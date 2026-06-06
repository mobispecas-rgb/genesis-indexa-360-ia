const express = require('express');
const router = express.Router();
const Produto = require('../models/Produto');
const { calcularNTC, gerarRASTHash } = require('../services/ntc-engine');

// POST /api/ntc/:id/calcular
router.post('/:id/calcular', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });

    const ntcResultado = calcularNTC(produto.toObject());
    const rastHash = gerarRASTHash(produto.toObject());

    if (!produto.ntc) produto.ntc = {};
    const historicoAtual = produto.ntc.historico || [];
    if (produto.ntc.calculado_em) {
      historicoAtual.push({
        score: produto.ntc.score || 0,
        status: produto.ntc.status || 'REPROVADO',
        calculado_em: produto.ntc.calculado_em
      });
    }

    produto.ntc = {
      ...ntcResultado,
      rast_hash: rastHash,
      historico: historicoAtual.slice(-10)
    };

    if (ntcResultado.status === 'APROVADO') produto.status_pipeline = 'APROVADO';
    else if (ntcResultado.status === 'REPROVADO') produto.status_pipeline = 'REPROVADO';
    else produto.status_pipeline = 'CERTIFICANDO';

    await produto.save();
    res.json({
      score: ntcResultado.score,
      status: ntcResultado.status,
      rast_hash: rastHash,
      faltam_para_aprovado: ntcResultado.faltam_para_aprovado,
      prioridades: ntcResultado.prioridades,
      componentes: ntcResultado.componentes,
      historico: produto.ntc.historico
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/ntc/:id/laudo — laudo completo com evidências
router.get('/:id/laudo', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (!produto.ntc || !produto.ntc.calculado_em) {
      return res.status(400).json({ erro: 'NTC ainda não calculado para este produto' });
    }
    res.json({
      produto_ref:  produto.ref,
      produto_id:   produto._id,
      score:        produto.ntc.score,
      status:       produto.ntc.status,
      rast_hash:    produto.ntc.rast_hash,
      calculado_em: produto.ntc.calculado_em,
      faltam_para_aprovado: produto.ntc.faltam_para_aprovado,
      prioridades:  produto.ntc.prioridades,
      componentes:  produto.ntc.componentes,
      historico:    produto.ntc.historico,
      aviso: 'Evidências visíveis acima — nenhuma informação está oculta'
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
