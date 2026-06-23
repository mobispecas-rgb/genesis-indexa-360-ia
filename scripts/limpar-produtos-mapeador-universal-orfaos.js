'use strict';

// Limpeza única: remove produtos cadastrados pelo Mapeador Universal antes da
// correção do botão "Excluir Selecionados" (que não chamava a API de exclusão
// e deixava os registros "fantasma" acumulados no banco, inflando a contagem
// da aba Performance).
//
// Critério: fonte = 'mapeador_universal' E nunca passou por enriquecimento
// real (ntc nulo ou decisao = 'REPROVADO', ou seja, nunca chegou a 'APROVADO'
// nem foi revisado manualmente). Roda uma vez via:
//   node scripts/limpar-produtos-mapeador-universal-orfaos.js
//   node scripts/limpar-produtos-mapeador-universal-orfaos.js --confirmar
//
// Sem a flag --confirmar, só lista quantos registros seriam removidos (modo
// dry-run), para conferência antes de aplicar de fato.

const db = require('../src/services/db');

function limpar() {
  const confirmar = process.argv.includes('--confirmar');

  const candidatos = db.db
    .prepare(
      `SELECT id, sku, nome, decisao, ntc FROM produtos
       WHERE fonte = 'mapeador_universal'
         AND (ntc IS NULL OR decisao != 'APROVADO')`,
    )
    .all();

  console.log(`Encontrados ${candidatos.length} produtos órfãos do Mapeador Universal (não enriquecidos/aprovados).`);

  if (!confirmar) {
    console.log('Modo dry-run (nada foi removido). Rode novamente com --confirmar para aplicar a exclusão.');
    return;
  }

  const excluirEmbeddings = db.db.prepare('DELETE FROM produto_embeddings WHERE produto_id = ?');
  const excluirProduto = db.db.prepare('DELETE FROM produtos WHERE id = ?');

  const transacao = db.db.transaction((ids) => {
    for (const id of ids) {
      excluirEmbeddings.run(id);
      excluirProduto.run(id);
    }
  });

  transacao(candidatos.map((p) => p.id));
  console.log(`Removidos ${candidatos.length} produtos órfãos com sucesso.`);
}

limpar();
