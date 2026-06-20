'use strict';

// Agente DNA — Claude Haiku 4.5 | Busca: Brave (primário) > SERPER (fallback)
// NUNCA inventa: sem fonte, campo retorna null com confiança "baixa".
const https = require('https');
const { validarGTIN, validarNCM, consultarNCMOficial } = require('./web-utils');

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
  CAMPOS_DNA.forEach(c => { vazio[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte não encontrada' }; });
  return vazio;
}

function httpsJSON(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON: ' + e.message)); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function buscarBrave(q, num) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return { resultados: [], erro: 'BRAVE_API_KEY nao configurada' };
  try {
    const encoded = encodeURIComponent(q);
    const data = await httpsJSON({
      hostname: 'api.search.brave.com',
      path: '/res/v1/web/search?q=' + encoded + '&count=' + num + '&country=br&search_lang=pt-br&safesearch=off',
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': key }
    });
    if (data.type === 'ErrorResponse' || (!data.web && data.message)) {
      const msg = data.message || JSON.stringify(data);
      console.error('[DNA] Brave erro:', msg);
      return { resultados: [], erro: 'Brave: ' + msg };
    }
    const resultados = (data.web?.results || []).slice(0, num)
      .filter(r => r.title && r.description)
      .map(r => ({ titulo: r.title, fonte: r.url, trecho: r.description }));
    return { resultados, erro: null };
  } catch (e) {
    console.error('[DNA] Brave:', e.message);
    return { resultados: [], erro: 'Brave: ' + e.message };
  }
}

async function buscarSerper(q, num) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { resultados: [], erro: 'SERPER_API_KEY nao configurada' };
  try {
    const body = JSON.stringify({ q, num, gl: 'br', hl: 'pt-br' });
    const data = await httpsJSON({
      hostname: 'google.serper.dev', path: '/search', method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, body);
    if (!data.organic && (data.message || data.error)) {
      const msg = data.message || data.error;
      console.error('[DNA] SERPER erro:', msg);
      return { resultados: [], erro: 'SERPER: ' + msg };
    }
    const resultados = (data.organic || []).slice(0, num)
      .filter(i => i.title && i.snippet)
      .map(i => ({ titulo: i.title, fonte: i.link, trecho: i.snippet }));
    return { resultados, erro: null };
  } catch (e) {
    console.error('[DNA] SERPER:', e.message);
    return { resultados: [], erro: 'SERPER: ' + e.message };
  }
}

async function buscarWeb(q, num) {
  if (process.env.BRAVE_API_KEY) return buscarBrave(q, Math.min(num, 10));
  if (process.env.SERPER_API_KEY) return buscarSerper(q, num);
  return { resultados: [], erro: 'Nenhuma API de busca configurada' };
}

async function enriquecerDnaViaWeb({ sku, fabricante, nome }) {
  if (!sku && !nome) return { ok: false, erro: 'SKU ou Nome obrigatorio', campos: camposVazios(), pendente_confirmacao: true };
  const vazio = camposVazios();
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, erro: 'ANTHROPIC_API_KEY nao configurada', campos: vazio, pendente_confirmacao: true };

  const termoBase = [fabricante, sku, nome].filter(Boolean).join(' ');
  let trechos = [], buscaErro = null;
  try { const b = await buscarWeb(termoBase, 12); trechos = b.resultados; buscaErro = b.erro; }
  catch (e) { console.error('[DNA]', e.message); }

  if (trechos.length === 0) {
    return { ok: true, encontrado: false, campos: vazio, fontes_consultadas: [], pendente_confirmacao: true,
      mensagem: buscaErro ? 'Busca indisponivel: ' + buscaErro : 'Sem resultados: ' + termoBase,
      debug_busca: buscaErro };
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const system = `Voce e especialista tecnico e fiscal em autopecas. Recebe dados de produto + resultados de busca numerados.
Para CADA campo retorne {"valor":...,"fonte_idx":N,"confianca":"alta"|"media"|"baixa","motivo":"..."}.
Campos: codigo_oem, ean, ncm, cest, motor, codigo_motor, marca_veiculo, modelo_veiculo, versao_veiculo, ano_inicial, ano_final, cilindrada, material, posicao, fmsi, comprimento, largura, altura, cross_codes, aplicacoes_adicionais, funcao_tecnica, boletins, substituicoes, fabricante_original, montadora, cc_oem, cc_importadores, peso_bruto, peso_liquido.
REGRAS: 1)NUNCA invente. 2)Sem evidencia: null. 3)fonte_idx=N. 4)Nao use fabricante de pecas em marca_veiculo/montadora. 5)JSON puro sem markdown.`;
    const userContent = `Produto: ${termoBase}\n\nResultados:\n` +
      trechos.map((t, i) => `${i+1}. ${t.titulo}\n${t.trecho}\nFonte: ${t.fonte}`).join('\n\n');
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system,
      messages: [{ role: 'user', content: userContent }]
    });
    const texto = msg.content?.[0]?.text || '{}';
    let bruto;
    try { const m = texto.match(/\{[\s\S]*\}/); bruto = JSON.parse(m ? m[0] : texto); } catch (e) { bruto = {}; }
    const campos = {};
    CAMPOS_DNA.forEach(c => {
      const item = bruto[c];
      if (!item || item.valor == null || item.valor === '') { campos[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte nao encontrada' }; return; }
      let valor = item.valor;
      const idx = Number(item.fonte_idx);
      const fonte = (idx >= 1 && idx <= trechos.length) ? trechos[idx-1].fonte : null;
      let confianca = ['alta','media','baixa'].includes(item.confianca) ? item.confianca : 'media';
      let motivo = typeof item.motivo === 'string' ? item.motivo.trim() : null;
      if (c === 'ean' && !validarGTIN(valor)) { valor = null; confianca = 'baixa'; motivo = 'GTIN invalido'; }
      if (c === 'ncm') { const l = validarNCM(valor); if (!l) { confianca = 'baixa'; motivo = 'NCM invalido'; } else valor = l; }
      campos[c] = { valor, fonte, confianca, motivo };
    });
    if (campos.ncm?.valor) {
      const desc = await consultarNCMOficial(campos.ncm.valor);
      campos.ncm.confianca = desc ? 'alta' : 'baixa';
      campos.ncm.motivo = desc ? 'confirmado TIPI: ' + desc : 'NCM nao encontrado na TIPI';
    }
    const encontrado = CAMPOS_DNA.some(c => campos[c]?.valor != null);
    return { ok: true, encontrado, campos, fontes_consultadas: trechos.map(t => t.fonte), pendente_confirmacao: true };
  } catch (e) {
    console.error('[DNA] IA:', e.message);
    return { ok: false, erro: e.message, campos: vazio, pendente_confirmacao: true };
  }
}

module.exports = { enriquecerDnaViaWeb, CAMPOS_DNA, camposVazios };
