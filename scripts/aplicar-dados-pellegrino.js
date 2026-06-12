#!/usr/bin/env node
// Aplica no NTC os dados extraídos da ficha técnica do portal B2B Pellegrino
// (produto 6183156330 - LuK - KIT EMBREAGEM ATUADOR LUK) e mostra o resultado.
// Fonte: portal Pellegrino (conta Mobis Distribuidora), aba "Ficha Técnica".
// Uso: node scripts/aplicar-dados-pellegrino.js

const ntc = require('../src/services/ntc-engine');

const dados = {
  // ── DNA — confirmado pela ficha Pellegrino ──
  fabricante:        'LuK',
  codigo_fabricante: '6183156330',
  familia_tecnica:   'Embreagem', // categoria do produto no portal (EMBREAGEM)

  // ── FM — nome técnico (4 palavras) ──
  nome: 'KIT EMBREAGEM ATUADOR LUK',

  // ── CO — fiscal (NCM confirmado; CEST/CST/origem ainda PENDENTES) ──
  ncm:    '87089300',
  cest:   null, // PENDENTE — não exibido na ficha do portal
  cst:    null, // PENDENTE
  origem: null, // PENDENTE

  // ── Identificadores ──
  ean: '4014870790165',

  // ── FI — Ficha Física / Pesos ──
  peso_bruto:   3.67,
  peso_liquido: null, // PENDENTE — portal só informa peso bruto

  // ── FP — Dimensões Físicas (metros) ──
  altura:      0.09,
  largura:     0.295,
  comprimento: 0.435,

  // ── AV/TF — Aplicação por motor (PENDENTE — preencher com fonte) ──
  marca:        null,
  modelo:       null,
  motor:        null,
  codigo_motor: null,
  cilindrada:   null,
  ano_inicial:  null,
  ano_final:    null,
  codigo_oem:   null,
};

const resultado = ntc.processar(dados);

console.log('NTC:', resultado.ntc, '→', resultado.decisao);
console.log('\nScores por módulo:');
for (const [chave, score] of Object.entries(resultado.scores)) {
  console.log(`  ${ntc.LABELS[chave]}: ${score}`);
}

console.log('\nImpedimentos:', resultado.impedimentos.length ? resultado.impedimentos : 'nenhum');
console.log('Pode cadastrar:', resultado.podeCadastrar);
console.log('Pode publicar (marketplace):', resultado.podePublicar);
console.log('RAST-HASH:', resultado.rast_hash);
