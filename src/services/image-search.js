'use strict';

const { httpsJSON } = require('./web-utils');

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
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY }
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

  return [];
}

module.exports = { buscarImagensReais };
