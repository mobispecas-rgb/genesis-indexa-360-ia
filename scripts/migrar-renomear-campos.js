'use strict';

// Migração única: renomeia chaves dentro de `dados_json` (tabela `produtos`)
// para o novo esquema de nomenclatura automotiva:
//   codigo_oem -> part_number_automotivo
//   motor      -> motorizacao_alvo_veiculo
//   posicao    -> posicao_montagem_peca
// Não sobrescreve um valor já existente na chave nova; só migra quando a
// chave nova está vazia/ausente. Roda uma vez via: node scripts/migrar-renomear-campos.js
const db = require('../src/services/db');

const RENOMEACOES = [
  ['codigo_oem', 'part_number_automotivo'],
  ['motor', 'motorizacao_alvo_veiculo'],
  ['posicao', 'posicao_montagem_peca'],
];

function migrar() {
  const rows = db.db.prepare('SELECT id, dados_json FROM produtos').all();
  let alterados = 0;
  const update = db.db.prepare('UPDATE produtos SET dados_json = ? WHERE id = ?');

  for (const row of rows) {
    let dados;
    try { dados = JSON.parse(row.dados_json || '{}'); } catch (_) { continue; }

    let mudou = false;
    for (const [antiga, nova] of RENOMEACOES) {
      if (dados[antiga] != null && dados[antiga] !== '' && (dados[nova] == null || dados[nova] === '')) {
        dados[nova] = dados[antiga];
        mudou = true;
      }
      if (antiga in dados) {
        delete dados[antiga];
        mudou = true;
      }
    }

    if (mudou) {
      update.run(JSON.stringify(dados), row.id);
      alterados++;
    }
  }

  console.log(`[Migração] ${alterados} de ${rows.length} produto(s) atualizado(s).`);
}

migrar();
