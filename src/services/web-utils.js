'use strict';

const https = require('https');

// Faz uma requisição HTTPS e resolve com o JSON da resposta.
// Aborta com erro após `timeoutMs` para evitar requisições penduradas
// (causa de "travamentos" quando Bling/Wix/Serper não respondem).
function httpsJSON(opts, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, r => {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout: sem resposta de ${opts.hostname} em ${timeoutMs/1000}s`)));
    if (body) req.write(body);
    req.end();
  });
}

// Valida checksum de GTIN-8/12/13/14 (módulo 10, peso 3/1 a partir do dígito mais à direita)
function validarGTIN(codigo) {
  const digitos = String(codigo == null ? '' : codigo).replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digitos.length)) return false;
  const nums = digitos.split('').map(Number);
  const check = nums.pop();
  let soma = 0;
  for (let i = 0; i < nums.length; i++) {
    const posicaoDaDireita = nums.length - i;
    soma += nums[i] * (posicaoDaDireita % 2 === 1 ? 3 : 1);
  }
  const digitoCalculado = (10 - (soma % 10)) % 10;
  return digitoCalculado === check;
}

// Valida NCM: precisa ter exatamente 8 dígitos numéricos (TIPI). Retorna o código limpo ou null.
function validarNCM(codigo) {
  const digitos = String(codigo == null ? '' : codigo).replace(/\D/g, '');
  return digitos.length === 8 ? digitos : null;
}

// Consulta a tabela TIPI oficial (BrasilAPI) para confirmar se o NCM existe.
// Retorna a descrição oficial do código, ou null se não encontrado/erro.
async function consultarNCMOficial(ncm8) {
  try {
    const data = await httpsJSON({ hostname: 'brasilapi.com.br', path: '/api/ncm/v1/' + ncm8, method: 'GET' }, null, 8000);
    return (data && data.codigo && data.descricao) ? data.descricao : null;
  } catch (e) {
    return null;
  }
}

// Busca web com fallback: Serper.dev (primário) → Google Custom Search (secundário)
async function buscarWeb(q, num = 10) {
  const resultados = [];
  if (process.env.SERPER_API_KEY) {
    try {
      const body = JSON.stringify({ q, num, gl: 'br', hl: 'pt-br' });
      const data = await httpsJSON({
        hostname: 'google.serper.dev', path: '/search', method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, body);
      (data.organic || []).forEach(item => {
        if (item.title && item.snippet) resultados.push({ titulo: item.title, fonte: item.link, trecho: item.snippet });
      });
    } catch (e) {
      console.error('[Busca Web] Serper:', e.message);
    }
  }
  if (resultados.length < num && process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX) {
    try {
      const url = new URL(`https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_SEARCH_KEY}&cx=${process.env.GOOGLE_SEARCH_CX}&q=${encodeURIComponent(q)}&num=10`);
      const data = await httpsJSON({ hostname: url.hostname, path: url.pathname + url.search, method: 'GET' });
      (data.items || []).forEach(item => {
        if (item.title && item.snippet && !resultados.some(r => r.fonte === item.link)) {
          resultados.push({ titulo: item.title, fonte: item.link, trecho: item.snippet });
        }
      });
    } catch (e) {
      console.error('[Busca Web] Google:', e.message);
    }
  }
  return resultados.slice(0, num);
}

module.exports = { httpsJSON, validarGTIN, validarNCM, consultarNCMOficial, buscarWeb };
