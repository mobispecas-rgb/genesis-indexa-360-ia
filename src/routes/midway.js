const express = require('express');
const router = express.Router();
const Produto = require('../models/Produto');

// POST /api/midway/:id — gera conteúdo MIDWAY via Claude (gate NTC >= 0.95)
router.post('/:id', async (req, res) => {
  try {
    const produto = await Produto.findById(req.params.id);
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });

    if (!produto.ntc || produto.ntc.score < 0.95) {
      return res.status(400).json({
        erro: `MIDWAY bloqueado — NTC ${produto.ntc?.score || 0} < 0.95`,
        faltam: produto.ntc?.faltam_para_aprovado,
        prioridades: produto.ntc?.prioridades || []
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ erro: 'ANTHROPIC_API_KEY não configurada' });
    }

    const oem = produto.oem_codes?.find(o => o.status === 'CONFIRMADO')?.codigo;
    const aplicacoes_str = produto.aplicacoes
      ?.map(a => `${a.montadora} ${a.modelo} ${a.codigo_motor} ${a.ano_inicial}-${a.ano_final}`)
      .join('; ');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Você é o MIDWAY Indexador Genesis iRollo 360.
Gere conteúdo de catálogo BASEADO EXCLUSIVAMENTE nos dados abaixo.
Nunca invente informações. Nunca infira compatibilidades.

DADOS CERTIFICADOS:
Referência: ${produto.ref}
Linha: ${produto.dna?.linha}
Família: ${produto.dna?.familia}
Grupo: ${produto.dna?.grupo || 'não informado'}
Marca: ${produto.marca}
Fabricante: ${produto.fabricante}
OEM principal: ${oem || 'não informado'}
Aplicações: ${aplicacoes_str || 'não informado'}

Retornar SOMENTE JSON sem markdown:
{"titulo_seo":"...","descricao_gerada":"...","meta_description":"...","tags_seo":["..."]}`
        }]
      })
    });

    const data = await response.json();
    const texto = data.content?.[0]?.text || '';
    let conteudo;
    try {
      conteudo = JSON.parse(texto.replace(/```json|```/g, '').trim());
    } catch (parseErr) {
      return res.status(500).json({ erro: 'Resposta Claude inválida', raw: texto });
    }

    produto.midway = { ...conteudo, gerado_em: new Date() };
    await produto.save();
    res.json({ mensagem: '⚡ MIDWAY gerado com sucesso', midway: produto.midway });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
