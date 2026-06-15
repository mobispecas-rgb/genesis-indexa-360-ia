'use strict';

const { httpsJSON } = require('./web-utils');

// Busca imagens reais de um produto — Serper.dev (primário) ou Google Custom
// Search (fallback). Usado tanto pela rota /api/imagens/buscar quanto pelo
// job de auto-enriquecimento para "colonizar" imagens reais (módulo IV).
// Retorna [] (nunca inventa) se nenhum provedor estiver configurado ou em caso de erro.
async function buscarImagensReais(q, max = 12) {
  if (!q) return [];

  if (process.env.SERPER_API_KEY) {
    try {
      const body = JSON.stringify({ q, num: max });
      const data = await httpsJSON({
        hostname: 'google.serper.dev', path: '/images', method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, body);
      return (data.images || []).slice(0, max).map(item => ({
        url: item.imageUrl,
        thumb: item.thumbnailUrl || item.imageUrl,
        titulo: item.title,
        fonte: item.source
      }));
    } catch (e) {
      console.error('[Imagens Reais] Serper:', e.message);
    }
  }

  if (process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX) {
    try {
      const url = new URL(`https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_SEARCH_KEY}&cx=${process.env.GOOGLE_SEARCH_CX}&q=${encodeURIComponent(q)}&searchType=image&num=${Math.min(max, 10)}`);
      const data = await httpsJSON({ hostname: url.hostname, path: url.pathname + url.search, method: 'GET' });
      return (data.items || []).slice(0, max).map(item => ({
        url: item.link,
        thumb: item.image && item.image.thumbnailLink,
        titulo: item.title,
        fonte: item.displayLink
      }));
    } catch (e) {
      console.error('[Imagens Reais] Google:', e.message);
    }
  }

  return [];
}

module.exports = { buscarImagensReais };
