'use strict';

const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const net = require('net');
const zlib = require('zlib');

// Verifica se um IP é privado/local — usado para impedir SSRF no fetch de páginas
function ipPrivada(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168)
      || (p[0] === 169 && p[1] === 254);
  }
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    return lo === '::1' || lo.startsWith('fe80:') || lo.startsWith('fc') || lo.startsWith('fd') || lo.startsWith('::ffff:127.');
  }
  return true; // formato desconhecido — bloqueia por segurança
}

// Busca o HTML de uma URL pública (anti-SSRF) seguindo poucos redirecionamentos.
async function fetchHtmlSeguro(urlStr, redirectsLeft = 3) {
  const parsed = new URL(urlStr);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Apenas URLs http/https são permitidas');
  }
  const enderecos = await dns.lookup(parsed.hostname, { all: true });
  if (enderecos.length === 0 || enderecos.some(e => ipPrivada(e.address))) {
    throw new Error('URL aponta para um endereço interno/privado — não permitido');
  }
  const proto = parsed.protocol === 'https:' ? https : http;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1'
  };
  return new Promise((resolve, reject) => {
    const r = proto.get(parsed, { headers }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirectsLeft > 0) {
        response.resume();
        const proxima = new URL(response.headers.location, parsed);
        resolve(fetchHtmlSeguro(proxima.href, redirectsLeft - 1));
        return;
      }
      if (response.statusCode >= 400) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} ao acessar a URL`));
        return;
      }
      const partes = [];
      let tamanho = 0;
      response.on('data', chunk => {
        tamanho += chunk.length;
        if (tamanho > 3 * 1024 * 1024) { response.destroy(); reject(new Error('Página muito grande (limite 3MB)')); return; }
        partes.push(chunk);
      });
      response.on('end', () => {
        const buffer = Buffer.concat(partes);
        const codificacao = (response.headers['content-encoding'] || '').toLowerCase();
        try {
          const descompactado = codificacao === 'br' ? zlib.brotliDecompressSync(buffer)
            : codificacao === 'gzip' ? zlib.gunzipSync(buffer)
            : codificacao === 'deflate' ? zlib.inflateSync(buffer)
            : buffer;
          resolve(descompactado.toString('utf8'));
        } catch (e) {
          resolve(buffer.toString('utf8'));
        }
      });
      response.on('error', reject);
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('Timeout ao acessar a URL')));
  });
}

// Extrai texto limpo de HTML — remove tags, scripts, estilos
function htmlParaTexto(html, maxChars = 4000) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
  return t.length > maxChars ? t.substring(0, maxChars) : t;
}

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

  // 3. Fetch real das 3 primeiras páginas para capturar "Similares", aplicações completas, etc.
  // Snippet do Google tem ~150 chars — seções como "Similares: NAKATA 42835 · CORVEN N444128"
  // só aparecem no corpo completo da página.
  const top3 = resultados.slice(0, 3);
  await Promise.all(top3.map(async (item, idx) => {
    try {
      const html = await fetchHtmlSeguro(item.fonte);
      const textoCompleto = htmlParaTexto(html, 5000);
      if (textoCompleto.length > item.trecho.length) {
        resultados[idx].trecho = textoCompleto;
        resultados[idx].trecho_completo = true;
      }
    } catch (e) {
      // Silencia erros de fetch individual — snippet do Google ainda está disponível
    }
  }));

  return resultados.slice(0, num);
}

module.exports = { httpsJSON, validarGTIN, validarNCM, consultarNCMOficial, buscarWeb, fetchHtmlSeguro, htmlParaTexto, ipPrivada };
