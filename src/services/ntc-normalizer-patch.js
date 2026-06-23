'use strict';

/**
 * NTC Normalizer Patch — Validador Deterministico de Confianca
 * Genesis iRollo 360 · Motor NTC 4.0
 *
 * PROBLEMA: LLMs marcam "confirmado" com 1 fonte ou com home pages institucionais.
 * SOLUCAO: roda SEMPRE pos-LLM, pre-ntc-engine. Rebaixa automaticamente:
 *   >= 2 fontes especificas em dominios distintos -> mantém "confirmado"
 *   == 1 fonte especifica                         -> rebaixa para "familia"
 *   == 0 fontes especificas                       -> rebaixa para "nulo" + valor = null
 *
 * FONTE ESPECIFICA = URL com path profundo de produto/ficha tecnica.
 * NAO e: home page da marca, dominio raiz, pagina de categoria generica.
 */

const DOMINIOS_INSTITUCIONAIS = [
  'sabo.com.br','mahle.com','metal-leve.com.br','ks-kolbenschmidt.com','ks.com',
  'cofap.com.br','nakata.com.br','monroe.com','gabriel.com.br','bosch.com.br',
  'bosch.com','ngk.com.br','ngk.com','wega.com.br','mann-filter.com',
  'mahle-aftermarket.com','luk.com','sachs.de','trw.com','frasle.com.br',
  'valeo.com','denso.com','delphi.com','continental.com','ina.de',
  'skf.com','gates.com','dayco.com','contitech.com',
];

function toArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v && typeof v === 'string' && v.trim()) {
    return v.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Determina se uma URL e especifica (fala do produto/codigo pesquisado)
 * ou generica (home page, dominio institucional sem path de produto).
 */
function isUrlEspecifica(url, codigoEntrada) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }

  const dominio = parsed.hostname.replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/$/, '');

  // Path muito curto = home page ou categoria raiz
  if (path.length < 4) return false;
  if (/^\/[a-z]{2}(-[a-z]{2})?$/.test(path)) return false;

  // Dominio institucional: exige path de produto ou mencao ao codigo
  if (DOMINIOS_INSTITUCIONAIS.includes(dominio)) {
    const temPathProduto = /\/(produto|part|peca|item|catalogo|ficha|referencia|oem|code|ref)\//i.test(path);
    const temAlphanumerico = /[A-Z0-9]{4,}/i.test(path);
    const mencionaCodigo = codigoEntrada &&
      url.toLowerCase().includes(codigoEntrada.toLowerCase().replace(/\s+/g, ''));
    if (!temPathProduto && !temAlphanumerico && !mencionaCodigo) return false;
  }

  return true;
}

/**
 * Conta fontes especificas distintas (por dominio).
 */
function contarFontesEspecificas(fontes, codigoEntrada) {
  if (!Array.isArray(fontes)) return 0;
  const especificas = fontes.filter(f => isUrlEspecifica(f, codigoEntrada));
  const dominiosUnicos = new Set(especificas.map(f => {
    try { return new URL(f).hostname.replace(/^www\./, ''); } catch { return f; }
  }));
  return dominiosUnicos.size;
}

/**
 * Normaliza um campo: rebaixa "confirmado" se fontes insuficientes.
 */
function normalizarCampo(campo, codigoEntrada) {
  if (!campo || typeof campo !== 'object') return campo;
  if (campo.confianca !== 'confirmado') return campo;

  const qtd = contarFontesEspecificas(campo.fontes, codigoEntrada);

  if (qtd >= 2) return campo;

  if (qtd === 1) {
    return {
      ...campo,
      confianca: 'familia',
      _rebaixado: 'confirmado→familia: apenas 1 fonte especifica (minimo: 2)'
    };
  }

  return {
    ...campo,
    valor: null,
    confianca: 'nulo',
    _rebaixado: 'confirmado→nulo: nenhuma fonte especifica encontrada'
  };
}

/**
 * Percorre recursivamente o objeto e normaliza todos os campos
 * com estrutura { valor, confianca, fontes }.
 */
function normalizarRecursivo(obj, codigoEntrada) {
  if (Array.isArray(obj)) {
    return obj.map(item => normalizarRecursivo(item, codigoEntrada));
  }
  if (obj && typeof obj === 'object') {
    if ('confianca' in obj && 'fontes' in obj) {
      return normalizarCampo(obj, codigoEntrada);
    }
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = normalizarRecursivo(v, codigoEntrada);
    }
    return result;
  }
  return obj;
}

/**
 * FUNCAO PRINCIPAL — chame SEMPRE apos o LLM, ANTES do ntc-engine.
 *
 * Uso:
 *   const { validarRespostaAgente, agenteParaNTC } = require('./ntc-normalizer-patch');
 *   const { ok, dados, auditoria } = validarRespostaAgente(respostaLLM);
 *   const dadosNTC = agenteParaNTC(dados);
 *   const resultado = ntcEngine.processar(dadosNTC);
 */
function validarRespostaAgente(respostaAgente) {
  if (!respostaAgente || typeof respostaAgente !== 'object') {
    return { ok: false, erro: 'Resposta do agente invalida ou nula', dados: null, auditoria: null };
  }

  const codigo = respostaAgente.codigo_entrada || '';
  const normalizado = normalizarRecursivo(respostaAgente, codigo);

  const rebaixamentos = [];
  function coletar(obj, path) {
    if (!obj || typeof obj !== 'object') return;
    if (obj._rebaixado) rebaixamentos.push({ campo: path, motivo: obj._rebaixado });
    for (const [k, v] of Object.entries(obj)) {
      if (k !== '_rebaixado') coletar(v, path ? path + '.' + k : k);
    }
  }
  coletar(normalizado, '');

  return {
    ok: true,
    dados: normalizado,
    auditoria: {
      codigo_entrada: codigo,
      modificado: rebaixamentos.length > 0,
      total_rebaixamentos: rebaixamentos.length,
      rebaixamentos,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Converte a resposta normalizada do agente para o formato
 * de entrada do ntc-engine.js (processar(d)).
 * So inclui campos com confianca != "nulo" e valor != null.
 */
function agenteParaNTC(d) {
  if (!d) return {};
  const get = (obj) => (obj && obj.confianca !== 'nulo' && obj.valor != null) ? obj.valor : null;

  const av0 = Array.isArray(d.av?.aplicacoes) ? d.av.aplicacoes[0] : null;
  const aplicacoesAdicionais = Array.isArray(d.av?.aplicacoes) && d.av.aplicacoes.length > 1
    ? d.av.aplicacoes.slice(1).map(a =>
        [a.montadora, a.modelo, a.motorizacao_alvo_veiculo, a.cilindrada,
         a.ano_inicial && a.ano_final ? a.ano_inicial + '-' + a.ano_final : a.ano_inicial
        ].filter(Boolean).join(' ')
      ).join('\n')
    : null;

  return {
    fabricante:          get(d.dna?.fabricante_original),
    fabricante_original: get(d.dna?.fabricante_original),
    part_number_automotivo: get(d.dna?.part_number_automotivo),
    codigo_oem:          get(d.dna?.part_number_automotivo),
    codigo_fabricante:   get(d.dna?.codigo_fabricante_normalizado) || get(d.dna?.part_number_automotivo),
    ean:                 get(d.dna?.ean),
    codigo_ean:          get(d.dna?.ean),
    familia_tecnica:     get(d.dna?.categoria_produto),
    nome:                get(d.fm?.nome_tecnico_completo),
    funcao_tecnica:      get(d.fm?.funcao_tecnica),
    funcao:              get(d.fm?.funcao_tecnica),
    marca:               av0?.montadora    || null,
    marca_veiculo:       av0?.montadora    || null,
    montadora_veiculo:   av0?.montadora    || null,
    modelo:              av0?.modelo       || null,
    modelo_veiculo:      av0?.modelo       || null,
    motorizacao_alvo_veiculo: av0?.motorizacao_alvo_veiculo || null,
    motor:               av0?.motorizacao_alvo_veiculo || null,
    cilindrada:          av0?.cilindrada   || null,
    ano_inicial:         av0?.ano_inicial  || null,
    ano_final:           av0?.ano_final    || null,
    aplicacoes_adicionais: aplicacoesAdicionais,
    ncm:                 get(d.co?.ncm),
    codigo_ncm:          get(d.co?.ncm),
    cest:                get(d.co?.cest),
    codigo_cest:         get(d.co?.cest),
    material:            get(d.mc?.material),
    composicao_material_peca: get(d.mc?.material),
    boletins:            toArray(d.bta?.boletins),
    substituicoes:       toArray(d.bta?.substituicoes),
    cc_oem:              toArray(d.cc?.cc_oem),
    cross_codes:         toArray(d.cc?.cc_aftermarket),
    cc_aftermarket:      toArray(d.cc?.cc_aftermarket),
    cc_importadores:     toArray(d.cc?.cc_importadores),
    linhagem_fabricante: get(d.lg?.linhagem) || get(d.dna?.fabricante_original),
    linhagem_montadora:  av0?.montadora || null,
    peso_bruto:          d.fi_fp?.peso_bruto   || null,
    peso_liquido:        d.fi_fp?.peso_liquido || null,
    comprimento:         d.fi_fp?.comprimento  || null,
    largura:             d.fi_fp?.largura      || null,
    altura:              d.fi_fp?.altura       || null,
    _status_agente:      d.status || null,
    _variantes:          d.variantes_possiveis || [],
    _codigo_entrada:     d.codigo_entrada || null,
  };
}

module.exports = {
  validarRespostaAgente,
  agenteParaNTC,
  normalizarCampo,
  contarFontesEspecificas,
  isUrlEspecifica,
};
