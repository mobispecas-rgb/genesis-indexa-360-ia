'use strict';

// ============================================================
// Agente DNA OEM 360 — Motor NTC 4.0  ·  v5.0 (2026-06-20)
// Busca: Gemini 2.0 Flash + Google Search Grounding nativo
// NÃO depende de SERPER_API_KEY nem GOOGLE_SEARCH_KEY.
// Requer: GEMINI_API_KEY (já configurada no Render).
// ============================================================
const { validarGTIN, validarNCM, consultarNCMOficial } = require('./web-utils');

// ─────────────────────────────────────────────────────────────
// REGRAS CANÔNICAS NTC
// ─────────────────────────────────────────────────────────────
const NTC_SYSTEM = `Você é o agente "DNA OEM 360" do sistema Genesis iRollo 360 (NTC Engine 4.0) para peças automotivas.

REGRAS ABSOLUTAS — NUNCA QUEBRE ESTAS REGRAS:

1. NUNCA invente, deduza ou "complete" um dado que não tenha fonte verificável na web. Se não encontrar evidência, o campo retorna null. Não existe "chute educado" — existe fato com fonte ou null.

2. SEMPRE diferencie três níveis de confiança por campo:
   - "confirmado": dado em 2+ fontes INDEPENDENTES E ESPECÍFICAS (página de produto, ficha técnica, catálogo com o código exato). A home page de uma marca (ex: ngk.com, mahle.com, sabo.com.br) NUNCA conta como fonte válida para um campo específico.
   - "familia": dado de código vizinho/aparentado (mesma família, prefixo ou faixa numérica). É pista, não fato. NUNCA promova "familia" para "confirmado".
   - "nulo": nenhuma fonte. Campo fica null.
   PROIBIDO repetir a mesma URL como fonte em múltiplos campos diferentes.

3. Código incompleto (sem sufixo de medida, tipo ou hífen)? Retorne "status": "codigo_incompleto" e liste variantes_possiveis. NÃO escolha um sufixo sozinho.

4. Para APLICAÇÃO VEICULAR com motor compartilhado/licenciado entre montadoras, explique o MECANISMO da triangulação em mecanismo_triangulacao.

5. Em fontes[], coloque as URLs EXATAS onde encontrou aquele dado específico.

6. Saída: SOMENTE o JSON abaixo. Nada antes ou depois. Sem markdown. Sem cercas de código.`;

const NTC_SCHEMA = `{
  "codigo_entrada": "<código exatamente como recebido>",
  "status": "ok | codigo_incompleto | nao_encontrado",
  "variantes_possiveis": [],
  "dna": {
    "fabricante_original":           { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] },
    "codigo_oem":                    { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] },
    "codigo_fabricante_normalizado": { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] },
    "ean":                           { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] },
    "categoria_produto":             { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] }
  },
  "fm": {
    "nome_tecnico_completo": { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] },
    "funcao_tecnica":        { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] }
  },
  "av": {
    "aplicacoes": [
      { "montadora": null, "modelo": null, "motor": null, "ano_inicial": null, "ano_final": null, "cilindrada": null, "confianca": "confirmado|familia|nulo", "fontes": [] }
    ],
    "mecanismo_triangulacao": null
  },
  "co": {
    "ncm":  { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] },
    "cest": { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] }
  },
  "mc": { "material": { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] } },
  "ec": { "engenharia_detalhe": { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] } },
  "bta": { "boletins": [], "substituicoes": [] },
  "cc": {
    "cc_oem":          [{ "marca": null, "codigo": null, "confianca": "confirmado|familia|nulo" }],
    "cc_aftermarket":  [{ "marca": null, "codigo": null, "confianca": "confirmado|familia|nulo" }],
    "cc_importadores": [{ "marca": null, "codigo": null, "confianca": "confirmado|familia|nulo" }]
  },
  "lg": { "linhagem": { "valor": null, "confianca": "confirmado|familia|nulo", "fontes": [] } },
  "fi_fp": { "peso_bruto": null, "peso_liquido": null, "comprimento": null, "largura": null, "altura": null }
}`;

// ─────────────────────────────────────────────────────────────
// CAMPOS LEGACY (compatibilidade com auto-enrich.js)
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// VALIDADOR DETERMINÍSTICO DE CONFIANÇA
// Rebaixa "confirmado" → "familia" se < 2 domínios distintos.
// ─────────────────────────────────────────────────────────────
function auditarConfianca(campo) {
  if (!campo || campo.confianca !== 'confirmado') return campo;
  const fontes = (campo.fontes || []).filter(f => f && typeof f === 'string' && f.startsWith('http'));
  const dominios = new Set();
  for (const f of fontes) { try { dominios.add(new URL(f).hostname.replace(/^www\./, '')); } catch (_) {} }
  if (dominios.size < 2) campo.confianca = 'familia';
  return campo;
}

function auditarCanonicoCompleto(can) {
  if (!can) return can;
  for (const k of Object.keys(can.dna || {})) auditarConfianca(can.dna[k]);
  for (const k of Object.keys(can.fm  || {})) auditarConfianca(can.fm[k]);
  for (const ap of (can.av?.aplicacoes || [])) {
    const dom = new Set();
    for (const f of (ap.fontes || [])) { try { dom.add(new URL(f).hostname.replace(/^www\./, '')); } catch (_) {} }
    if (ap.confianca === 'confirmado' && dom.size < 2) ap.confianca = 'familia';
  }
  for (const sec of [can.co, can.mc, can.ec, can.lg]) {
    if (!sec) continue;
    for (const k of Object.keys(sec)) auditarConfianca(sec[k]);
  }
  return can;
}

// ─────────────────────────────────────────────────────────────
// BRIDGE: canônico → legacy (para auto-enrich.js)
// ─────────────────────────────────────────────────────────────
function canonParaLegado(can) {
  if (!can) return camposVazios();
  const C  = { confirmado: 'alta', familia: 'media', nulo: 'baixa' };
  const g  = f => (f && f.confianca !== 'nulo' && f.valor != null) ? f.valor : null;
  const gf = f => (Array.isArray(f?.fontes) && f.fontes.length) ? f.fontes[0] : null;
  const av0 = Array.isArray(can.av?.aplicacoes) ? can.av.aplicacoes[0] : null;
  const ac  = av0?.confianca || 'nulo';
  const af  = (Array.isArray(av0?.fontes) && av0.fontes.length) ? av0.fontes[0] : null;
  const avRest = Array.isArray(can.av?.aplicacoes) && can.av.aplicacoes.length > 1
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
// AGENTE PRINCIPAL — Gemini 2.0 Flash + Google Search Grounding
// ─────────────────────────────────────────────────────────────
async function enriquecerDnaViaWeb({ sku, fabricante, nome, nivel_busca }) {
  if (!sku && !nome) {
    return { ok: false, erro: 'SKU ou Nome obrigatorio', campos: camposVazios(), pendente_confirmacao: true };
  }
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, erro: 'GEMINI_API_KEY nao configurada', campos: camposVazios(), pendente_confirmacao: true };
  }

  const codigoEntrada = sku || nome;
  const termoBase    = [fabricante, sku, nome].filter(Boolean).join(' ');
  const maxTokens    = nivel_busca === 'agressivo' ? 4096 : nivel_busca === 'discreto' ? 1024 : 2048;

  try {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const userPrompt =
      `CÓDIGO: ${codigoEntrada}\n` +
      `PRODUTO: ${termoBase}\n\n` +
      `Pesquise na web e retorne o JSON canônico NTC completo.\n\n` +
      `ESQUEMA DE SAÍDA OBRIGATÓRIO (retorne SOMENTE este JSON, sem markdown):\n` +
      NTC_SCHEMA;

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: userPrompt,
      config: {
        systemInstruction: NTC_SYSTEM,
        tools: [{ googleSearch: {} }],
        temperature: 0.1,
        maxOutputTokens: maxTokens,
      },
    });

    const rawText = response.text || '';
    console.log(`[DNA v5] Gemini ${rawText.length} chars | ${codigoEntrada}`);

    // Parse JSON
    let canonico;
    try {
      const cleaned = rawText.trim()
        .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      canonico = JSON.parse(m ? m[0] : cleaned);
    } catch (e) {
      console.error('[DNA v5] parse:', e.message, '| raw:', rawText.substring(0, 200));
      return { ok: false, erro: 'Parse JSON: ' + e.message, campos: camposVazios(), pendente_confirmacao: true };
    }

    if (!canonico.codigo_entrada) canonico.codigo_entrada = codigoEntrada;

    // Validador determinístico (rebaixa confirmado sem 2+ domínios)
    auditarCanonicoCompleto(canonico);

    // Validar EAN/GTIN por checksum
    if (canonico.dna?.ean?.valor != null) {
      const s = String(canonico.dna.ean.valor).replace(/\D/g, '');
      if (!validarGTIN(s)) {
        canonico.dna.ean = { valor: null, confianca: 'nulo', fontes: [] };
      } else {
        canonico.dna.ean.valor = s;
      }
    }

    // Validar NCM + consulta TIPI oficial
    if (canonico.co?.ncm?.valor != null) {
      const l = validarNCM(canonico.co.ncm.valor);
      if (!l) {
        canonico.co.ncm = { valor: null, confianca: 'nulo', fontes: [] };
      } else {
        canonico.co.ncm.valor = l;
        try {
          const desc = await consultarNCMOficial(l);
          if (desc) { canonico.co.ncm.confianca = 'confirmado'; canonico.co.ncm._tipi = desc; }
        } catch (_) {}
      }
    }

    // Normalizar anos
    if (Array.isArray(canonico.av?.aplicacoes)) {
      for (const ap of canonico.av.aplicacoes) {
        for (const f of ['ano_inicial', 'ano_final']) {
          if (ap[f] != null && ap[f] !== 'atual') {
            const n = parseInt(ap[f], 10);
            ap[f] = (!isNaN(n) && n >= 1950 && n <= 2035) ? n : null;
          }
        }
      }
    }

    const camposLegado      = canonParaLegado(canonico);
    const campos_preenchidos = CAMPOS_DNA.filter(c => camposLegado[c]?.valor != null).length;

    console.log(`[DNA v5] ${campos_preenchidos}/${CAMPOS_DNA.length} campos | status: ${canonico.status || 'ok'}`);

    return {
      ok: true,
      encontrado: campos_preenchidos > 0,
      campos: camposLegado,
      campos_canonico: canonico,
      fontes_consultadas: [],
      campos_preenchidos,
      total_campos: CAMPOS_DNA.length,
      pendente_confirmacao: true,
    };

  } catch (e) {
    console.error('[DNA v5] Gemini:', e.message);
    return { ok: false, erro: e.message, campos: camposVazios(), pendente_confirmacao: true };
  }
}

module.exports = { enriquecerDnaViaWeb, CAMPOS_DNA, camposVazios, canonParaLegado };
