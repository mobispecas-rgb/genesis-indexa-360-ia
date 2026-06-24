'use strict';

// ============================================================
// Agente Universal de IA — DeepSeek (único provedor, única API)
// Substitui a cadeia anterior (Gemini → Claude) por um único
// motor, para simplificar o controle de erros do sistema.
// ============================================================
const { httpsJSON } = require('./web-utils');

async function chamarLLM({ system, userContent, maxTokens = 1000 }) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY nao configurada');
  }
  const body = JSON.stringify({
    model: 'deepseek-chat',
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
  });
  const data = await httpsJSON({
    hostname: 'api.deepseek.com', path: '/chat/completions', method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body, 75000);
  if (data.error) throw new Error(data.error.message || 'Erro DeepSeek');
  const texto = data?.choices?.[0]?.message?.content || '';
  const finishReason = data?.choices?.[0]?.finish_reason || null;
  return { texto, motor: 'DeepSeek Chat', finishReason };
}

async function verificarStatus() {
  if (!process.env.DEEPSEEK_API_KEY) {
    return { ok: false, configurado: false, mensagem: 'Configure DEEPSEEK_API_KEY no Render' };
  }
  try {
    await chamarLLM({ system: 'Responda apenas "ok".', userContent: 'ping', maxTokens: 5 });
    return { ok: true, configurado: true, mensagem: 'Motor IA conectado — DeepSeek Chat' };
  } catch (e) {
    return { ok: false, configurado: false, mensagem: e.message };
  }
}

module.exports = { chamarLLM, verificarStatus };
