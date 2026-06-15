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
`);

// Migração: coluna `pausado` — permite excluir um produto específico do job
// de auto-enriquecimento 24/7 (pausa independente por produto), preservando
// a possibilidade de enriquecê-lo manualmente via "Minerar selecionados".
const _colunasProdutos = db.prepare("PRAGMA table_info(produtos)").all().map(c => c.name);
if (!_colunasProdutos.includes('pausado')) {
  db.exec("ALTER TABLE produtos ADD COLUMN pausado INTEGER NOT NULL DEFAULT 0");
}

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
};
