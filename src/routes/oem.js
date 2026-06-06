const express = require('express');
const router = express.Router();
const Produto = require('../models/Produto');

// POST /api/oem/:id — adiciona código OEM
router.post('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (produto.frozen_fields?.includes('oem_codes')) {
      return res.status(400).json({ erro: 'OEM codes estão congelados' });
    }
    const { codigo, fabricante, tipo, status, evidencia } = req.body;
    if (!codigo || !tipo) return res.status(400).json({ erro: 'codigo e tipo são obrigatórios' });
    produto.oem_codes.push({ codigo, fabricante, tipo, status: status || 'PENDENTE', evidencia });
    await produto.save();
    res.status(201).json(produto.oem_codes);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/oem/:id/:oem_id — confirma/atualiza OEM
router.put('/:id/:oem_id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    const oem = produto.oem_codes.id(req.params.oem_id);
    if (!oem) return res.status(404).json({ erro: 'OEM não encontrado' });
    if (oem.frozen) return res.status(400).json({ erro: 'Este OEM está congelado' });
    Object.assign(oem, req.body);
    await produto.save();
    res.json(oem);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// DELETE /api/oem/:id/:oem_id
router.delete('/:id/:oem_id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    const oem = produto.oem_codes.id(req.params.oem_id);
    if (!oem) return res.status(404).json({ erro: 'OEM não encontrado' });
    if (oem.frozen) return res.status(400).json({ erro: 'OEM congelado não pode ser removido' });
    oem.deleteOne();
    await produto.save();
    res.json({ mensagem: 'OEM removido' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
