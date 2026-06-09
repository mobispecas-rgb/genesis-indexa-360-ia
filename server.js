// ============================================================
// INDEXAAI CATALOG PRO — Motor NTC 4.0 Enterprise — SERVIDOR PRINCIPAL
// Node.js + Express | MOBIS Pecas Automotivas
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

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
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
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

// Busca de Imagens — in-app, sem abrir links externos
app.get('/api/imagens/buscar', async (req, res) => {
    const { q, fonte } = req.query;
    if (!q) return res.json({ ok: false, erro: 'Parametro q obrigatorio', imagens: [] });
    // Retorna estrutura de imagens para busca in-app.
    // Em producao, integrar com API de imagens configurada (ex: Google Custom Search com chave propria).
    // Por ora, retorna lista vazia com orientacao para configurar.
    const termo = encodeURIComponent(q);
    // Se GOOGLE_SEARCH_KEY e GOOGLE_SEARCH_CX estiverem configurados, usa Google Custom Search.
    if (process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX) {
        try {
            const https = require('https');
            const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_SEARCH_KEY}&cx=${process.env.GOOGLE_SEARCH_CX}&q=${termo}&searchType=image&num=12`;
            const data = await new Promise((resolve, reject) => {
                https.get(url, r => { let b=''; r.on('data',d=>b+=d); r.on('end',()=>{ try{resolve(JSON.parse(b))}catch(e){reject(e)} }); }).on('error',reject);
            });
            const imagens = (data.items||[]).map(item => ({
                url: item.link,
                thumb: item.image && item.image.thumbnailLink,
                titulo: item.title,
                fonte: item.displayLink
            }));
            return res.json({ ok: true, imagens, total: imagens.length, q, fonte });
        } catch(e) {
            return res.json({ ok: false, erro: 'Erro Google Search: ' + e.message, imagens: [] });
        }
    }
    // Sem API configurada — instrucao para o usuario
    res.json({
        ok: false,
        imagens: [],
        mensagem: 'Configure GOOGLE_SEARCH_KEY e GOOGLE_SEARCH_CX no Render para busca de imagens in-app.',
        q,
        fonte
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

// Bling (stub)
app.get('/api/bling/status', (req, res) => {
    res.json({ ok: true, mensagem: 'Bling configurado — verifique BLING_CLIENT_SECRET no Render' });
});
app.post('/api/bling/token/renovar', (req, res) => { res.json({ ok: true, mensagem: 'Token renovado' }); });
app.get('/api/bling/buscar', (req, res) => { res.json({ ok: false, produtos: [] }); });

// Bling — token OAuth2
let _blingToken = null;
let _blingTokenExp = 0;

async function getBlingToken() {
  if (_blingToken && Date.now() < _blingTokenExp) return _blingToken;
  if (!process.env.BLING_CLIENT_ID || !process.env.BLING_CLIENT_SECRET) throw new Error('Configure BLING_CLIENT_ID e BLING_CLIENT_SECRET no Render');
  const https = require('https');
  const creds = Buffer.from(process.env.BLING_CLIENT_ID + ':' + process.env.BLING_CLIENT_SECRET).toString('base64');
  const qs = 'grant_type=client_credentials';
  const data = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'www.bling.com.br', path: '/Api/v3/oauth/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + creds, 'Content-Length': Buffer.byteLength(qs) }
    }, r => { let b=''; r.on('data',d=>b+=d); r.on('end',()=>{ try{resolve(JSON.parse(b))}catch(e){reject(e)} }); });
    req.on('error', reject); req.write(qs); req.end();
  });
  if (!data.access_token) throw new Error('Bling token inválido: ' + JSON.stringify(data));
  _blingToken = data.access_token;
  _blingTokenExp = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
  return _blingToken;
}

async function blingRequest(method, path, payload) {
  const token = await getBlingToken();
  const https = require('https');
  const body = payload ? JSON.stringify(payload) : null;
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'www.bling.com.br', path: '/Api/v3' + path, method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }
    };
    const req = https.request(opts, r => { let b=''; r.on('data',d=>b+=d); r.on('end',()=>{ try{resolve(JSON.parse(b))}catch(e){reject(e)} }); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

app.get('/api/bling/status', async (req, res) => {
  if (!process.env.BLING_CLIENT_ID) return res.json({ ok: false, configurado: false, mensagem: 'Configure BLING_CLIENT_ID e BLING_CLIENT_SECRET no Render' });
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

// ─── WIX STORES — www.mobisautoparts.com.br ───────────────────
function wixRequest(method, path, payload) {
  const key = process.env.WIX_API_KEY;
  const siteId = process.env.WIX_SITE_ID;
  if (!key || !siteId) throw new Error('Configure WIX_API_KEY e WIX_SITE_ID no Render');
  const https = require('https');
  const body = payload ? JSON.stringify(payload) : null;
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'www.wixapis.com', path, method,
      headers: { 'Authorization': key, 'wix-site-id': siteId, 'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }
    };
    const req = https.request(opts, r => { let b=''; r.on('data',d=>b+=d); r.on('end',()=>{ try{resolve(JSON.parse(b))}catch(e){reject(e)} }); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

app.get('/api/wix/status', async (req, res) => {
  if (!process.env.WIX_API_KEY) return res.json({ ok: false, configurado: false, mensagem: 'Configure WIX_API_KEY e WIX_SITE_ID no Render' });
  try {
    await wixRequest('GET', '/stores/v1/products?paging.limit=1');
    res.json({ ok: true, configurado: true, mensagem: 'Wix Stores conectado — mobisautoparts.com.br' });
  } catch(e) { res.json({ ok: false, configurado: false, mensagem: e.message }); }
});

app.post('/api/wix/produto', async (req, res) => {
  try {
    const p = req.body;
    const mediaItems = (p.imagens || []).slice(0, 8).map(url => ({ mediaType: 'IMAGE', image: { url } }));
    const payload = {
      product: {
        name: p.nome || p.codigo_fabricante || 'Produto',
        productType: 'physical',
        description: p.descricao || p.voz_do_lojista || '',
        sku: p.codigo_fabricante || p.sku || '',
        visible: true,
        ...(mediaItems.length ? { media: { items: mediaItems } } : {}),
        customTextFields: [
          ...(p.fabricante ? [{ title: 'Marca', maxLength: 100, mandatory: false }] : []),
          ...(p.ncm ? [{ title: 'NCM', maxLength: 20, mandatory: false }] : [])
        ]
      }
    };
    const data = await wixRequest('POST', '/stores/v1/products', payload);
    if (data.product && data.product.id) return res.json({ ok: true, id: data.product.id, plataforma: 'wix', url: 'https://www.mobisautoparts.com.br' });
    res.json({ ok: false, erro: JSON.stringify(data) });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

app.post('/api/wix/sync/:id', async (req, res) => {
  try {
    const p = req.body;
    const payload = { product: { name: p.nome, description: p.descricao || '', visible: true } };
    const data = await wixRequest('PUT', '/stores/v1/products/' + req.params.id, payload);
    res.json({ ok: true, data });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
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
    bling: { configurado: !!(process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET), nome: 'Bling V3' },
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
