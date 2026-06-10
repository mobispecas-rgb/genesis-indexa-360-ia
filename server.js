// ============================================================
// INDEXAAI CATALOG PRO — Motor NTC 4.0 Enterprise — SERVIDOR PRINCIPAL
// Node.js + Express | MOBIS Pecas Automotivas
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;

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

// -----------------------------------------------------------
// MIDDLEWARES
// -----------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir arquivos estaticos (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Logger
app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${req.method} ${req.path}`);
    next();
});

// -----------------------------------------------------------
// ROTAS API
// -----------------------------------------------------------

// Health check
app.get('/api/health', (req, res) => {
    res.json({
          ok: true,
          status: 'online',
          sistema: 'IndexaAí.com — Motor NTC 4.0',
          uptime: Math.round(process.uptime()),
          timestamp: new Date().toISOString()
    });
});

// Status
app.get('/api/status', (req, res) => {
    res.json({
          ok: true,
          versao: '4.0.0',
          sistema: 'IndexaAí.com',
          empresa: 'MOBIS Pecas Automotivas'
    });
});

// Auth routes (stub)
app.post('/api/auth/login', (req, res) => {
    const { email, senha } = req.body;
    // Credenciais fixas por enquanto
    if (email === 'mobispecas@gmail.com' && senha === 'mobis2024') {
        return res.json({ ok: true, token: 'genesis-token-' + Date.now(), usuario: { nome: 'Jose Nunes Jr.', empresa: 'MOBIS Peças' } });
    }
    res.status(401).json({ ok: false, erro: 'Credenciais inválidas.' });
});

app.get('/api/auth/verificar', (req, res) => {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer genesis-token-')) {
        return res.json({ ok: true });
    }
    res.status(401).json({ ok: false, erro: 'Token inválido.' });
});

app.post('/api/auth/alterar-senha', (req, res) => {
    res.json({ ok: true, mensagem: 'Senha alterada com sucesso!' });
});

// Motor IA — Gerar descrição (Voz do Lojista)
app.post('/api/motor/voz', async (req, res) => {
    const { perfil, prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, erro: 'Prompt obrigatório' });

    try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 400,
            system: `Você é um redator técnico de autopeças. Regras absolutas:
1. USE SOMENTE os dados fornecidos pelo usuário. NUNCA invente.
2. Se um campo não estiver nos dados: NÃO mencione, NÃO estime, NÃO deduza.
3. NUNCA invente: OEM, NCM, EAN, aplicação veicular, motor, pressão, torque, material, medida ou garantia.
4. Se os dados forem insuficientes para uma frase completa, responda apenas: "Dados insuficientes para gerar descrição. Complete os campos obrigatórios."
5. Máximo 2 frases. Sem bullet points. Sem markdown.`,
            messages: [{ role: 'user', content: prompt }]
        });
        const texto = msg.content?.[0]?.text || '';
        res.json({ ok: true, texto, perfil });
    } catch (e) {
        console.error('[Voz IA]', e.message);
        res.json({ ok: false, erro: e.message });
    }
});

// ─── NTC Engine (Núcleo de Triangulação Certificada) ─────────
const ntcEngine = require('./src/services/ntc-engine');

// Motor NTC — 13 componentes — NUNCA inventa dados
app.post('/api/motor/nct', (req, res) => {
    const resultado = ntcEngine.processar(req.body);
    res.json({ ok: true, ...resultado, nct: resultado.ntc, nct_componentes: resultado.componentes });
});

// Motor Hash
app.post('/api/motor/hash', (req, res) => {
    const { sku, oem, empresa } = req.body;
    const rast_hash = ntcEngine.gerarRastHash({ codigo_oem: oem || sku, fabricante: empresa || 'MOBIS' });
    res.json({ ok: true, rast_hash });
});

// Motor Enriquecer — NULL em campos sem evidência documental
app.post('/api/motor/enriquecer', (req, res) => {
    const dados = req.body;
    if (!dados.oem && !dados.nome && !dados.codigo_oem) {
        return res.status(400).json({ ok: false, erro: 'OEM ou Nome obrigatório' });
    }
    if (!dados.codigo_oem) dados.codigo_oem = dados.oem || null;

    const resultado = ntcEngine.processar(dados);
    const aplicacaoVeicular = (dados.marca && dados.modelo && dados.motor)
        ? [dados.marca, dados.modelo, dados.versao, dados.motor, dados.cilindrada,
           dados.ano_inicial && dados.ano_final
               ? dados.ano_inicial + '-' + dados.ano_final
               : dados.ano_inicial || null
          ].filter(Boolean).join(' ')
        : null;

    res.json({
        ok: true,
        ...resultado,
        nct: resultado.ntc,
        nct_componentes: resultado.componentes,
        modelo_ia: 'IndexaAí Motor NTC 4.0',
        enriquecimento: {
            nome_enriquecido:        dados.nome          || null,
            ncm_sugerido:            dados.ncm           || null,
            aplicacao_veicular:      aplicacaoVeicular,
            descricao_tecnica:       null,
            sistema_veiculo:         null,
            reino:                   null,
            material_composicao:     dados.material      || null,
            confianca_enriquecimento: resultado.ntc,
        },
        aviso: resultado.bloqueios.length > 0
            ? resultado.bloqueios.join(' | ')
            : null,
    });
});

// Proxy de imagem — evita bloqueio por hotlinking/CORS no navegador
app.get('/api/imagens/proxy', (req, res) => {
    const imgUrl = req.query.url;
    if (!imgUrl) return res.status(400).end();
    try {
        const parsed = new URL(imgUrl);
        const proto = parsed.protocol === 'https:' ? require('https') : require('http');
        const opts = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': parsed.origin } };
        const imgReq = proto.get(opts, imgRes => {
            res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            imgRes.pipe(res);
        }).on('error', () => res.status(502).end());
        imgReq.setTimeout(15000, () => imgReq.destroy(new Error('Timeout')));
    } catch(e) {
        res.status(400).end();
    }
});

// Busca de Imagens — Serper.dev (primário) ou Google Custom Search (fallback)
app.get('/api/imagens/buscar', async (req, res) => {
    const { q, fonte } = req.query;
    if (!q) return res.json({ ok: false, erro: 'Parametro q obrigatorio', imagens: [] });

    // 1) Serper.dev — 2.500 buscas grátis, depois $1/1.000 (só 1 chave)
    if (process.env.SERPER_API_KEY) {
        try {
            const body = JSON.stringify({ q, num: 12 });
            const data = await httpsJSON({
                hostname: 'google.serper.dev', path: '/images', method: 'POST',
                headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, body);
            const imagens = (data.images||[]).map(item => ({
                url: item.imageUrl,
                thumb: item.thumbnailUrl || item.imageUrl,
                titulo: item.title,
                fonte: item.source
            }));
            return res.json({ ok: true, imagens, total: imagens.length, q, fonte, provider: 'serper' });
        } catch(e) {
            return res.json({ ok: false, erro: 'Erro Serper: ' + e.message, imagens: [] });
        }
    }

    // 2) Google Custom Search — 100 buscas/dia grátis (fallback)
    if (process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX) {
        try {
            const url = new URL(`https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_SEARCH_KEY}&cx=${process.env.GOOGLE_SEARCH_CX}&q=${encodeURIComponent(q)}&searchType=image&num=12`);
            const data = await httpsJSON({ hostname: url.hostname, path: url.pathname + url.search, method: 'GET' });
            const imagens = (data.items||[]).map(item => ({
                url: item.link,
                thumb: item.image && item.image.thumbnailLink,
                titulo: item.title,
                fonte: item.displayLink
            }));
            return res.json({ ok: true, imagens, total: imagens.length, q, fonte, provider: 'google' });
        } catch(e) {
            return res.json({ ok: false, erro: 'Erro Google Search: ' + e.message, imagens: [] });
        }
    }

    // Sem API configurada
    res.json({
        ok: false, imagens: [],
        mensagem: 'Configure SERPER_API_KEY no Render para busca de imagens (2.500 buscas grátis em serper.dev).',
        q, fonte
    });
});

// Produtos (stub)
app.get('/api/produtos', (req, res) => {
    res.json({ ok: true, produtos: [], total: 0 });
});
app.post('/api/produtos', (req, res) => {
    const rast_hash = require('crypto').createHash('md5').update((req.body.sku||'')+(req.body.oem||'')+'MOBIS').digest('hex').substring(0,16);
    res.json({ ok: true, id_bling: 'LOCAL-' + Date.now(), nct: 0.90, rast_hash });
});
app.delete('/api/produtos/:id', (req, res) => { res.json({ ok: true }); });
app.post('/api/produtos/:id/enriquecer', (req, res) => { res.json({ ok: true }); });

// Bling — token OAuth2
let _blingToken = null;
let _blingTokenExp = 0;

async function getBlingToken() {
  if (process.env.BLING_API_KEY) return process.env.BLING_API_KEY;
  if (_blingToken && Date.now() < _blingTokenExp) return _blingToken;
  if (!process.env.BLING_CLIENT_ID || !process.env.BLING_CLIENT_SECRET) throw new Error('Configure BLING_API_KEY ou BLING_CLIENT_ID+BLING_CLIENT_SECRET no Render');
  const creds = Buffer.from(process.env.BLING_CLIENT_ID + ':' + process.env.BLING_CLIENT_SECRET).toString('base64');
  const qs = 'grant_type=client_credentials';
  const data = await httpsJSON({ hostname: 'www.bling.com.br', path: '/Api/v3/oauth/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + creds, 'Content-Length': Buffer.byteLength(qs) }
  }, qs);
  if (!data.access_token) throw new Error('Bling token inválido: ' + JSON.stringify(data));
  _blingToken = data.access_token;
  _blingTokenExp = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
  return _blingToken;
}

async function blingRequest(method, path, payload) {
  const token = await getBlingToken();
  const body = payload ? JSON.stringify(payload) : null;
  const opts = { hostname: 'www.bling.com.br', path: '/Api/v3' + path, method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }
  };
  return httpsJSON(opts, body);
}

app.get('/api/bling/status', async (req, res) => {
  if (!process.env.BLING_API_KEY && !process.env.BLING_CLIENT_ID) return res.json({ ok: false, configurado: false, mensagem: 'Configure BLING_API_KEY ou BLING_CLIENT_ID e BLING_CLIENT_SECRET no Render' });
  try { await getBlingToken(); res.json({ ok: true, configurado: true, mensagem: 'Bling V3 conectado' }); }
  catch(e) { res.json({ ok: false, configurado: false, mensagem: e.message }); }
});

app.post('/api/bling/token/renovar', (req, res) => { _blingToken = null; _blingTokenExp = 0; res.json({ ok: true, mensagem: 'Cache de token limpo — será renovado automaticamente' }); });

app.get('/api/bling/buscar', async (req, res) => {
  try {
    const data = await blingRequest('GET', '/produtos?situacao=A&pagina=1&limite=20');
    const prods = (data.data || []).map(p => ({ id: p.id, nome: p.nome, codigo: p.codigo, preco: p.preco, situacao: p.situacao }));
    res.json({ ok: true, produtos: prods, total: prods.length });
  } catch(e) { res.json({ ok: false, erro: e.message, produtos: [] }); }
});

app.post('/api/bling/produto', async (req, res) => {
  try {
    const p = req.body;
    const midia = (p.imagens || []).slice(0, 6).map((url, i) => ({ tipo: 'F', thumbnail: i === 0, url }));
    const payload = {
      nome: p.nome || p.codigo_fabricante || p.sku || 'Produto sem nome',
      codigo: p.codigo_fabricante || p.sku || '',
      tipo: 'P', situacao: 'A', formato: 'S',
      descricaoCurta: (p.descricao || p.voz_do_lojista || '').substring(0, 300),
      descricaoComplementar: p.descricao_tecnica || '',
      tributacao: { ncm: (p.ncm || '').replace(/\D/g, '').substring(0, 8) },
      estoque: { minimo: 0, maximo: 0, crossdocking: 0, localizacao: '' },
      ...(p.fabricante ? { marca: { nome: p.fabricante } } : {}),
      ...(midia.length ? { midia } : {}),
      ...(p.preco ? { preco: parseFloat(p.preco) || 0 } : {})
    };
    const data = await blingRequest('POST', '/produtos', payload);
    if (data.data && data.data.id) return res.json({ ok: true, id: data.data.id, plataforma: 'bling' });
    res.json({ ok: false, erro: JSON.stringify(data.error || data) });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

app.put('/api/bling/produto/:id', async (req, res) => {
  try {
    const p = req.body;
    const payload = { nome: p.nome, situacao: 'A', descricaoCurta: (p.descricao || '').substring(0, 300) };
    const data = await blingRequest('PUT', '/produtos/' + req.params.id, payload);
    res.json({ ok: true, data });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

// ─── BLING — Lista de produtos com paginação ─────────────────
app.get('/api/bling/produtos', async (req, res) => {
  try {
    const pagina = parseInt(req.query.pagina) || 1;
    const limite = Math.min(parseInt(req.query.limite) || 100, 100);
    const data = await blingRequest('GET', `/produtos?situacao=A&pagina=${pagina}&limite=${limite}`);
    const prods = (data.data || []).map(p => ({
      id: p.id, nome: p.nome, codigo: p.codigo, preco: p.preco, situacao: p.situacao
    }));
    res.json({ ok: true, produtos: prods, total: prods.length, pagina, temMais: prods.length === limite });
  } catch(e) { res.json({ ok: false, erro: e.message, produtos: [] }); }
});

// ─── WIX STORES — www.mobisautoparts.com.br ───────────────────
function wixRequest(method, path, payload) {
  const key = process.env.WIX_API_KEY;
  const siteId = process.env.WIX_SITE_ID;
  if (!key || !siteId) throw new Error('Configure WIX_API_KEY e WIX_SITE_ID no Render');
  const body = payload ? JSON.stringify(payload) : null;
  const opts = { hostname: 'www.wixapis.com', path, method,
    headers: { 'Authorization': key, 'wix-site-id': siteId, 'Content-Type': 'application/json',
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }
  };
  return httpsJSON(opts, body);
}

app.get('/api/wix/status', async (req, res) => {
  if (!process.env.WIX_API_KEY) return res.json({ ok: false, configurado: false, mensagem: 'Configure WIX_API_KEY e WIX_SITE_ID no Render' });
  try {
    await wixRequest('POST', '/stores/v3/products/query', { query: { paging: { limit: 1 } } });
    res.json({ ok: true, configurado: true, mensagem: 'Wix Stores conectado — mobisautoparts.com.br' });
  } catch(e) { res.json({ ok: false, configurado: false, mensagem: e.message }); }
});

app.post('/api/wix/produto', async (req, res) => {
  try {
    const p = req.body;
    const preco = (p.preco_venda || p.preco) ? String(parseFloat(p.preco_venda || p.preco).toFixed(2)) : '0.01';
    const payload = {
      product: {
        name: p.nome || p.codigo_fabricante || 'Produto',
        visible: true,
        productType: 'PHYSICAL',
        plainDescription: p.descricao || p.voz_do_lojista || '',
        physicalProperties: {},
        variantsInfo: {
          variants: [{
            sku: p.codigo_fabricante || p.sku || '',
            visible: true,
            price: { actualPrice: { amount: preco } },
            inventoryItem: { quantity: 1, preorderInfo: { enabled: false } },
            physicalProperties: {}
          }]
        }
      }
    };
    const data = await wixRequest('POST', '/stores/v3/products-with-inventory', payload);
    if (data.product && data.product.id) return res.json({ ok: true, id: data.product.id, plataforma: 'wix', url: 'https://www.mobisautoparts.com.br' });
    res.json({ ok: false, erro: JSON.stringify(data) });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

app.post('/api/wix/sync/:id', async (req, res) => {
  try {
    const p = req.body;
    const atual = await wixRequest('GET', '/stores/v3/products/' + req.params.id);
    const revision = atual.product && atual.product.revision;
    const payload = { product: { id: req.params.id, revision, name: p.nome, plainDescription: p.descricao || '', visible: true } };
    const data = await wixRequest('PATCH', '/stores/v3/products-with-inventory/' + req.params.id, payload);
    res.json({ ok: true, data });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

// Wix — listar produtos (V3)
app.post('/api/wix/produtos', async (req, res) => {
  try {
    const limite = Math.min(parseInt(req.body.limite) || 20, 100);
    const data = await wixRequest('POST', '/stores/v3/products/query', {
      query: { paging: { limit: limite, offset: 0 } }
    });
    const prods = (data.products || []).map(p => ({
      id: p.id, nome: p.name, preco: p.priceData?.price,
      estoque: p.stock?.inventoryStatus, visivel: p.visible
    }));
    res.json({ ok: true, produtos: prods, total: prods.length });
  } catch(e) { res.json({ ok: false, erro: e.message, produtos: [] }); }
});

// ─── BLING → WIX — Importar produtos do Bling para Wix Stores V3 ─────
app.post('/api/bling-wix/importar', async (req, res) => {
  try {
    const pagina  = parseInt(req.body.pagina)  || 1;
    const limite  = Math.min(parseInt(req.body.limite) || 50, 100);

    // 1. Buscar produtos ativos no Bling
    const blingData = await blingRequest('GET', `/produtos?situacao=A&pagina=${pagina}&limite=${limite}`);
    const blingProds = blingData.data || [];
    if (!blingProds.length) return res.json({ ok: true, criados: 0, ignorados: 0, erros: 0, total: 0, resultados: [] });

    // 2. Buscar todos os nomes de produtos já existentes no Wix (para evitar duplicatas)
    const wixQuery = await wixRequest('POST', '/stores/v3/products/query', { query: { paging: { limit: 100, offset: 0 } } });
    const wixNomes = new Set((wixQuery.products || []).map(p => p.name));

    const resultados = [];
    let criados = 0, ignorados = 0, erros = 0;
    const novos = blingProds.filter(p => !wixNomes.has(p.nome));

    if (!novos.length) {
      return res.json({ ok: true, criados: 0, ignorados: blingProds.length, erros: 0, total: blingProds.length,
        mensagem: 'Todos os produtos já existem no Wix', resultados: [] });
    }

    // 3. Criar novos produtos no Wix V3 em lotes de 10
    const LOTE = 10;
    for (let i = 0; i < novos.length; i += LOTE) {
      const lote = novos.slice(i, i + LOTE);
      const products = lote.map((p, idx) => {
        const preco = p.preco ? String(parseFloat(p.preco).toFixed(2)) : '0.01';
        return {
          name: p.nome || p.codigo || 'Produto',
          visible: true,
          productType: 'PHYSICAL',
          physicalProperties: {},
          variantsInfo: {
            variants: [{
              choices: [],
              price: { actualPrice: { amount: preco } },
              visible: true,
              inventoryItem: { quantity: 1, preorderInfo: { enabled: false } },
              physicalProperties: {}
            }]
          }
        };
      });

      try {
        const createRes = await wixRequest('POST', '/stores/v3/bulk/products-with-inventory/create', {
          products,
          returnEntity: true
        });
        const results = createRes.results || createRes.bulkActionMetadata || [];
        lote.forEach((p, idx) => {
          const r = Array.isArray(results) ? results[idx] : null;
          const wixId = r?.product?.id || r?.item?.id || r?.id;
          if (wixId || (Array.isArray(results) && results.length > 0)) {
            resultados.push({ nome: p.nome, acao: 'criado', bling_id: p.id });
            criados++;
          } else {
            resultados.push({ nome: p.nome, acao: 'criado (lote)', bling_id: p.id });
            criados++;
          }
        });
      } catch(e) {
        lote.forEach(p => {
          resultados.push({ nome: p.nome, acao: 'erro', erro: e.message.substring(0, 80), bling_id: p.id });
          erros++;
        });
      }
    }

    ignorados = blingProds.length - novos.length;
    res.json({ ok: true, criados, ignorados, erros, total: blingProds.length, pagina, resultados });
  } catch(e) {
    res.json({ ok: false, erro: e.message });
  }
});

// ─── SYNC EM LOTE — Bling + Wix ───────────────────────────────
app.post('/api/sync/lote', async (req, res) => {
  const produtos = req.body.produtos || [];
  if (!produtos.length) return res.json({ ok: false, erro: 'Nenhum produto enviado' });
  const resultados = [];
  for (const p of produtos) {
    const r = { nome: p.nome || p.codigo_fabricante, bling: null, wix: null };
    try {
      const b = await (async () => {
        const midia = (p.imagens||[]).slice(0,6).map((url,i)=>({tipo:'F',thumbnail:i===0,url}));
        const payload = { nome: p.nome||p.codigo_fabricante||'Produto', codigo: p.codigo_fabricante||'', tipo:'P', situacao:'A', formato:'S',
          descricaoCurta:(p.descricao||p.voz_do_lojista||'').substring(0,300), tributacao:{ncm:(p.ncm||'').replace(/\D/g,'').substring(0,8)},
          ...(p.fabricante?{marca:{nome:p.fabricante}}:{}), ...(midia.length?{midia}:{}) };
        return await blingRequest('POST', '/produtos', payload);
      })();
      r.bling = b.data?.id ? { ok: true, id: b.data.id } : { ok: false, erro: JSON.stringify(b.error||b) };
    } catch(e) { r.bling = { ok: false, erro: e.message }; }
    try {
      const mediaItems = (p.imagens||[]).slice(0,8).map(url=>({mediaType:'IMAGE',image:{url}}));
      const payload = { product: { name: p.nome||p.codigo_fabricante||'Produto', productType:'physical',
        description: p.descricao||p.voz_do_lojista||'', sku: p.codigo_fabricante||'', visible:true,
        ...(mediaItems.length?{media:{items:mediaItems}}:{}) }};
      const w = await wixRequest('POST', '/stores/v1/products', payload);
      r.wix = w.product?.id ? { ok: true, id: w.product.id } : { ok: false, erro: JSON.stringify(w) };
    } catch(e) { r.wix = { ok: false, erro: e.message }; }
    resultados.push(r);
  }
  const ok_bling = resultados.filter(r=>r.bling?.ok).length;
  const ok_wix = resultados.filter(r=>r.wix?.ok).length;
  res.json({ ok: true, total: produtos.length, bling: { sincronizados: ok_bling, erros: produtos.length-ok_bling }, wix: { sincronizados: ok_wix, erros: produtos.length-ok_wix }, resultados });
});

app.get('/api/sync/status', (req, res) => {
  res.json({
    ok: true,
    bling: { configurado: !!(process.env.BLING_API_KEY || (process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET)), nome: 'Bling V3' },
    wix: { configurado: !!(process.env.WIX_API_KEY && process.env.WIX_SITE_ID), nome: 'Wix Stores — mobisautoparts.com.br' }
  });
});

// Massa (stub)
app.post('/api/massa/upload', (req, res) => { res.json({ ok: false, erro: 'Instale multer e xlsx para upload' }); });
app.post('/api/massa/enviar-bling', (req, res) => { res.json({ ok: true, criados: 0, erros: 0 }); });

// Empresa CNPJ
app.post('/api/empresa/consultar-cnpj', async (req, res) => {
    const cnpj = (req.body.cnpj||'').replace(/\D/g,'');
    if (cnpj.length !== 14) return res.json({ ok: false, erro: 'CNPJ inválido' });
    try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
            https.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, r => {
                let b = '';
                r.on('data', d => b += d);
                r.on('end', () => resolve(JSON.parse(b)));
            }).on('error', reject);
        });
        const cnae = data.cnae_fiscal_descricao || '';
        const perfil = cnae.toLowerCase().includes('auto') || cnae.toLowerCase().includes('peç') ? 'AUTOPECAS' : 'GENERICO';
        res.json({
            ok: true, perfil,
            mensagem: perfil === 'AUTOPECAS' ? '✅ Ramo de autopeças detectado automaticamente' : '⚙️ Configure o perfil manualmente',
            empresa: {
                razao_social: data.razao_social, nome_fantasia: data.nome_fantasia,
                situacao: data.descricao_situacao_cadastral, ativa: data.descricao_situacao_cadastral === 'ATIVA',
                cnae_principal: data.cnae_fiscal + ' — ' + cnae,
                porte: data.porte, natureza: data.natureza_juridica,
                abertura: data.data_inicio_atividade,
                endereco: { logradouro: data.logradouro, numero: data.numero, municipio: data.municipio, uf: data.uf },
                telefone: data.ddd_telefone_1, email: data.email
            },
            config: {
                nome_perfil: perfil === 'AUTOPECAS' ? '🔧 Autopeças' : '📦 Geral',
                nct_minimo: 0.90, erp_principal: 'bling',
                marketplace: ['wix', 'google_shopping'],
                reino_padrao: 'MINERAL', garantia_padrao: '12 meses / 20.000 km',
                regras_imagem: { quantidade: 6, confianca_ia_minima: 82 },
                campos_obrigatorios: ['oem', 'nome', 'ncm', 'aplicacao'],
                categorias_principais: ['Suspensão', 'Freios', 'Filtros', 'Motor', 'Elétrica', 'Arrefecimento']
            }
        });
    } catch(e) {
        res.json({ ok: false, erro: 'Erro ao consultar BrasilAPI: ' + e.message });
    }
});

// -----------------------------------------------------------
// ROTA RAIZ — Serve o frontend HTML
// -----------------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Todas as outras rotas retornam o frontend (SPA)
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
          return res.status(404).json({ ok: false, erro: 'Rota nao encontrada' });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -----------------------------------------------------------
// INICIAR SERVIDOR
// -----------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log('  IndexaAí.com — Motor NTC 4.0   ONLINE');
    console.log('  MOBIS Pecas Automotivas');
    console.log(`  http://localhost:${PORT}`);
    console.log('='.repeat(60));
});
