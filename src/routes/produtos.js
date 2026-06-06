const express = require('express');
const router = express.Router();
const Produto = require('../models/Produto');
const { calcularNTC, gerarRASTHash } = require('../services/ntc-engine');

// GET /api/produtos — lista com filtros
router.get('/', async (req, res) => {
  try {
    const { status, ntc_min, ntc_max, empresa } = req.query;
    const filtro = {};
    if (status)   filtro.status_pipeline = status;
    if (empresa)  filtro.empresa_id = empresa;
    if (ntc_min || ntc_max) {
      filtro['ntc.score'] = {};
      if (ntc_min) filtro['ntc.score'].$gte = parseFloat(ntc_min);
      if (ntc_max) filtro['ntc.score'].$lte = parseFloat(ntc_max);
    }
    const produtos = await Produto.find(filtro).sort({ atualizado_em: -1 });
    res.json({ total: produtos.length, produtos });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// POST /api/produtos — cria rascunho
router.post('/', async (req, res) => {
  try {
    const { ref, descricao_bruta, empresa_id } = req.body;
    if (!ref) return res.status(400).json({ erro: 'ref é obrigatório' });
    const produto = new Produto({
      ref,
      empresa_id: empresa_id || 'MOBIS',
      dna: { descricao_bruta: descricao_bruta || null },
      status_pipeline: 'RASCUNHO'
    });
    await produto.save();
    res.status(201).json(produto);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/produtos/:id — ficha completa
router.get('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json(produto);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/produtos/:id/dna — atualiza DNA (merge seguro)
router.put('/:id/dna', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    const frozen = produto.frozen_fields || [];
    if (!frozen.includes('dna')) {
      Object.keys(req.body).forEach(k => {
        if (req.body[k] !== null && req.body[k] !== undefined) {
          produto.dna[k] = req.body[k];
        }
      });
    }
    produto.status_pipeline = 'CERTIFICANDO';
    await produto.save();
    res.json(produto);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/produtos/:id/fiscal
router.put('/:id/fiscal', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (req.body.ncm && !/^\d{8}$/.test(req.body.ncm)) {
      return res.status(400).json({ erro: 'NCM deve ter exatamente 8 dígitos' });
    }
    const frozen = produto.frozen_fields || [];
    if (!frozen.includes('fiscal')) {
      Object.keys(req.body).forEach(k => {
        if (req.body[k] !== null && req.body[k] !== undefined) {
          produto.fiscal[k] = req.body[k];
        }
      });
    }
    await produto.save();
    res.json(produto);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/produtos/:id/logistica
router.put('/:id/logistica', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    const frozen = produto.frozen_fields || [];
    if (!frozen.includes('logistica')) {
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
    }
    await produto.save();
    res.json(produto);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/produtos/:id/marca
router.put('/:id/marca', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    const frozen = produto.frozen_fields || [];
    if (!frozen.includes('marca')) {
      if (req.body.marca)           produto.marca = req.body.marca;
      if (req.body.fabricante)      produto.fabricante = req.body.fabricante;
      if (req.body.marca_evidencia) produto.marca_evidencia = req.body.marca_evidencia;
    }
    await produto.save();
    res.json(produto);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/produtos/:id/unidade
router.put('/:id/unidade', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (req.body.unidade_venda) produto.unidade_venda = req.body.unidade_venda;
    await produto.save();
    res.json(produto);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// POST /api/produtos/:id/congelar
router.post('/:id/congelar', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (!produto.ntc || produto.ntc.score < 0.95) {
      return res.status(400).json({
        erro: `Congelamento bloqueado — NTC ${produto.ntc?.score || 0} < 0.95`,
        prioridades: produto.ntc?.prioridades || []
      });
    }
    produto.status_pipeline = 'CONGELADO';
    produto.frozen_fields = ['dna','oem_codes','aplicacoes','fiscal','marca','fabricante'];
    await produto.save();
    res.json({ mensagem: '❄️ Produto congelado com sucesso', produto });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// DELETE /api/produtos/:id
router.delete('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    if (produto.status_pipeline === 'CONGELADO') {
      return res.status(400).json({ erro: 'Produto CONGELADO não pode ser apagado' });
    }
    await produto.deleteOne();
    res.json({ mensagem: 'Produto removido' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
