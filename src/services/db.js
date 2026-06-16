'use strict';

// Persistência SQLite (better-sqlite3) — catálogo de produtos e log do job
// de auto-enriquecimento. Usa DB_PATH (disco persistente no Render) ou
// ./data na raiz do projeto em ambiente local.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_DIR = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'genesis.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  nome TEXT,
  dados_json TEXT NOT NULL DEFAULT '{}',
  fornecedor_nome TEXT,
  fornecedor_cnpj TEXT,
  nota_fiscal_chave TEXT,
  fonte TEXT NOT NULL DEFAULT 'manual',
  ntc REAL DEFAULT 0,
  decisao TEXT,
  rast_hash TEXT,
  bling_id TEXT,
  wix_id TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auto_enrich_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produto_id INTEGER,
  sku TEXT,
  acao TEXT,
  detalhes TEXT,
  ntc_antes REAL,
  ntc_depois REAL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_produtos_ntc ON produtos(ntc);
CREATE INDEX IF NOT EXISTS idx_produtos_fonte ON produtos(fonte);
CREATE INDEX IF NOT EXISTS idx_log_criado ON auto_enrich_log(criado_em);

CREATE TABLE IF NOT EXISTS bling_oauth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  refresh_token TEXT,
  expires_em INTEGER,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Aba "Conectores NTC": bancos de referência usados pelo agente de
-- enriquecimento para "busca cega" (montadoras, fabricantes/importadores,
-- catálogos de aplicação original como PartSouq/TecDoc) e conectores de
-- bancos de dados/sites externos do lojista (login/senha) usados para
-- importar produtos, imagens e atualizações.
CREATE TABLE IF NOT EXISTS ntc_referencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,             -- 'montadora' | 'fabricante' | 'catalogo' | 'conector'
  nome TEXT NOT NULL,
  logo_url TEXT,
  site TEXT,
  subtipo TEXT,                   -- fabricante: 'oem' | 'aftermarket' | 'importador'
  nota_ntc_referencia REAL,       -- catalogo: confiabilidade da fonte (0-1)
  usuario TEXT,                   -- conector: login do banco/site externo
  senha TEXT,                     -- conector: senha do banco/site externo
  url TEXT,                       -- conector/catalogo: endereço de acesso
  espelho_nuvem TEXT,             -- conector: 'wix' | 'drive' | ''
  ativo INTEGER NOT NULL DEFAULT 1,
  observacoes TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ntc_referencias_tipo ON ntc_referencias(tipo);
`);

// Migração: coluna `pausado` — permite excluir um produto específico do job
// de auto-enriquecimento 24/7 (pausa independente por produto), preservando
// a possibilidade de enriquecê-lo manualmente via "Minerar selecionados".
const _colunasProdutos = db.prepare("PRAGMA table_info(produtos)").all().map(c => c.name);
if (!_colunasProdutos.includes('pausado')) {
  db.exec("ALTER TABLE produtos ADD COLUMN pausado INTEGER NOT NULL DEFAULT 0");
}

// Migração: colunas Algolia — permite configurar busca via API Algolia em
// conectores que usam esse mecanismo (ex: Pellegrino B2B) sem precisar de
// scraping autenticado, contornando WAFs que bloqueiam IPs de servidores.
const _colunasRef = db.prepare("PRAGMA table_info(ntc_referencias)").all().map(c => c.name);
if (!_colunasRef.includes('algolia_app_id')) db.exec("ALTER TABLE ntc_referencias ADD COLUMN algolia_app_id TEXT");
if (!_colunasRef.includes('algolia_api_key')) db.exec("ALTER TABLE ntc_referencias ADD COLUMN algolia_api_key TEXT");
if (!_colunasRef.includes('algolia_index'))   db.exec("ALTER TABLE ntc_referencias ADD COLUMN algolia_index TEXT");
// Pasta exclusiva do Genesis no Google Drive (ID extraído da URL da pasta)
if (!_colunasRef.includes('drive_folder_id')) db.exec("ALTER TABLE ntc_referencias ADD COLUMN drive_folder_id TEXT");

function linhaParaProduto(row) {
  if (!row) return null;
  let dados = {};
  try { dados = JSON.parse(row.dados_json || '{}'); } catch (e) { dados = {}; }
  return { ...row, dados };
}

// Cria ou atualiza um produto pelo SKU. Mescla dados_json com o existente
// (campos novos sobrescrevem, mas nunca apagam o que já está confirmado
// a menos que explicitamente enviados como null/undefined no patch).
function upsertProduto(p) {
  if (!p.sku) throw new Error('sku é obrigatório');
  const existente = db.prepare('SELECT * FROM produtos WHERE sku = ?').get(p.sku);

  let dados = {};
  if (existente) {
    try { dados = JSON.parse(existente.dados_json || '{}'); } catch (e) { dados = {}; }
  }
  if (p.dados && typeof p.dados === 'object') {
    dados = { ...dados, ...p.dados };
  } else if (typeof p.dados_json === 'string') {
    try { dados = JSON.parse(p.dados_json); } catch (e) { /* mantém dados atuais */ }
  }

  const campos = {
    sku: p.sku,
    nome: p.nome != null ? p.nome : (existente ? existente.nome : (dados.nome || null)),
    dados_json: JSON.stringify(dados),
    fornecedor_nome: p.fornecedor_nome !== undefined ? p.fornecedor_nome : (existente ? existente.fornecedor_nome : null),
    fornecedor_cnpj: p.fornecedor_cnpj !== undefined ? p.fornecedor_cnpj : (existente ? existente.fornecedor_cnpj : null),
    nota_fiscal_chave: p.nota_fiscal_chave !== undefined ? p.nota_fiscal_chave : (existente ? existente.nota_fiscal_chave : null),
    fonte: p.fonte || (existente ? existente.fonte : 'manual'),
    ntc: p.ntc != null ? p.ntc : (existente ? existente.ntc : 0),
    decisao: p.decisao || (existente ? existente.decisao : null),
    rast_hash: p.rast_hash || (existente ? existente.rast_hash : null),
    bling_id: p.bling_id !== undefined ? p.bling_id : (existente ? existente.bling_id : null),
    wix_id: p.wix_id !== undefined ? p.wix_id : (existente ? existente.wix_id : null),
  };

  if (existente) {
    db.prepare(`UPDATE produtos SET nome=@nome, dados_json=@dados_json, fornecedor_nome=@fornecedor_nome,
      fornecedor_cnpj=@fornecedor_cnpj, nota_fiscal_chave=@nota_fiscal_chave, fonte=@fonte, ntc=@ntc,
      decisao=@decisao, rast_hash=@rast_hash, bling_id=@bling_id, wix_id=@wix_id, atualizado_em=datetime('now')
      WHERE sku=@sku`).run(campos);
  } else {
    db.prepare(`INSERT INTO produtos (sku, nome, dados_json, fornecedor_nome, fornecedor_cnpj, nota_fiscal_chave,
      fonte, ntc, decisao, rast_hash, bling_id, wix_id)
      VALUES (@sku, @nome, @dados_json, @fornecedor_nome, @fornecedor_cnpj, @nota_fiscal_chave,
      @fonte, @ntc, @decisao, @rast_hash, @bling_id, @wix_id)`).run(campos);
  }

  return linhaParaProduto(db.prepare('SELECT * FROM produtos WHERE sku = ?').get(p.sku));
}

function obterProduto(id) {
  return linhaParaProduto(db.prepare('SELECT * FROM produtos WHERE id = ?').get(id));
}

function obterProdutoPorSku(sku) {
  return linhaParaProduto(db.prepare('SELECT * FROM produtos WHERE sku = ?').get(sku));
}

function listarProdutos({ limit = 50, offset = 0, decisao, fonte, busca } = {}) {
  let sql = 'SELECT * FROM produtos';
  const where = [];
  const params = {};
  if (decisao) { where.push('decisao = @decisao'); params.decisao = decisao; }
  if (fonte) { where.push('fonte = @fonte'); params.fonte = fonte; }
  if (busca) { where.push('(sku LIKE @busca OR nome LIKE @busca)'); params.busca = '%' + busca + '%'; }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY atualizado_em DESC LIMIT @limit OFFSET @offset';
  params.limit = limit;
  params.offset = offset;
  const rows = db.prepare(sql).all(params);
  return rows.map(linhaParaProduto);
}

function contarProdutos() {
  return db.prepare('SELECT COUNT(*) AS total FROM produtos').get().total;
}

// Produtos candidatos ao job de auto-enriquecimento: NTC ainda não aprovado
// (< 0.95), priorizando os mais antigos/menos atualizados primeiro. Produtos
// pausados (pausado=1) ficam fora do lote automático, mas continuam podendo
// ser enriquecidos manualmente via "Minerar selecionados".
function listarParaEnriquecer(limit = 5) {
  const rows = db.prepare(`SELECT * FROM produtos WHERE (ntc IS NULL OR ntc < 0.95) AND pausado = 0
    ORDER BY atualizado_em ASC LIMIT ?`).all(limit);
  return rows.map(linhaParaProduto);
}

function contarParaEnriquecer() {
  return db.prepare(`SELECT COUNT(*) AS total FROM produtos WHERE (ntc IS NULL OR ntc < 0.95) AND pausado = 0`).get().total;
}

// Pausa/retoma o auto-enriquecimento 24/7 para um produto específico.
function definirPausado(id, pausado) {
  const info = db.prepare('UPDATE produtos SET pausado = ? WHERE id = ?').run(pausado ? 1 : 0, id);
  if (info.changes === 0) return null;
  return obterProduto(id);
}

function excluirProduto(id) {
  return db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
}

function registrarLog({ produto_id, sku, acao, detalhes, ntc_antes, ntc_depois }) {
  db.prepare(`INSERT INTO auto_enrich_log (produto_id, sku, acao, detalhes, ntc_antes, ntc_depois)
    VALUES (@produto_id, @sku, @acao, @detalhes, @ntc_antes, @ntc_depois)`).run({
    produto_id: produto_id || null,
    sku: sku || null,
    acao: acao || null,
    detalhes: detalhes != null ? String(detalhes) : null,
    ntc_antes: ntc_antes != null ? ntc_antes : null,
    ntc_depois: ntc_depois != null ? ntc_depois : null,
  });
}

function listarLogsRecentes(limit = 20) {
  return db.prepare('SELECT * FROM auto_enrich_log ORDER BY criado_em DESC LIMIT ?').all(limit);
}

function obterEstatisticas() {
  const total = contarProdutos();
  const porDecisao = db.prepare('SELECT decisao, COUNT(*) AS total FROM produtos GROUP BY decisao').all();
  const porFonte = db.prepare('SELECT fonte, COUNT(*) AS total FROM produtos GROUP BY fonte').all();
  const mediaNtc = db.prepare('SELECT AVG(ntc) AS media FROM produtos').get().media;
  const pendentesEnriquecer = contarParaEnriquecer();
  return {
    total,
    media_ntc: mediaNtc != null ? Math.round(mediaNtc * 10000) / 10000 : 0,
    por_decisao: porDecisao.reduce((acc, r) => { acc[r.decisao || 'SEM_AVALIACAO'] = r.total; return acc; }, {}),
    por_fonte: porFonte.reduce((acc, r) => { acc[r.fonte || 'desconhecida'] = r.total; return acc; }, {}),
    pendentes_enriquecer: pendentesEnriquecer,
  };
}

// Tokens OAuth2 do Bling (authorization_code), persistidos em disco para
// sobreviver a reinícios do servidor. `expires_em` é timestamp Unix (ms).
function salvarBlingOAuth({ access_token, refresh_token, expires_in }) {
  const expires_em = Date.now() + (expires_in || 21600) * 1000;
  db.prepare(`INSERT INTO bling_oauth (id, access_token, refresh_token, expires_em, atualizado_em)
    VALUES (1, @access_token, @refresh_token, @expires_em, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET access_token=@access_token, refresh_token=@refresh_token,
      expires_em=@expires_em, atualizado_em=datetime('now')`)
    .run({ access_token, refresh_token, expires_em });
}

function obterBlingOAuth() {
  return db.prepare('SELECT * FROM bling_oauth WHERE id = 1').get() || null;
}

// ===== Conectores NTC (montadoras, fabricantes/importadores, catálogos de
// referência e conectores de bancos de dados/sites externos do lojista) =====
const NTC_REF_TIPOS = ['montadora', 'fabricante', 'catalogo', 'conector'];

function listarReferencias(tipo) {
  if (tipo) return db.prepare('SELECT * FROM ntc_referencias WHERE tipo = ? ORDER BY nome COLLATE NOCASE').all(tipo);
  return db.prepare('SELECT * FROM ntc_referencias ORDER BY tipo, nome COLLATE NOCASE').all();
}

function criarReferencia(r) {
  if (!r.tipo || NTC_REF_TIPOS.indexOf(r.tipo) === -1) throw new Error('tipo inválido');
  if (!r.nome) throw new Error('nome é obrigatório');
  const info = db.prepare(`INSERT INTO ntc_referencias
    (tipo, nome, logo_url, site, subtipo, nota_ntc_referencia, usuario, senha, url, espelho_nuvem, ativo, observacoes, algolia_app_id, algolia_api_key, algolia_index, drive_folder_id)
    VALUES (@tipo, @nome, @logo_url, @site, @subtipo, @nota_ntc_referencia, @usuario, @senha, @url, @espelho_nuvem, @ativo, @observacoes, @algolia_app_id, @algolia_api_key, @algolia_index, @drive_folder_id)`)
    .run({
      tipo: r.tipo, nome: r.nome,
      logo_url: r.logo_url || null, site: r.site || null, subtipo: r.subtipo || null,
      nota_ntc_referencia: r.nota_ntc_referencia != null ? r.nota_ntc_referencia : null,
      usuario: r.usuario || null, senha: r.senha || null, url: r.url || null,
      espelho_nuvem: r.espelho_nuvem || null,
      ativo: r.ativo === false ? 0 : 1,
      observacoes: r.observacoes || null,
      algolia_app_id: r.algolia_app_id || null,
      algolia_api_key: r.algolia_api_key || null,
      algolia_index: r.algolia_index || null,
      drive_folder_id: r.drive_folder_id || null,
    });
  return db.prepare('SELECT * FROM ntc_referencias WHERE id = ?').get(info.lastInsertRowid);
}

function atualizarReferencia(id, r) {
  const existente = db.prepare('SELECT * FROM ntc_referencias WHERE id = ?').get(id);
  if (!existente) return null;
  const campos = {
    nome: r.nome !== undefined ? r.nome : existente.nome,
    logo_url: r.logo_url !== undefined ? r.logo_url : existente.logo_url,
    site: r.site !== undefined ? r.site : existente.site,
    subtipo: r.subtipo !== undefined ? r.subtipo : existente.subtipo,
    nota_ntc_referencia: r.nota_ntc_referencia !== undefined ? r.nota_ntc_referencia : existente.nota_ntc_referencia,
    usuario: r.usuario !== undefined ? r.usuario : existente.usuario,
    senha: r.senha !== undefined ? r.senha : existente.senha,
    url: r.url !== undefined ? r.url : existente.url,
    espelho_nuvem: r.espelho_nuvem !== undefined ? r.espelho_nuvem : existente.espelho_nuvem,
    ativo: r.ativo !== undefined ? (r.ativo ? 1 : 0) : existente.ativo,
    observacoes: r.observacoes !== undefined ? r.observacoes : existente.observacoes,
    algolia_app_id: r.algolia_app_id !== undefined ? r.algolia_app_id || null : existente.algolia_app_id,
    algolia_api_key: r.algolia_api_key !== undefined ? r.algolia_api_key || null : existente.algolia_api_key,
    algolia_index: r.algolia_index !== undefined ? r.algolia_index || null : existente.algolia_index,
    drive_folder_id: r.drive_folder_id !== undefined ? r.drive_folder_id || null : existente.drive_folder_id,
    id: id,
  };
  db.prepare(`UPDATE ntc_referencias SET nome=@nome, logo_url=@logo_url, site=@site, subtipo=@subtipo,
    nota_ntc_referencia=@nota_ntc_referencia, usuario=@usuario, senha=@senha, url=@url,
    espelho_nuvem=@espelho_nuvem, ativo=@ativo, observacoes=@observacoes,
    algolia_app_id=@algolia_app_id, algolia_api_key=@algolia_api_key, algolia_index=@algolia_index,
    drive_folder_id=@drive_folder_id, atualizado_em=datetime('now')
    WHERE id=@id`).run(campos);
  return db.prepare('SELECT * FROM ntc_referencias WHERE id = ?').get(id);
}

function excluirReferencia(id) {
  return db.prepare('DELETE FROM ntc_referencias WHERE id = ?').run(id);
}

// Popula os bancos de montadoras/fabricantes/catálogos de referência na
// primeira execução, para o agente já ter uma base de "busca cega". O
// lojista pode editar, completar (logos/sites) ou remover qualquer item.
function seedReferenciasNTC() {
  const total = db.prepare('SELECT COUNT(*) AS total FROM ntc_referencias').get().total;

  // Logos servidos via Wikimedia Commons (Special:FilePath — link estável que
  // redireciona para o arquivo). Em caso de link quebrado, o card mostra o
  // ícone padrão e o lojista pode usar "🔍 Buscar logo" para substituir.
  const montadoras = [
    { nome: 'Toyota', site: 'https://www.toyota.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Toyota_carlogo.svg' },
    { nome: 'Honda', site: 'https://www.honda.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Honda_logo.svg' },
    { nome: 'Hyundai', site: 'https://www.hyundai.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Hyundai_Motor_Company_logo.svg' },
    { nome: 'Kia', site: 'https://www.kia.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/KIA_logo3.svg' },
    { nome: 'Ford', site: 'https://www.ford.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Ford_logo_flat.svg' },
    { nome: 'Chevrolet', site: 'https://www.chevrolet.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Chevrolet-logo.svg' },
    { nome: 'Volkswagen', site: 'https://www.vw.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Volkswagen_logo_2019.svg' },
    { nome: 'Fiat', site: 'https://www.fiat.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/FIAT_logo_%282020%29.svg' },
    { nome: 'Renault', site: 'https://www.renault.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Renault_2021_Text.svg' },
    { nome: 'Nissan', site: 'https://www.nissan.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Nissan_2020_logo.svg' },
    { nome: 'Peugeot', site: 'https://www.peugeot.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Peugeot_Logo.svg' },
    { nome: 'Citroën', site: 'https://www.citroen.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Citroen_2022.svg' },
    { nome: 'Mitsubishi', site: 'https://www.mitsubishimotors.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Mitsubishi_Motors_SVG_logo.svg' },
    { nome: 'Jeep', site: 'https://www.jeep.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Jeep_logo.svg' },
    { nome: 'Mercedes-Benz', site: 'https://www2.mercedes-benz.com.br', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Mercedes-Benz_logo_2.svg' },
    { nome: 'Iveco', site: 'https://www.iveco.com/brasil', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Iveco_Logo_2023.svg' },
  ];

  const fabricantes = [
    { nome: 'Bosch', site: 'https://www.bosch.com.br', subtipo: 'oem', logo_url: null },
    { nome: 'Mahle', site: 'https://www.br.mahle.com', subtipo: 'oem', logo_url: null },
    { nome: 'ZF', site: 'https://www.zf.com/brazil/pt/home/home.html', subtipo: 'oem', logo_url: null },
    { nome: 'Continental', site: 'https://www.continental.com', subtipo: 'oem', logo_url: null },
    { nome: 'Denso', site: 'https://www.denso.com/br/pt/', subtipo: 'oem', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Denso_logo.svg' },
    { nome: 'Valeo', site: 'https://www.valeo.com/en/brazil/', subtipo: 'oem', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Valeo_Logo.svg' },
    { nome: 'Schaeffler / INA', site: 'https://www.schaeffler.com.br', subtipo: 'oem', logo_url: null },
    { nome: 'SKF', site: 'https://www.skf.com/br', subtipo: 'oem', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/SKF_logo.svg' },
    { nome: 'NGK', site: 'https://www.ngkntk.com.br', subtipo: 'oem', logo_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Ngk_logo.svg' },
    { nome: 'Nakata', site: 'https://www.nakata.com.br', subtipo: 'aftermarket', logo_url: null },
    { nome: 'Cofap', site: 'https://loja.cofap.com.br', subtipo: 'aftermarket', logo_url: null },
    { nome: 'Fras-le', site: 'https://www.fras-le.com', subtipo: 'aftermarket', logo_url: null },
    { nome: 'Tecfil', site: 'https://www.tecfil.com.br', subtipo: 'aftermarket', logo_url: null },
    { nome: 'Fremax', site: 'https://www.fremax.com.br', subtipo: 'aftermarket', logo_url: null },
  ];

  const catalogos = [
    { nome: 'PartSouq', url: 'https://www.partsouq.com', nota_ntc_referencia: 0.9, observacoes: 'Catálogo de aplicação original (peça × chassi/VIN) — referência para CC/AV/LG.' },
    { nome: 'TecDoc', url: 'https://www.tecdoc.net', nota_ntc_referencia: 0.9, observacoes: 'Catálogo mundial de aplicações e cross-codes aftermarket — referência para CC/AV.' },
    { nome: 'Fras-le Catálogo', url: 'https://www.frasle.com.br', nota_ntc_referencia: 0.8, observacoes: 'Catálogo nacional de aplicações (freios/embreagem) — referência para AV/CC.' },
    { nome: 'Schaeffler REPXPERT', url: 'https://www.repxpert.com.br', nota_ntc_referencia: 0.85, observacoes: 'Catálogo técnico INA/FAG/LuK — referência para EC/MC/CC.' },
    { nome: 'RockAuto', url: 'https://www.rockauto.com', nota_ntc_referencia: 0.7, observacoes: 'Referência de mercado/preço e cross-codes aftermarket americano.' },
    { nome: 'Mercado Livre', url: 'https://www.mercadolivre.com.br', nota_ntc_referencia: 0.6, observacoes: 'Referência de demanda/preço regional — não usar como fonte de aplicação original.' },
  ];

  // Importadores independentes consagrados no mercado nacional (subtipo
  // "importador") e catálogos de referência adicionais — inseridos de forma
  // idempotente (não duplicam em bancos que já rodaram o seed original).
  const importadores = [
    { nome: 'Sabó', site: 'https://www.sabo.com.br' },
    { nome: 'Fortbras', site: 'https://www.fortbras.com.br' },
    { nome: 'Hipper Freios', site: 'https://www.hipperfreios.com.br' },
    { nome: 'DPK Distribuidora Automotiva', site: 'https://www.dpk.com.br' },
    { nome: 'JP Group', site: 'https://jpgroup.dk/en/' },
  ];

  const catalogosExtra = [
    { nome: '7Zap', url: 'https://7zap.com/', nota_ntc_referencia: 0.75, observacoes: 'Diagramas explodidos e peças originais por marca/VIN, com cross-reference internacional — referência para AV/CC/LG.' },
    { nome: 'AutoDoc', url: 'https://www.autodoc.pt', nota_ntc_referencia: 0.6, observacoes: 'Loja/catálogo europeu de autopeças de reposição com busca por veículo — referência cruzada de aplicações.' },
    { nome: 'Mopar / Stellantis Parts Catalog', url: 'https://www.moparoficial.com.br', nota_ntc_referencia: 0.7, observacoes: 'Catálogo oficial de peças originais Mopar para Fiat/Jeep/Peugeot/Citroën no Brasil — referência para CC/AV/LG.' },
  ];

  const insert = db.prepare(`INSERT INTO ntc_referencias (tipo, nome, logo_url, site, subtipo, nota_ntc_referencia, url, observacoes)
    VALUES (@tipo, @nome, @logo_url, @site, @subtipo, @nota_ntc_referencia, @url, @observacoes)`);
  const existe = db.prepare('SELECT id FROM ntc_referencias WHERE tipo = ? AND nome = ?');
  const preencherFaltantes = db.prepare(`UPDATE ntc_referencias SET
      site = COALESCE(site, @site), logo_url = COALESCE(logo_url, @logo_url)
    WHERE tipo = @tipo AND nome = @nome`);

  const tx = db.transaction(() => {
    if (total === 0) {
      montadoras.forEach(m => insert.run({ tipo: 'montadora', nome: m.nome, logo_url: m.logo_url, site: m.site, subtipo: null, nota_ntc_referencia: null, url: null, observacoes: null }));
      fabricantes.forEach(f => insert.run({ tipo: 'fabricante', nome: f.nome, logo_url: f.logo_url, site: f.site, subtipo: f.subtipo, nota_ntc_referencia: null, url: null, observacoes: null }));
      catalogos.forEach(c => insert.run({ tipo: 'catalogo', nome: c.nome, logo_url: null, site: null, subtipo: null, nota_ntc_referencia: c.nota_ntc_referencia, url: c.url, observacoes: c.observacoes }));
    } else {
      // Banco já existente: completa site/logo das montadoras e fabricantes
      // que ainda estiverem em branco, sem sobrescrever edições do lojista.
      montadoras.forEach(m => preencherFaltantes.run({ tipo: 'montadora', nome: m.nome, site: m.site, logo_url: m.logo_url }));
      fabricantes.forEach(f => preencherFaltantes.run({ tipo: 'fabricante', nome: f.nome, site: f.site, logo_url: f.logo_url }));
    }

    importadores.forEach(i => {
      if (!existe.get('fabricante', i.nome)) {
        insert.run({ tipo: 'fabricante', nome: i.nome, logo_url: null, site: i.site, subtipo: 'importador', nota_ntc_referencia: null, url: null, observacoes: null });
      }
    });
    catalogosExtra.forEach(c => {
      if (!existe.get('catalogo', c.nome)) {
        insert.run({ tipo: 'catalogo', nome: c.nome, logo_url: null, site: null, subtipo: null, nota_ntc_referencia: c.nota_ntc_referencia, url: c.url, observacoes: c.observacoes });
      }
    });
  });
  tx();
}

module.exports = {
  db,
  upsertProduto,
  obterProduto,
  obterProdutoPorSku,
  listarProdutos,
  contarProdutos,
  listarParaEnriquecer,
  contarParaEnriquecer,
  definirPausado,
  excluirProduto,
  registrarLog,
  listarLogsRecentes,
  obterEstatisticas,
  salvarBlingOAuth,
  obterBlingOAuth,
  listarReferencias,
  criarReferencia,
  atualizarReferencia,
  excluirReferencia,
  seedReferenciasNTC,
};
