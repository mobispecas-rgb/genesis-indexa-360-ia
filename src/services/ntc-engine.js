const crypto = require('crypto');

const PESOS = {
  DNA: 0.25, TF: 0.15, FM: 0.10, CO: 0.10, AV: 0.10,
  MC:  0.05, EC: 0.05, BTA: 0.05, CC: 0.05, LG: 0.05,
  IV:  0.05, FI: 0.03, FP: 0.02
};

const DESCRICOES = {
  DNA: 'DNA do Produto (Linha + Família)',
  TF:  'Tipificação Fiscal (NCM 8 dígitos)',
  FM:  'Fabricante e Marca confirmados',
  CO:  'Código OEM confirmado',
  AV:  'Aplicação veicular com 8 campos',
  MC:  'Imagem principal aprovada',
  EC:  'Especificação comercial',
  BTA: 'Base técnica ativa',
  CC:  'Codificação cruzada (EAN/GTIN)',
  LG:  'Dados logísticos (peso + dimensão)',
  IV:  'Indexação visual MIDWAY gerada',
  FI:  'Fontes identificadas em todos campos',
  FP:  'Fingerprint RAST-HASH'
};

function calcularNTC(produto) {
  const comp = {};

  comp.DNA = (produto.dna?.linha && produto.dna?.familia) ? 1 : 0;
  comp.TF  = (produto.fiscal?.ncm && /^\d{8}$/.test(produto.fiscal.ncm)) ? 1 : 0;
  comp.FM  = (produto.marca && produto.fabricante) ? 1 : 0;
  comp.CO  = produto.oem_codes?.some(o => o.status === 'CONFIRMADO') ? 1 : 0;
  comp.AV  = produto.aplicacoes?.some(a =>
    a.montadora && a.modelo && a.codigo_motor &&
    a.ano_inicial && a.ano_final && a.combustivel
  ) ? 1 : 0;
  comp.MC  = produto.imagens?.some(i => i.tipo === 'PRINCIPAL' && i.aprovada === true) ? 1 : 0;
  comp.EC  = (produto.unidade_venda && produto.unidade_venda.trim() !== '') ? 1 : 0;
  comp.BTA = (produto.dna?.codigo_dna && produto.dna?.grupo) ? 1 : 0;
  comp.CC  = produto.oem_codes?.some(o =>
    ['EAN','GTIN'].includes(o.tipo) && o.status === 'CONFIRMADO'
  ) ? 1 : 0;
  comp.LG  = (produto.logistica?.peso_bruto &&
    (produto.logistica?.altura || produto.logistica?.comprimento || produto.logistica?.largura)
  ) ? 1 : 0;
  comp.IV  = (produto.midway?.descricao_gerada && produto.midway?.titulo_seo) ? 1 : 0;

  // FI — evidências declaradas em todos os campos com valor
  const evidencias = [
    produto.dna?.linha           ? produto.dna?.evidencia        : undefined,
    produto.fiscal?.ncm          ? produto.fiscal?.ncm_evidencia : undefined,
    produto.marca                ? produto.marca_evidencia        : undefined,
    produto.oem_codes?.find(o => o.status === 'CONFIRMADO')?.codigo
                                 ? produto.oem_codes.find(o => o.status === 'CONFIRMADO')?.evidencia : undefined,
  ].filter(v => v !== undefined);
  comp.FI = evidencias.length > 0 && evidencias.every(v => v && v !== '') ? 1 : 0;

  comp.FP = (produto.ntc?.rast_hash && produto.ntc.rast_hash.startsWith('NCT·')) ? 1 : 0;

  const score = Math.round(
    Object.keys(PESOS).reduce((acc, k) => acc + (comp[k] || 0) * PESOS[k], 0) * 100
  ) / 100;

  const status = score >= 0.95 ? 'APROVADO' : score >= 0.60 ? 'PENDENTE' : 'REPROVADO';
  const faltam = Math.max(0, Math.round((0.95 - score) * 100) / 100);

  const prioridades = Object.keys(PESOS)
    .filter(k => comp[k] === 0)
    .sort((a, b) => PESOS[b] - PESOS[a])
    .slice(0, 4)
    .map(k => ({ componente: k, descricao: DESCRICOES[k], ganho_potencial: PESOS[k] }));

  return {
    score, status,
    calculado_em: new Date(),
    faltam_para_aprovado: faltam,
    prioridades,
    componentes: Object.fromEntries(
      Object.keys(PESOS).map(k => [k, {
        valor:        comp[k] || 0,
        peso:         PESOS[k],
        contribuicao: Math.round((comp[k] || 0) * PESOS[k] * 100) / 100,
        descricao:    DESCRICOES[k],
        evidencia:    obterEvidencia(produto, k)
      }])
    )
  };
}

function obterEvidencia(produto, k) {
  const mapa = {
    DNA: produto.dna?.evidencia || null,
    TF:  produto.fiscal?.ncm_evidencia || null,
    FM:  produto.marca_evidencia || null,
    CO:  produto.oem_codes?.find(o => o.status === 'CONFIRMADO')?.evidencia || null,
    AV:  produto.aplicacoes?.find(a => a.montadora && a.modelo)?.evidencia || null,
    MC:  produto.imagens?.find(i => i.tipo === 'PRINCIPAL')?.url || null,
    EC:  produto.unidade_venda ? 'Operador' : null,
    BTA: produto.dna?.codigo_dna || null,
    CC:  produto.oem_codes?.find(o => ['EAN','GTIN'].includes(o.tipo))?.codigo || null,
    LG:  produto.logistica?.peso_bruto ? `${produto.logistica.peso_bruto}kg` : null,
    IV:  produto.midway?.gerado_em ? `${produto.midway.gerado_em}` : null,
    FI:  null,
    FP:  produto.ntc?.rast_hash || null,
  };
  return mapa[k] || null;
}

function gerarRASTHash(produto) {
  const str = (produto.ref || '') +
    (produto.oem_codes?.find(o => o.status === 'CONFIRMADO')?.codigo || '') +
    (produto.empresa_id || '');
  return 'NCT·' + crypto.createHash('md5')
    .update(str).digest('hex').slice(0, 16).toUpperCase();
}

// REGRA FUNDAMENTAL — nunca sobrescrever campo frozen
function mergeSegurofieldByField(existente, novos) {
  const frozen = existente.frozen_fields || [];
  const resultado = { ...existente };
  Object.keys(novos).forEach(campo => {
    if (frozen.includes(campo)) return;
    if (novos[campo] !== null && novos[campo] !== undefined) {
      resultado[campo] = novos[campo];
    }
  });
  return resultado;
}

// Rejeita aplicação veicular incompleta
function validarAplicacao(av) {
  const obrigatorios = ['montadora','modelo','codigo_motor','ano_inicial','ano_final','combustivel'];
  const faltando = obrigatorios.filter(c => !av[c]);
  if (faltando.length > 0)
    throw new Error(`Aplicação rejeitada — campos ausentes: ${faltando.join(', ')}`);
  if (!['DIESEL','GASOLINA','FLEX','ELETRICO'].includes(av.combustivel))
    throw new Error('Combustível inválido');
  if (Number(av.ano_final) < Number(av.ano_inicial))
    throw new Error('Ano final menor que ano inicial');
  return true;
}

module.exports = { calcularNTC, gerarRASTHash, mergeSegurofieldByField, validarAplicacao, PESOS, DESCRICOES };
