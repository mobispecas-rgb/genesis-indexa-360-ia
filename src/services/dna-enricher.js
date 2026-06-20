'use strict';

// Agente de Enriquecimento de DNA via Web — Claude Haiku 4.5 + SERPER
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

async function buscarWeb(q, num = 12) {
  if (!process.env.SERPER_API_KEY) return [];
  try {
    const body = JSON.stringify({ q, num, gl: 'br', hl: 'pt-br' });
    const data = await httpsJSON({
      hostname: 'google.serper.dev', path: '/search', method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, body);
    return (data.organic || []).slice(0, num)
      .filter(i => i.title && i.snippet)
      .map(i => ({ titulo: i.title, fonte: i.link, trecho: i.snippet }));
  } catch (e) {
    console.error('[DNA Enricher] busca:', e.message);
    return [];
  }
}

async function enriquecerDnaViaWeb({ sku, fabricante, nome }) {
  if (!sku && !nome) return { ok: false, erro: 'SKU ou Nome obrigatório', campos: camposVazios(), pendente_confirmacao: true };
  const vazio = camposVazios();
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, erro: 'ANTHROPIC_API_KEY não configurada', campos: vazio, pendente_confirmacao: true };

  const termoBase = [fabricante, sku, nome].filter(Boolean).join(' ');
  let trechos = [];
  try { trechos = await buscarWeb(termoBase, 12); } catch (e) { console.error('[DNA Enricher]', e.message); }

  if (trechos.length === 0) {
    return { ok: true, encontrado: false, campos: vazio, fontes_consultadas: [], pendente_confirmacao: true, mensagem: 'Sem resultados de busca.' };
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const system = `Você é especialista técnico e fiscal em autopeças. Recebe dados de produto + resultados de busca numerados.
Para CADA campo, retorne {"valor":...,"fonte_idx":N,"confianca":"alta"|"media"|"baixa","motivo":"..."}.
Campos: codigo_oem, ean, ncm, cest, motor, codigo_motor, marca_veiculo, modelo_veiculo, versao_veiculo, ano_inicial, ano_final, cilindrada, material, posicao, fmsi, comprimento, largura, altura, cross_codes, aplicacoes_adicionais, funcao_tecnica, boletins, substituicoes, fabricante_original, montadora, cc_oem, cc_importadores, peso_bruto, peso_liquido.
REGRAS: 1)NUNCA invente. 2)Sem evidência: null. 3)fonte_idx=N do resultado. 4)Não use fabricante de peças em marca_veiculo/montadora. 5)JSON puro sem markdown.`;

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
      if (!item || item.valor == null || item.valor === '') { campos[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte não encontrada' }; return; }
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
