'use strict';

// Agente de Enriquecimento de DNA via Web — Claude Haiku 4.5
// Busca: Brave Search API (grátis $5/mês) com fallback SERPER
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

// Brave Search API — $5 crédito grátis/mês (~1.000 buscas)
async function buscarBrave(q, num = 10) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return { resultados: [], erro: 'BRAVE_API_KEY não configurada' };
  try {
    const encoded = encodeURIComponent(q);
    const data = await httpsJSON({
      hostname: 'api.search.brave.com',
      path: '/res/v1/web/search?q=' + encoded + '&count=' + num + '&country=br&search_lang=pt&safesearch=off',
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': key }
    });
    if (data.type === 'ErrorResponse' || (!data.web && data.message)) {
      const msg = data.message || JSON.stringify(data);
      console.error('[DNA Enricher] Brave erro:', msg);
      return { resultados: [], erro: 'Brave: ' + msg };
    }
    const resultados = (data.web?.results || []).slice(0, num)
      .filter(r => r.title && r.description)
      .map(r => ({ titulo: r.title, fonte: r.url, trecho: r.description }));
    return { resultados, erro: null };
  } catch (e) {
    console.error('[DNA Enricher] Brave:', e.message);
    return { resultados: [], erro: 'Brave: ' + e.message };
  }
}

// SERPER — fallback caso BRAVE_API_KEY não esteja configurada
async function buscarSerper(q, num = 12) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { resultados: [], erro: 'SERPER_API_KEY não configurada' };
  try {
    const body = JSON.stringify({ q, num, gl: 'br', hl: 'pt-br' });
    const data = await httpsJSON({
      hostname: 'google.serper.dev', path: '/search', method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, body);
    if (!data.organic && (data.message || data.error || data.statusCode)) {
      const msg = data.message || data.error || ('HTTP ' + data.statusCode);
      console.error('[DNA Enricher] SERPER erro:', msg);
      return { resultados: [], erro: 'SERPER: ' + msg };
    }
    const resultados = (data.organic || []).slice(0, num)
      .filter(i => i.title && i.snippet)
      .map(i => ({ titulo: i.title, fonte: i.link, trecho: i.snippet }));
    return { resultados, erro: null };
  } catch (e) {
    console.error('[DNA Enricher] SERPER:', e.message);
    return { resultados: [], erro: 'SERPER: ' + e.message };
  }
}

// Seleciona provedor: Brave (primário) > SERPER (fallback)
async function buscarWeb(q, num = 12) {
  if (process.env.BRAVE_API_KEY) return buscarBrave(q, Math.min(num, 10));
  if (process.env.SERPER_API_KEY) return buscarSerper(q, num);
  return { resultados: [], erro: 'Nenhuma API de busca configurada (BRAVE_API_KEY ou SERPER_API_KEY)' };
}

async function enriquecerDnaViaWeb({ sku, fabricante, nome }) {
  if (!sku && !nome) return { ok: false, erro: 'SKU ou Nome obrigatório', campos: camposVazios(), pendente_confirmacao: true };
  const vazio = camposVazios();
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, erro: 'ANTHROPIC_API_KEY não configurada', campos: vazio, pendente_confirmacao: true };

  const termoBase = [fabricante, sku, nome].filter(Boolean).join(' ');
  let trechos = [], buscaErro = null;
  try {
    const busca = await buscarWeb(termoBase, 12);
    trechos = busca.resultados;
    buscaErro = busca.erro;
  } catch (e) { console.error('[DNA Enricher]', e.message); }

  if (trechos.length === 0) {
    const mensagem = buscaErro
      ? 'Busca web indisponível: ' + buscaErro
      : 'Sem resultados de busca para: ' + termoBase;
    return { ok: true, encontrado: false, campos: vazio, fontes_consultadas: [], pendente_confirmacao: true, mensagem, debug_busca: buscaErro };
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const system = `Você é especialista técnico e fiscal em autopeças. Recebe dados de produto + resultados de busca numerados.

Para CADA campo abaixo, retorne {"valor": ..., "fonte_idx": N, "confianca": "alta"|"media"|"baixa", "motivo": "..."}.

Campos obrigatórios (retorne todos):
- codigo_oem, ean, ncm, cest, motor, codigo_motor, marca_veiculo, modelo_veiculo, versao_veiculo
- ano_inicial, ano_final, cilindrada, material, posicao, fmsi, comprimento, largura, altura
- cross_codes (string: "MARCA COD; MARCA COD"), aplicacoes_adicionais (string: uma por linha)
- funcao_tecnica, boletins, substituicoes, fabricante_original, montadora
- cc_oem, cc_importadores, peso_bruto, peso_liquido

REGRAS ABSOLUTAS:
1. NUNCA invente — só use valores EXPLÍCITOS nos resultados de busca.
2. Sem evidência: {"valor": null, "fonte_idx": null, "confianca": "baixa"}.
3. fonte_idx = número do resultado (1..N) de onde extraiu o valor.
4. NUNCA use nome de fabricante de peças (Bosch, NGK, Mahle) em marca_veiculo/montadora.
5. Responda SOMENTE com JSON válido, sem markdown.`;

    const userContent = `Produto: ${termoBase}\n\nResultados:\n` +
      trechos.map((t, i) => `${i+1}. ${t.titulo}\n${t.trecho}\nFonte: ${t.fonte}`).join('\n\n');

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: userContent }]
    });

    const texto = msg.content?.[0]?.text || '{}';
    let bruto;
    try { const m = texto.match(/\{[\s\S]*\}/); bruto = JSON.parse(m ? m[0] : texto); } catch (e) { bruto = {}; }

    const campos = {};
    CAMPOS_DNA.forEach(c => {
      const item = bruto[c];
      if (!item || item.valor == null || item.valor === '') {
        campos[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte não encontrada' };
        return;
      }
      let valor = item.valor;
      const idx = Number(item.fonte_idx);
      const fonte = (idx >= 1 && idx <= trechos.length) ? trechos[idx - 1].fonte : null;
      let confianca = ['alta','media','baixa'].includes(item.confianca) ? item.confianca : 'media';
      let motivo = typeof item.motivo === 'string' ? item.motivo.trim() : null;
      if (c === 'ean' && !validarGTIN(valor)) { valor = null; confianca = 'baixa'; motivo = 'GTIN inválido (checksum)'; }
      if (c === 'ncm') { const limpo = validarNCM(valor); if (!limpo) { confianca = 'baixa'; motivo = 'NCM inválido'; } else valor = limpo; }
      campos[c] = { valor, fonte, confianca, motivo };
    });

    if (campos.ncm?.valor) {
      const desc = await consultarNCMOficial(campos.ncm.valor);
      campos.ncm.confianca = desc ? 'alta' : 'baixa';
      campos.ncm.motivo = desc ? 'confirmado na TIPI: ' + desc : 'NCM não encontrado na TIPI';
    }

    const encontrado = CAMPOS_DNA.some(c => campos[c]?.valor != null);
    return { ok: true, encontrado, campos, fontes_consultadas: trechos.map(t => t.fonte), pendente_confirmacao: true };
  } catch (e) {
    console.error('[DNA Enricher] IA:', e.message);
    return { ok: false, erro: e.message, campos: vazio, pendente_confirmacao: true };
  }
}

module.exports = { enriquecerDnaViaWeb, CAMPOS_DNA, camposVazios };
