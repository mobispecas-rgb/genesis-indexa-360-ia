'use strict';

/**
 * NTC 4.0 — Núcleo de Triangulação Certificada
 * Genesis Indexa 360 IA · MOBIS Peças Automotivas
 *
 * PROIBIÇÕES ABSOLUTAS — NUNCA inventar:
 *   OEM · NCM · EAN · GTIN · CEST · aplicação · motor
 *   peso · medida · imagem · código cambiado · fabricante
 *
 * Sem evidência documental → retornar null / false / []
 * O NTC é a única autoridade de aprovação.
 *
 * FLUXO: DNA→TF→FM→CO→AV→MC→EC→BTA→CC→LG→IV→FI→FP→NTC
 *
 * FÓRMULA:
 *   DNA=25% · TF=15% · FM=10% · CO=10% · AV=10%
 *   MC=5%   · EC=5%  · BTA=5% · CC=5%  · LG=5%
 *   IV=5%   · FI=3%  · FP=2%
 *
 * STATUS:
 *   NTC >= 0.95           → APROVADO
 *   0.60 <= NTC < 0.95   → PENDENTE
 *   NTC < 0.60            → REPROVADO
 *   (nunca usar BLOQUEADO)
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
// PESOS OFICIAIS
// ─────────────────────────────────────────────────────────────
const PESOS = {
  DNA: 0.25,
  TF:  0.15,
  FM:  0.10,
  CO:  0.10,
  AV:  0.10,
  MC:  0.05,
  EC:  0.05,
  BTA: 0.05,
  CC:  0.05,
  LG:  0.05,
  IV:  0.05,
  FI:  0.03,
  FP:  0.02,
};

const LABELS = {
  DNA: 'DNA — Fabricante Original (25%)',
  TF:  'TF  — Triangulação OEM (15%)',
  FM:  'FM  — Nome Técnico Completo (10%)',
  CO:  'CO  — Fiscal NCM/CEST/CST (10%)',
  AV:  'AV  — Aplicação por Motor (10%)',
  MC:  'MC  — Material Construtivo (5%)',
  EC:  'EC  — Engenharia (5%)',
  BTA: 'BTA — Boletim Técnico Aplicado (5%)',
  CC:  'CC  — Códigos Cambiados Certificados (5%)',
  LG:  'LG  — Linhagem Genealógica (5%)',
  IV:  'IV  — Integridade Visual (5%)',
  FI:  'FI  — Ficha Física / Pesos (3%)',
  FP:  'FP  — Dimensões Físicas (2%)',
};

// ─────────────────────────────────────────────────────────────
// MÓDULO DNA — Fabricante original comprovado
// ─────────────────────────────────────────────────────────────

// Helper: converte string/array em array (split por ; ou ,)
function toArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v && typeof v === 'string' && v.trim()) {
    return v.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function moduloDNA(d) {
  const dna = {
    fabricante_original: d.fabricante || d.fabricante_original || null,
    codigo_dna:          d.codigo_fabricante || d.codigo_oem || d.oem || null,
    familia_tecnica:     d.familia_tecnica   || null,
    confirmado:          false,
  };

  let score = 0;
  if (dna.fabricante_original && dna.codigo_dna && dna.familia_tecnica) {
    dna.confirmado = true;
    score = 1.0;
  } else if (dna.fabricante_original && dna.codigo_dna) {
    score = 0.6;
  } else if (dna.fabricante_original) {
    score = 0.3;
  }

  return { dados: dna, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO TF — Triangulação: Fabricante + Código + Aplicação
// ─────────────────────────────────────────────────────────────
function moduloTF(d, dnaConfirmado) {
  const temFabricante  = !!(d.fabricante || d.fabricante_original);
  const temCodigo      = !!(d.codigo_oem || d.oem);
  const temAplicacao   = !!(d.motor || d.codigo_motor || d.modelo || d.modelo_veiculo);

  let score = 0;
  if (temFabricante && temCodigo && temAplicacao) score = 1.0;
  else if (temFabricante && temCodigo)            score = 0.6;
  else if (temCodigo)                             score = 0.3;

  // Sem triangulação completa → TF = 0
  const triangulado = temFabricante && temCodigo && temAplicacao;

  return {
    dados: {
      fabricante:  d.fabricante  || d.fabricante_original || null,
      codigo:      d.codigo_oem  || d.oem || null,
      aplicacao:   d.motor || d.modelo || d.modelo_veiculo || null,
      triangulado,
    },
    score: triangulado ? score : 0,
  };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO FM — Nome técnico completo (mín. 3 palavras)
// ─────────────────────────────────────────────────────────────
function moduloFM(d) {
  const nome    = d.nome || null;
  const palavras = nome ? nome.trim().split(/\s+/).filter(Boolean) : [];

  let score = 0;
  if (palavras.length >= 3)                              score = 1.0;
  else if (palavras.length === 2)                        score = 0.6;
  else if (palavras.length === 1 && palavras[0].length > 3) score = 0.3;

  return { dados: { nome, palavras: palavras.length }, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO CO — Fiscal: NCM 8 dígitos · CEST · CST · Origem
// ─────────────────────────────────────────────────────────────
function moduloCO(d) {
  const ncm    = d.ncm    || null;
  const cest   = d.cest   || null;
  const cst    = d.cst    || null;
  const origem = d.origem || null;

  const ncmLimpo = (ncm || '').replace(/\D/g, '');
  const ncmValido = ncmLimpo.length === 8;

  let score = 0;
  if (ncmValido && cest && cst && origem) score = 1.0;
  else if (ncmValido && cest)             score = 0.8;
  else if (ncmValido)                     score = 0.6;
  else if (ncmLimpo.length > 0)          score = 0.3;

  return { dados: { ncm, cest, cst, origem, ncm_valido: ncmValido }, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO AV — Aplicação nasce do MOTOR, não do veículo
// ─────────────────────────────────────────────────────────────
function moduloAV(d) {
  const av = {
    montadora:    d.marca         || d.marca_veiculo    || null,
    veiculo:      d.modelo        || d.modelo_veiculo   || null,
    versao:       d.versao        || d.versao_veiculo   || null,
    motor:        d.motor         || null,
    codigo_motor: d.codigo_motor  || null,
    cilindrada:   d.cilindrada    || null,
    ano_inicial:  d.ano_inicial   || null,
    ano_final:    d.ano_final     || null,
  };

  const temCompleto = av.montadora && av.veiculo && av.versao &&
                      av.motor && av.cilindrada && av.codigo_motor &&
                      av.ano_inicial && av.ano_final;
  const temParcial  = av.montadora && av.veiculo && av.motor && av.ano_inicial;
  const temMinimo   = av.montadora && av.veiculo && av.ano_inicial;

  let score = 0;
  if (temCompleto)     score = 1.0;
  else if (temParcial) score = 0.7;
  else if (temMinimo)  score = 0.4;
  else if (av.montadora || av.veiculo) score = 0.2;

  return { dados: av, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO MC — Material Construtivo (sem documento → null)
// ─────────────────────────────────────────────────────────────
function moduloMC(d) {
  const material = d.material || null;
  const score    = (material && material.trim().length > 3) ? 1.0 : 0;
  return { dados: { material }, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO EC — Engenharia
// ─────────────────────────────────────────────────────────────
function moduloEC(d) {
  const ec = {
    funcao:         d.funcao || d.funcao_tecnica || null,
    especificacoes: Array.isArray(d.especificacoes) ? d.especificacoes : [],
    dimensoes:      Array.isArray(d.dimensoes)      ? d.dimensoes      : [],
    pressao:        d.pressao        || null,
    temperatura:    d.temperatura    || null,
    torque:         d.torque         || null,
  };
  const preenchidos = [ec.funcao, ec.pressao, ec.temperatura, ec.torque,
    ec.especificacoes.length > 0, ec.dimensoes.length > 0].filter(Boolean).length;
  const score = Math.min(preenchidos / 3, 1.0);
  return { dados: ec, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO BTA — Boletim Técnico Aplicado
// ─────────────────────────────────────────────────────────────
function moduloBTA(d) {
  const bta = {
    boletins:      toArray(d.boletins),
    revisoes:      toArray(d.revisoes),
    substituicoes: toArray(d.substituicoes),
  };
  const total = bta.boletins.length + bta.revisoes.length + bta.substituicoes.length;
  const score = total > 0 ? Math.min(total / 3, 1.0) : 0;
  return { dados: bta, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO CC — Códigos Cambiados Certificados (nunca misturar)
// ─────────────────────────────────────────────────────────────
function moduloCC(d) {
  const cc = {
    dna:         toArray(d.cc_dna),
    oem:         toArray(d.cc_oem),
    aftermarket: toArray(d.cc_aftermarket || d.cross_codes),
    importadores:toArray(d.cc_importadores),
  };
  const total = cc.dna.length + cc.oem.length + cc.aftermarket.length + cc.importadores.length;
  const score = total > 0 ? Math.min(total / 4, 1.0) : 0;
  return { dados: cc, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO LG — Linhagem Genealógica (árvore)
// ─────────────────────────────────────────────────────────────
function moduloLG(d) {
  const lg = {
    fabricante_original: d.linhagem_fabricante   || d.fabricante_original || d.fabricante || null,
    montadora:           d.linhagem_montadora    || d.marca_veiculo || d.marca || null,
    distribuidor:        d.linhagem_distribuidor  || null,
    importador:          d.linhagem_importador    || null,
    marketplace:         d.linhagem_marketplace   || null,
  };
  const niveis = Object.values(lg).filter(Boolean).length;
  const score  = Math.min(niveis / 3, 1.0);
  return { dados: lg, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO IV — Integridade Visual (sem evidência → nota = 0)
// ─────────────────────────────────────────────────────────────
function moduloIV(d) {
  const iv = {
    nota:          0,
    foto_principal:!!d.iv_foto_principal,
    embalagem:     !!d.iv_embalagem,
    etiqueta:      !!d.iv_etiqueta,
    ocr:           !!d.iv_ocr,
    angulos:       typeof d.iv_angulos === 'number' ? d.iv_angulos : 0,
  };

  // Nota calculada por evidências reais
  const pontos = [iv.foto_principal, iv.embalagem, iv.etiqueta, iv.ocr].filter(Boolean).length;
  const bonus  = Math.min(iv.angulos / 6, 1) * 0.2;
  iv.nota = parseFloat(Math.min((pontos / 4) * 0.8 + bonus, 1.0).toFixed(2));

  // Imagens recebidas (só pontua se realmente fornecidas)
  const imgs = Array.isArray(d.imagens) ? d.imagens : [];
  if (imgs.length > 0 && !iv.foto_principal) {
    iv.foto_principal = true;
    const extra = Math.min(imgs.length / 6, 1);
    iv.nota = parseFloat(Math.max(iv.nota, extra * 0.8).toFixed(2));
  }

  const score = iv.nota;
  return { dados: iv, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO FI — Ficha Física / Pesos (com origem comprovada)
// ─────────────────────────────────────────────────────────────
function moduloFI(d) {
  const fi = {
    peso_liquido: d.peso_liquido || null,
    peso_bruto:   d.peso_bruto   || null,
  };
  let score = 0;
  if (fi.peso_liquido && fi.peso_bruto) score = 1.0;
  else if (fi.peso_liquido || fi.peso_bruto) score = 0.5;
  return { dados: fi, score };
}

// ─────────────────────────────────────────────────────────────
// MÓDULO FP — Dimensões Físicas (com origem comprovada)
// ─────────────────────────────────────────────────────────────
function moduloFP(d) {
  const fp = {
    altura:      d.altura      || null,
    largura:     d.largura     || null,
    comprimento: d.comprimento || null,
  };
  const preenchidos = Object.values(fp).filter(Boolean).length;
  const score = preenchidos === 3 ? 1.0 : preenchidos === 2 ? 0.5 : preenchidos === 1 ? 0.2 : 0;
  return { dados: fp, score };
}

// ─────────────────────────────────────────────────────────────
// RAST-HASH — DNA + OEM + Fabricante + Motor + Aplicação + NCM + EAN + Data
// ─────────────────────────────────────────────────────────────
function gerarRastHash(d) {
  const partes = [
    d.codigo_dna   || d.codigo_fabricante || '',
    d.codigo_oem   || d.oem              || '',
    d.fabricante                          || '',
    d.motor        || d.codigo_motor     || '',
    [d.montadora || d.marca, d.veiculo || d.modelo, d.ano_inicial].filter(Boolean).join(' ') || '',
    (d.ncm || '').replace(/\D/g, ''),
    d.ean          || d.gtin             || '',
    d.data_indexacao || new Date().toISOString().substring(0, 10),
  ];
  const str = partes.join('|');
  return crypto.createHash('md5').update(str).digest('hex').substring(0, 16).toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// CALCULAR NTC — aplica pesos e retorna score + status
// ─────────────────────────────────────────────────────────────
function calcularNTC(scores) {
  let ntc = 0;
  for (const [chave, peso] of Object.entries(PESOS)) {
    const val = Math.min(Math.max(parseFloat(scores[chave] || 0), 0), 1);
    ntc += val * peso;
  }
  ntc = parseFloat(Math.min(ntc, 1.0).toFixed(4));
  const decisao = ntc >= 0.95 ? 'APROVADO' : ntc >= 0.60 ? 'PENDENTE' : 'REPROVADO';
  return { ntc, decisao };
}

// ─────────────────────────────────────────────────────────────
// VALIDAR BLOQUEIOS OBRIGATÓRIOS
// ─────────────────────────────────────────────────────────────
function validarBloqueios(modulos, ntc) {
  const impedimentos = [];

  if (!modulos.DNA.dados.confirmado) {
    impedimentos.push('SEM DNA — fabricante original não confirmado');
  }
  if (!modulos.TF.dados.triangulado) {
    impedimentos.push('SEM TRIANGULAÇÃO — Fabricante + Código + Aplicação obrigatórios');
  }
  if (!modulos.AV.dados.motor) {
    impedimentos.push('SEM APLICAÇÃO POR MOTOR — aplicação nasce do motor, não do veículo');
  }

  const podeCadastrar = impedimentos.length === 0;

  // Marketplace: DNA + TF + AV confirmados + IV >= 0.80 + NTC >= 0.95
  const podePublicar = podeCadastrar &&
    modulos.IV.dados.nota >= 0.80 &&
    ntc >= 0.95;

  return {
    impedimentos,
    podeCadastrar,
    podePublicar,
    publicavel: podePublicar,
  };
}

// ─────────────────────────────────────────────────────────────
// PIPELINE COMPLETO — DNA→TF→FM→CO→AV→MC→EC→BTA→CC→LG→IV→FI→FP→NTC
// ─────────────────────────────────────────────────────────────
function processar(dados) {
  const d = dados || {};

  // Executar cada módulo em sequência
  const modulos = {
    DNA: moduloDNA(d),
    TF:  moduloTF(d),
    FM:  moduloFM(d),
    CO:  moduloCO(d),
    AV:  moduloAV(d),
    MC:  moduloMC(d),
    EC:  moduloEC(d),
    BTA: moduloBTA(d),
    CC:  moduloCC(d),
    LG:  moduloLG(d),
    IV:  moduloIV(d),
    FI:  moduloFI(d),
    FP:  moduloFP(d),
  };

  // Extrair scores
  const scores = {};
  for (const [k, m] of Object.entries(modulos)) scores[k] = m.score;

  // Calcular NTC
  const { ntc, decisao } = calcularNTC(scores);

  // Validar bloqueios
  const { impedimentos, podeCadastrar, podePublicar, publicavel } = validarBloqueios(modulos, ntc);

  // Gerar RAST-HASH com todos os campos
  const rast_hash = gerarRastHash({
    codigo_dna:      modulos.DNA.dados.codigo_dna,
    codigo_oem:      d.codigo_oem || d.oem,
    fabricante:      modulos.DNA.dados.fabricante_original,
    motor:           modulos.AV.dados.motor,
    codigo_motor:    modulos.AV.dados.codigo_motor,
    montadora:       modulos.AV.dados.montadora,
    veiculo:         modulos.AV.dados.veiculo,
    ano_inicial:     modulos.AV.dados.ano_inicial,
    ncm:             modulos.CO.dados.ncm,
    ean:             d.ean || d.gtin,
    data_indexacao:  d.data_indexacao || new Date().toISOString().substring(0, 10),
  });

  return {
    ntc,
    decisao,
    rast_hash,
    scores,       // scores individuais (0.0–1.0)
    modulos,      // dados completos de cada módulo
    componentes:  scores,  // alias para compatibilidade
    impedimentos,
    podeCadastrar,
    podePublicar,
    publicavel,
    fonte_real: false,
  };
}

// ─────────────────────────────────────────────────────────────
// GERAR CABEÇOTE ERP BLING
// ─────────────────────────────────────────────────────────────
function gerarCabecoteERP(resultado, dados) {
  const dna = resultado.modulos.DNA.dados;
  const av  = resultado.modulos.AV.dados;
  const co  = resultado.modulos.CO.dados;

  return {
    cabecalho: {
      nome_tecnico:  dados.nome         || null,
      marca_dna:     dna.fabricante_original || null,
      codigo_dna:    dna.codigo_dna     || null,
      oem_principal: dados.codigo_oem   || dados.oem || null,
    },
    gavetas: {
      categoria:     dados.categoria    || null,
      subcategoria:  dados.subcategoria || null,
      sistema:       dados.sistema      || null,
      montadora:     av.montadora       || null,
      motor:         av.motor           || null,
      cilindrada:    av.cilindrada      || null,
      codigo_motor:  av.codigo_motor    || null,
      dna:           dna.fabricante_original || null,
    },
    tags: [
      dna.fabricante_original,
      dados.codigo_oem || dados.oem,
      av.motor,
      av.montadora,
      dados.sistema,
      [av.montadora, av.veiculo, av.ano_inicial, av.ano_final].filter(Boolean).join(' ') || null,
    ].filter(Boolean),
    fiscal: {
      ncm:    co.ncm    || null,
      cest:   co.cest   || null,
      cst:    co.cst    || null,
      origem: co.origem || null,
    },
    ntc:        resultado.ntc,
    decisao:    resultado.decisao,
    rast_hash:  resultado.rast_hash,
    publicavel: resultado.publicavel,
  };
}

// ─────────────────────────────────────────────────────────────
// GERAR ESTRUTURA WIX (abas)
// ─────────────────────────────────────────────────────────────
function gerarEstruturaWix(resultado, dados) {
  if (!resultado.publicavel) {
    return { publicavel: false, motivo: resultado.impedimentos.join(' | ') || 'NTC < 0.95 ou IV < 0.80' };
  }

  const dna  = resultado.modulos.DNA.dados;
  const av   = resultado.modulos.AV.dados;
  const co   = resultado.modulos.CO.dados;
  const mc   = resultado.modulos.MC.dados;
  const ec   = resultado.modulos.EC.dados;
  const bta  = resultado.modulos.BTA.dados;
  const cc   = resultado.modulos.CC.dados;

  return {
    publicavel: true,
    abas: {
      descricao_tecnica: { nome: dados.nome || null, funcao: ec.funcao || null, material: mc.material || null },
      aplicacao_motor:   av,
      dados_fiscais:     { ncm: co.ncm, cest: co.cest, cst: co.cst, origem: co.origem },
      material:          { material: mc.material || null },
      engenharia:        ec,
      boletim_tecnico:   bta,
      codigos_cambiados: cc,
      dna:               dna,
    },
    seo_liberado: resultado.ntc >= 0.95,
  };
}

module.exports = {
  processar,
  calcularNTC,
  gerarRastHash,
  validarBloqueios,
  gerarCabecoteERP,
  gerarEstruturaWix,
  moduloDNA, moduloTF, moduloFM, moduloCO, moduloAV,
  moduloMC,  moduloEC, moduloBTA, moduloCC, moduloLG,
  moduloIV,  moduloFI, moduloFP,
  PESOS,
  LABELS,
};
