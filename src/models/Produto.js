const mongoose = require('mongoose');

const OEMSchema = new mongoose.Schema({
  codigo:     { type: String, required: true },
  fabricante: { type: String, default: null },
  tipo:       { type: String, enum: ['OEM','OEM_SUBSTITUIDO','AFTERMARKET','EAN','GTIN'], required: true },
  status:     { type: String, enum: ['CONFIRMADO','PENDENTE'], default: 'PENDENTE' },
  evidencia:  { type: String, default: null },
  frozen:     { type: Boolean, default: false }
});

const AplicacaoSchema = new mongoose.Schema({
  montadora:    { type: String, required: true },
  modelo:       { type: String, required: true },
  versao:       { type: String, default: null },
  codigo_motor: { type: String, required: true },
  cilindrada:   { type: String, default: null },
  combustivel:  { type: String, enum: ['DIESEL','GASOLINA','FLEX','ELETRICO'], required: true },
  ano_inicial:  { type: Number, required: true },
  ano_final:    { type: Number, required: true },
  evidencia:    { type: String, default: null }
});

const ImagemSchema = new mongoose.Schema({
  url:       { type: String, required: true },
  tipo:      { type: String, enum: ['PRINCIPAL','LATERAL','TECNICA','DETALHE','EMBALAGEM'], required: true },
  aprovada:  { type: Boolean, default: false },
  resolucao: { type: String, default: null }
});

const ComponenteNTCSchema = new mongoose.Schema({
  valor:        { type: Number, default: 0 },
  peso:         { type: Number, required: true },
  contribuicao: { type: Number, default: 0 },
  descricao:    { type: String },
  evidencia:    { type: String, default: null }
}, { _id: false });

const NTCSchema = new mongoose.Schema({
  score:                { type: Number, default: 0 },
  status:               { type: String, enum: ['APROVADO','PENDENTE','REPROVADO'], default: 'REPROVADO' },
  calculado_em:         { type: Date },
  faltam_para_aprovado: { type: Number, default: 0.95 },
  prioridades:          [{ componente: String, descricao: String, ganho_potencial: Number }],
  componentes: {
    DNA: ComponenteNTCSchema,
    TF:  ComponenteNTCSchema,
    FM:  ComponenteNTCSchema,
    CO:  ComponenteNTCSchema,
    AV:  ComponenteNTCSchema,
    MC:  ComponenteNTCSchema,
    EC:  ComponenteNTCSchema,
    BTA: ComponenteNTCSchema,
    CC:  ComponenteNTCSchema,
    LG:  ComponenteNTCSchema,
    IV:  ComponenteNTCSchema,
    FI:  ComponenteNTCSchema,
    FP:  ComponenteNTCSchema,
  },
  rast_hash: { type: String, default: null },
  historico: [{ score: Number, status: String, calculado_em: Date }]
}, { _id: false });

const ProdutoSchema = new mongoose.Schema({
  ref:           { type: String, required: true },
  empresa_id:    { type: String, default: 'MOBIS' },
  unidade_venda: { type: String, default: null },

  dna: {
    descricao_bruta: { type: String, default: null },
    linha:           { type: String, default: null },
    familia:         { type: String, default: null },
    grupo:           { type: String, default: null },
    codigo_dna:      { type: String, default: null },
    origem_pais:     { type: String, default: null },
    evidencia:       { type: String, default: null }
  },

  marca:           { type: String, default: null },
  fabricante:      { type: String, default: null },
  marca_evidencia: { type: String, default: null },

  oem_codes:  [OEMSchema],
  aplicacoes: [AplicacaoSchema],
  imagens:    [ImagemSchema],

  fiscal: {
    ncm:           { type: String, default: null },
    cest:          { type: String, default: null },
    cfop:          { type: String, default: null },
    origem:        { type: Number, default: null },
    ipi:           { type: Number, default: null },
    icms:          { type: Number, default: null },
    pis:           { type: Number, default: null },
    cofins:        { type: Number, default: null },
    ncm_evidencia: { type: String, default: null }
  },

  logistica: {
    peso_liq:    { type: Number, default: null },
    peso_bruto:  { type: Number, default: null },
    altura:      { type: Number, default: null },
    largura:     { type: Number, default: null },
    comprimento: { type: Number, default: null },
    volume:      { type: Number, default: null },
    evidencia:   { type: String, default: null }
  },

  midway: {
    descricao_gerada:  { type: String, default: null },
    titulo_seo:        { type: String, default: null },
    meta_description:  { type: String, default: null },
    tags_seo:          [String],
    gerado_em:         { type: Date, default: null }
  },

  ntc: { type: NTCSchema, default: () => ({}) },

  status_pipeline: {
    type: String,
    enum: ['RASCUNHO','CERTIFICANDO','APROVADO','REPROVADO','CONGELADO'],
    default: 'RASCUNHO'
  },
  frozen_fields: [String]

}, { timestamps: { createdAt: 'criado_em', updatedAt: 'atualizado_em' } });

module.exports = mongoose.model('Produto', ProdutoSchema);
