'use strict';

// Agente de Enriquecimento DNA — Motor NTC 4.0
// Estrategia multi-query: 4 buscas targetadas para maximizar cobertura dos 28 CAMPOS_DNA
// Brave Search (primario) -> SERPER (fallback)
// NUNCA inventa: sem fonte, campo retorna null
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
  CAMPOS_DNA.forEach(c => {
    vazio[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte nao encontrada' };
  });
  return vazio;
}

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

// -- Brave Search (primario) --
async function buscarBrave(q, num = 10) {
  if (!process.env.BRAVE_API_KEY) return [];
  try {
    const encoded = encodeURIComponent(q);
    const count = Math.min(num, 20);
    const data = await httpsJSON({
      hostname: 'api.search.brave.com',
      path: `/res/v1/web/search?q=${encoded}&count=${count}&search_lang=pt-br&country=br`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': process.env.BRAVE_API_KEY
      }
    });
    if (data.type === 'ErrorResponse') {
      console.error('[DNA] Brave erro:', data.message);
      return [];
    }
    return (data.web?.results || [])
      .slice(0, num)
      .filter(i => i.title && i.description)
      .map(i => ({ titulo: i.title, fonte: i.url, trecho: i.description }));
  } catch (e) {
    console.error('[DNA] Brave:', e.message);
    return [];
  }
}

// -- SERPER (fallback) --
async function buscarSerper(q, num = 10) {
  if (!process.env.SERPER_API_KEY) return [];
  try {
    const body = JSON.stringify({ q, num, gl: 'br', hl: 'pt-br' });
    const data = await httpsJSON({
      hostname: 'google.serper.dev',
      path: '/search',
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);
    return (data.organic || [])
      .slice(0, num)
      .filter(i => i.title && i.snippet)
      .map(i => ({ titulo: i.title, fonte: i.link, trecho: i.snippet }));
  } catch (e) {
    console.error('[DNA] SERPER:', e.message);
    return [];
  }
}

// -- buscarWeb: Brave primeiro, SERPER se vazio --
async function buscarWeb(q, num = 10) {
  const r = await buscarBrave(q, num);
  if (r.length > 0) return r;
  return buscarSerper(q, num);
}

// -- Multi-query: 4 buscas paralelas targetadas --
async function buscarMultiQuery({ fabricante, sku, nome }) {
  const base = [fabricante, sku, nome].filter(Boolean).join(' ');

  const queries = [
    base + ' especificacoes tecnicas ficha tecnica autopecas material posicao dimensoes',
    base + ' NCM CEST EAN codigo fiscal classificacao tributaria autopecas Brasil',
    base + ' aplicacao veicular compatibilidade motor cilindrada ano montadora caminhao',
    base + ' codigo OEM equivalente substituicao cross reference fabricante original'
  ];

  const allResults = [];
  const seenUrls = new Set();

  const resultSets = await Promise.allSettled(queries.map(q => buscarWeb(q, 8)));

  for (const result of resultSets) {
    if (result.status !== 'fulfilled') continue;
    for (const r of result.value) {
      if (r.fonte && !seenUrls.has(r.fonte)) {
        seenUrls.add(r.fonte);
        allResults.push(r);
      }
    }
  }

  console.log('[DNA] Multi-query: ' + queries.length + ' buscas -> ' + allResults.length + ' resultados unicos');
  return allResults;
}

// -- Enriquecimento principal --
async function enriquecerDnaViaWeb({ sku, fabricante, nome }) {
  if (!sku && !nome) {
    return { ok: false, erro: 'SKU ou Nome obrigatorio', campos: camposVazios(), pendente_confirmacao: true };
  }
  const vazio = camposVazios();
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, erro: 'ANTHROPIC_API_KEY nao configurada', campos: vazio, pendente_confirmacao: true };
  }

  let trechos = [];
  try {
    trechos = await buscarMultiQuery({ fabricante, sku, nome });
  } catch (e) {
    console.error('[DNA Enricher] busca:', e.message);
  }

  if (trechos.length === 0) {
    return {
      ok: true, encontrado: false, campos: vazio,
      fontes_consultadas: [], campos_preenchidos: 0,
      pendente_confirmacao: true, mensagem: 'Sem resultados de busca.'
    };
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const termoBase = [fabricante, sku, nome].filter(Boolean).join(' ');

    const system = `Voce e especialista tecnico e fiscal em autopecas brasileiras (caminhoes, vans, utilitarios diesel).
Recebe resultados de MULTIPLAS buscas sobre um produto e deve preencher TODOS os campos abaixo.

Para CADA campo, retorne um objeto com: {"valor":...,"fonte_idx":N,"confianca":"alta"|"media"|"baixa","motivo":"..."}
fonte_idx = numero do resultado [N] onde encontrou a informacao. Se nao encontrou: valor=null, fonte_idx=null.

CAMPOS (preencha TODOS que encontrar evidencia):
- codigo_oem: codigo original do fabricante OEM (ex: "83803-03030", "21010-58T00")
- ean: codigo de barras EAN-13 (exatamente 13 digitos numericos)
- ncm: codigo NCM 8 digitos para classificacao fiscal brasileira
- cest: codigo CEST 7 digitos para substituicao tributaria
- motor: nome/codigo do motor do veiculo (ex: "4D56", "MWM X10", "2.8 TDI")
- codigo_motor: codigo alfanumerico do motor (ex: "AJ", "XUD11")
- marca_veiculo: MARCA DO VEICULO, nao da peca (Ford, GM, VW, Fiat, Mercedes, Iveco, etc.)
- modelo_veiculo: MODELO DO VEICULO (S10, Ranger, Transit, Sprinter, Daily, etc.)
- versao_veiculo: versao ou acabamento do veiculo (ex: "XLT 4x4", "2.5 TD Pick-up")
- ano_inicial: primeiro ano de aplicacao (numero inteiro, ex: 2008)
- ano_final: ultimo ano de aplicacao (numero inteiro ou string "atual")
- cilindrada: cilindrada em cc ou litros (ex: 2800, "2.8")
- material: material principal da peca (aco, aluminio, borracha, ferro fundido, etc.)
- posicao: posicao de montagem (dianteiro, traseiro, direito, esquerdo, superior, etc.)
- fmsi: codigo FMSI ou WVA (para pastilhas/lonas de freio, ex: "D1012")
- comprimento: comprimento em mm (numero)
- largura: largura em mm (numero)
- altura: altura em mm (numero)
- cross_codes: ARRAY de codigos equivalentes de outras marcas ["MANN W940/25", "FRAM PH3614"]
- aplicacoes_adicionais: outros veiculos compativeis alem do principal
- funcao_tecnica: funcao tecnica da peca (ex: "veda o cilindro contra vazamento de gases")
- boletins: boletins tecnicos ou service bulletins (ex: "TSB 123/2015")
- substituicoes: codigos antigos que esta peca substitui
- fabricante_original: fabricante OEM da peca (LuK, Sachs, Bosch, Mahle, etc.)
- montadora: empresa montadora do veiculo (Ford Motor Company, GM do Brasil, etc.)
- cc_oem: codigo do concorrente OEM direto
- cc_importadores: codigos usados por importadores/distribuidores
- peso_bruto: peso bruto em kg com embalagem (numero decimal)
- peso_liquido: peso liquido em kg sem embalagem (numero decimal)

REGRAS NTC — OBRIGATORIAS:
1. NUNCA invente. Sem evidencia explicita no texto = null. Confianca deve refletir a certeza real.
2. marca_veiculo e montadora = marca do VEICULO, NUNCA da peca
3. EAN: apenas se houver 13 digitos numericos explicitos no texto
4. NCM: apenas se houver 8 digitos explicitos; formato sem pontos (ex: "84099900")
5. Retorne JSON puro sem markdown, sem blocos de codigo, sem texto adicional`;

    const userContent = 'Produto: ' + termoBase + '\n\nResultados de busca (' + trechos.length + ' fontes):\n' +
      trechos.map((t, i) => '[' + (i + 1) + '] ' + t.titulo + '\n' + t.trecho + '\nURL: ' + t.fonte).join('\n\n');

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3500,
      system,
      messages: [{ role: 'user', content: userContent }]
    });

    const texto = msg.content?.[0]?.text || '{}';
    let bruto;
    try {
      const m = texto.match(/\{[\s\S]*\}/);
      bruto = JSON.parse(m ? m[0] : texto);
    } catch (e) {
      console.error('[DNA] parse JSON IA:', e.message, '| raw:', texto.substring(0, 200));
      bruto = {};
    }

    const campos = {};
    CAMPOS_DNA.forEach(c => {
      const item = bruto[c];
      if (!item || item.valor == null || item.valor === '') {
        campos[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte nao encontrada' };
        return;
      }
      let valor = item.valor;
      const idx = Number(item.fonte_idx);
      const fonte = (idx >= 1 && idx <= trechos.length) ? trechos[idx - 1].fonte : null;
      let confianca = ['alta', 'media', 'baixa'].includes(item.confianca) ? item.confianca : 'media';
      let motivo = typeof item.motivo === 'string' ? item.motivo.trim() : null;

      if (c === 'ean') {
        const s = String(valor).replace(/\D/g, '');
        if (!validarGTIN(s)) { valor = null; confianca = 'baixa'; motivo = 'GTIN invalido (checksum)'; }
        else valor = s;
      }
      if (c === 'ncm') {
        const limpo = validarNCM(valor);
        if (!limpo) { confianca = 'baixa'; motivo = 'NCM invalido'; }
        else valor = limpo;
      }
      if ((c === 'ano_inicial' || c === 'ano_final') && valor !== 'atual') {
        const n = parseInt(valor, 10);
        if (isNaN(n) || n < 1950 || n > 2035) { valor = null; confianca = 'baixa'; motivo = 'ano fora do intervalo valido'; }
        else valor = n;
      }
      if ((c === 'peso_bruto' || c === 'peso_liquido') && valor !== null) {
        const n = parseFloat(String(valor).replace(',', '.'));
        valor = isNaN(n) ? null : n;
      }
      if (c === 'cross_codes' && !Array.isArray(valor)) {
        valor = typeof valor === 'string' ? [valor] : null;
      }

      campos[c] = { valor, fonte, confianca, motivo };
    });

    if (campos.ncm?.valor) {
      try {
        const desc = await consultarNCMOficial(campos.ncm.valor);
        campos.ncm.confianca = desc ? 'alta' : 'baixa';
        campos.ncm.motivo = desc ? 'confirmado na TIPI: ' + desc : 'NCM nao encontrado na TIPI';
      } catch (_) { /* ignora */ }
    }

    const encontrado = CAMPOS_DNA.some(c => campos[c]?.valor != null);
    const campos_preenchidos = CAMPOS_DNA.filter(c => campos[c]?.valor != null).length;

    console.log('[DNA] Resultado: ' + campos_preenchidos + '/' + CAMPOS_DNA.length + ' campos preenchidos');

    return {
      ok: true,
      encontrado,
      campos,
      fontes_consultadas: trechos.map(t => t.fonte),
      campos_preenchidos,
      total_campos: CAMPOS_DNA.length,
      pendente_confirmacao: true
    };
  } catch (e) {
    console.error('[DNA Enricher] IA:', e.message);
    return { ok: false, erro: e.message, campos: vazio, pendente_confirmacao: true };
  }
}

module.exports = { enriquecerDnaViaWeb, CAMPOS_DNA, camposVazios, buscarWeb };
