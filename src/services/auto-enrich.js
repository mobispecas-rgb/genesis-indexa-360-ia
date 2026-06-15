'use strict';

// ============================================================
// JOB DE AUTO-ENRIQUECIMENTO 24/7 — Genesis Indexa 360 IA
// ============================================================
// Roda em background (setInterval, ver server.js) e processa um lote de
// produtos já cadastrados por ciclo, sempre na seguinte ordem:
//
//   1. RASTREABILIDADE — se o produto tem fornecedor (nota fiscal de
//      entrada), preserva o fornecedor na Linhagem Genealógica (LG).
//      Se NÃO houver fornecedor, marca fonte = "avulso" (cadastro
//      independente, sem nota de origem).
//   2. DNA NA WEB — preenche campos vazios (OEM/EAN/NCM/CEST/aplicação/
//      motor/material/dimensões/cross-codes/boletins/etc.) via busca web
//      + IA. NUNCA sobrescreve um campo já preenchido (nunca inventa).
//   3. COLONIZAÇÃO DE IMAGENS — busca imagens reais do produto na web para
//      elevar o módulo IV (Integridade Visual).
//   4. Recalcula o NTC 4.0 e persiste.
//
// Tudo é registrado em auto_enrich_log para auditoria.
const db = require('./db');
const ntcEngine = require('./ntc-engine');
const { enriquecerDnaViaWeb } = require('./dna-enricher');
const { buscarImagensReais } = require('./image-search');

const DNA_COOLDOWN_MS = (Number(process.env.AUTO_ENRICH_DNA_COOLDOWN_H) || 24) * 60 * 60 * 1000;
const IMG_COOLDOWN_MS = (Number(process.env.AUTO_ENRICH_IMG_COOLDOWN_H) || 24) * 60 * 60 * 1000;
const MIN_IMAGENS_IV = 4;

// Mapa: campo do agente de DNA na Web → campo simples em `dados` (NTC engine)
const MAPA_DNA_SIMPLES = {
  codigo_oem: 'codigo_oem', ean: 'ean', ncm: 'ncm', cest: 'cest',
  motor: 'motor', codigo_motor: 'codigo_motor',
  marca_veiculo: 'marca', modelo_veiculo: 'modelo', versao_veiculo: 'versao',
  ano_inicial: 'ano_inicial', ano_final: 'ano_final', cilindrada: 'cilindrada',
  material: 'material', posicao: 'posicao', fmsi: 'fmsi',
  comprimento: 'comprimento', largura: 'largura', altura: 'altura',
  funcao_tecnica: 'funcao',
  fabricante_original: 'linhagem_fabricante',
  montadora: 'linhagem_montadora',
  peso_bruto: 'peso_bruto', peso_liquido: 'peso_liquido',
};

// Aplica os campos retornados pelo agente de DNA na Web em `dados`,
// preenchendo SOMENTE campos vazios (nunca sobrescreve dado confirmado).
function aplicarCamposDna(dados, campos, acoes) {
  for (const [campoDna, alvo] of Object.entries(MAPA_DNA_SIMPLES)) {
    const item = campos[campoDna];
    if (item && item.valor != null && item.valor !== '' && (dados[alvo] == null || dados[alvo] === '')) {
      dados[alvo] = item.valor;
      acoes.push('dna:' + campoDna);
    }
  }

  if (campos.boletins?.valor && (!Array.isArray(dados.boletins) || !dados.boletins.length)) {
    dados.boletins = String(campos.boletins.valor).split('\n').map(s => s.trim()).filter(Boolean);
    acoes.push('dna:boletins');
  }
  if (campos.substituicoes?.valor && (!Array.isArray(dados.substituicoes) || !dados.substituicoes.length)) {
    dados.substituicoes = String(campos.substituicoes.valor).split('\n').map(s => s.trim()).filter(Boolean);
    acoes.push('dna:substituicoes');
  }
  if (campos.cc_oem?.valor && (!Array.isArray(dados.cc_oem) || !dados.cc_oem.length)) {
    dados.cc_oem = String(campos.cc_oem.valor).split('\n').map(s => s.trim()).filter(Boolean);
    acoes.push('dna:cc_oem');
  }
  if (campos.cross_codes?.valor && (!Array.isArray(dados.cc_aftermarket) || !dados.cc_aftermarket.length)) {
    dados.cc_aftermarket = String(campos.cross_codes.valor).split(';').map(s => s.trim()).filter(Boolean);
    acoes.push('dna:cross_codes');
  }
  if (campos.aplicacoes_adicionais?.valor && !dados.aplicacoes_adicionais) {
    dados.aplicacoes_adicionais = String(campos.aplicacoes_adicionais.valor).split('\n').map(s => s.trim()).filter(Boolean);
    acoes.push('dna:aplicacoes_adicionais');
  }
}

// Passo 1 — Rastreabilidade: preserva o fornecedor da nota fiscal de entrada
// na Linhagem Genealógica (LG), ou marca o cadastro como "avulso" quando não
// há fornecedor de origem.
function aplicarFornecedorOuAvulso(row, dados, acoes) {
  if (row.fornecedor_nome) {
    if (!dados.linhagem_distribuidor) {
      dados.linhagem_distribuidor = row.fornecedor_nome;
      acoes.push('lg:fornecedor');
    }
    return 'fornecedor';
  }
  if (!dados.linhagem_marketplace) {
    dados.linhagem_marketplace = 'Cadastro Avulso — MOBIS';
    acoes.push('lg:avulso');
  }
  return row.fonte === 'fornecedor' ? row.fonte : 'avulso';
}

// Passo 2 — DNA na Web: preenche campos vazios via busca web + IA (com
// cooldown para não repetir buscas sem sentido em produtos sem fonte).
// Quando `forcar` é true (disparo manual via "Enriquecer agora"), ignora o
// cooldown e a verificação de "campos-chave já preenchidos" — o usuário
// pediu explicitamente uma nova busca para completar TODOS os campos do DNA
// (cross-codes, boletins, substituições, cc_oem, pesos, dimensões etc.).
async function enriquecerDnaSeNecessario(row, dados, acoes, forcar) {
  if (!process.env.ANTHROPIC_API_KEY) return;

  if (!forcar) {
    const ultimaTentativa = dados._auto_dna_tentativa ? new Date(dados._auto_dna_tentativa).getTime() : 0;
    if (Date.now() - ultimaTentativa < DNA_COOLDOWN_MS) return;

    const camposChaveFaltando = !dados.codigo_oem || !dados.ean || !dados.ncm
      || !dados.motor || !dados.material || !dados.cilindrada;
    if (!camposChaveFaltando) return;
  }

  dados._auto_dna_tentativa = new Date().toISOString();
  const resultado = await enriquecerDnaViaWeb({ sku: row.sku, fabricante: dados.fabricante, nome: dados.nome });
  if (resultado.ok && resultado.encontrado) {
    aplicarCamposDna(dados, resultado.campos, acoes);
  } else if (!resultado.ok) {
    acoes.push('dna:erro(' + (resultado.erro || 'falha desconhecida') + ')');
  } else if (!resultado.encontrado) {
    acoes.push('dna:sem_resultado');
  }
}

// Passo 3 — Colonização de imagens reais: eleva o módulo IV buscando fotos
// reais do produto na web quando o cadastro ainda tem poucas imagens.
// Quando `forcar` é true, ignora o cooldown e o piso de MIN_IMAGENS_IV (mas
// não busca de novo se já atingiu o teto de 8 imagens).
async function colonizarImagensSeNecessario(row, dados, acoes, forcar) {
  const imagens = Array.isArray(dados.imagens) ? dados.imagens : [];
  if (imagens.length >= 8) return;
  if (!forcar) {
    if (imagens.length >= MIN_IMAGENS_IV) return;

    const ultimaTentativa = dados._auto_iv_tentativa ? new Date(dados._auto_iv_tentativa).getTime() : 0;
    if (Date.now() - ultimaTentativa < IMG_COOLDOWN_MS) return;
  }

  const q = [dados.fabricante, row.sku, dados.nome].filter(Boolean).join(' ');
  if (!q) return;

  dados._auto_iv_tentativa = new Date().toISOString();
  const encontradas = await buscarImagensReais(q, 8);
  const urls = encontradas.map(i => i.url).filter(Boolean);
  if (!urls.length) return;

  const todas = [...new Set([...imagens, ...urls])].slice(0, 8);
  if (todas.length > imagens.length) {
    dados.imagens = todas;
    dados.iv_foto_principal = true;
    acoes.push('iv:imagens(+' + (todas.length - imagens.length) + ')');
  }
}

// Processa um único produto: rastreabilidade → DNA web → imagens → recálculo NTC → persistência.
// `opts.forcar` (disparo manual via "Enriquecer agora") ignora os cooldowns
// e o gate de "campos-chave já preenchidos" do job 24/7.
async function enriquecerProdutoAuto(row, opts = {}) {
  const dados = { ...row.dados };
  const acoes = [];
  const forcar = !!opts.forcar;

  const antes = ntcEngine.processar(dados);

  const fonte = aplicarFornecedorOuAvulso(row, dados, acoes);
  await enriquecerDnaSeNecessario(row, dados, acoes, forcar);
  await colonizarImagensSeNecessario(row, dados, acoes, forcar);

  const depois = ntcEngine.processar(dados);

  db.upsertProduto({
    sku: row.sku,
    nome: dados.nome || row.nome,
    dados,
    fonte,
    ntc: depois.ntc,
    decisao: depois.decisao,
    rast_hash: depois.rast_hash,
  });

  db.registrarLog({
    produto_id: row.id,
    sku: row.sku,
    acao: acoes.length ? acoes.join(',') : 'sem_mudancas',
    ntc_antes: antes.ntc,
    ntc_depois: depois.ntc,
  });

  return { sku: row.sku, nome: dados.nome || row.nome, ntc_antes: antes.ntc, ntc_depois: depois.ntc, decisao: depois.decisao, fonte, acoes };
}

// ─── Estado do job (status para o painel de monitoramento) ───────────────
const _status = {
  habilitado: process.env.AUTO_ENRICH_ENABLED !== 'false',
  rodando: false,
  ultima_execucao: null,
  ultimo_resultado: [],
  total_processados: 0,
  total_ciclos: 0,
};

// Processa um lote de produtos pendentes (NTC < 0.95), começando pelos
// menos atualizados — ou seja, produtos já cadastrados primeiro.
async function rodarCicloAutoEnrich(batchSize) {
  if (!_status.habilitado) return { ok: false, erro: 'Job 24/7 está pausado' };
  if (_status.rodando) return { ok: false, erro: 'Ciclo já em execução' };
  const tamanho = batchSize || Number(process.env.AUTO_ENRICH_BATCH_SIZE) || 5;

  _status.rodando = true;
  const resultados = [];
  try {
    const lote = db.listarParaEnriquecer(tamanho);
    for (const row of lote) {
      try {
        const r = await enriquecerProdutoAuto(row);
        resultados.push(r);
      } catch (e) {
        console.error('[Auto-Enrich]', row.sku, e.message);
        db.registrarLog({ produto_id: row.id, sku: row.sku, acao: 'erro', detalhes: e.message });
        resultados.push({ sku: row.sku, erro: e.message });
      }
    }
  } finally {
    _status.rodando = false;
    _status.ultima_execucao = new Date().toISOString();
    _status.ultimo_resultado = resultados;
    _status.total_processados += resultados.length;
    _status.total_ciclos += 1;
  }
  return { ok: true, processados: resultados.length, resultados };
}

function obterStatus() {
  return {
    ..._status,
    fila_pendente: db.contarParaEnriquecer(),
    estatisticas: db.obterEstatisticas(),
    logs_recentes: db.listarLogsRecentes(20),
  };
}

// Liga/desliga o job 24/7 em tempo de execução (pausa global, independente do
// AUTO_ENRICH_ENABLED de inicialização) — usado para conter o consumo de
// créditos da API durante testes controlados.
function definirHabilitado(habilitado) {
  _status.habilitado = !!habilitado;
  return _status.habilitado;
}

module.exports = {
  enriquecerProdutoAuto,
  rodarCicloAutoEnrich,
  obterStatus,
  definirHabilitado,
  aplicarFornecedorOuAvulso,
  aplicarCamposDna,
};
