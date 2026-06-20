'use strict';

// ============================================================
// Agente de Enriquecimento DNA — Motor NTC 4.0
// REGRA CANÔNICA DNA OEM 360 — versão 4.0 (2026-06-20)
// ============================================================
// Estratégia multi-query: 4 buscas targetadas para maximizar cobertura
// Brave Search (primário) → SERPER (fallback)
//
// REGRA ABSOLUTA: NUNCA inventa. Sem fonte = null. Ponto final.
// ============================================================
const https = require('https');
const { validarGTIN, validarNCM, consultarNCMOficial } = require('./web-utils');

// ─────────────────────────────────────────────────────────────
// REGRAS CANÔNICAS — NUNCA QUEBRAR
// (Lei do sistema — nenhum agente, LLM ou código externo pode contornar)
// ─────────────────────────────────────────────────────────────
const NTC_CANONICAL_RULES = `
REGRAS ABSOLUTAS — NUNCA QUEBRE ESTAS REGRAS:

1. NUNCA invente, deduza ou "complete" um dado que não tenha fonte verificável
   nos resultados de busca fornecidos. Se não encontrar evidência, o campo
   retorna null. Não existe "chute educado" — existe fato com fonte ou null.

2. SEMPRE diferencie três níveis de confiança por campo:
   - "confirmado": o dado apareceu em pelo menos 2 fontes independentes
     E ESPECÍFICAS (página de produto, ficha técnica, catálogo com o código
     exato pesquisado). Uma URL institucional genérica (ex: a home page da
     marca) NUNCA conta como fonte válida.
   - "familia": o dado vem de um código vizinho/aparentado (mesma família de
     produto, prefixo, ou faixa numérica), mas não do código exato pesquisado.
     Isso é uma pista, não um fato. Nunca promova "familia" para "confirmado".
   - "nulo": nenhuma fonte encontrada. Campo fica null.

   PROIBIDO: repetir a mesma URL como "fonte" em múltiplos campos diferentes
   só para preencher o requisito de "tem fonte". Cada fonte citada precisa
   realmente mencionar aquele dado específico.

3. Quando o código de entrada estiver incompleto (faltando sufixo de medida,
   tipo, ou hífen), NÃO tente adivinhar o sufixo. Retorne
   "status": "codigo_incompleto" e liste no campo variantes_possiveis
   os sufixos/formatos encontrados nos resultados, SEM escolher um sozinho.

4. Para APLICAÇÃO VEICULAR, sempre que o motor for compartilhado/licenciado
   entre montadoras, explique o MECANISMO da triangulação — não apenas liste
   os veículos. Isso vira o campo mecanismo_triangulacao e alimenta a LG.

5. Em fontes[], coloque as URLs EXATAS dos resultados fornecidos onde encontrou
   o dado. Cada fonte citada precisa mencionar aquele dado específico.

6. Saída deve ser SOMENTE o JSON abaixo, preenchido. Nada de texto antes ou
   depois. Nada de markdown com cercas de código. Apenas o objeto JSON.
`;

// Schema de saída canônico completo
const NTC_OUTPUT_SCHEMA = {
  codigo_entrada: "<código exatamente como recebido>",
  status: "ok | codigo_incompleto | nao_encontrado",
  variantes_possiveis: [],
  dna: {
    fabricante_original:           { valor: null, confianca: "confirmado|familia|nulo", fontes: [] },
    codigo_oem:                    { valor: null, confianca: "confirmado|familia|nulo", fontes: [] },
    codigo_fabricante_normalizado: { valor: null, confianca: "confirmado|familia|nulo", fontes: [] },
    ean:                           { valor: null, confianca: "confirmado|familia|nulo", fontes: [] },
    categoria_produto:             { valor: null, confianca: "confirmado|familia|nulo", fontes: [] }
  },
  fm: {
    nome_tecnico_completo: { valor: null, confianca: "confirmado|familia|nulo", fontes: [] },
    funcao_tecnica:        { valor: null, confianca: "confirmado|familia|nulo", fontes: [] }
  },
  av: {
    aplicacoes: [
      {
        montadora: null, modelo: null, motor: null,
        ano_inicial: null, ano_final: null, cilindrada: null,
        confianca: "confirmado|familia|nulo", fontes: []
      }
    ],
    mecanismo_triangulacao: null
  },
  co: {
    ncm:  { valor: null, confianca: "confirmado|familia|nulo", fontes: [] },
    cest: { valor: null, confianca: "confirmado|familia|nulo", fontes: [] }
  },
  mc: {
    material: { valor: null, confianca: "confirmado|familia|nulo", fontes: [] }
  },
  ec: {
    engenharia_detalhe: { valor: null, confianca: "confirmado|familia|nulo", fontes: [] }
  },
  bta: {
    boletins:     [],
    substituicoes: []
  },
  cc: {
    cc_oem:          [{ marca: null, codigo: null, confianca: "confirmado|familia|nulo" }],
    cc_aftermarket:  [{ marca: null, codigo: null, confianca: "confirmado|familia|nulo" }],
    cc_importadores: [{ marca: null, codigo: null, confianca: "confirmado|familia|nulo" }]
  },
  lg: {
    linhagem: { valor: null, confianca: "confirmado|familia|nulo", fontes: [] }
  },
  fi_fp: {
    peso_bruto: null, peso_liquido: null,
    comprimento: null, largura: null, altura: null
  }
};

// ─────────────────────────────────────────────────────────────
// CAMPOS LEGADO — backward compat com auto-enrich.js
// ─────────────────────────────────────────────────────────────
const CAMPOS_DNA = [
  'codigo_oem', 'ean', 'ncm', 'cest', 'motor', 'codigo_motor',
  'marca_veiculo', 'modelo_veiculo', 'versao_veiculo', 'ano_inicial', 'ano_final',
  'cilindrada', 'material', 'posicao', 'fmsi', 'comprimento', 'largura', 'altura',
  'cross_codes', 'aplicacoes_adicionais',
  'funcao_tecnica', 'boletins', 'substituicoes',
  'fabricante_original', 'montadora',
  'cc_oem', 'cc_importadores', 'peso_bruto', 'peso_liquido'
];

function camposVazios() {
  const vazio = {};
  CAMPOS_DNA.forEach(c => {
    vazio[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte nao encontrada' };
  });
  return vazio;
}

// ─────────────────────────────────────────────────────────────
// BRIDGE: schema canônico → CAMPOS_DNA legado
// ─────────────────────────────────────────────────────────────
function canonParaLegado(can) {
  if (!can) return camposVazios();
  const CONF_MAP = { confirmado: 'alta', familia: 'media', nulo: 'baixa' };
  const g  = (f) => (f && f.confianca !== 'nulo' && f.valor != null) ? f.valor : null;
  const gc = (f) => CONF_MAP[f?.confianca] || 'baixa';
  const gf = (f) => (Array.isArray(f?.fontes) && f.fontes.length) ? f.fontes[0] : null;
  const av0     = Array.isArray(can.av?.aplicacoes) ? can.av.aplicacoes[0] : null;
  const avConf  = av0?.confianca || 'nulo';
  const avFonte = (Array.isArray(av0?.fontes) && av0.fontes.length) ? av0.fontes[0] : null;
  const avRest = Array.isArray(can.av?.aplicacoes) && can.av.aplicacoes.length > 1
    ? can.av.aplicacoes.slice(1)
        .map(a => [a.montadora, a.modelo, a.motor, a.cilindrada,
                   (a.ano_inicial && a.ano_final) ? `${a.ano_inicial}-${a.ano_final}` : a.ano_inicial
                  ].filter(Boolean).join(' '))
        .join('\n')
    : null;
  const ccOemArr  = (can.cc?.cc_oem || []).filter(c => c && c.codigo).map(c => `${c.marca || ''} ${c.codigo}`.trim());
  const ccAmArr   = (can.cc?.cc_aftermarket || []).filter(c => c && c.codigo).map(c => `${c.marca || ''} ${c.codigo}`.trim());
  const ccImArr   = (can.cc?.cc_importadores || []).filter(c => c && c.codigo).map(c => `${c.marca || ''} ${c.codigo}`.trim());
  const mk = (valor, confiancaKey, fonte) => ({ valor, fonte, confianca: CONF_MAP[confiancaKey] || 'baixa', motivo: null });
  const mkAv = (valor) => mk(valor, avConf, avFonte);
  return {
    codigo_oem:            mk(g(can.dna?.codigo_oem),         can.dna?.codigo_oem?.confianca,          gf(can.dna?.codigo_oem)),
    ean:                   mk(g(can.dna?.ean),                 can.dna?.ean?.confianca,                 gf(can.dna?.ean)),
    ncm:                   mk(g(can.co?.ncm),                  can.co?.ncm?.confianca,                  gf(can.co?.ncm)),
    cest:                  mk(g(can.co?.cest),                 can.co?.cest?.confianca,                 gf(can.co?.cest)),
    motor:                 mkAv(av0?.motor        || null),
    codigo_motor:          mk(null, 'nulo', null),
    marca_veiculo:         mkAv(av0?.montadora    || null),
    modelo_veiculo:        mkAv(av0?.modelo       || null),
    versao_veiculo:        mk(null, 'nulo', null),
    ano_inicial:           mkAv(av0?.ano_inicial  || null),
    ano_final:             mkAv(av0?.ano_final    || null),
    cilindrada:            mkAv(av0?.cilindrada   || null),
    material:              mk(g(can.mc?.material),            can.mc?.material?.confianca,             gf(can.mc?.material)),
    posicao:               mk(null, 'nulo', null),
    fmsi:                  mk(null, 'nulo', null),
    comprimento:           mk(can.fi_fp?.comprimento || null, 'familia', null),
    largura:               mk(can.fi_fp?.largura     || null, 'familia', null),
    altura:                mk(can.fi_fp?.altura      || null, 'familia', null),
    cross_codes:           { valor: ccAmArr.length ? ccAmArr : null, fonte: null, confianca: 'media', motivo: null },
    aplicacoes_adicionais: { valor: avRest,                         fonte: null, confianca: 'media', motivo: null },
    funcao_tecnica:        mk(g(can.fm?.funcao_tecnica),       can.fm?.funcao_tecnica?.confianca,       gf(can.fm?.funcao_tecnica)),
    boletins:              { valor: (can.bta?.boletins?.length    ? can.bta.boletins    : null), fonte: null, confianca: 'media', motivo: null },
    substituicoes:         { valor: (can.bta?.substituicoes?.length ? can.bta.substituicoes : null), fonte: null, confianca: 'media', motivo: null },
    fabricante_original:   mk(g(can.dna?.fabricante_original), can.dna?.fabricante_original?.confianca, gf(can.dna?.fabricante_original)),
    montadora:             mkAv(av0?.montadora    || null),
    cc_oem:                { valor: ccOemArr.length ? ccOemArr : null, fonte: null, confianca: 'media', motivo: null },
    cc_importadores:       { valor: ccImArr.length  ? ccImArr  : null, fonte: null, confianca: 'media', motivo: null },
    peso_bruto:            mk(can.fi_fp?.peso_bruto   || null, 'familia', null),
    peso_liquido:          mk(can.fi_fp?.peso_liquido || null, 'familia', null),
  };
}

// ─────────────────────────────────────────────────────────────
// WEB SEARCH — Brave (primário) + SERPER (fallback)
// ─────────────────────────────────────────────────────────────
function httpsJSON(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('Timeout busca')));
    if (body) req.write(body);
    req.end();
  });
}

async function buscarBrave(q, num = 10) {
  if (!process.env.BRAVE_API_KEY) return [];
  try {
    const encoded = encodeURIComponent(q);
    const count = Math.min(num, 20);
    const data = await httpsJSON({
      hostname: 'api.search.brave.com',
      path: '/res/v1/web/search' + '?' + 'q=' + encoded + '&count=' + count + '&search_lang=pt-br&country=br',
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY }
    });
    if (data.type === 'ErrorResponse') { console.error('[DNA] Brave erro:', data.message); return []; }
    return (data.web?.results || []).slice(0, num).filter(i => i.title && i.description).map(i => ({ titulo: i.title, fonte: i.url, trecho: i.description }));
  } catch (e) { console.error('[DNA] Brave:', e.message); return []; }
}

async function buscarSerper(q, num = 10) {
  if (!process.env.SERPER_API_KEY) return [];
  try {
    const body = JSON.stringify({ q, num, gl: 'br', hl: 'pt-br' });
    const data = await httpsJSON({
      hostname: 'google.serper.dev', path: '/search', method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, body);
    return (data.organic || []).slice(0, num).filter(i => i.title && i.snippet).map(i => ({ titulo: i.title, fonte: i.link, trecho: i.snippet }));
  } catch (e) { console.error('[DNA] SERPER:', e.message); return []; }
}

async function buscarWeb(q, num = 10) {
  const r = await buscarBrave(q, num);
  if (r.length > 0) return r;
  return buscarSerper(q, num);
}

async function buscarMultiQuery({ fabricante, sku, nome, numResultados = 12 }) {
  const base = [fabricante, sku, nome].filter(Boolean).join(' ');
  const queries = [
    base + ' especificacoes tecnicas ficha tecnica autopecas material posicao dimensoes',
    base + ' NCM CEST EAN codigo fiscal classificacao tributaria autopecas Brasil',
    base + ' aplicacao veicular compatibilidade motor cilindrada ano montadora caminhao',
    base + ' codigo OEM equivalente substituicao cross reference fabricante original'
  ];
  const allResults = []; const seenUrls = new Set();
  const resultSets = await Promise.allSettled(queries.map(q => buscarWeb(q, numResultados)));
  for (const result of resultSets) {
    if (result.status !== 'fulfilled') continue;
    for (const r of result.value) {
      if (r.fonte && !seenUrls.has(r.fonte)) { seenUrls.add(r.fonte); allResults.push(r); }
    }
  }
  console.log('[DNA] Multi-query: ' + queries.length + ' buscas, ' + allResults.length + ' resultados únicos');
  return allResults;
}

// ─────────────────────────────────────────────────────────────
// AGENTE PRINCIPAL — DNA OEM 360 com Regra Canônica NTC 4.0
// ─────────────────────────────────────────────────────────────
async function enriquecerDnaViaWeb({ sku, fabricante, nome, nivel_busca }) {
  if (!sku && !nome) return { ok: false, erro: 'SKU ou Nome obrigatorio', campos: camposVazios(), pendente_confirmacao: true };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, erro: 'ANTHROPIC_API_KEY nao configurada', campos: camposVazios(), pendente_confirmacao: true };
  const numResultados = nivel_busca === 'agressivo' ? 20 : nivel_busca === 'discreto' ? 5 : 12;
  const maxTokens    = nivel_busca === 'agressivo' ? 4000 : nivel_busca === 'discreto' ? 1500 : 2500;
  let trechos = [];
  try { trechos = await buscarMultiQuery({ fabricante, sku, nome, numResultados }); }
  catch (e) { console.error('[DNA Enricher] busca:', e.message); }
  if (trechos.length === 0) return { ok: true, encontrado: false, campos: camposVazios(), fontes_consultadas: [], campos_preenchidos: 0, pendente_confirmacao: true, mensagem: 'Sem resultados de busca.' };
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const codigoEntrada = sku || nome || 'desconhecido';
    const termoBase = [fabricante, sku, nome].filter(Boolean).join(' ');
    const system = 'Você é o agente "DNA OEM 360" do sistema Genesis Indexa 360 IA — um motor de\n' +
      'cadastro técnico certificado (NTC Engine 4.0) para peças automotivas.\n\n' +
      'Sua única função é: analisar os resultados de busca fornecidos sobre um produto\n' +
      'e devolver um JSON estruturado com os dados técnicos REAIS encontrados nesses resultados.\n\n' +
      NTC_CANONICAL_RULES +
      '\nESQUEMA DE SAÍDA OBRIGATÓRIO (retorne SOMENTE este JSON preenchido, sem markdown):\n' +
      JSON.stringify(NTC_OUTPUT_SCHEMA, null, 2);
    const userContent = 'CÓDIGO DE ENTRADA: ' + codigoEntrada + '\n' +
      'PRODUTO: ' + termoBase + '\n\n' +
      'Resultados de busca (' + trechos.length + ' fontes):\n' +
      trechos.map((t, i) => '[' + (i+1) + '] Título: ' + t.titulo + '\nURL: ' + t.fonte + '\nTrecho: ' + t.trecho).join('\n\n');
    const msg = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system, messages: [{ role: 'user', content: userContent }] });
    const rawText = msg.content?.[0]?.text || '{}';
    let canonico;
    try {
      const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      canonico = JSON.parse(m ? m[0] : cleaned);
    } catch (e) { console.error('[DNA] parse JSON IA:', e.message); canonico = {}; }
    if (!canonico.codigo_entrada) canonico.codigo_entrada = codigoEntrada;
    if (canonico.dna?.ean?.valor != null) {
      const s = String(canonico.dna.ean.valor).replace(/\D/g, '');
      if (!validarGTIN(s)) canonico.dna.ean = { valor: null, confianca: 'nulo', fontes: [], _rebaixado: 'GTIN inválido' };
      else canonico.dna.ean.valor = s;
    }
    if (canonico.co?.ncm?.valor != null) {
      const limpo = validarNCM(canonico.co.ncm.valor);
      if (!limpo) canonico.co.ncm = { valor: null, confianca: 'nulo', fontes: [], _rebaixado: 'NCM inválido' };
      else {
        canonico.co.ncm.valor = limpo;
        try { const desc = await consultarNCMOficial(limpo); if (desc) { canonico.co.ncm.confianca = 'confirmado'; canonico.co.ncm._ncm_tipi = desc; } } catch (_) {}
      }
    }
    if (Array.isArray(canonico.av?.aplicacoes)) {
      for (const ap of canonico.av.aplicacoes) {
        for (const campo of ['ano_inicial', 'ano_final']) {
          if (ap[campo] != null && ap[campo] !== 'atual') { const n = parseInt(ap[campo], 10); ap[campo] = (!isNaN(n) && n >= 1950 && n <= 2035) ? n : null; }
        }
      }
    }
    const camposLegado = canonParaLegado(canonico);
    const campos_preenchidos = CAMPOS_DNA.filter(c => camposLegado[c]?.valor != null).length;
    const encontrado = campos_preenchidos > 0;
    console.log('[DNA] Resultado canônico: ' + campos_preenchidos + '/' + CAMPOS_DNA.length + ' campos');
    return { ok: true, encontrado, campos: camposLegado, campos_canonico: canonico, fontes_consultadas: trechos.map(t => t.fonte), campos_preenchidos, total_campos: CAMPOS_DNA.length, pendente_confirmacao: true };
  } catch (e) {
    console.error('[DNA Enricher] IA:', e.message);
    return { ok: false, erro: e.message, campos: camposVazios(), pendente_confirmacao: true };
  }
}

module.exports = { enriquecerDnaViaWeb, CAMPOS_DNA, camposVazios, buscarWeb, canonParaLegado };
