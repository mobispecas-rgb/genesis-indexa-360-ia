'use strict';

// ============================================================
// Agente DNA OEM 360 — Motor NTC 4.0  ·  v5.1 (2026-06-20)
// LLM   : Claude Haiku (ANTHROPIC_API_KEY — configurada)
// Busca : Serper → DuckDuckGo HTML (sem chave, gratuito)
// ============================================================
const https = require('https');
const { validarGTIN, validarNCM, consultarNCMOficial, httpsJSON } = require('./web-utils');

// ─────────────────────────────────────────────────────────────
// BUSCA WEB: Serper (primário) → DuckDuckGo HTML (fallback)
// ─────────────────────────────────────────────────────────────
async function buscarSerper(query, num) {
  if (!process.env.SERPER_API_KEY) return [];
  try {
    const body = JSON.stringify({ q: query, num, gl: 'br', hl: 'pt-br' });
    const data = await httpsJSON({
      hostname: 'google.serper.dev', path: '/search', method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, body, 10000);
    return (data.organic || []).filter(i => i.title && i.snippet)
      .map(i => ({ titulo: i.title, fonte: i.link, trecho: i.snippet }));
  } catch (e) {
    console.error('[DNA] Serper:', e.message);
    return [];
  }
}

async function buscarDDG(query, num) {
  return new Promise(resolve => {
    const q = encodeURIComponent(query);
    const opts = {
      hostname: 'html.duckduckgo.com', path: `/html/?q=${q}`, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'text/html', 'Accept-Language': 'pt-BR,pt;q=0.9'
      }
    };
    const req = https.request(opts, res => {
      let html = '';
      res.on('data', d => { if (html.length < 200000) html += d; });
      res.on('end', () => {
        const results = [];
        const blockRe = /<div class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
        let m;
        while ((m = blockRe.exec(html)) !== null && results.length < num) {
          const block = m[1];
          const titleM = block.match(/<a[^>]+class="result__a"[^>]*>([^<]+)<\/a>/i);
          const hrefM  = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/i);
          const snipM  = block.match(/class="result__snippet"[^>]*>([^<]+)/i);
          if (titleM && snipM) {
            let url = hrefM ? hrefM[1] : '';
            if (url.startsWith('//duckduckgo.com/l/?')) {
              const uddg = url.match(/uddg=([^&]+)/);
              if (uddg) url = decodeURIComponent(uddg[1]);
            }
            results.push({ titulo: titleM[1].trim(), fonte: url, trecho: snipM[1].trim() });
          }
        }
        resolve(results);
      });
      res.on('error', () => resolve([]));
    });
    req.on('error', () => resolve([]));
    req.setTimeout(12000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

async function buscarMultiQuery({ fabricante, sku, nome, numResultados = 10 }) {
  const base = [fabricante, sku, nome].filter(Boolean).join(' ');
  const queries = [
    base + ' ficha tecnica especificacoes autopecas',
    base + ' NCM EAN codigo fiscal tributario',
    base + ' aplicacao veicular motor montadora ano',
    base + ' OEM cross reference equivalente substituicao'
  ];
  const seen = new Set(); const all = [];
  for (const q of queries) {
    let res = await buscarSerper(q, numResultados);
    if (res.length === 0) res = await buscarDDG(q, numResultados);
    for (const r of res) {
      if (r.fonte && !seen.has(r.fonte)) { seen.add(r.fonte); all.push(r); }
    }
  }
  console.log(`[DNA v5.1] ${all.length} fontes encontradas`);
  return all;
}

// ─────────────────────────────────────────────────────────────
// REGRAS CANÔNICAS NTC
// ─────────────────────────────────────────────────────────────
const NTC_SYSTEM = `Você é o agente "DNA OEM 360" do Genesis iRollo 360 (NTC Engine 4.0).

REGRAS ABSOLUTAS:
1. NUNCA invente dados sem fonte nos trechos fornecidos. Sem evidência = null.
2. Três níveis: "confirmado" (2+ fontes independentes específicas), "familia" (código vizinho), "nulo" (sem fonte). Home page de marca NUNCA é fonte válida.
3. Código incompleto? status="codigo_incompleto" + variantes_possiveis. Não escolha sufixo.
4. Motor compartilhado entre montadoras? Explique triangulação em mecanismo_triangulacao.
5. fontes[]: URLs EXATAS do dado específico.
6. Saída: SOMENTE o JSON. Sem markdown. Sem texto antes ou depois.`;

const NTC_SCHEMA = `{"codigo_entrada":"<exato>","status":"ok|codigo_incompleto|nao_encontrado","variantes_possiveis":[],"dna":{"fabricante_original":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"codigo_oem":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"codigo_fabricante_normalizado":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"ean":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"categoria_produto":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"fm":{"nome_tecnico_completo":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"funcao_tecnica":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"av":{"aplicacoes":[{"montadora":null,"modelo":null,"motor":null,"ano_inicial":null,"ano_final":null,"cilindrada":null,"confianca":"confirmado|familia|nulo","fontes":[]}],"mecanismo_triangulacao":null},"co":{"ncm":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"cest":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"mc":{"material":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"ec":{"engenharia_detalhe":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"bta":{"boletins":[],"substituicoes":[]},"cc":{"cc_oem":[{"marca":null,"codigo":null,"confianca":"confirmado|familia|nulo"}],"cc_aftermarket":[{"marca":null,"codigo":null,"confianca":"confirmado|familia|nulo"}],"cc_importadores":[{"marca":null,"codigo":null,"confianca":"confirmado|familia|nulo"}]},"lg":{"linhagem":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"fi_fp":{"peso_bruto":null,"peso_liquido":null,"comprimento":null,"largura":null,"altura":null}}`;

const CAMPOS_DNA = [
  'codigo_oem','ean','ncm','cest','motor','codigo_motor',
  'marca_veiculo','modelo_veiculo','versao_veiculo','ano_inicial','ano_final','cilindrada',
  'material','posicao','fmsi','comprimento','largura','altura',
  'cross_codes','aplicacoes_adicionais','funcao_tecnica',
  'boletins','substituicoes','fabricante_original','montadora',
  'cc_oem','cc_importadores','peso_bruto','peso_liquido'
];

function camposVazios() {
  const v = {};
  CAMPOS_DNA.forEach(c => { v[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte nao encontrada' }; });
  return v;
}

function auditarConfianca(campo) {
  if (!campo || campo.confianca !== 'confirmado') return campo;
  const fontes = (campo.fontes || []).filter(f => f && f.startsWith('http'));
  const doms = new Set();
  for (const f of fontes) { try { doms.add(new URL(f).hostname.replace(/^www\./, '')); } catch (_) {} }
  if (doms.size < 2) campo.confianca = 'familia';
  return campo;
}

function auditarCanonicoCompleto(can) {
  if (!can) return can;
  for (const k of Object.keys(can.dna || {})) auditarConfianca(can.dna[k]);
  for (const k of Object.keys(can.fm  || {})) auditarConfianca(can.fm[k]);
  for (const ap of (can.av?.aplicacoes || [])) {
    const doms = new Set();
    for (const f of (ap.fontes || [])) { try { doms.add(new URL(f).hostname.replace(/^www\./, '')); } catch (_) {} }
    if (ap.confianca === 'confirmado' && doms.size < 2) ap.confianca = 'familia';
  }
  for (const sec of [can.co, can.mc, can.ec, can.lg]) {
    if (!sec) continue;
    for (const k of Object.keys(sec)) auditarConfianca(sec[k]);
  }
  return can;
}

function canonParaLegado(can) {
  if (!can) return camposVazios();
  const C  = { confirmado: 'alta', familia: 'media', nulo: 'baixa' };
  const g  = f => (f && f.confianca !== 'nulo' && f.valor != null) ? f.valor : null;
  const gf = f => (Array.isArray(f?.fontes) && f.fontes.length) ? f.fontes[0] : null;
  const av0 = Array.isArray(can.av?.aplicacoes) ? can.av.aplicacoes[0] : null;
  const ac  = av0?.confianca || 'nulo';
  const af  = (Array.isArray(av0?.fontes) && av0.fontes.length) ? av0.fontes[0] : null;
  const avRest = (can.av?.aplicacoes?.length > 1)
    ? can.av.aplicacoes.slice(1).map(a =>
        [a.montadora, a.modelo, a.motor, a.cilindrada,
         (a.ano_inicial && a.ano_final) ? `${a.ano_inicial}-${a.ano_final}` : a.ano_inicial
        ].filter(Boolean).join(' ')
      ).join('\n')
    : null;
  const oe = (can.cc?.cc_oem         || []).filter(c => c?.codigo).map(c => `${c.marca||''} ${c.codigo}`.trim());
  const am = (can.cc?.cc_aftermarket  || []).filter(c => c?.codigo).map(c => `${c.marca||''} ${c.codigo}`.trim());
  const im = (can.cc?.cc_importadores || []).filter(c => c?.codigo).map(c => `${c.marca||''} ${c.codigo}`.trim());
  const mk = (valor, k, f) => ({ valor, fonte: f, confianca: C[k] || 'baixa', motivo: null });
  const ma = v => mk(v, ac, af);
  return {
    codigo_oem:            mk(g(can.dna?.codigo_oem),         can.dna?.codigo_oem?.confianca,         gf(can.dna?.codigo_oem)),
    ean:                   mk(g(can.dna?.ean),                can.dna?.ean?.confianca,                 gf(can.dna?.ean)),
    ncm:                   mk(g(can.co?.ncm),                 can.co?.ncm?.confianca,                  gf(can.co?.ncm)),
    cest:                  mk(g(can.co?.cest),                can.co?.cest?.confianca,                 gf(can.co?.cest)),
    motor:                 ma(av0?.motor      || null),
    codigo_motor:          mk(null, 'nulo', null),
    marca_veiculo:         ma(av0?.montadora  || null),
    modelo_veiculo:        ma(av0?.modelo     || null),
    versao_veiculo:        mk(null, 'nulo', null),
    ano_inicial:           ma(av0?.ano_inicial || null),
    ano_final:             ma(av0?.ano_final   || null),
    cilindrada:            ma(av0?.cilindrada  || null),
    material:              mk(g(can.mc?.material),             can.mc?.material?.confianca,             gf(can.mc?.material)),
    posicao:               mk(null, 'nulo', null),
    fmsi:                  mk(null, 'nulo', null),
    comprimento:           mk(can.fi_fp?.comprimento || null, 'familia', null),
    largura:               mk(can.fi_fp?.largura     || null, 'familia', null),
    altura:                mk(can.fi_fp?.altura      || null, 'familia', null),
    cross_codes:           { valor: am.length ? am : null,  fonte: null, confianca: 'media', motivo: null },
    aplicacoes_adicionais: { valor: avRest,                 fonte: null, confianca: 'media', motivo: null },
    funcao_tecnica:        mk(g(can.fm?.funcao_tecnica),       can.fm?.funcao_tecnica?.confianca,       gf(can.fm?.funcao_tecnica)),
    boletins:              { valor: can.bta?.boletins?.length    ? can.bta.boletins    : null, fonte: null, confianca: 'media', motivo: null },
    substituicoes:         { valor: can.bta?.substituicoes?.length ? can.bta.substituicoes : null, fonte: null, confianca: 'media', motivo: null },
    fabricante_original:   mk(g(can.dna?.fabricante_original), can.dna?.fabricante_original?.confianca, gf(can.dna?.fabricante_original)),
    montadora:             ma(av0?.montadora || null),
    cc_oem:                { valor: oe.length ? oe : null, fonte: null, confianca: 'media', motivo: null },
    cc_importadores:       { valor: im.length ? im : null, fonte: null, confianca: 'media', motivo: null },
    peso_bruto:            mk(can.fi_fp?.peso_bruto   || null, 'familia', null),
    peso_liquido:          mk(can.fi_fp?.peso_liquido || null, 'familia', null),
  };
}

// ─────────────────────────────────────────────────────────────
// AGENTE PRINCIPAL — Claude Haiku + busca web (Serper/DDG)
// ─────────────────────────────────────────────────────────────
async function enriquecerDnaViaWeb({ sku, fabricante, nome, nivel_busca }) {
  if (!sku && !nome) return { ok: false, erro: 'SKU ou Nome obrigatorio', campos: camposVazios(), pendente_confirmacao: true };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, erro: 'ANTHROPIC_API_KEY nao configurada', campos: camposVazios(), pendente_confirmacao: true };

  const codigoEntrada = sku || nome;
  const termoBase    = [fabricante, sku, nome].filter(Boolean).join(' ');
  const numResultados = nivel_busca === 'agressivo' ? 15 : nivel_busca === 'discreto' ? 5 : 10;
  const maxTokens    = nivel_busca === 'agressivo' ? 4000 : nivel_busca === 'discreto' ? 1500 : 2500;

  let trechos = [];
  try { trechos = await buscarMultiQuery({ fabricante, sku, nome, numResultados }); }
  catch (e) { console.error('[DNA v5.1] busca:', e.message); }

  if (trechos.length === 0) {
    return { ok: true, encontrado: false, campos: camposVazios(), fontes_consultadas: [], campos_preenchidos: 0, pendente_confirmacao: true, mensagem: 'Sem resultados de busca.' };
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const userContent =
      `CÓDIGO: ${codigoEntrada}\nPRODUTO: ${termoBase}\n\n` +
      `Resultados de busca (${trechos.length} fontes):\n` +
      trechos.map((t, i) => `[${i+1}] ${t.titulo}\nURL: ${t.fonte}\n${t.trecho}`).join('\n\n') +
      `\n\nESQUEMA DE SAÍDA (retorne SOMENTE este JSON):\n${NTC_SCHEMA}`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: NTC_SYSTEM,
      messages: [{ role: 'user', content: userContent }]
    });

    const rawText = msg.content?.[0]?.text || '{}';
    console.log(`[DNA v5.1] Claude ${rawText.length} chars | ${codigoEntrada}`);

    let canonico;
    try {
      const cleaned = rawText.trim().replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      canonico = JSON.parse(m ? m[0] : cleaned);
    } catch (e) {
      console.error('[DNA v5.1] parse:', e.message);
      return { ok: false, erro: 'Parse JSON: ' + e.message, campos: camposVazios(), pendente_confirmacao: true };
    }

    if (!canonico.codigo_entrada) canonico.codigo_entrada = codigoEntrada;
    auditarCanonicoCompleto(canonico);

    if (canonico.dna?.ean?.valor != null) {
      const s = String(canonico.dna.ean.valor).replace(/\D/g, '');
      if (!validarGTIN(s)) canonico.dna.ean = { valor: null, confianca: 'nulo', fontes: [] };
      else canonico.dna.ean.valor = s;
    }

    if (canonico.co?.ncm?.valor != null) {
      const l = validarNCM(canonico.co.ncm.valor);
      if (!l) { canonico.co.ncm = { valor: null, confianca: 'nulo', fontes: [] }; }
      else {
        canonico.co.ncm.valor = l;
        try { const desc = await consultarNCMOficial(l); if (desc) { canonico.co.ncm.confianca = 'confirmado'; canonico.co.ncm._tipi = desc; } } catch (_) {}
      }
    }

    if (Array.isArray(canonico.av?.aplicacoes)) {
      for (const ap of canonico.av.aplicacoes) {
        for (const f of ['ano_inicial', 'ano_final']) {
          if (ap[f] != null && ap[f] !== 'atual') { const n = parseInt(ap[f],10); ap[f] = (!isNaN(n)&&n>=1950&&n<=2035)?n:null; }
        }
      }
    }

    const camposLegado      = canonParaLegado(canonico);
    const campos_preenchidos = CAMPOS_DNA.filter(c => camposLegado[c]?.valor != null).length;
    console.log(`[DNA v5.1] ${campos_preenchidos}/${CAMPOS_DNA.length} | status: ${canonico.status||'ok'}`);

    return { ok: true, encontrado: campos_preenchidos > 0, campos: camposLegado, campos_canonico: canonico, fontes_consultadas: trechos.map(t => t.fonte), campos_preenchidos, total_campos: CAMPOS_DNA.length, pendente_confirmacao: true };

  } catch (e) {
    console.error('[DNA v5.1] Claude:', e.message);
    return { ok: false, erro: e.message, campos: camposVazios(), pendente_confirmacao: true };
  }
}

module.exports = { enriquecerDnaViaWeb, CAMPOS_DNA, camposVazios, canonParaLegado };
