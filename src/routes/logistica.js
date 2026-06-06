const express = require('express');
const router = express.Router();
const Produto = require('../models/Produto');

// GET /api/logistica/:id
router.get('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id, 'ref logistica frozen_fields');
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json({ ref: produto.ref, logistica: produto.logistica, frozen: produto.frozen_fields?.includes('logistica') });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/logistica/:id
router.put('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (produto.frozen_fields?.includes('logistica')) {
      return res.status(400).json({ erro: 'Dados logísticos estão congelados' });
    }
    Object.keys(req.body).forEach(k => {
      if (req.body[k] !== null && req.body[k] !== undefined) {
        produto.logistica[k] = req.body[k];
      }
    });
    const l = produto.logistica;
    if (l.altura && l.largura && l.comprimento) {
      produto.logistica.volume = Math.round(
        (l.altura * l.largura * l.comprimento) / 1000000 * 1000
      ) / 1000;
    }
    await produto.save();
    res.json(produto.logistica);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
