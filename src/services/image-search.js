'use strict';

const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const { httpsJSON, ipPrivada } = require('./web-utils');
const { chamarLLM } = require('./llm');

// Verifica se uma URL "sugerida" pelo DeepSeek é de fato uma imagem real e
// acessível (HTTP 200 + Content-Type image/*) antes de aceitá-la — o LLM não
// tem garantia de lembrar links reais de memória, então toda URL sugerida
// passa por essa verificação anti-alucinação (e anti-SSRF) antes de ser
// exibida como "imagem real" do produto.
async function urlEhImagemReal(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch (e) { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  try {
    const enderecos = await dns.lookup(parsed.hostname, { all: true });
    if (enderecos.length === 0 || enderecos.some(e => ipPrivada(e.address))) return false;
  } catch (e) { return false; }

  const proto = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = proto.request(parsed, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      res.resume();
      const tipo = (res.headers['content-type'] || '').toLowerCase();
      resolve(res.statusCode >= 200 && res.statusCode < 300 && tipo.startsWith('image/'));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(6000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Último recurso quando nenhum provedor de busca de imagens (Brave/Serper/
// Google) está configurado: pede ao DeepSeek para SUGERIR urls de imagem que
// ele conheça de catálogos/marketplaces — mas nenhuma URL sugerida é exibida
// sem antes ser verificada de verdade (urlEhImagemReal). É um workaround
// pedido explicitamente; é MENOS confiável que busca de imagem real porque
// depende de o modelo "lembrar" links corretos, e a maioria tende a não
// passar da verificação.
async function buscarImagensViaDeepSeek(q, max = 6) {
  if (!process.env.DEEPSEEK_API_KEY) return [];
  const system = 'Voce e um assistente de catalogacao de autopecas. Quando conhecer, de memoria de treinamento, ' +
    'urls DIRETAS de imagem (terminando em .jpg/.jpeg/.png/.webp) de paginas de produto reais (fabricante, ' +
    'Mercado Livre, Amazon, Shopee, distribuidores), liste-as. Se nao tiver certeza de uma URL real e exata, ' +
    'NAO invente uma — omita. Responda APENAS um JSON array de strings (urls), sem markdown. Se nao conhecer ' +
    'nenhuma URL real, responda [].';
  let candidatos = [];
  try {
    const { texto } = await chamarLLM({ system, userContent: q, maxTokens: 600 });
    const jsonStr = texto.match(/\[[\s\S]*\]/)?.[0] || '[]';
    candidatos = JSON.parse(jsonStr).filter(u => typeof u === 'string');
  } catch (e) {
    console.error('[Imagens] DeepSeek sugestao:', e.message);
    return [];
  }
  if (!candidatos.length) return [];

  const verificacoes = await Promise.all(candidatos.slice(0, max * 3).map(async (url) => ({
    url, ok: await urlEhImagemReal(url),
  })));
  return verificacoes
    .filter(v => v.ok)
    .slice(0, max)
    .map(v => ({ url: v.url, thumb: v.url, titulo: q, fonte: 'deepseek (sugestao verificada)' }));
}

// Busca imagens reais de um produto via Brave Image Search (primario, gratis)
// ou Serper.dev /images (fallback) ou Google Custom Search (terciario).
// Retorna [] se nenhum provedor configurado ou em caso de erro.
async function buscarImagensReais(q, max = 12) {
  if (!q) return [];

  // Brave Image Search (primario - mesma chave da busca web)
  if (process.env.BRAVE_API_KEY) {
    try {
      const encoded = encodeURIComponent(q);
      const count = Math.min(max, 20);
      const data = await httpsJSON({
        hostname: 'api.search.brave.com',
        path: '/res/v1/images/search?q=' + encoded + '&count=' + count + '&country=br&safesearch=off',
        method: 'GET',
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY.trim() }
      });
      if (data.type === 'ErrorResponse' || data.message) {
        console.error('[Imagens] Brave erro:', data.message || JSON.stringify(data));
      } else if (data.results && data.results.length > 0) {
        return data.results.slice(0, max).map(item => ({
          url: item.url || (item.properties && item.properties.url),
          thumb: (item.thumbnail && item.thumbnail.src) || item.url,
          titulo: item.title,
          fonte: item.source || item.page_domain
        })).filter(i => i.url);
      }
    } catch (e) {
      console.error('[Imagens] Brave:', e.message);
    }
  }

  // SERPER /images (fallback)
  if (process.env.SERPER_API_KEY) {
    try {
      const body = JSON.stringify({ q, num: max });
      const data = await httpsJSON({
        hostname: 'google.serper.dev', path: '/images', method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, body);
      if (data.images && data.images.length > 0) {
        return data.images.slice(0, max).map(item => ({
          url: item.imageUrl,
          thumb: item.thumbnailUrl || item.imageUrl,
          titulo: item.title,
          fonte: item.source
        }));
      }
      if (data.message || data.error) console.error('[Imagens] SERPER:', data.message || data.error);
    } catch (e) {
      console.error('[Imagens] SERPER:', e.message);
    }
  }

  // Google Custom Search Images (terciario)
  if (process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX) {
    try {
      const gurl = 'https://www.googleapis.com/customsearch/v1?key=' + process.env.GOOGLE_SEARCH_KEY + '&cx=' + process.env.GOOGLE_SEARCH_CX + '&q=' + encodeURIComponent(q) + '&searchType=image&num=' + Math.min(max, 10);
      const u = new URL(gurl);
      const data = await httpsJSON({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET' });
      return (data.items || []).slice(0, max).map(item => ({
        url: item.link,
        thumb: item.image && item.image.thumbnailLink,
        titulo: item.title,
        fonte: item.displayLink
      }));
    } catch (e) {
      console.error('[Imagens] Google:', e.message);
    }
  }

  // Último recurso (sem nenhum provedor de busca configurado): tenta via
  // DeepSeek + verificação real de URL. Menos confiável que busca de imagem
  // de verdade — configure BRAVE_API_KEY/SERPER_API_KEY para resultados
  // melhores.
  if (!process.env.BRAVE_API_KEY && !process.env.SERPER_API_KEY && !(process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX)) {
    try {
      const viaDeepSeek = await buscarImagensViaDeepSeek(q, max);
      if (viaDeepSeek.length) return viaDeepSeek;
    } catch (e) {
      console.error('[Imagens] DeepSeek fallback:', e.message);
    }
  }

  return [];
}

module.exports = { buscarImagensReais };
