const express = require('express');
const router = express.Router();
const Produto = require('../models/Produto');

// GET /api/fiscal/:id
router.get('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id, 'ref fiscal frozen_fields');
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json({ ref: produto.ref, fiscal: produto.fiscal, frozen: produto.frozen_fields?.includes('fiscal') });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/fiscal/:id
router.put('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (produto.frozen_fields?.includes('fiscal')) {
      return res.status(400).json({ erro: 'Dados fiscais estão congelados' });
    }
    if (req.body.ncm && !/^\d{8}$/.test(req.body.ncm)) {
      return res.status(400).json({ erro: 'NCM deve ter exatamente 8 dígitos' });
    }
    Object.keys(req.body).forEach(k => {
      if (req.body[k] !== null && req.body[k] !== undefined) {
        produto.fiscal[k] = req.body[k];
      }
    });
    await produto.save();
    res.json(produto.fiscal);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
