const express = require('express');
const router = express.Router();
const Produto = require('../models/Produto');

// GET /api/marketplace — produtos aprovados para exportação
router.get('/', async (req, res) => {
  try {
    const { canal, empresa } = req.query;
    const filtro = { status_pipeline: 'APROVADO' };
    if (empresa) filtro.empresa_id = empresa;

    const produtos = await Produto.find(filtro, {
      ref: 1, empresa_id: 1, marca: 1, fabricante: 1,
      dna: 1, oem_codes: 1, aplicacoes: 1, imagens: 1,
      logistica: 1, fiscal: 1, midway: 1, 'ntc.score': 1,
      'ntc.rast_hash': 1, 'ntc.status': 1
    }).sort({ 'ntc.score': -1 });

    res.json({
      total: produtos.length,
      canal: canal || 'generico',
      gerado_em: new Date(),
      produtos
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/marketplace/:id — ficha marketplace de um produto
router.get('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (produto.status_pipeline !== 'APROVADO' && produto.status_pipeline !== 'CONGELADO') {
      return res.status(400).json({
        erro: `Produto não disponível para marketplace — status: ${produto.status_pipeline}`,
        ntc_score: produto.ntc?.score || 0
      });
    }
    res.json({
      ref: produto.ref,
      marca: produto.marca,
      fabricante: produto.fabricante,
      dna: produto.dna,
      oem_codes: produto.oem_codes?.filter(o => o.status === 'CONFIRMADO'),
      aplicacoes: produto.aplicacoes,
      imagens: produto.imagens?.filter(i => i.aprovada),
      logistica: produto.logistica,
      fiscal: { ncm: produto.fiscal?.ncm, cest: produto.fiscal?.cest },
      midway: produto.midway,
      ntc: { score: produto.ntc?.score, status: produto.ntc?.status, rast_hash: produto.ntc?.rast_hash }
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
