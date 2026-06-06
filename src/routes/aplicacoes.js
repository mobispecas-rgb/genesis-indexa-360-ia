const express = require('express');
const router = express.Router();
const Produto = require('../models/Produto');
const { validarAplicacao } = require('../services/ntc-engine');

// POST /api/aplicacoes/:id
router.post('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (produto.frozen_fields?.includes('aplicacoes')) {
      return res.status(400).json({ erro: 'Aplicações estão congeladas' });
    }
    validarAplicacao(req.body);
    produto.aplicacoes.push(req.body);
    await produto.save();
    res.status(201).json(produto.aplicacoes);
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// DELETE /api/aplicacoes/:id/:av_id
router.delete('/:id/:av_id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (produto.frozen_fields?.includes('aplicacoes')) {
      return res.status(400).json({ erro: 'Aplicações estão congeladas' });
    }
    const av = produto.aplicacoes.id(req.params.av_id);
    if (!av) return res.status(404).json({ erro: 'Aplicação não encontrada' });
    av.deleteOne();
    await produto.save();
    res.json({ mensagem: 'Aplicação removida' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
