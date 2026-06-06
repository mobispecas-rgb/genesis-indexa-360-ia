const express = require('express');
const router = express.Router();
const Produto = require('../models/Produto');

// POST /api/imagens/:id — adiciona imagem
router.post('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    const { url, tipo, resolucao } = req.body;
    if (!url || !tipo) return res.status(400).json({ erro: 'url e tipo são obrigatórios' });
    produto.imagens.push({ url, tipo, aprovada: false, resolucao });
    await produto.save();
    res.status(201).json(produto.imagens);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/imagens/:id/:img_id/aprovar
router.put('/:id/:img_id/aprovar', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    const img = produto.imagens.id(req.params.img_id);
    if (!img) return res.status(404).json({ erro: 'Imagem não encontrada' });
    img.aprovada = true;
    await produto.save();
    res.json(img);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// DELETE /api/imagens/:id/:img_id
router.delete('/:id/:img_id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    const img = produto.imagens.id(req.params.img_id);
    if (!img) return res.status(404).json({ erro: 'Imagem não encontrada' });
    img.deleteOne();
    await produto.save();
    res.json({ mensagem: 'Imagem removida' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
