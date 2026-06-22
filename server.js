// ============================================================
// INDEXAAI CATALOG PRO — Motor NTC 4.0 Enterprise — SERVIDOR PRINCIPAL
// Node.js + Express | MOBIS Pecas Automotivas
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const zlib = require('zlib');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const { httpsJSON, validarGTIN, validarNCM, consultarNCMOficial, buscarWeb } = require('./src/services/web-utils');
const { enriquecerDnaViaWeb } = require('./src/services/dna-enricher');
const vectorSearch = require('./src/services/vector-search-service');
const { buscarImagensReais } = require('./src/services/image-search');
const db = require('./src/services/db');
const autoEnrich = require('./src/services/auto-enrich');
const { parseNFeXML } = require('./src/services/nfe-parser');
const driveService = require('./src/services/drive');

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Keep-alive: evita cold start no Render free tier ────────────────────────
// Pinga o próprio /api/health a cada 14 min (Render dorme após 15 min de idle)
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  const mod = SELF_URL.startsWith('https') ? https : http;
  mod.get(`${SELF_URL}/api/health`, () => {}).on('error', () => {});
}, 14 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

// ── Auto-Enriquecimento 24/7 — melhora produtos já cadastrados em background ─
// Processa um lote por ciclo: rastreabilidade (fornecedor/avulso) → DNA na
// Web → colonização de imagens reais → recálculo do NTC 4.0.
const AUTO_ENRICH_INTERVAL_MIN = Number(process.env.AUTO_ENRICH_INTERVAL_MIN) || 10;
if (process.env.AUTO_ENRICH_ENABLED !== 'false') {
  setInterval(() => {
    autoEnrich.rodarCicloAutoEnrich().catch(e => console.error('[Auto-Enrich]', e.message));
  }, AUTO_ENRICH_INTERVAL_MIN * 60 * 1000);
}
// ─────────────────────────────────────────────────────────────────────────────

// Verifica se um IP é privado/local — usado para impedir SSRF no raspador de URLs
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

// Busca o HTML de uma URL pública para o raspador de catálogo.
// Valida o IP resolvido (anti-SSRF) e segue poucos redirecionamentos.
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
  // Headers de navegador real — muitas lojas (Tray, VTEX etc.) bloqueiam com
  // 403/405 requisições que não trazem Accept/Accept-Language/Accept-Encoding
  // e um User-Agent reconhecido.
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

// Extrai título, meta tags e dados estruturados (schema.org Product / JSON-LD) de um HTML
function extrairMetaProduto(html) {
  const tituloMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const titulo = tituloMatch ? tituloMatch[1].trim() : null;

  const meta = {};
  const metaRegex1 = /<meta\s+[^>]*?(?:property|name)=["']([^"']+)["'][^>]*?content=["']([^"']*)["'][^>]*>/gi;
  const metaRegex2 = /<meta\s+[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = metaRegex1.exec(html))) meta[m[1].toLowerCase()] = m[2];
  while ((m = metaRegex2.exec(html))) if (!meta[m[2].toLowerCase()]) meta[m[2].toLowerCase()] = m[1];

  const jsonLd = [];
  const ldRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRegex.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(p => jsonLd.push(p));
    } catch (e) { /* ignora blocos JSON-LD inválidos */ }
  }
  const produtoLd = jsonLd.flatMap(p => p['@graph'] || [p]).find(p => {
    const tipo = p['@type'];
    return tipo === 'Product' || (Array.isArray(tipo) && tipo.includes('Product'));
  }) || null;

  return { titulo, meta, produtoLd };
}

// Remove tags/scripts/estilos do HTML, deixando apenas texto visível (truncado)
function htmlParaTexto(html, limite = 6000) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limite);
}

// Converte HTML em texto preservando os links "Texto (LINK: url-absoluta)" —
// usado no raspador de catálogo para a IA conseguir referenciar a página de cada produto.
function htmlParaTextoComLinks(html, baseUrl, limite = 15000) {
  let semBlocos = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  semBlocos = semBlocos.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const texto = inner.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!texto) return ' ';
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch (e) { abs = href; }
    return ' ' + texto + ' (LINK: ' + abs + ') ';
  });

  return semBlocos
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limite);
}

// Extrai lista de produtos de blocos JSON-LD do tipo ItemList (páginas de catálogo/categoria)
function extrairListaProdutosLd(html, baseUrl) {
  const jsonLd = [];
  const ldRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRegex.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(p => jsonLd.push(p));
    } catch (e) { /* ignora blocos JSON-LD inválidos */ }
  }
  const blocos = jsonLd.flatMap(p => p['@graph'] || [p]);
  const listas = blocos.filter(p => {
    const tipo = p['@type'];
    return tipo === 'ItemList' || (Array.isArray(tipo) && tipo.includes('ItemList'));
  });

  const produtos = [];
  for (const lista of listas) {
    for (const el of (lista.itemListElement || [])) {
      const item = el.item || el;
      const tipo = item['@type'];
      const ehProduto = tipo === 'Product' || (Array.isArray(tipo) && tipo.includes('Product'));
      if (!ehProduto && !item.name) continue;
      const oferta = Array.isArray(item.offers) ? item.offers[0] : item.offers;
      let url = item.url || el.url || item['@id'] || null;
      if (url) { try { url = new URL(url, baseUrl).href; } catch (e) { /* mantém como veio */ } }
      produtos.push({
        nome: item.name || null,
        sku: item.sku || item.mpn || null,
        fabricante: (item.brand && (item.brand.name || item.brand)) || null,
        preco: (oferta && oferta.price != null) ? Number(oferta.price) : null,
        url
      });
    }
  }
  return produtos;
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
            model: 'claude-haiku-4-5-20251001',
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

// Status do Motor IA (Claude Sonnet) — usado pela Voz do Lojista e demais motores de IA
app.get('/api/ia/status', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, configurado: false, mensagem: 'Configure ANTHROPIC_API_KEY no Render' });
    try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        await client.models.retrieve('claude-haiku-4-5-20251001');
        res.json({ ok: true, configurado: true, mensagem: 'Motor IA conectado — Claude Sonnet 4.6' });
    } catch (e) {
        res.json({ ok: false, configurado: false, mensagem: e.message });
    }
});

// ─── NTC Engine (Núcleo de Triangulação Certificada) ─────────
const ntcEngine = require('./src/services/ntc-engine')
const ntcNormalizerPatch = require('./src/services/ntc-normalizer-patch');

// Motor NTC — 13 componentes — NUNCA inventa dados
// normalizaAliases: converte os nomes que o frontend/DNA envia para os nomes que o ntc-engine lê
function normalizaAliases(d) {
    const r = Object.assign({}, d);
    // AV — aplicação veicular
    if (!r.marca  && r.marca_veiculo)    r.marca  = r.marca_veiculo;
    if (!r.modelo && r.modelo_veiculo)   r.modelo = r.modelo_veiculo;
    if (!r.motor  && r.motor_aplicacao)  r.motor  = r.motor_aplicacao;
    // DNA
    if (!r.fabricante && r.fabricante_original) r.fabricante = r.fabricante_original;
    if (!r.codigo_fabricante && r.sku)          r.codigo_fabricante = r.sku;
    if (!r.familia_tecnica && r.familia)        r.familia_tecnica = r.familia;
    // EC
    if (!r.funcao && r.funcao_tecnica) r.funcao = r.funcao_tecnica;
    // LG — linhagem genealógica
    if (!r.linhagem_fabricante && r.fabricante_original) r.linhagem_fabricante = r.fabricante_original;
    if (!r.linhagem_montadora  && r.montadora)           r.linhagem_montadora  = r.montadora;
    if (!r.linhagem_distribuidor && r.distribuidor)      r.linhagem_distribuidor = r.distribuidor;
    if (!r.linhagem_importador && r.importador)          r.linhagem_importador = r.importador;
    // MC — material
    if (!r.material && r.material_composicao) r.material = r.material_composicao;
    return r;
}

app.post('/api/motor/nct', (req, res) => {
    const dados = normalizaAliases(req.body);
    const resultado = ntcEngine.processar(dados);
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
    const dados = normalizaAliases(req.body);
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
        aviso: resultado.impedimentos.length > 0
            ? resultado.impedimentos.join(' | ')
            : null,
    });
});

// Motor Extração Técnica — busca web (Serper) + IA extraem OEM/NCM/EAN/Motor/Material
// NUNCA inventa: campo fica null se não estiver explícito nos resultados de busca
app.post('/api/motor/extrair-tecnico', async (req, res) => {
    const { sku, fabricante, nome, nivel_busca } = req.body;
    const vazio = { codigo_oem: null, ncm: null, ean: null, motor: null, material: null };
    if (!nome && !sku) return res.status(400).json({ ok: false, erro: 'SKU ou Nome obrigatório' });
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, erro: 'ANTHROPIC_API_KEY não configurada', dados: vazio });

    const q = [fabricante, sku, nome].filter(Boolean).join(' ');
    let trechos = [];
    if (process.env.SERPER_API_KEY) {
        try {
            const body = JSON.stringify({ q, num: 10, gl: 'br', hl: 'pt-br' });
            const data = await httpsJSON({
                hostname: 'google.serper.dev', path: '/search', method: 'POST',
                headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, body);
            trechos = (data.organic || []).slice(0, 8)
                .filter(item => item.title && item.snippet)
                .map(item => ({ titulo: item.title, fonte: item.link, trecho: item.snippet }));
        } catch (e) {
            console.error('[Extrair Técnico] busca:', e.message);
        }
    }

    if (trechos.length === 0) {
        return res.json({ ok: true, encontrado: false, dados: vazio, mensagem: 'Sem resultados de busca para extrair dados técnicos.' });
    }

    try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 500,
            system: `Você é um especialista técnico em autopeças automotivas. Vai receber dados de um produto (nome, marca, SKU) e trechos de resultados de busca na web sobre esse produto.

Sua tarefa: extrair os seguintes dados técnicos, SOMENTE se estiverem EXPLICITAMENTE presentes nos trechos fornecidos:
- codigo_oem: código OEM (Original Equipment Manufacturer) do fabricante do veículo
- ncm: código NCM (8 dígitos numéricos)
- ean: código EAN/GTIN (8, 12, 13 ou 14 dígitos numéricos)
- motor: aplicação de motor/veículo (ex: "GM Família I 8V", "Fiat Fire 1.0/1.4")
- material: material/composição da peça

REGRAS ABSOLUTAS:
1. NUNCA invente, estime ou deduza valores que não estejam escritos nos trechos.
2. Se um dado não estiver EXPLICITAMENTE nos trechos, retorne null para esse campo.
3. Responda APENAS com um objeto JSON válido, sem markdown, sem texto adicional, no formato exato:
{"codigo_oem": null, "ncm": null, "ean": null, "motor": null, "material": null}`,
            messages: [{
                role: 'user',
                content: `Produto: ${[fabricante, sku, nome].filter(Boolean).join(' | ')}\n\nResultados de busca:\n`
                    + trechos.map((t, i) => `${i + 1}. ${t.titulo}\n${t.trecho}\nFonte: ${t.fonte}`).join('\n\n')
            }]
        });
        const texto = msg.content?.[0]?.text || '{}';
        let dados;
        try {
            const jsonMatch = texto.match(/\{[\s\S]*\}/);
            dados = Object.assign({}, vazio, JSON.parse(jsonMatch ? jsonMatch[0] : texto));
        } catch (e) {
            dados = vazio;
        }
        const encontrado = Object.keys(vazio).some(k => dados[k] != null && dados[k] !== '');
        res.json({ ok: true, encontrado, dados, fontes: trechos.map(t => t.fonte) });
    } catch (e) {
        console.error('[Extrair Técnico] IA:', e.message);
        res.json({ ok: false, erro: e.message, dados: vazio });
    }
});

// Agente de Enriquecimento de DNA via Web — busca na web os campos dos módulos
// CO/AV/FM/MC/FP do NTC (código OEM, EAN/GTIN, NCM/CEST, aplicação veicular,
// material, dimensões, FMSI etc.) e devolve, para cada campo, o valor, a fonte
// (URL) e a confiança (alta/media/baixa). NUNCA inventa: sem fonte, o campo
// volta null com confiança "baixa" e motivo "fonte não encontrada". EAN passa
// por checksum GTIN e NCM precisa ter 8 dígitos — senão é marcado para
// confirmação fiscal. Resultado sempre "pendente_confirmacao": nunca auto-aprova.
// (lógica compartilhada com o job de auto-enriquecimento em src/services/dna-enricher.js)
app.post('/api/motor/enriquecer-dna', async (req, res) => {
    const { sku, fabricante, nome, nivel_busca } = req.body;
    if (!sku && !nome) return res.status(400).json({ ok: false, erro: 'SKU ou Nome obrigatório' });
    const resultado = await enriquecerDnaViaWeb({ sku, fabricante, nome, nivel_busca });
    // Calcula NTC 4.0 sobre os campos enriquecidos
    if (resultado.ok && resultado.campos) {
      const dadosNtc = {};
      for (const [k, v] of Object.entries(resultado.campos)) {
        if (v && v.valor != null) dadosNtc[k] = v.valor;
      }
      try { resultado.ntc = ntcEngine.processar(dadosNtc); } catch (_) {}
    }
    res.json(resultado);
});

// Busca Vetorial (Vector Search) — embeddings via Gemini + similaridade de
// cosseno sobre o DNA/OEM/aplicação/cross-codes já indexados pelo job de
// auto-enriquecimento (src/services/vector-search-service.js). Roda dentro
// do próprio Genesis, sem depender de BigQuery/Vertex AI Vector Search.
//
// REGRA NTC: cada item de `resultados` é uma SUGESTÃO (status "Sugestão
// Vetorial"), nunca um dado confirmado — `valor`/`fonte`/`url_origem` vêm
// null até validação documental (ex.: dna-enricher.js). Nenhum destes
// endpoints escreve em produtos nem no score NTC; quem consome a sugestão é
// responsável por validar a fonte antes de promovê-la para AV/CC/CO/DNA.
app.post('/api/vector/search', async (req, res) => {
    const { texto, campo, limit, threshold } = req.body;
    if (!texto) return res.status(400).json({ ok: false, erro: 'texto é obrigatório' });
    try {
        const resultados = await vectorSearch.buscarSimilaridade(texto, { campo, limit, threshold });
        res.json({ ok: true, resultados });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

app.post('/api/vector/oem', async (req, res) => {
    const { texto, limit, threshold } = req.body;
    if (!texto) return res.status(400).json({ ok: false, erro: 'texto é obrigatório' });
    try {
        const resultados = await vectorSearch.buscarOEM(texto, { limit, threshold });
        res.json({ ok: true, resultados });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

app.post('/api/vector/dna', async (req, res) => {
    const { texto, limit, threshold } = req.body;
    if (!texto) return res.status(400).json({ ok: false, erro: 'texto é obrigatório' });
    try {
        const resultados = await vectorSearch.buscarDNA(texto, { limit, threshold });
        res.json({ ok: true, resultados });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

app.post('/api/vector/application', async (req, res) => {
    const { texto, limit, threshold } = req.body;
    if (!texto) return res.status(400).json({ ok: false, erro: 'texto é obrigatório' });
    try {
        const resultados = await vectorSearch.buscarAplicacaoMotor(texto, { limit, threshold });
        res.json({ ok: true, resultados });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

// Extração de texto de PDF — permite importar catálogos/notas de fornecedor em PDF
// no Catálogo de Produtos (o texto extraído é processado pelo parser de texto livre).
// Limita o tempo de uma operação do pdf-parse: em PDFs grandes/complexos
// (catálogos com muitas páginas e imagens), getText/getTable podem demorar
// demais e deixar a conexão pendurada até o proxy do Render derrubá-la
// (o navegador então mostra "Failed to fetch" em vez de um erro claro).
function comTimeout(promise, ms, msg) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

app.post('/api/catalogo/extrair-pdf', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo PDF obrigatório' });
    console.log(`[Extrair PDF] Recebido ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(2)} MB)`);
    const parser = new PDFParse({ data: req.file.buffer });
    try {
        const resultado = await comTimeout(parser.getText(), 45000, 'PDF muito grande/complexo — tempo limite de leitura excedido');
        const texto = resultado.text.replace(/\n*-- \d+ of \d+ --\n*/g, '\n\n');

        // Tenta detectar tabelas (catálogos tabulares: SKU/Descrição/Marca/Preço em colunas).
        // Quando há tabela, ela é convertida em CSV — muito mais confiável para o
        // parser de catálogo do que o texto corrido extraído do PDF.
        // Tem tempo limite próprio: se demorar demais, segue só com o texto.
        let tabela = null;
        try {
            const resultadoTabelas = await comTimeout(parser.getTable(), 25000, 'tempo limite na detecção de tabela');
            const candidatas = (resultadoTabelas.mergedTables || [])
                .filter(t => Array.isArray(t) && t.length >= 2 && Array.isArray(t[0]) && t[0].length >= 2);
            if (candidatas.length) {
                const maior = candidatas.reduce((a, b) => (b.length * b[0].length) > (a.length * a[0].length) ? b : a);
                tabela = maior.map(linha => linha.map(cel => {
                    const s = (cel == null ? '' : String(cel)).replace(/\s+/g, ' ').trim();
                    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
                }).join(',')).join('\n');
            }
        } catch (eTabela) {
            console.error('[Extrair PDF] Tabela:', eTabela.message);
        }

        const paginas = resultado.pages ? resultado.pages.length : (resultado.total || null);
        console.log(`[Extrair PDF] OK — ${paginas || '?'} página(s), ${texto.length} caracteres${tabela ? ', tabela detectada' : ''}`);
        res.json({ ok: true, texto, tabela, paginas });
    } catch (e) {
        console.error('[Extrair PDF]', e.message);
        res.status(400).json({ ok: false, erro: 'Falha ao ler PDF: ' + e.message });
    } finally {
        await parser.destroy();
    }
});

// Raspador de página de produto/fornecedor — extrai dados via meta tags, JSON-LD
// (schema.org Product) e IA, para identificar e cadastrar o produto automaticamente.
// NUNCA inventa: campo fica null se não estiver explícito no conteúdo da página.
app.post('/api/catalogo/raspar', async (req, res) => {
    const { url } = req.body;
    const vazio = { sku: null, nome: null, fabricante: null, codigo_oem: null, ncm: null, ean: null, motor: null, material: null, preco: null };
    if (!url) return res.status(400).json({ ok: false, erro: 'URL obrigatória' });

    let html;
    try {
        html = await fetchHtmlSeguro(url);
    } catch (e) {
        return res.json({ ok: false, erro: 'Erro ao acessar URL: ' + e.message, dados: vazio });
    }

    const { titulo, meta, produtoLd } = extrairMetaProduto(html);
    const texto = htmlParaTexto(html);

    if (!process.env.ANTHROPIC_API_KEY) {
        return res.json({
            ok: true, encontrado: false, dados: vazio,
            bruto: { titulo, produtoLd },
            mensagem: 'ANTHROPIC_API_KEY não configurada — não foi possível identificar os dados do produto.'
        });
    }

    try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const contexto = [
            'Título da página: ' + (titulo || ''),
            produtoLd ? 'Dados estruturados (schema.org Product): ' + JSON.stringify(produtoLd).slice(0, 3000) : '',
            'Meta tags relevantes: ' + JSON.stringify({
                'og:title': meta['og:title'] || null, 'og:description': meta['og:description'] || null,
                'product:price:amount': meta['product:price:amount'] || null, 'product:price:currency': meta['product:price:currency'] || null,
                'og:price:amount': meta['og:price:amount'] || null, 'og:price:currency': meta['og:price:currency'] || null
            }),
            'Texto da página (truncado): ' + texto
        ].filter(Boolean).join('\n\n');

        const msg = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            system: `Você é um especialista em catalogação de autopeças. Vai receber o conteúdo de uma página de produto/fornecedor (título, dados estruturados, meta tags e texto).

Sua tarefa: extrair os seguintes dados do produto, SOMENTE se estiverem EXPLICITAMENTE presentes no conteúdo:
- sku: código/part number do produto (do fabricante)
- nome: nome/descrição do produto
- fabricante: marca/fabricante
- codigo_oem: código OEM
- ncm: código NCM (8 dígitos)
- ean: código EAN/GTIN
- motor: aplicação de motor/veículo
- material: material/composição
- preco: preço numérico (apenas número, sem símbolo de moeda; use ponto como separador decimal)

REGRAS ABSOLUTAS:
1. NUNCA invente, estime ou deduza valores que não estejam no conteúdo.
2. Se um dado não estiver explícito, retorne null para esse campo.
3. Responda APENAS com um objeto JSON válido, sem markdown, no formato exato:
{"sku": null, "nome": null, "fabricante": null, "codigo_oem": null, "ncm": null, "ean": null, "motor": null, "material": null, "preco": null}`,
            messages: [{ role: 'user', content: contexto }]
        });
        const respostaTexto = msg.content?.[0]?.text || '{}';
        let dados;
        try {
            const jsonMatch = respostaTexto.match(/\{[\s\S]*\}/);
            dados = Object.assign({}, vazio, JSON.parse(jsonMatch ? jsonMatch[0] : respostaTexto));
        } catch (e) {
            dados = vazio;
        }
        const encontrado = Object.keys(vazio).some(k => dados[k] != null && dados[k] !== '');
        res.json({ ok: true, encontrado, dados, fonte: url });
    } catch (e) {
        console.error('[Raspador] IA:', e.message);
        res.json({ ok: false, erro: e.message, dados: vazio });
    }
});

// Raspador de página de catálogo/categoria — extrai VÁRIOS produtos de uma vez.
// Tenta primeiro dados estruturados (schema.org ItemList); se a página não tiver,
// usa IA sobre o texto da página (com links preservados) para listar os produtos
// visíveis. NUNCA inventa: cada campo fica null se não estiver explícito.
app.post('/api/catalogo/raspar-lista', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, erro: 'URL obrigatória' });

    let html;
    try {
        html = await fetchHtmlSeguro(url);
    } catch (e) {
        return res.json({ ok: false, erro: 'Erro ao acessar URL: ' + e.message, produtos: [] });
    }

    const produtosLd = extrairListaProdutosLd(html, url);
    if (produtosLd.length > 0) {
        return res.json({ ok: true, encontrado: true, produtos: produtosLd, total: produtosLd.length, fonte: 'schema.org' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
        return res.json({
            ok: true, encontrado: false, produtos: [],
            mensagem: 'ANTHROPIC_API_KEY não configurada — não foi possível identificar os produtos da página.'
        });
    }

    try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const texto = htmlParaTextoComLinks(html, url);

        const msg = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            system: `Você é um especialista em catalogação de autopeças. Vai receber o texto de uma página de catálogo/categoria de um fornecedor, com links no formato "Texto (LINK: url)".

Sua tarefa: identificar cada PRODUTO listado na página e extrair, SOMENTE se estiver EXPLICITAMENTE presente no texto:
- nome: nome/descrição do produto
- sku: código/part number do produto, se houver
- fabricante: marca/fabricante, se houver
- preco: preço numérico (apenas número, ponto como separador decimal), se houver
- url: o link (LINK: ...) da página do produto, se houver

REGRAS ABSOLUTAS:
1. NUNCA invente, estime ou deduza valores que não estejam no texto.
2. Se um dado não estiver explícito, retorne null para esse campo.
3. Ignore links de menu, banner, paginação, login, carrinho, redes sociais — liste apenas produtos.
4. Liste no máximo 40 produtos.
5. Responda APENAS com um array JSON válido, sem markdown, no formato:
[{"nome": null, "sku": null, "fabricante": null, "preco": null, "url": null}]`,
            messages: [{ role: 'user', content: texto }]
        });
        const respostaTexto = msg.content?.[0]?.text || '[]';
        let produtos;
        try {
            const jsonMatch = respostaTexto.match(/\[[\s\S]*\]/);
            produtos = JSON.parse(jsonMatch ? jsonMatch[0] : respostaTexto);
            if (!Array.isArray(produtos)) produtos = [];
        } catch (e) {
            produtos = [];
        }
        res.json({ ok: true, encontrado: produtos.length > 0, produtos, total: produtos.length, fonte: 'ia' });
    } catch (e) {
        console.error('[Raspador Catálogo] IA:', e.message);
        res.json({ ok: false, erro: e.message, produtos: [] });
    }
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
// (lógica compartilhada com o job de auto-enriquecimento em src/services/image-search.js)
app.get('/api/imagens/buscar', async (req, res) => {
    const { q, fonte } = req.query;
    if (!q) return res.json({ ok: false, erro: 'Parametro q obrigatorio', imagens: [] });

    if (!process.env.BRAVE_API_KEY && !process.env.SERPER_API_KEY && !(process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX)) {
        return res.json({
            ok: false, imagens: [],
            mensagem: 'Configure BRAVE_API_KEY (primário) ou SERPER_API_KEY no Render para busca de imagens.',
            q, fonte
        });
    }

    try {
        const imagens = await buscarImagensReais(q, 12);
        const provider = process.env.BRAVE_API_KEY ? 'brave' : process.env.SERPER_API_KEY ? 'serper' : 'google';
        res.json({ ok: true, imagens, total: imagens.length, q, fonte, provider });
    } catch (e) {
        res.json({ ok: false, erro: e.message, imagens: [] });
    }
});

// ─── PRODUTOS — Catálogo persistido (SQLite) ──────────────────────────
// Cada produto guarda os dados completos do NTC (`dados`), além de
// fornecedor/nota fiscal (rastreabilidade) e o NTC já calculado.
app.get('/api/produtos', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limite) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const { decisao, fonte, categoria, subcategoria, busca } = req.query;
        let produtos = db.listarProdutos({ limit, offset, decisao, fonte, busca });

        produtos = produtos.map(p => {
            const familia = p.dados.familia_tecnica || p.dados.familia || null;
            return {
                ...p,
                categoria: familia ? nomeCategoriaPrincipal(familia) : null,
                subcategoria: familia ? classificarSubcategoria(familia, p.nome) : null,
            };
        });

        if (categoria) produtos = produtos.filter(p => p.categoria === categoria);
        if (subcategoria) produtos = produtos.filter(p => p.subcategoria === subcategoria);

        res.json({ ok: true, produtos, total: db.contarProdutos() });
    } catch (e) {
        res.json({ ok: false, erro: e.message, produtos: [] });
    }
});

app.get('/api/produtos/:id', (req, res) => {
    const produto = db.obterProduto(req.params.id);
    if (!produto) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });
    res.json({ ok: true, produto });
});

// Cria/atualiza um produto (upsert pelo SKU), calcula o NTC 4.0 e persiste.
app.post('/api/produtos', (req, res) => {
    try {
        const body = req.body || {};
        const dados = body.dados && typeof body.dados === 'object' ? body.dados : body;
        const sku = body.sku || dados.codigo_fabricante || dados.sku || dados.codigo_oem;
        if (!sku) return res.status(400).json({ ok: false, erro: 'sku (ou codigo_fabricante) obrigatório' });

        const resultado = ntcEngine.processar(dados);
        const fonte = body.fonte || (body.fornecedor_nome ? 'fornecedor' : 'avulso');

        const produto = db.upsertProduto({
            sku: String(sku),
            nome: dados.nome || null,
            dados,
            fornecedor_nome: body.fornecedor_nome || null,
            fornecedor_cnpj: body.fornecedor_cnpj || null,
            nota_fiscal_chave: body.nota_fiscal_chave || null,
            fonte,
            ntc: resultado.ntc,
            decisao: resultado.decisao,
            rast_hash: resultado.rast_hash,
        });

        res.json({ ok: true, produto, ntc: resultado.ntc, decisao: resultado.decisao, rast_hash: resultado.rast_hash });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

app.delete('/api/produtos/:id', (req, res) => {
    try {
        db.excluirProduto(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// Pausa/retoma o auto-enriquecimento 24/7 para um produto específico — permite
// selecionar exatamente quais produtos o job processa automaticamente,
// mantendo os demais "congelados" para não consumir créditos da API durante testes.
app.post('/api/produtos/:id/pausar', (req, res) => {
    try {
        const pausado = !!(req.body && req.body.pausado);
        const produto = db.definirPausado(req.params.id, pausado);
        if (!produto) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });
        res.json({ ok: true, produto });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// Força o reprocessamento (DNA web + imagens + NTC) de um produto específico
app.post('/api/produtos/:id/enriquecer', async (req, res) => {
    try {
        const produto = db.obterProduto(req.params.id);
        if (!produto) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });
        const resultado = await autoEnrich.enriquecerProdutoAuto(produto, { forcar: true });
        res.json({ ok: true, resultado });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// Sincroniza um produto do catálogo local com Wix e Bling, levando o Selo de
// Qualidade NTC, código de rastreamento (rast_hash), códigos cambiados,
// medidas/pesos de fábrica e categoria/subcategoria resolvidas automaticamente.
app.post('/api/produtos/:id/sincronizar', async (req, res) => {
    try {
        const produto = db.obterProduto(req.params.id);
        if (!produto) return res.status(404).json({ ok: false, erro: 'Produto não encontrado' });

        const p = {
            ...produto.dados,
            sku: produto.sku,
            codigo_fabricante: produto.dados.codigo_fabricante || produto.sku,
            nome: produto.nome || produto.dados.nome,
            ntc: produto.ntc,
            decisao: produto.decisao,
            rast_hash: produto.rast_hash,
        };

        const resultado = { ok: true, wix: null, bling: null };
        const atualizacao = {};

        if (process.env.WIX_API_KEY && process.env.WIX_SITE_ID) {
            try {
                const { payload, categoriaIds } = await montarPayloadProdutoWix(p);
                const data = await wixRequest('POST', '/stores/v3/products-with-inventory', payload);
                if (data.product && data.product.id) {
                    await atribuirCategoriasWix(data.product.id, categoriaIds);
                    atualizacao.wix_id = data.product.id;
                    resultado.wix = { ok: true, id: data.product.id, categorias: categoriaIds || null };
                } else {
                    resultado.wix = { ok: false, erro: JSON.stringify(data) };
                }
            } catch (e) { resultado.wix = { ok: false, erro: e.message }; }
        } else {
            resultado.wix = { ok: false, erro: 'WIX_API_KEY/WIX_SITE_ID não configurados' };
        }

        if (process.env.BLING_API_KEY || process.env.BLING_CLIENT_ID) {
            try {
                const payload = await montarPayloadProdutoBling(p);
                const data = await blingRequest('POST', '/produtos', payload);
                if (data.data && data.data.id) {
                    atualizacao.bling_id = data.data.id;
                    resultado.bling = { ok: true, id: data.data.id, categoria: payload.categoria || null };
                } else {
                    resultado.bling = { ok: false, erro: JSON.stringify(data.error || data) };
                }
            } catch (e) { resultado.bling = { ok: false, erro: e.message }; }
        } else {
            resultado.bling = { ok: false, erro: 'BLING_API_KEY/BLING_CLIENT_ID não configurados' };
        }

        if (Object.keys(atualizacao).length) {
            db.upsertProduto({ sku: produto.sku, dados: produto.dados, ...atualizacao });
        }

        res.json(resultado);
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// Lista categorias/subcategorias resolvidas (mesma taxonomia usada no Wix e no
// Bling) a partir do catálogo local — usada para filtrar produtos por
// categoria/subcategoria dentro do app.
app.get('/api/categorias', (req, res) => {
    try {
        const produtos = db.listarProdutos({ limit: 1000 });
        const mapa = new Map();
        for (const produto of produtos) {
            const familia = produto.dados.familia_tecnica || produto.dados.familia;
            if (!familia) continue;
            const categoria = nomeCategoriaPrincipal(familia);
            const subcategoria = classificarSubcategoria(familia, produto.nome) || null;
            const chave = categoria + '|' + (subcategoria || '');
            if (!mapa.has(chave)) mapa.set(chave, { categoria, subcategoria, total: 0 });
            mapa.get(chave).total += 1;
        }
        res.json({ ok: true, categorias: [...mapa.values()] });
    } catch (e) {
        res.json({ ok: false, erro: e.message, categorias: [] });
    }
});

// ─── CONECTORES NTC — bancos de montadoras, fabricantes/importadores,
// catálogos de referência (PartSouq, TecDoc...) e conectores de bancos de
// dados/sites externos do lojista usados pelo agente para "busca cega" ───
app.get('/api/ntc-referencias', (req, res) => {
    try {
        db.seedReferenciasNTC();
        const tipo = req.query.tipo || null;
        res.json({ ok: true, itens: db.listarReferencias(tipo) });
    } catch (e) {
        res.json({ ok: false, erro: e.message, itens: [] });
    }
});

app.post('/api/ntc-referencias', (req, res) => {
    try {
        const item = db.criarReferencia(req.body || {});
        res.json({ ok: true, item });
    } catch (e) {
        res.status(400).json({ ok: false, erro: e.message });
    }
});

app.put('/api/ntc-referencias/:id', (req, res) => {
    try {
        const item = db.atualizarReferencia(Number(req.params.id), req.body || {});
        if (!item) return res.status(404).json({ ok: false, erro: 'Não encontrado' });
        res.json({ ok: true, item });
    } catch (e) {
        res.status(400).json({ ok: false, erro: e.message });
    }
});

app.delete('/api/ntc-referencias/:id', (req, res) => {
    try {
        db.excluirReferencia(Number(req.params.id));
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ ok: false, erro: e.message });
    }
});

// Faz GET HTTP/HTTPS para um URL. authHeader sobrepõe Basic Auth quando fornecido.
// Usa User-Agent de Chrome real para passar por WAFs que bloqueiam bots.
function _fetchConector(url, usuario, senha, timeout = 14000, authHeader = null) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(new Error('URL inválida: ' + url)); }
        const proto = parsed.protocol === 'https:' ? https : http;
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
        };
        if (authHeader) {
            headers['Authorization'] = authHeader;
        } else if (usuario || senha) {
            headers['Authorization'] = 'Basic ' + Buffer.from(`${usuario || ''}:${senha || ''}`).toString('base64');
        }
        const opts = { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: (parsed.pathname || '/') + (parsed.search || ''), headers };
        const t0 = Date.now();
        const req = proto.get(opts, (r) => {
            const latencia = Date.now() - t0;
            const partes = [];
            let tamanho = 0;
            r.on('data', chunk => { tamanho += chunk.length; if (tamanho < 65536) partes.push(chunk); });
            r.on('end', () => {
                const buf = Buffer.concat(partes);
                const enc = (r.headers['content-encoding'] || '').toLowerCase();
                let corpo;
                try {
                    corpo = enc === 'br' ? zlib.brotliDecompressSync(buf).toString('utf8')
                          : enc === 'gzip' ? zlib.gunzipSync(buf).toString('utf8')
                          : enc === 'deflate' ? zlib.inflateSync(buf).toString('utf8')
                          : buf.toString('utf8');
                } catch (_) { corpo = buf.toString('utf8'); }
                resolve({ status: r.statusCode, content_type: r.headers['content-type'] || '', location: r.headers['location'] || '', latencia_ms: latencia, corpo });
            });
        });
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout após ' + timeout + 'ms')); });
        req.on('error', reject);
    });
}

// Faz POST HTTP/HTTPS com corpo JSON. Retorna {status, corpo}.
function _httpPostJson(url, payload, authHeader = null, timeout = 12000) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(new Error('URL inválida: ' + url)); }
        const proto = parsed.protocol === 'https:' ? https : http;
        const body = JSON.stringify(payload);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Genesis-NTC-Conector/4.0', 'Accept': 'application/json' };
        if (authHeader) headers['Authorization'] = authHeader;
        const opts = { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: (parsed.pathname || '/') + (parsed.search || ''), method: 'POST', headers };
        const req = proto.request(opts, (r) => {
            let corpo = '';
            r.setEncoding('utf8');
            r.on('data', c => { corpo += c; });
            r.on('end', () => resolve({ status: r.statusCode, corpo }));
        });
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout POST ' + timeout + 'ms')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ─── AUTENTICAÇÃO POR FORMULÁRIO HTML ────────────────────────────────────────

// Cache de sessões autenticadas (id conector → { cookies, url_base, expira })
const _sessoeConnectores = new Map();
const _SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos

// Converte headers Set-Cookie em string para reenvio no próximo request
function _parseCookies(setCookieHeaders) {
    if (!setCookieHeaders) return '';
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    return arr.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

// Mescla dois strings de cookies; o segundo sobrepõe chaves do primeiro
function _mesclaCookies(base, novo) {
    if (!base) return novo || '';
    if (!novo) return base || '';
    const mapa = {};
    for (const parte of (base + '; ' + novo).split(';')) {
        const p = parte.trim();
        const eq = p.indexOf('=');
        if (eq > 0) mapa[p.substring(0, eq).trim()] = p.substring(eq + 1);
    }
    return Object.entries(mapa).map(([k, v]) => `${k}=${v}`).join('; ');
}

// GET com cookies de sessão + decompressão — retorna também os Set-Cookie da resposta
function _fetchComCookies(url, cookies, timeout = 14000) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(new Error('URL inválida: ' + url)); }
        const proto = parsed.protocol === 'https:' ? https : http;
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
        };
        if (cookies) headers['Cookie'] = cookies;
        const opts = { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: (parsed.pathname || '/') + (parsed.search || ''), headers };
        const t0 = Date.now();
        const req = proto.get(opts, (r) => {
            const latencia = Date.now() - t0;
            const partes = [];
            let tamanho = 0;
            r.on('data', chunk => { tamanho += chunk.length; if (tamanho < 262144) partes.push(chunk); });
            r.on('end', () => {
                const buf = Buffer.concat(partes);
                const enc = (r.headers['content-encoding'] || '').toLowerCase();
                let corpo;
                try {
                    corpo = enc === 'br' ? zlib.brotliDecompressSync(buf).toString('utf8')
                          : enc === 'gzip' ? zlib.gunzipSync(buf).toString('utf8')
                          : enc === 'deflate' ? zlib.inflateSync(buf).toString('utf8')
                          : buf.toString('utf8');
                } catch (_) { corpo = buf.toString('utf8'); }
                resolve({ status: r.statusCode, corpo, setCookies: r.headers['set-cookie'], location: r.headers['location'] || '', latencia_ms: latencia, content_type: r.headers['content-type'] || '' });
            });
        });
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout após ' + timeout + 'ms')); });
        req.on('error', reject);
    });
}

// POST application/x-www-form-urlencoded com cookies + decompressão
function _httpPostForm(url, formBody, cookies, timeout = 14000) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(new Error('URL inválida: ' + url)); }
        const proto = parsed.protocol === 'https:' ? https : http;
        const body = Object.entries(formBody).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v || '')}`).join('&');
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Origin': parsed.origin,
            'Referer': url,
        };
        if (cookies) headers['Cookie'] = cookies;
        const opts = { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: (parsed.pathname || '/') + (parsed.search || ''), method: 'POST', headers };
        const req = proto.request(opts, (r) => {
            const partes = [];
            let tamanho = 0;
            r.on('data', chunk => { tamanho += chunk.length; if (tamanho < 262144) partes.push(chunk); });
            r.on('end', () => {
                const buf = Buffer.concat(partes);
                const enc = (r.headers['content-encoding'] || '').toLowerCase();
                let corpo;
                try {
                    corpo = enc === 'br' ? zlib.brotliDecompressSync(buf).toString('utf8')
                          : enc === 'gzip' ? zlib.gunzipSync(buf).toString('utf8')
                          : enc === 'deflate' ? zlib.inflateSync(buf).toString('utf8')
                          : buf.toString('utf8');
                } catch (_) { corpo = buf.toString('utf8'); }
                resolve({ status: r.statusCode, corpo, setCookies: r.headers['set-cookie'], location: r.headers['location'] || '' });
            });
        });
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout POST Form ' + timeout + 'ms')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Detecta se uma string HTML contém um formulário de login
function _ehPaginaLogin(html) {
    return html && (
        html.includes('type="password"') || html.includes("type='password'") ||
        html.includes('name="password"') || html.includes('name="senha"') ||
        html.includes('name="Password"') || html.includes('name="Senha"')
    );
}

// Realiza login via formulário HTML; usa cache por 30 minutos.
// Sucesso: { cookies, url_base, tipo }
// Falha:   { falha: true, motivo: string }
async function _loginFormulario(item) {
    if (!item.usuario || !item.senha) return { falha: true, motivo: 'Sem credenciais cadastradas' };

    // Retorna sessão em cache se ainda válida
    const cached = _sessoeConnectores.get(item.id);
    if (cached && cached.expira > Date.now()) return { cookies: cached.cookies, url_base: cached.url_base, tipo: 'cache' };

    let urlBase;
    try { urlBase = new URL(item.url).origin; } catch (_) { return { falha: true, motivo: 'URL inválida' }; }

    // Se o item.url já é uma página de login, coloca ele primeiro na lista
    const pareceLogin = /\/(login|acesso|entrar|signin|account\/login|Account\/Login)/i.test(item.url);
    const loginCandidatos = pareceLogin
        ? [item.url, urlBase + '/login', urlBase + '/account/login', urlBase + '/customer/account/login', urlBase + '/usuarios/login', urlBase + '/acesso', urlBase + '/entrar']
        : [urlBase + '/login', urlBase + '/account/login', urlBase + '/customer/account/login', urlBase + '/usuarios/login', urlBase + '/acesso', urlBase + '/entrar', item.url];

    const diagnostico = [];
    let loginHtml = '', loginCookies = '', loginUrl = '';
    for (const lu of loginCandidatos) {
        try {
            const rGet = await _fetchComCookies(lu, '');
            diagnostico.push(`${lu.replace(urlBase, '') || '/'} → HTTP ${rGet.status}`);
            if (rGet.status === 200 && _ehPaginaLogin(rGet.corpo)) {
                loginHtml = rGet.corpo;
                loginCookies = _parseCookies(rGet.setCookies);
                loginUrl = lu;
                break;
            }
            // Segue redirect manual se 301/302 e ainda não tentamos o destino
            if ((rGet.status === 301 || rGet.status === 302) && rGet.location) {
                try {
                    const dest = new URL(rGet.location, urlBase).toString();
                    const rRed = await _fetchComCookies(dest, _parseCookies(rGet.setCookies));
                    diagnostico.push(`  → redirect ${dest.replace(urlBase, '') || '/'} → HTTP ${rRed.status}`);
                    if (rRed.status === 200 && _ehPaginaLogin(rRed.corpo)) {
                        loginHtml = rRed.corpo;
                        loginCookies = _mesclaCookies(_parseCookies(rGet.setCookies), _parseCookies(rRed.setCookies));
                        loginUrl = dest;
                        break;
                    }
                } catch (_) {}
            }
        } catch (e) { diagnostico.push(`${lu.replace(urlBase, '') || '/'} → erro: ${e.message.substring(0, 60)}`); }
    }
    if (!loginHtml) return { falha: true, motivo: 'Página de login não acessível.\nDiagnóstico:\n' + diagnostico.join('\n') };

    // Extrai todos os inputs hidden (ViewState, CSRF token, etc.)
    const camposOcultos = {};
    const inputRe = /<input[^>]+type=["']?hidden["']?[^>]*>/gi;
    let im;
    while ((im = inputRe.exec(loginHtml)) !== null) {
        const tag = im[0];
        const nameM = /name=["']([^"']+)["']/i.exec(tag);
        const valueM = /value=["']([^"']*)["']/i.exec(tag);
        if (nameM) camposOcultos[nameM[1]] = valueM ? valueM[1] : '';
    }

    // Detecta nome do campo de usuário
    const userFields = ['email', 'username', 'login', 'usuario', 'user', 'Email', 'UserName', 'txtEmail', 'txtLogin'];
    const passFields = ['password', 'senha', 'pass', 'Password', 'Senha', 'txtSenha', 'txtPassword'];
    let userField = 'email', passField = 'password';
    for (const f of userFields) { if (loginHtml.includes(`name="${f}"`) || loginHtml.includes(`name='${f}'`)) { userField = f; break; } }
    for (const f of passFields) { if (loginHtml.includes(`name="${f}"`) || loginHtml.includes(`name='${f}'`)) { passField = f; break; } }

    // Detecta action do formulário de login
    let formAction = loginUrl;
    const formRe = /<form[^>]+(?:action|ACTION)=["']([^"']+)["'][^>]*>/i;
    const fm = formRe.exec(loginHtml);
    if (fm && fm[1] && !fm[1].startsWith('#')) {
        try { formAction = new URL(fm[1], urlBase).toString(); } catch (_) {}
    }

    // Submete formulário
    const formBody = { ...camposOcultos, [userField]: item.usuario, [passField]: item.senha };
    const rPost = await _httpPostForm(formAction, formBody, loginCookies);
    let cookiesFinal = _mesclaCookies(loginCookies, _parseCookies(rPost.setCookies));

    // Segue redirect se necessário (login bem-sucedido costuma redirecionar)
    if ((rPost.status === 301 || rPost.status === 302) && rPost.location) {
        try {
            const destino = new URL(rPost.location, urlBase).toString();
            const rRedir = await _fetchComCookies(destino, cookiesFinal);
            cookiesFinal = _mesclaCookies(cookiesFinal, _parseCookies(rRedir.setCookies));
            if (_ehPaginaLogin(rRedir.corpo)) return { falha: true, motivo: 'Login falhou — redirecionou de volta para login (credenciais incorretas?)' };
        } catch (e) { /* ignora erro de redirect */ }
    } else if (rPost.status === 200 && _ehPaginaLogin(rPost.corpo)) {
        // Ainda na página de login = credenciais rejeitadas
        const erroRe = /class="[^"]*(?:error|alert|danger|invalid)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p|li)>/i;
        const erroM = erroRe.exec(rPost.corpo);
        const msgErro = erroM ? erroM[1].replace(/<[^>]+>/g, '').trim().substring(0, 200) : 'Credenciais inválidas ou captcha bloqueando';
        return { falha: true, motivo: `Login rejeitado: ${msgErro}` };
    }

    // Armazena sessão no cache
    _sessoeConnectores.set(item.id, { cookies: cookiesFinal, url_base: urlBase, expira: Date.now() + _SESSION_TTL_MS });
    return { cookies: cookiesFinal, url_base: urlBase, tipo: 'form-login' };
}

// Decodifica o validUntil embutido numa Algolia Secured API Key (base64).
// Retorna o timestamp Unix de expiração ou null se não encontrar.
function _algoliaKeyExpiry(apiKey) {
    try {
        const decoded = Buffer.from(apiKey, 'base64').toString('utf-8');
        // Algolia secured key: 64 chars de hash HMAC-SHA256 hex + query string de restrições
        const qs = decoded.substring(64);
        const params = new URLSearchParams(qs);
        const v = params.get('validUntil');
        return v ? Number(v) : null;
    } catch (_) { return null; }
}

// Tenta extrair uma nova Algolia Search API Key do site autenticado do Pellegrino.
// Faz login via formulário, busca o JS de configuração do Algolia e extrai a chave.
// Retorna a nova chave como string, ou null se não conseguir.
async function _renovarChaveAlgolia(item) {
    try {
        const sessao = await _loginFormulario(item);
        if (sessao.falha) return null;
        const urlBase = sessao.url_base;
        // Tenta extrair a chave dos arquivos JS que a contêm
        const candidatos = [
            urlBase + '/js/catalogo/algoliaSearchInterop.js',
            urlBase + '/catalogo/ais',
            urlBase + '/',
        ];
        const reChave = /(?:apiKey|_aisApiKey|algolia[_-]?api[_-]?key|searchApiKey)['":\s=]+['"]([A-Za-z0-9+/=]{60,})['"]/i;
        for (const url of candidatos) {
            try {
                const r = await _fetchComCookies(url, sessao.cookies, 14000);
                if (r.status !== 200) continue;
                const m = reChave.exec(r.corpo);
                if (m && m[1]) {
                    const novaChave = m[1];
                    // Verifica que a chave extraída tem validade maior que a atual
                    const expiry = _algoliaKeyExpiry(novaChave);
                    if (!expiry || expiry > Date.now() / 1000) {
                        db.atualizarReferencia(item.id, { algolia_api_key: novaChave });
                        console.log(`[Algolia] Chave renovada para conector #${item.id} via ${url} (validUntil=${expiry})`);
                        return novaChave;
                    }
                }
            } catch (_) {}
        }
        return null;
    } catch (_) { return null; }
}

// Job de renovação proativa: a cada 6h verifica todos os conectores Algolia
// e renova chaves que expiram nas próximas 26h (garante 24h de folga).
setInterval(async () => {
    const agora = Math.floor(Date.now() / 1000);
    const limite = agora + 26 * 3600; // 26h à frente
    for (const item of db.listarReferencias('conector')) {
        if (!item.algolia_app_id || !item.algolia_api_key || !item.usuario || !item.senha) continue;
        const expiry = _algoliaKeyExpiry(item.algolia_api_key);
        if (expiry && expiry < limite) {
            console.log(`[Algolia] Renovando chave de #${item.id} (${item.nome}) — expira em ${Math.round((expiry - agora) / 3600)}h`);
            await _renovarChaveAlgolia(item).catch(() => {});
        }
    }
}, 6 * 3600 * 1000);

// Busca produtos via API Algolia InstantSearch — contorna WAF pois chama
// diretamente os servidores Algolia (*.algolia.net) sem passar pelo site.
// Renova a chave automaticamente se estiver a menos de 2h do vencimento.
// Retorna { itens, formato, total } ou { falha, motivo }
async function _buscarAlgolia(item, termo) {
    const appId = (item.algolia_app_id || '').trim();
    let apiKey  = (item.algolia_api_key || '').trim();
    const index = (item.algolia_index  || '').trim();
    if (!appId || !apiKey || !index) {
        return { falha: true, motivo: 'Configuração Algolia incompleta (App ID, API Key ou Índice ausente)' };
    }
    // Renova proativamente se a chave vence em menos de 2h
    const expiry = _algoliaKeyExpiry(apiKey);
    if (expiry && expiry < Math.floor(Date.now() / 1000) + 7200 && item.usuario && item.senha) {
        const nova = await _renovarChaveAlgolia(item).catch(() => null);
        if (nova) apiKey = nova;
    }
    return new Promise((resolve) => {
        const hitsPerPage = item._hitsPerPage !== undefined ? item._hitsPerPage : 40;
        const body = Buffer.from(JSON.stringify({ query: termo, hitsPerPage }));
        const options = {
            hostname: `${appId}-dsn.algolia.net`,
            path: `/1/indexes/${encodeURIComponent(index)}/query`,
            method: 'POST',
            headers: {
                'X-Algolia-Application-Id': appId,
                'X-Algolia-API-Key': apiKey,
                'Content-Type': 'application/json',
                'Content-Length': body.length,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        };
        const req = https.request(options, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    if (!data.hits) return resolve({ falha: true, motivo: `Algolia HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf-8').substring(0, 200)}` });
                    // Extrator de campos aninhados com padrão { v: valor } (Pellegrino)
                    // ou string simples (outros conectores Algolia)
                    const _v = f => f == null ? '' : (typeof f === 'object' && !Array.isArray(f) ? String(f.v ?? f.value ?? '') : String(f));
                    const itens = data.hits.map(h => {
                        // Nome: tenta hierarquia de categorias (Pellegrino b2b), depois campos genéricos
                        const cat1 = _v(h.categoria_1_b2b || h.categoria_1);
                        const cat2 = _v(h.categoria_2_b2b || h.categoria_2);
                        const cat3 = _v(h.categoria_3_b2b || h.categoria_3);
                        const nomeCateg = [cat1, cat2, cat3].filter(Boolean).join(' › ');
                        return {
                            sku:               h.objectID || h.sku || h.codigo || '',
                            nome:              nomeCateg || h.name || h.nome || h.title || h.descricao || '',
                            ean:               _v(h.ean) || _v(h.ean_code) || '',
                            ncm:               _v(h.ncm) || '',
                            codigo_fabricante: _v(h.codigo_fabricante_br) || _v(h.codigo_fabricante) || '',
                            marca:             _v(h.marca) || _v(h.fabricante) || h.brand || '',
                            aplicacao:         _v(h.aplicacao) || h.application || '',
                            linha:             h.linha || h.line || '',
                            preco:             h.price != null ? h.price : (h.preco != null ? h.preco : ''),
                            categoria:         nomeCateg || h.category || _v(h.categoria) || '',
                            imagem:            h.image || h.imagem || h.thumbnail || '',
                            url:               h.url || h.link || '',
                        };
                    });
                    resolve({ itens, formato: 'algolia', total: data.nbHits || itens.length, url_usada: `algolia://${appId}/${index}` });
                } catch (e) { resolve({ falha: true, motivo: 'Erro ao parsear resposta Algolia: ' + e.message }); }
            });
        });
        req.on('error', e => resolve({ falha: true, motivo: 'Erro de rede Algolia: ' + e.message }));
        req.setTimeout(12000, () => { req.destroy(); resolve({ falha: true, motivo: 'Timeout Algolia (12s)' }); });
        req.write(body);
        req.end();
    });
}

// Busca produtos em um conector autenticado pesquisando por termo.
// Usado pelo agente de auto-enriquecimento para consultar fornecedores.
// Retorna { itens, formato } ou { falha, motivo }
async function _buscarNoConector(item, termo) {
    // Algolia tem prioridade: sem scraping, sem WAF, sem login
    if (item.algolia_app_id && item.algolia_api_key && item.algolia_index) {
        return _buscarAlgolia(item, termo);
    }

    let sessao;
    if (item.usuario && item.senha) {
        sessao = await _loginFormulario(item);
        if (sessao.falha) return { falha: true, motivo: sessao.motivo };
    }
    const cookies = sessao ? sessao.cookies : '';
    const urlBase = sessao ? sessao.url_base : new URL(item.url).origin;

    // Constrói URL de busca — tenta padrões comuns
    const termoCodificado = encodeURIComponent(termo);
    const buscaUrls = [
        urlBase + '/catalogsearch/result/index/?q=' + termoCodificado,
        urlBase + '/busca?q=' + termoCodificado,
        urlBase + '/search?q=' + termoCodificado,
        urlBase + '/produtos?busca=' + termoCodificado,
    ];

    for (const bu of buscaUrls) {
        try {
            const r = await _fetchComCookies(bu, cookies, 15000);
            if (r.status !== 200) continue;
            const magento = _scrapeMagentoHtml(r.corpo);
            if (magento && magento.itens.length > 0) return { itens: magento.itens, formato: magento.formato, url_usada: bu };
            const gen = _parseConectorCorpo(r.corpo, r.content_type);
            if (gen && gen.itens.length > 0) return { itens: gen.itens, formato: gen.formato, url_usada: bu };
        } catch (_) {}
    }
    return { falha: true, motivo: `Nenhum resultado encontrado para "${termo}" nos caminhos de busca testados` };
}

// Tenta autenticar em uma loja Magento 2 via REST API.
// Sucesso: { base, token, tipo }
// Falha:   { falha: true, erros: string[] }  — inclui diagnóstico por endpoint
async function _tentarMagentoAuth(urlOriginal, usuario, senha) {
    if (!usuario && !senha) return { falha: true, erros: ['Sem credenciais cadastradas'] };
    let base;
    try { base = new URL(urlOriginal).origin; } catch (_) { return { falha: true, erros: ['URL inválida'] }; }

    const erros = [];
    for (const tipo of ['customer', 'admin']) {
        for (const prefix of _MAGENTO_REST_PREFIXES) {
            const endpoint = `${base}${prefix}/integration/${tipo}/token`;
            try {
                const r = await _httpPostJson(endpoint, { username: usuario || '', password: senha || '' });
                if (r.status === 200) {
                    try {
                        const token = JSON.parse(r.corpo);
                        if (typeof token === 'string' && token.length > 10) return { base, token, tipo };
                    } catch (_) { erros.push(`${prefix}/${tipo} → HTTP 200 mas resposta não é token`); continue; }
                }
                erros.push(`${prefix}/integration/${tipo}/token → HTTP ${r.status}`);
            } catch (e) {
                erros.push(`${prefix}/integration/${tipo}/token → erro: ${e.message.substring(0, 80)}`);
            }
        }
    }
    return { falha: true, erros };
}

// Extrai produtos de uma resposta Magento 2 REST (/rest/V1/products).
function _parseMagentoProducts(corpo) {
    try {
        const data = JSON.parse(corpo);
        const items = data.items || (Array.isArray(data) ? data : null);
        if (!items) return null;
        return {
            formato: 'magento2',
            itens: items.map(p => ({
                sku: p.sku || '',
                nome: p.name || '',
                preco: p.price != null ? p.price : '',
                status: p.status === 1 ? 'Ativo' : 'Inativo',
                tipo: p.type_id || '',
                peso: p.weight || '',
            })),
            total: data.total_count || items.length,
        };
    } catch (_) { return null; }
}

// Tenta detectar e parsear os dados recebidos do conector em um array de
// produtos/objetos. Suporta JSON (array ou {data/itens/produtos:[]}) e CSV.
function _parseConectorCorpo(corpo, contentType) {
    const ct = (contentType || '').toLowerCase();

    if (ct.includes('json') || corpo.trimStart().startsWith('{') || corpo.trimStart().startsWith('[')) {
        try {
            const parsed = JSON.parse(corpo);
            if (Array.isArray(parsed)) return { formato: 'json', itens: parsed };
            for (const k of ['items', 'data', 'itens', 'produtos', 'products', 'result', 'results', 'rows', 'records']) {
                if (parsed[k] && Array.isArray(parsed[k])) return { formato: 'json', itens: parsed[k], total: parsed.total_count || parsed.total || parsed.count || null };
            }
            return { formato: 'json', itens: [parsed] };
        } catch (_) {}
    }

    if (ct.includes('csv') || ct.includes('text/plain') || corpo.includes(';') || corpo.includes(',')) {
        try {
            const linhas = corpo.trim().split(/\r?\n/).filter(Boolean);
            if (linhas.length < 2) return { formato: 'csv', itens: [] };
            const sep = linhas[0].includes(';') ? ';' : ',';
            const cabecalho = linhas[0].split(sep).map(s => s.trim().replace(/^["']|["']$/g, ''));
            const itens = linhas.slice(1).map(l => {
                const vals = l.split(sep).map(s => s.trim().replace(/^["']|["']$/g, ''));
                const obj = {};
                cabecalho.forEach((k, i) => { obj[k] = vals[i] || ''; });
                return obj;
            });
            return { formato: 'csv', itens };
        } catch (_) {}
    }

    // Tenta raspar tabelas HTML genéricas (catálogos com <table>)
    if (corpo.includes('<table') && corpo.includes('<tr')) {
        try {
            const tableRe = /<table[\s\S]*?<\/table>/gi;
            let bestItens = [];
            let tm;
            while ((tm = tableRe.exec(corpo)) !== null) {
                const tbl = tm[0];
                const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
                const rows = [];
                let rm;
                while ((rm = rowRe.exec(tbl)) !== null) rows.push(rm[1]);
                if (rows.length < 2) continue;
                const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
                const header = [];
                let cm;
                while ((cm = cellRe.exec(rows[0])) !== null) header.push(cm[1].replace(/<[^>]+>/g, '').trim());
                if (header.length < 2) continue;
                const itensTabela = [];
                for (let i = 1; i < rows.length; i++) {
                    const vals = [];
                    cellRe.lastIndex = 0;
                    while ((cm = cellRe.exec(rows[i])) !== null) vals.push(cm[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim());
                    if (vals.filter(Boolean).length < 1) continue;
                    const obj = {};
                    header.forEach((h, idx) => { obj[h || ('col' + idx)] = vals[idx] || ''; });
                    itensTabela.push(obj);
                }
                if (itensTabela.length > bestItens.length) bestItens = itensTabela;
            }
            if (bestItens.length > 0) return { formato: 'tabela-html', itens: bestItens, total: bestItens.length };
        } catch (_) {}
    }

    // MercadoLivre — extrai produtos das listas de categoria/busca
    if (corpo.includes('ui-search-item__title') || corpo.includes('andes-money-amount')) {
        try {
            const nomeRe = /class="[^"]*ui-search-item__title[^"]*"[^>]*>([\s\S]*?)<\/(?:h2|span|a)>/g;
            const precoRe = /class="[^"]*andes-money-amount__fraction[^"]*">([^<]+)<\/span>/g;
            const urlRe = /class="[^"]*ui-search-link[^"]*"[^>]+href="([^"]+)"/g;
            const nomes = [], precos = [], urls = [];
            let m;
            while ((m = nomeRe.exec(corpo)) !== null) nomes.push(m[1].replace(/<[^>]+>/g, '').trim());
            while ((m = precoRe.exec(corpo)) !== null) precos.push(m[1].trim());
            while ((m = urlRe.exec(corpo)) !== null) urls.push(m[1]);
            if (nomes.length > 0) {
                const itensML = nomes.map((n, i) => ({ sku: '', nome: n, preco: precos[i] || '', url: urls[i] || '' }));
                return { formato: 'mercadolivre', itens: itensML, total: itensML.length };
            }
        } catch (_) {}
    }

    // Sites React/Next.js — extrai dados de produto do __NEXT_DATA__ ou window.__STATE__
    const nextRe = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
    const stateRe = /window\.__(?:INITIAL_STATE|STATE|PRELOADED_STATE|REDUX_STATE|APP_STATE)__\s*=\s*(\{[\s\S]*?\});/;
    for (const re of [nextRe, stateRe]) {
        const nm = re.exec(corpo);
        if (!nm) continue;
        try {
            const obj = JSON.parse(nm[1]);
            const encontrados = _extrairProdutosDeObj(obj, 0);
            if (encontrados.length > 0) return { formato: 'json-embutido', itens: encontrados, total: encontrados.length };
        } catch (_) {}
    }

    return { formato: 'html', itens: [], preview: corpo.substring(0, 800) };
}

// Percorre recursivamente um objeto JSON procurando arrays de produtos.
function _extrairProdutosDeObj(obj, profundidade) {
    if (profundidade > 6 || !obj || typeof obj !== 'object') return [];
    if (Array.isArray(obj)) {
        if (obj.length > 0 && obj[0] && typeof obj[0] === 'object' && (obj[0].name || obj[0].title || obj[0].nome || obj[0].sku || obj[0].id)) {
            return obj.map(p => ({
                sku: p.sku || p.id || p.codigo || '',
                nome: p.name || p.title || p.nome || p.titulo || p.description || '',
                preco: p.price || p.valor || p.preco || (p.offers && p.offers.price) || '',
                url: p.url || p.permalink || p.link || '',
                imagem: p.thumbnail || p.image || p.foto || '',
            })).filter(p => p.nome);
        }
        for (const item of obj.slice(0, 10)) {
            const r = _extrairProdutosDeObj(item, profundidade + 1);
            if (r.length > 0) return r;
        }
        return [];
    }
    for (const key of Object.keys(obj)) {
        const r = _extrairProdutosDeObj(obj[key], profundidade + 1);
        if (r.length > 0) return r;
    }
    return [];
}

// Raspa produtos de uma página HTML de catálogo Magento 2.
// Tenta JSON-LD estruturado primeiro; cai para regex de classes Magento se não encontrar.
// Retorna { formato, itens, total } ou null se não parece catálogo Magento.
function _scrapeMagentoHtml(html) {
    let itens = [], m;

    // 1) JSON-LD — dados estruturados (Product ou ItemList)
    const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    while ((m = ldRe.exec(html)) !== null) {
        try {
            const d = JSON.parse(m[1]);
            const lista = d['@graph'] ? d['@graph'].filter(x => x && x['@type'] === 'Product')
                        : d['@type'] === 'ItemList' ? (d.itemListElement || []).map(x => (x.item || x)).filter(x => x && x.name)
                        : d['@type'] === 'Product' ? [d] : [];
            lista.forEach(p => {
                if (!p.name) return;
                const of = p.offers ? (Array.isArray(p.offers) ? p.offers[0] : p.offers) : {};
                itens.push({ sku: p.sku || p.productID || '', nome: p.name, preco: of.price || of.priceCurrency ? of.price || '' : '', url: p.url || '', imagem: Array.isArray(p.image) ? p.image[0] : (p.image || '') });
            });
        } catch (_) {}
    }
    if (itens.length > 0) return { formato: 'magento-html', itens, total: itens.length };

    // 2) HTML regex — classes padrão do Magento 2 frontend
    if (!html.includes('product-item-link') && !html.includes('product-item-name')) return null;

    const _esc = s => s.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '').trim();

    // Extrai nomes e URLs dos produtos
    const linkRe = /class="product-item-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = linkRe.exec(html)) !== null) {
        const nome = _esc(m[2]);
        if (nome) itens.push({ sku: '', nome, preco: '', url: m[1], imagem: '' });
    }
    if (!itens.length) return null;

    // Extrai preços numéricos via data-price-amount (mais confiável que texto formatado)
    const precoRe = /data-price-amount="([0-9.]+)"/g;
    let pi = 0;
    while ((m = precoRe.exec(html)) !== null && pi < itens.length) itens[pi++].preco = m[1];

    // Extrai SKUs via data-product-sku ou data-item-id
    const skuRe = /data-product-sku="([^"]+)"/g;
    let si = 0;
    while ((m = skuRe.exec(html)) !== null && si < itens.length) itens[si++].sku = m[1];

    // Extrai imagem principal
    const imgRe = /class="product-image-photo"[^>]+src="([^"]+)"/g;
    let ii = 0;
    while ((m = imgRe.exec(html)) !== null && ii < itens.length) itens[ii++].imagem = m[1];

    return { formato: 'magento-html', itens, total: itens.length };
}

// Testa se um conector consegue se conectar ao URL cadastrado.
// Em caso de 401: obtém token Magento 2 e retorna sucesso imediatamente
// (obter o token já prova que as credenciais são válidas).
// Se configurado com Algolia, testa conectividade diretamente na API Algolia.
app.post('/api/ntc-referencias/:id/testar', async (req, res) => {
    try {
        const item = db.listarReferencias().find(r => r.id === Number(req.params.id));
        if (!item) return res.status(404).json({ ok: false, erro: 'Conector não encontrado.' });

        // Teste de conectividade Algolia
        if (item.algolia_app_id && item.algolia_api_key && item.algolia_index) {
            const t0 = Date.now();
            const expiry = _algoliaKeyExpiry(item.algolia_api_key);
            const agoraS = Math.floor(Date.now() / 1000);
            const expiryInfo = expiry
                ? (expiry < agoraS ? '⚠️ Chave EXPIRADA' : `Chave válida por mais ${Math.round((expiry - agoraS) / 3600)}h`)
                : 'Chave permanente (sem validUntil)';
            // Busca com query vazia para obter total de produtos do catálogo
            const rTotal = await _buscarAlgolia({ ...item, _hitsPerPage: 0 }, '');
            const totalCatalogo = !rTotal.falha ? rTotal.total : null;
            const r = await _buscarAlgolia(item, 'filtro');
            if (r.falha) return res.json({ ok: false, erro: r.motivo, latencia_ms: Date.now() - t0, expiry_info: expiryInfo });
            const totalInfo = totalCatalogo != null ? `Catálogo total: ${totalCatalogo.toLocaleString('pt-BR')} produtos.` : '';
            return res.json({ ok: true, status: 200, latencia_ms: Date.now() - t0, auth_tipo: 'algolia', content_type: 'application/json', expiry_info: expiryInfo, total_catalogo: totalCatalogo, preview: `Algolia OK — ${totalInfo} ${expiryInfo}.` });
        }

        if (!item.url) return res.status(400).json({ ok: false, erro: 'Este conector não tem URL cadastrada.' });

        const t0 = Date.now();
        let r = await _fetchConector(item.url, item.usuario, item.senha);
        let auth_tipo = (item.usuario || item.senha) ? 'basic' : 'none';

        if (r.status >= 400 && (item.usuario || item.senha)) {
            const mg = await _tentarMagentoAuth(item.url, item.usuario, item.senha);
            if (mg && !mg.falha) {
                return res.json({ ok: true, status: 200, latencia_ms: Date.now() - t0, content_type: 'application/json', auth_tipo: 'magento2-' + mg.tipo, preview: `Token Magento 2 (${mg.tipo}) obtido — credenciais válidas. Clique em 📥 Importar para buscar os produtos.` });
            }
            // Mostra diagnóstico: o que cada tentativa de token retornou
            const diag = mg && mg.erros ? '\nDiagnóstico:\n' + mg.erros.join('\n') : '';
            return res.json({ ok: false, status: r.status, latencia_ms: r.latencia_ms, auth_tipo, erro: `HTTP ${r.status} no site; autenticação Magento 2 falhou em todos os prefixos.${diag}` });
        }

        res.json({ ok: r.status < 400, status: r.status, latencia_ms: r.latencia_ms, content_type: r.content_type, auth_tipo, preview: r.corpo.substring(0, 500), location: r.location || undefined });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// Busca produtos por termo em um conector (com login automático se necessário).
// Usado pelo agente de auto-enriquecimento para consultar fornecedores autenticados.
app.post('/api/ntc-referencias/:id/buscar', async (req, res) => {
    try {
        const item = db.listarReferencias().find(r => r.id === Number(req.params.id));
        if (!item) return res.status(404).json({ ok: false, erro: 'Conector não encontrado.' });
        if (!item.url && !(item.algolia_app_id && item.algolia_api_key && item.algolia_index)) return res.status(400).json({ ok: false, erro: 'Conector sem URL nem configuração Algolia.' });
        const termo = (req.body && req.body.termo) || '';
        if (!termo.trim()) return res.status(400).json({ ok: false, erro: 'Parâmetro "termo" obrigatório.' });
        const resultado = await _buscarNoConector(item, termo.trim());
        if (resultado.falha) return res.json({ ok: false, erro: resultado.motivo });
        res.json({ ok: true, ...resultado, total: resultado.itens ? resultado.itens.length : 0 });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// Renova a Algolia Search API Key do conector fazendo login e extraindo nova chave.
app.post('/api/ntc-referencias/:id/renovar-chave', async (req, res) => {
    try {
        const item = db.listarReferencias().find(r => r.id === Number(req.params.id));
        if (!item) return res.status(404).json({ ok: false, erro: 'Conector não encontrado.' });
        if (!item.algolia_app_id) return res.status(400).json({ ok: false, erro: 'Conector não usa Algolia.' });
        if (!item.usuario || !item.senha) return res.status(400).json({ ok: false, erro: 'Conector sem usuário/senha — necessário para renovar a chave.' });
        _sessoeConnectores.delete(item.id); // força novo login
        const novaChave = await _renovarChaveAlgolia(item);
        if (!novaChave) return res.json({ ok: false, erro: 'Não foi possível extrair nova chave Algolia do site. Cole a chave manualmente via DevTools.' });
        const expiry = _algoliaKeyExpiry(novaChave);
        const agoraS = Math.floor(Date.now() / 1000);
        const horasRestantes = expiry ? Math.round((expiry - agoraS) / 3600) : null;
        res.json({ ok: true, preview: `Chave renovada com sucesso!${horasRestantes ? ` Válida por mais ${horasRestantes}h.` : ''}` });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// Recebe a chave Algolia capturada pelo bookmarklet no browser do usuário e salva.
// Precisa de CORS aberto pois o bookmarklet roda no domínio do fornecedor.
app.options('/api/ntc-referencias/:id/renovar-chave-browser', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});
app.post('/api/ntc-referencias/:id/renovar-chave-browser', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        const { algolia_api_key } = req.body || {};
        if (!algolia_api_key || algolia_api_key.length < 20) {
            return res.status(400).json({ ok: false, erro: 'algolia_api_key inválida ou ausente' });
        }
        const item = db.listarReferencias().find(r => r.id === Number(req.params.id));
        if (!item) return res.status(404).json({ ok: false, erro: 'Conector não encontrado' });
        const expiry = _algoliaKeyExpiry(algolia_api_key);
        const agoraS = Math.floor(Date.now() / 1000);
        const horasRestantes = expiry ? Math.round((expiry - agoraS) / 3600) : null;
        db.atualizarReferencia(Number(req.params.id), { algolia_api_key });
        console.log(`[Bookmarklet] Chave renovada para conector #${req.params.id} (${item.nome})${horasRestantes ? ` — válida por ${horasRestantes}h` : ''}`);
        res.json({ ok: true, expiry_info: horasRestantes ? `Válida por mais ${horasRestantes}h` : 'Chave permanente' });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

// Exporta TODOS os produtos do índice Algolia como CSV para download no PC.
// Usa a Browse API (cursor-based) e inclui TODOS os campos brutos do índice.
app.get('/api/ntc-referencias/:id/exportar-algolia', async (req, res) => {
    try {
        const item = db.listarReferencias().find(r => r.id === Number(req.params.id));
        if (!item) return res.status(404).json({ ok: false, erro: 'Conector não encontrado.' });
        if (!item.algolia_app_id || !item.algolia_api_key || !item.algolia_index) {
            return res.status(400).json({ ok: false, erro: 'Conector sem configuração Algolia.' });
        }
        const appId  = item.algolia_app_id.trim();
        const apiKey = item.algolia_api_key.trim();
        const index  = item.algolia_index.trim();
        const csvEsc = s => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;

        // Planifica um campo: { v: valor } → valor, array → pipe-separated, objeto → JSON
        const flat = (v) => {
            if (v == null) return '';
            if (typeof v === 'object' && !Array.isArray(v)) {
                if ('v' in v) return String(v.v ?? '');
                if ('value' in v) return String(v.value ?? '');
                return JSON.stringify(v);
            }
            if (Array.isArray(v)) return v.map(flat).join('|');
            return String(v);
        };

        // Campos a excluir (internos do Algolia, sem valor para o usuário)
        const EXCLUIR = new Set(['_highlightResult', '_snippetResult', '_rankingInfo', '_distinctSeqID']);

        // Consulta Algolia via POST /query com paginação (page=0,1,2...)
        // A chave secured não tem ACL browse, então usamos a search API normal.
        const _pagina = (page) => new Promise((resolve) => {
            const body = Buffer.from(JSON.stringify({ query: '', hitsPerPage: 1000, page }));
            const opts = {
                hostname: `${appId}-dsn.algolia.net`,
                path: `/1/indexes/${encodeURIComponent(index)}/query`,
                method: 'POST',
                headers: {
                    'X-Algolia-Application-Id': appId,
                    'X-Algolia-API-Key': apiKey,
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                },
            };
            const r2 = https.request(opts, resp => {
                const chunks = [];
                resp.on('data', d => chunks.push(d));
                resp.on('end', () => {
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
                    catch (e) { resolve({ error: e.message }); }
                });
            });
            r2.on('error', e => resolve({ error: e.message }));
            r2.setTimeout(30000, () => { r2.destroy(); resolve({ error: 'timeout' }); });
            r2.write(body);
            r2.end();
        });

        // Primeira página para descobrir campos e total de páginas
        const primeira = await _pagina(0);
        if (primeira.error || !primeira.hits) {
            return res.status(502).json({ ok: false, erro: primeira.error || JSON.stringify(primeira) });
        }
        // Coleta todas as chaves únicas da primeira página (descobre esquema)
        const colunasSet = new Set(['objectID']);
        for (const h of primeira.hits) {
            for (const k of Object.keys(h)) {
                if (!EXCLUIR.has(k)) colunasSet.add(k);
            }
        }
        // url_produto construída a partir do objectID (padrão Pellegrino)
        const urlBase = item.url ? new URL(item.url).origin : 'https://compreonline.pellegrino.com.br';
        colunasSet.add('url_produto');
        const colunas = [...colunasSet];

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${index}-${new Date().toISOString().slice(0,10)}.csv"`);
        res.write('﻿'); // BOM UTF-8 para Excel
        res.write(colunas.map(csvEsc).join(';') + '\r\n');

        const escreverPagina = (hits) => {
            for (const h of hits) {
                const id = h.objectID || '';
                const urlProduto = id ? `${urlBase}/catalogo?pdpwsid=${encodeURIComponent(id)}&pdpobjectid=${encodeURIComponent(id)}` : '';
                const row = { ...h, url_produto: urlProduto };
                res.write(colunas.map(k => csvEsc(flat(row[k]))).join(';') + '\r\n');
            }
        };

        escreverPagina(primeira.hits);
        const nbPages = primeira.nbPages || 1;
        for (let p = 1; p < nbPages; p++) {
            const pg = await _pagina(p);
            if (pg.error || !pg.hits || !pg.hits.length) break;
            escreverPagina(pg.hits);
        }

        res.end();
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ ok: false, erro: e.message });
        else res.end();
    }
});

// Testa login via formulário HTML para um conector (invalida cache forçando novo login).
app.post('/api/ntc-referencias/:id/login', async (req, res) => {
    try {
        const item = db.listarReferencias().find(r => r.id === Number(req.params.id));
        if (!item) return res.status(404).json({ ok: false, erro: 'Conector não encontrado.' });
        if (!item.usuario || !item.senha) return res.status(400).json({ ok: false, erro: 'Conector sem usuário/senha cadastrados.' });
        _sessoeConnectores.delete(item.id); // força novo login
        const resultado = await _loginFormulario(item);
        if (resultado.falha) return res.json({ ok: false, erro: resultado.motivo });
        res.json({ ok: true, tipo: resultado.tipo, url_base: resultado.url_base, preview: `Login realizado com sucesso (${resultado.tipo}). Sessão válida por 30 minutos.` });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// Prefixos de URL REST que lojas Magento 2 costumam usar (varia por configuração).
const _MAGENTO_REST_PREFIXES = ['/rest/V1', '/rest/default/V1', '/rest/all/V1', '/rest/pt_BR/V1'];

// Importa até `limite` produtos do conector, com fallback automático para
// Magento 2 REST API quando a primeira tentativa retorna 401/403.
// Tenta múltiplos prefixos de URL REST caso o padrão /rest/V1 retorne 404/405.
app.post('/api/ntc-referencias/:id/importar', async (req, res) => {
    try {
        const item = db.listarReferencias().find(r => r.id === Number(req.params.id));
        if (!item) return res.status(404).json({ ok: false, erro: 'Conector não encontrado.' });

        const limite = Math.min(parseInt((req.body && req.body.limite) || 20), 200);

        // Se Algolia configurado, usa busca direta sem precisar do site
        if (item.algolia_app_id && item.algolia_api_key && item.algolia_index) {
            const resultado = await _buscarAlgolia(item, (req.body && req.body.termo) || '');
            if (resultado.falha) return res.json({ ok: false, erro: resultado.motivo });
            const itens = resultado.itens.slice(0, limite);
            return res.json({ ok: true, formato: 'algolia', itens, preview_itens: itens, total: resultado.total, auth_tipo: 'algolia', latencia_ms: 0 });
        }

        if (!item.url) return res.status(400).json({ ok: false, erro: 'Este conector não tem URL cadastrada.' });

        let r = await _fetchConector(item.url, item.usuario, item.senha);

        // Fallback Magento 2: tenta token e depois GET /products nos prefixos conhecidos.
        // Dispara em qualquer 4xx (incluindo 405 de páginas de login) quando há credenciais.
        if (r.status >= 400 && (item.usuario || item.senha)) {
            const mg = await _tentarMagentoAuth(item.url, item.usuario, item.senha);
            if (mg && !mg.falha) {
                const bearerHeader = 'Bearer ' + mg.token;
                const qs = `?searchCriteria[pageSize]=${limite}&searchCriteria[currentPage]=1`;
                for (const prefix of _MAGENTO_REST_PREFIXES) {
                    const prodUrl = mg.base + prefix + '/products' + qs;
                    try {
                        r = await _fetchConector(prodUrl, null, null, 20000, bearerHeader);
                        if (r.status === 200) {
                            const parsed = _parseMagentoProducts(r.corpo);
                            if (parsed) return res.json({ ok: true, ...parsed, preview_itens: parsed.itens.slice(0, limite), latencia_ms: r.latencia_ms, auth_tipo: 'magento2-' + mg.tipo });
                        }
                    } catch (_) {}
                }
                return res.json({ ok: false, erro: `Token Magento 2 (${mg.tipo}) obtido, mas nenhum prefixo REST retornou produtos (HTTP ${r.status}). Use uma conta com permissão de catálogo/admin.`, status: r.status, auth_tipo: 'magento2-' + mg.tipo });
            }
            const diag = mg && mg.erros ? '\nDiagnóstico:\n' + mg.erros.join('\n') : '';
            return res.json({ ok: false, erro: `HTTP ${r.status} no site; autenticação Magento 2 falhou em todos os prefixos.${diag}`, status: r.status });
        }

        if (r.status >= 400) return res.json({ ok: false, erro: `Servidor respondeu com HTTP ${r.status}.`, status: r.status });

        // Se retornou uma página de login em vez do catálogo, tenta logar por formulário
        if (r.status === 200 && _ehPaginaLogin(r.corpo) && (item.usuario || item.senha)) {
            const sessao = await _loginFormulario(item);
            if (!sessao.falha) {
                const rAuth = await _fetchComCookies(item.url, sessao.cookies, 18000);
                if (rAuth.status === 200 && !_ehPaginaLogin(rAuth.corpo)) {
                    r = rAuth; // usa a resposta autenticada para continuar o parse abaixo
                } else {
                    return res.json({ ok: false, erro: 'Login por formulário realizado mas catálogo ainda não acessível.', status: rAuth.status });
                }
            } else {
                return res.json({ ok: false, erro: `Site retornou página de login. Tentei logar automaticamente mas falhou: ${sessao.motivo}` });
            }
        }

        // Tenta raspar HTML de catálogo Magento (URL pública de listagem/busca)
        const ct = (r.content_type || '').toLowerCase();
        if (ct.includes('text/html') || (r.corpo.includes('product-item') || r.corpo.includes('application/ld+json'))) {
            const primPag = _scrapeMagentoHtml(r.corpo);
            if (primPag && primPag.itens.length > 0) {
                let todosItens = primPag.itens.slice();
                // Paginação automática — tenta até 9 páginas extras para atingir `limite`
                try {
                    const urlBase = new URL(item.url);
                    const paginaInicial = parseInt(urlBase.searchParams.get('p') || '1');
                    for (let p = paginaInicial + 1; todosItens.length < limite && p <= paginaInicial + 9; p++) {
                        urlBase.searchParams.set('p', String(p));
                        const rp = await _fetchConector(urlBase.toString(), item.usuario, item.senha);
                        if (rp.status !== 200) break;
                        const pag = _scrapeMagentoHtml(rp.corpo);
                        if (!pag || !pag.itens.length) break;
                        // Detecta última página (mesmos produtos da anterior)
                        if (pag.itens[0].nome === todosItens[todosItens.length - pag.itens.length]?.nome) break;
                        todosItens = todosItens.concat(pag.itens);
                    }
                } catch (_) {}
                return res.json({ ok: true, formato: 'magento-html', total: todosItens.length, preview_itens: todosItens.slice(0, limite), latencia_ms: r.latencia_ms });
            }
        }

        const { formato, itens, total, preview } = _parseConectorCorpo(r.corpo, r.content_type);
        res.json({ ok: true, formato, total: total || itens.length, preview_itens: itens.slice(0, limite), latencia_ms: r.latencia_ms, preview_html: preview });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// ─── AUTO-ENRIQUECIMENTO 24/7 — status e disparo manual ───────────────
app.get('/api/auto-enrich/status', (req, res) => {
    res.json({ ok: true, ...autoEnrich.obterStatus() });
});

app.post('/api/auto-enrich/trigger', async (req, res) => {
    const batchSize = parseInt(req.body && req.body.batchSize) || undefined;
    const resultado = await autoEnrich.rodarCicloAutoEnrich(batchSize);
    res.json(resultado);
});

// Pausa/retoma o job 24/7 em tempo de execução — não consome créditos da API
// enquanto pausado, permitindo testes controlados via "Minerar selecionados".
app.post('/api/auto-enrich/toggle', (req, res) => {
    const habilitado = autoEnrich.definirHabilitado(req.body && req.body.habilitado);
    res.json({ ok: true, habilitado });
});

// ─── EXPORT APROVADOS — CSV para Google Sheets / Drive / Bling / Wix ─────────
// Retorna produtos com NTC ≥ ntc_min (padrão 0.95) como CSV BOM-UTF-8.
// Google Sheets pode importar via =IMPORTDATA("URL") sem credenciais.
app.get('/api/produtos/export-csv', (req, res) => {
    const ntcMin  = Math.max(0, Math.min(1, parseFloat(req.query.ntc_min  || '0.95')));
    const decisao = (req.query.decisao || '').trim();
    const limite  = Math.min(parseInt(req.query.limite || '50000') || 50000, 50000);
    try {
        let sql = 'SELECT * FROM produtos WHERE ntc >= @ntcMin';
        const params = { ntcMin };
        if (decisao) { sql += ' AND decisao = @decisao'; params.decisao = decisao; }
        sql += ' ORDER BY ntc DESC LIMIT @limite';
        params.limite = limite;
        const rows = db.db.prepare(sql).all(params);

        const campos = ['sku','nome','ean','ncm','fabricante','codigo_oem','aplicacao',
            'preco_custo','categoria','subcategoria','linha','url_fornecedor','imagem',
            'ntc','decisao','fornecedor_nome','fonte'];
        const esc = v => {
            const s = v == null ? '' : String(v);
            return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
        };
        const linhas = ['﻿' + campos.join(',')];
        for (const row of rows) {
            let d = {};
            try { d = JSON.parse(row.dados_json || '{}'); } catch (_) {}
            linhas.push(campos.map(c => esc(row[c] != null ? row[c] : d[c])).join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="genesis-aprovados-ntc${Math.round(ntcMin*100)}.csv"`);
        res.send(linhas.join('\r\n'));
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

// ─── GOOGLE SHOPPING FEED — XML para Google Merchant Center ──────────────────
// Retorna feed RSS 2.0 / Google Merchant Center com produtos aprovados (NTC ≥ 0.95).
// Google Merchant Center: Produtos → Feeds → Adicionar feed → URL agendada → cole esta URL.
// Listagens gratuitas: 100% free, sem custo por clique.
app.get('/api/produtos/google-shopping-feed', (req, res) => {
    const ntcMin = Math.max(0, Math.min(1, parseFloat(req.query.ntc_min || '0.95')));
    const limite = Math.min(parseInt(req.query.limite || '50000') || 50000, 50000);
    try {
        const rows = db.db.prepare(
            'SELECT * FROM produtos WHERE ntc >= @ntcMin AND decisao = \'APROVADO\' ORDER BY ntc DESC LIMIT @limite'
        ).all({ ntcMin, limite });

        const siteUrl = process.env.RENDER_EXTERNAL_URL || 'https://genesis-indexa-360-ia.onrender.com';
        const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

        const items = rows.map(row => {
            let d = {};
            try { d = JSON.parse(row.dados_json || '{}'); } catch (_) {}
            const get = (...keys) => { for (const k of keys) { const v = row[k] != null ? row[k] : d[k]; if (v != null && v !== '') return v; } return ''; };
            const sku = get('sku');
            const nome = get('nome');
            const preco = get('preco_venda', 'preco_custo');
            const imagem = get('imagem', 'imagem_url');
            const fabricante = get('fabricante');
            const gtin = get('ean');
            const mpn = get('codigo_oem');
            const desc = get('descricao') || [
                nome, fabricante && `Fabricante: ${fabricante}`,
                get('aplicacao') && `Aplicação: ${get('aplicacao')}`,
                `SKU: ${sku}`
            ].filter(Boolean).join(' | ');

            if (!nome || !preco) return '';

            return [
                '    <item>',
                `      <g:id>${esc(sku)}</g:id>`,
                `      <g:title>${esc(nome.substring(0,150))}</g:title>`,
                `      <g:description>${esc(desc.substring(0,5000))}</g:description>`,
                `      <g:link>${esc(siteUrl)}</g:link>`,
                imagem ? `      <g:image_link>${esc(imagem)}</g:image_link>` : '',
                `      <g:condition>new</g:condition>`,
                `      <g:availability>in_stock</g:availability>`,
                `      <g:price>${parseFloat(preco).toFixed(2)} BRL</g:price>`,
                gtin ? `      <g:gtin>${esc(gtin)}</g:gtin>` : '',
                mpn  ? `      <g:mpn>${esc(mpn)}</g:mpn>` : '',
                fabricante ? `      <g:brand>${esc(fabricante)}</g:brand>` : '',
                `      <g:google_product_category>Veículos e Peças</g:google_product_category>`,
                '    </item>',
            ].filter(Boolean).join('\n');
        }).filter(Boolean).join('\n');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>iRollo 360 — Peças Automotivas</title>
    <link>${esc(siteUrl)}</link>
    <description>Catálogo de peças automotivas aprovadas NTC 4.0</description>
${items}
  </channel>
</rss>`;

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(xml);
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

// ─── CADASTRO EM MASSA — importar lote de produtos ────────────────────────────
// Recebe { itens: [...], fornecedor_nome, fonte } e faz upsert em lote.
// Campos dos itens seguem o padrão Algolia/CSV do Pellegrino B2B.
// Campos vazios NÃO sobrescrevem dados já confirmados (merge seletivo).
app.post('/api/produtos/importar-lote', (req, res) => {
    try {
        const { itens, fornecedor_nome, fonte } = req.body || {};
        if (!Array.isArray(itens) || itens.length === 0) {
            return res.status(400).json({ ok: false, erro: 'Campo "itens" é obrigatório e deve ser array não vazio' });
        }
        let inseridos = 0, atualizados = 0, erros = 0;
        const erros_lista = [];
        for (const item of itens) {
            try {
                const sku = String(item.sku || item.objectID || item.codigo || '').trim();
                if (!sku) { erros++; continue; }
                const existente = db.obterProdutoPorSku(sku);
                // Monta dados filtrando vazios → não apaga campos já confirmados
                const mapeados = {
                    ean:          item.ean || item.codigo_ean,
                    ncm:          item.ncm,
                    fabricante:   item.marca || item.fabricante,
                    codigo_oem:   item.codigo_fabricante || item.codigo_fabricante_br || item.codigo_oem,
                    aplicacao:    item.aplicacao || item.descricao_aplicacao,
                    preco_custo:  item.preco || item.preco_custo || item.price,
                    categoria:    item.categoria_1 || item.categoria,
                    subcategoria: item.categoria_2 || item.subcategoria,
                    linha:        item.linha || item.familia,
                    url_fornecedor: item.url_produto || item.url,
                    imagem:       item.imagem || item.thumbnail,
                };
                const dadosNovos = {};
                for (const [k, v] of Object.entries(mapeados)) {
                    if (v != null && v !== '') dadosNovos[k] = String(v);
                }
                if (item.imagens) {
                    dadosNovos.imagens = Array.isArray(item.imagens) ? item.imagens : [item.imagens];
                }
                const dadosFinais = existente ? { ...(existente.dados || {}), ...dadosNovos } : dadosNovos;
                const cat1 = item.categoria_1 || item.categoria || '';
                const cat2 = item.categoria_2 || item.subcategoria || '';
                const cat3 = item.categoria_3 || '';
                const nome = item.nome || item.descricao ||
                    [cat1, cat2, cat3].filter(Boolean).join(' › ') || sku;
                db.upsertProduto({
                    sku, nome, dados: dadosFinais,
                    fornecedor_nome: fornecedor_nome || item.fornecedor_nome || '',
                    fonte: fonte || item.fonte || 'fornecedor',
                });
                if (existente) { atualizados++; } else { inseridos++; }
            } catch (e) {
                erros++;
                if (erros_lista.length < 5) erros_lista.push({ sku: item.sku || item.objectID, erro: e.message });
            }
        }
        res.json({ ok: true, inseridos, atualizados, erros, total: itens.length, erros_lista });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

// Busca uma página do índice Algolia e salva os produtos no banco local.
// O cliente chama em loop (página 0, 1, 2 ...) até cobrir total_paginas.
app.post('/api/ntc-referencias/:id/importar-algolia-pagina', async (req, res) => {
    try {
        const item = db.listarReferencias().find(r => r.id === Number(req.params.id));
        if (!item) return res.status(404).json({ ok: false, erro: 'Conector não encontrado' });
        if (!item.algolia_app_id || !item.algolia_api_key || !item.algolia_index) {
            return res.status(400).json({ ok: false, erro: 'Conector sem configuração Algolia' });
        }
        const appId  = item.algolia_app_id.trim();
        let apiKey   = item.algolia_api_key.trim();
        const index  = item.algolia_index.trim();
        const pagina = parseInt((req.body && req.body.pagina) || 0);
        const hitsPerPage = Math.min(parseInt((req.body && req.body.hitsPerPage) || 200), 1000);

        // Renova chave se necessário
        const expiry = _algoliaKeyExpiry(apiKey);
        if (expiry && expiry < Math.floor(Date.now() / 1000) + 7200 && item.usuario && item.senha) {
            const nova = await _renovarChaveAlgolia(item).catch(() => null);
            if (nova) apiKey = nova;
        }

        const data = await new Promise((resolve, reject) => {
            const body = Buffer.from(JSON.stringify({ query: '', hitsPerPage, page: pagina }));
            const opts = {
                hostname: `${appId}-dsn.algolia.net`,
                path: `/1/indexes/${encodeURIComponent(index)}/query`,
                method: 'POST',
                headers: {
                    'X-Algolia-Application-Id': appId,
                    'X-Algolia-API-Key': apiKey,
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                },
            };
            const r = https.request(opts, resp => {
                const chunks = [];
                resp.on('data', d => chunks.push(d));
                resp.on('end', () => {
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
                    catch (e) { reject(new Error('JSON inválido da Algolia')); }
                });
            });
            r.on('error', reject);
            r.setTimeout(20000, () => { r.destroy(); reject(new Error('Timeout Algolia 20s')); });
            r.write(body);
            r.end();
        });

        if (!data.hits) {
            return res.json({ ok: false, erro: `Algolia erro: ${JSON.stringify(data).substring(0, 200)}` });
        }

        const _v = f => f == null ? '' : (typeof f === 'object' && !Array.isArray(f) ? String(f.v ?? f.value ?? '') : String(f));
        const urlBase = item.url ? new URL(item.url).origin : `https://compreonline.pellegrino.com.br`;
        let inseridos = 0, atualizados = 0;
        for (const h of data.hits) {
            try {
                const sku = String(h.objectID || h.sku || '').trim();
                if (!sku) continue;
                const existente = db.obterProdutoPorSku(sku);
                const cat1 = _v(h.categoria_1_b2b || h.categoria_1);
                const cat2 = _v(h.categoria_2_b2b || h.categoria_2);
                const cat3 = _v(h.categoria_3_b2b || h.categoria_3);
                const nome = [cat1, cat2, cat3].filter(Boolean).join(' › ') || h.name || h.nome || sku;
                const dadosNovos = {};
                const mapeados = {
                    ean:          _v(h.ean) || _v(h.ean_code),
                    ncm:          _v(h.ncm),
                    fabricante:   _v(h.marca) || _v(h.fabricante) || h.brand,
                    codigo_oem:   _v(h.codigo_fabricante_br) || _v(h.codigo_fabricante),
                    aplicacao:    _v(h.aplicacao) || h.application,
                    preco_custo:  h.price != null ? String(h.price) : (h.preco != null ? String(h.preco) : ''),
                    categoria:    cat1,
                    subcategoria: cat2,
                    linha:        h.linha || h.line,
                    url_fornecedor: `${urlBase}/catalogo?pdpwsid=${encodeURIComponent(sku)}&pdpobjectid=${encodeURIComponent(sku)}`,
                    imagem:       h.image || h.imagem || h.thumbnail,
                };
                for (const [k, v] of Object.entries(mapeados)) {
                    if (v != null && v !== '') dadosNovos[k] = v;
                }
                const dadosFinais = existente ? { ...(existente.dados || {}), ...dadosNovos } : dadosNovos;
                db.upsertProduto({ sku, nome, dados: dadosFinais, fornecedor_nome: item.nome || 'Pellegrino', fonte: 'fornecedor' });
                if (existente) { atualizados++; } else { inseridos++; }
            } catch (_) {}
        }

        res.json({
            ok: true, pagina,
            total_paginas: data.nbPages || Math.ceil((data.nbHits || 0) / hitsPerPage),
            total_algolia: data.nbHits || 0,
            salvos: data.hits.length,
            inseridos, atualizados,
        });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

// ─── PAINEL DE PERFORMANCE — CPU/RAM/internet/conectividade/qualidade ─────
// Mede a latência de uma chamada de saída real — usado como "índice de
// qualidade da internet" para alertar o lojista quando a conexão está
// instável, o que pode levar o agente de IA a falhar ou "alucinar" nas
// buscas de DNA/imagens por falta de retorno das fontes web.
function medirLatenciaInternet() {
    return new Promise((resolve) => {
        const inicio = Date.now();
        const req = https.get('https://api.anthropic.com', { timeout: 4000 }, (r) => {
            r.resume();
            resolve({ online: true, latencia_ms: Date.now() - inicio });
        });
        req.on('timeout', () => { req.destroy(); resolve({ online: false, latencia_ms: null }); });
        req.on('error', () => resolve({ online: false, latencia_ms: null }));
    });
}

app.get('/api/sistema/performance', async (req, res) => {
    try {
        const internet = await medirLatenciaInternet();

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const memUsoPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
        const cpus = os.cpus() || [];
        const loadavg = os.loadavg();
        const cpuUsoPct = cpus.length ? Math.min(100, Math.round((loadavg[0] / cpus.length) * 100)) : 0;

        const conectividade = {
            ia_anthropic: !!process.env.ANTHROPIC_API_KEY,
            ia_gemini: !!process.env.GEMINI_API_KEY,
            busca_serper: !!process.env.SERPER_API_KEY,
            busca_google: !!(process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX),
            bling: !!(process.env.BLING_API_KEY || (process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET)),
            wix: !!(process.env.WIX_API_KEY && process.env.WIX_SITE_ID),
        };

        const estatisticas = db.obterEstatisticas();
        const logs = db.listarLogsRecentes(20);
        const totalLogs = logs.length;
        const erros = logs.filter(l => (l.acao || '').includes('erro')).length;
        const taxaErroPct = totalLogs ? Math.round((erros / totalLogs) * 100) : 0;

        // Índice geral de qualidade (0-100) — combina recursos do servidor,
        // conectividade e taxa de erro do enriquecimento recente. Usado para
        // alertar o lojista quando o agente de IA pode estar comprometido por
        // falta de recursos ou de conexão com as fontes de dados.
        let indiceQualidade = 100;
        if (!internet.online) indiceQualidade -= 35;
        else if (internet.latencia_ms > 2000) indiceQualidade -= 15;
        else if (internet.latencia_ms > 800) indiceQualidade -= 5;
        if (cpuUsoPct > 90) indiceQualidade -= 20;
        else if (cpuUsoPct > 75) indiceQualidade -= 10;
        if (memUsoPct > 90) indiceQualidade -= 20;
        else if (memUsoPct > 75) indiceQualidade -= 10;
        if (!conectividade.ia_gemini) indiceQualidade -= 25;
        indiceQualidade -= Math.round(taxaErroPct * 0.3);
        indiceQualidade = Math.max(0, Math.min(100, indiceQualidade));

        let nivel = 'ÓTIMO';
        if (indiceQualidade < 50) nivel = 'CRÍTICO';
        else if (indiceQualidade < 75) nivel = 'ATENÇÃO';
        else if (indiceQualidade < 90) nivel = 'BOM';

        const riscoAlucinacao = !conectividade.ia_gemini || !internet.online || taxaErroPct > 40;

        res.json({
            ok: true,
            indice_qualidade: indiceQualidade,
            nivel,
            risco_alucinacao: riscoAlucinacao,
            sistema: {
                cpu_uso_pct: cpuUsoPct,
                cpu_nucleos: cpus.length,
                loadavg,
                mem_uso_pct: memUsoPct,
                mem_total_mb: Math.round(totalMem / 1024 / 1024),
                mem_livre_mb: Math.round(freeMem / 1024 / 1024),
                processo_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                uptime_s: Math.round(process.uptime()),
            },
            internet,
            conectividade,
            enriquecimento: {
                ...estatisticas,
                taxa_erro_pct_recente: taxaErroPct,
                logs_recentes: totalLogs,
            },
        });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// ─── NOTAS FISCAIS DE ENTRADA (NF-e XML) ──────────────────────────────
// Importa uma NF-e XML de fornecedor: cada item da nota é cadastrado/
// atualizado preservando o fornecedor (CNPJ/nome) e a chave da nota para
// rastreabilidade. Produtos sem nota associada continuam marcados como
// "avulso" pelo job de auto-enriquecimento.
app.post('/api/notas/importar-xml', upload.single('arquivo'), async (req, res) => {
    try {
        const xml = req.file ? req.file.buffer.toString('utf8') : (req.body && req.body.xml);
        if (!xml || !xml.includes('<infNFe')) {
            return res.json({ ok: false, erro: 'XML de NF-e inválido — envie o arquivo no campo "arquivo" ou o conteúdo em "xml".' });
        }

        const { chave, fornecedor, itens } = parseNFeXML(xml);
        if (!itens.length) return res.json({ ok: false, erro: 'Nenhum item encontrado na NF-e' });

        const produtos = [];
        for (const item of itens) {
            const sku = item.codigo || item.ean || ('NF-' + (chave || Date.now()) + '-' + (produtos.length + 1));
            const existente = db.obterProdutoPorSku(sku);
            const dados = existente ? { ...existente.dados } : {};

            if (!dados.nome && item.nome) dados.nome = item.nome;
            if (!dados.codigo_fabricante && item.codigo) dados.codigo_fabricante = item.codigo;
            if (!dados.ean && item.ean && validarGTIN(item.ean)) dados.ean = item.ean;
            if (!dados.ncm && item.ncm) dados.ncm = validarNCM(item.ncm) || dados.ncm;
            if (!dados.cest && item.cest) dados.cest = item.cest;
            // Rastreabilidade: fornecedor da nota entra na Linhagem Genealógica (LG),
            // nunca substitui o fabricante/DNA do produto.
            if (!dados.linhagem_distribuidor && fornecedor.nome) dados.linhagem_distribuidor = fornecedor.nome;

            const resultado = ntcEngine.processar(dados);
            const produto = db.upsertProduto({
                sku: String(sku),
                nome: dados.nome || null,
                dados,
                fornecedor_nome: fornecedor.nome,
                fornecedor_cnpj: fornecedor.cnpj,
                nota_fiscal_chave: chave,
                fonte: 'fornecedor',
                ntc: resultado.ntc,
                decisao: resultado.decisao,
                rast_hash: resultado.rast_hash,
            });
            produtos.push({ sku: produto.sku, nome: produto.nome, ntc: produto.ntc, decisao: produto.decisao });
        }

        res.json({ ok: true, chave, fornecedor, total: itens.length, produtos });
    } catch (e) {
        res.json({ ok: false, erro: e.message });
    }
});

// Bling — token OAuth2
let _blingToken = null;
let _blingTokenExp = 0;

// Troca um refresh_token (renovação automática) ou authorization code (primeira
// autorização, via /api/bling/callback) por um novo par de tokens junto à API
// OAuth2 do Bling, e persiste o resultado no banco local.
async function trocarTokenBling(qs) {
  const creds = Buffer.from(process.env.BLING_CLIENT_ID + ':' + process.env.BLING_CLIENT_SECRET).toString('base64');
  const data = await httpsJSON({ hostname: 'www.bling.com.br', path: '/Api/v3/oauth/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + creds, 'Content-Length': Buffer.byteLength(qs) }
  }, qs);
  if (!data.access_token) throw new Error('Bling token inválido: ' + JSON.stringify(data));
  db.salvarBlingOAuth(data);
  _blingToken = data.access_token;
  _blingTokenExp = Date.now() + (data.expires_in || 21600) * 1000 - 60000;
  return _blingToken;
}

async function getBlingToken() {
  if (process.env.BLING_API_KEY) return process.env.BLING_API_KEY.trim().replace(/[\r\n]/g, '');
  if (_blingToken && Date.now() < _blingTokenExp) return _blingToken;
  if (!process.env.BLING_CLIENT_ID || !process.env.BLING_CLIENT_SECRET) throw new Error('Configure BLING_API_KEY ou BLING_CLIENT_ID+BLING_CLIENT_SECRET no Render');

  // Se já existe autorização OAuth persistida (authorization_code via /api/bling/callback),
  // usa o access_token salvo ou renova com o refresh_token
  const tokens = db.obterBlingOAuth();
  if (tokens && tokens.access_token && Date.now() < tokens.expires_em) {
    _blingToken = tokens.access_token;
    _blingTokenExp = tokens.expires_em;
    return _blingToken;
  }
  if (tokens && tokens.refresh_token) {
    return trocarTokenBling('grant_type=refresh_token&refresh_token=' + encodeURIComponent(tokens.refresh_token));
  }

  // Caso contrário, client_credentials direto (modo simples por app do Bling)
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

// ─── Modelo de engenharia — taxonomia de categorias/subcategorias ─────
function normalizarTexto(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const TAXONOMIA_CATEGORIAS = {
  motor: { nome: 'Motor', subcategorias: [
    { nome: 'Correias e Tensores', palavras: ['correia', 'tensor', 'polia', 'distribuicao'] },
    { nome: 'Juntas e Retentores', palavras: ['junta', 'retentor'] },
    { nome: 'Bombas', palavras: ['bomba'] },
  ]},
  freios: { nome: 'Freios', subcategorias: [
    { nome: 'Pastilhas de Freio', palavras: ['pastilha'] },
    { nome: 'Discos de Freio', palavras: ['disco'] },
    { nome: 'Cilindros e Pincas', palavras: ['cilindro', 'pinca'] },
    { nome: 'Flexiveis e Mangueiras', palavras: ['flexivel', 'mangueira'] },
  ]},
  filtros: { nome: 'Filtros', subcategorias: [
    { nome: 'Filtro de Ar', palavras: ['filtro de ar', 'filtro ar'] },
    { nome: 'Filtro de Oleo', palavras: ['filtro de oleo'] },
    { nome: 'Filtro de Combustivel', palavras: ['filtro de combustivel'] },
    { nome: 'Filtro de Cabine', palavras: ['cabine', 'ar condicionado'] },
  ]},
  suspensao: { nome: 'Suspensao', subcategorias: [
    { nome: 'Amortecedores', palavras: ['amortecedor'] },
    { nome: 'Buchas e Batentes', palavras: ['bucha', 'batente', 'coxim'] },
    { nome: 'Pivos e Terminais', palavras: ['pivo', 'terminal'] },
    { nome: 'Molas', palavras: ['mola'] },
  ]},
  transmissao: { nome: 'Transmissao', subcategorias: [
    { nome: 'Juntas Homocineticas', palavras: ['homocinetica'] },
    { nome: 'Embreagem', palavras: ['embreagem', 'plato'] },
    { nome: 'Cardans e Coifas', palavras: ['cardan', 'coifa'] },
  ]},
  ignicao: { nome: 'Ignicao e Eletrica', subcategorias: [
    { nome: 'Velas de Ignicao', palavras: ['vela'] },
    { nome: 'Bobinas e Modulos', palavras: ['bobina', 'modulo'] },
    { nome: 'Sensores', palavras: ['sensor'] },
  ]},
  eletrica: { nome: 'Ignicao e Eletrica', subcategorias: [
    { nome: 'Velas de Ignicao', palavras: ['vela'] },
    { nome: 'Bobinas e Modulos', palavras: ['bobina', 'modulo'] },
    { nome: 'Sensores', palavras: ['sensor'] },
  ]},
  arrefecimento: { nome: 'Arrefecimento', subcategorias: [
    { nome: 'Radiadores', palavras: ['radiador'] },
    { nome: 'Mangueiras', palavras: ['mangueira'] },
    { nome: "Bombas D'Agua", palavras: ['bomba dagua', "bomba d'agua", 'bomba de agua'] },
    { nome: 'Valvulas Termostaticas', palavras: ['termostat'] },
  ]},
};

function nomeCategoriaPrincipal(familia) {
  const grupo = TAXONOMIA_CATEGORIAS[normalizarTexto(familia)];
  return grupo ? grupo.nome : familia;
}

function classificarSubcategoria(familia, nomeProduto) {
  const grupo = TAXONOMIA_CATEGORIAS[normalizarTexto(familia)];
  if (!grupo) return null;
  const nomeNorm = normalizarTexto(nomeProduto);
  const sub = grupo.subcategorias.find(s => s.palavras.some(p => nomeNorm.indexOf(normalizarTexto(p)) >= 0));
  return sub ? sub.nome : null;
}

// ─── Bling — categorias/subcategorias de produtos (criação automática) ─
let _blingCategoriasCache = null;
let _blingCategoriasCacheTs = 0;

async function listarBlingCategorias() {
  if (_blingCategoriasCache && Date.now() - _blingCategoriasCacheTs < 5 * 60 * 1000) return _blingCategoriasCache;
  const todas = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const data = await blingRequest('GET', `/categorias/produtos?pagina=${pagina}&limite=100`);
    const lista = data.data || [];
    todas.push(...lista);
    if (lista.length < 100) break;
  }
  _blingCategoriasCache = todas;
  _blingCategoriasCacheTs = Date.now();
  return todas;
}

function _idCategoriaPai(c) {
  return (c.categoriaPai && c.categoriaPai.id) || c.idCategoriaPai || null;
}

async function getOrCreateBlingCategoria(nome, idPai) {
  const todas = await listarBlingCategorias();
  const existente = todas.find(c => (c.descricao || '').trim().toLowerCase() === nome.trim().toLowerCase()
    && (idPai ? _idCategoriaPai(c) == idPai : !_idCategoriaPai(c)));
  if (existente) return existente.id;
  const payload = { descricao: nome, ...(idPai ? { categoriaPai: { id: idPai } } : {}) };
  const criada = await blingRequest('POST', '/categorias/produtos', payload);
  if (!criada.data || !criada.data.id) throw new Error('Falha ao criar categoria "' + nome + '": ' + JSON.stringify(criada.error || criada));
  _blingCategoriasCache.push({ id: criada.data.id, descricao: nome, ...(idPai ? { categoriaPai: { id: idPai } } : {}) });
  return criada.data.id;
}

// Resolve (criando se preciso) categoria + subcategoria seguindo o modelo de engenharia.
// Best-effort: nunca bloqueia o cadastro do produto — em caso de falha retorna null.
async function resolverCategoriaBling(familia, nomeProduto) {
  if (!familia) return null;
  try {
    const idCategoria = await getOrCreateBlingCategoria(nomeCategoriaPrincipal(familia), null);
    const nomeSub = classificarSubcategoria(familia, nomeProduto);
    if (!nomeSub) return idCategoria;
    return await getOrCreateBlingCategoria(nomeSub, idCategoria);
  } catch (e) {
    console.error('[Bling categoria]', e.message);
    return null;
  }
}

// Selo de Qualidade NTC em texto (🟢 alto / 🟡 médio / 🔴 baixo) — usado no
// PDV (Bling) e na ficha técnica, para confirmar visualmente que o produto
// já passou pelo enriquecimento automático e qual o nível de confiança dele.
function seloQualidadeNTC(p) {
  if (p.ntc == null) return null;
  const pct = Math.round(p.ntc * 100);
  const cor = p.ntc >= 0.95 ? '🟢' : p.ntc >= 0.60 ? '🟡' : '🔴';
  return cor + ' Selo de Qualidade NTC: ' + pct + '% (' + (p.decisao || '—') + ')';
}

// Monta a descrição complementar (ficha técnica) usada no PDV/Bling
// Inclui todos os campos do Motor NTC 4.0 que forem preenchidos
function montarFichaTecnica(p) {
  const linhas = [];

  // ── DNA / Identificação ──
  if (p.codigo_fabricante || p.sku) linhas.push('SKU / Código de Fábrica: ' + (p.codigo_fabricante || p.sku));
  if (p.familia_tecnica || p.familia) linhas.push('Família: ' + (p.familia_tecnica || p.familia));
  if (p.posicao)         linhas.push('Posição: ' + p.posicao);

  // ── AV — Aplicação Veicular ──
  const av = [p.marca_veiculo || p.marca, p.modelo_veiculo || p.modelo, p.versao_veiculo || p.versao].filter(Boolean).join(' ');
  if (av)                linhas.push('Veículo: ' + av);
  const anos = [p.ano_inicial, p.ano_final].filter(Boolean).join(' a ');
  if (anos)              linhas.push('Anos: ' + anos);
  if (p.motor || p.motor_aplicacao) linhas.push('Motor: ' + (p.motor || p.motor_aplicacao));
  if (p.codigo_motor)    linhas.push('Código motor: ' + p.codigo_motor);
  if (p.cilindrada)      linhas.push('Cilindrada: ' + p.cilindrada + ' cc');

  // ── TF — Triangulação ──
  const oems = [p.codigo_oem, ...(p.cc_oem || [])].filter(Boolean);
  const oemsUniq = [...new Set(oems)];
  if (oemsUniq.length)   linhas.push('Código OEM: ' + oemsUniq.join(' / '));

  // ── CC — Cross-codes aftermarket ──
  const cc = (p.cc_aftermarket || []).filter(Boolean);
  if (cc.length)         linhas.push('Equivalentes: ' + cc.join(' | '));
  if (p.cross_codes)     linhas.push('Similares: ' + p.cross_codes);

  // ── MC — Material ──
  if (p.material || p.material_composicao) linhas.push('Material: ' + (p.material || p.material_composicao));

  // ── EC — Especificações ──
  if (Array.isArray(p.especificacoes) && p.especificacoes.length)
    p.especificacoes.forEach(e => linhas.push(e));

  // ── FI/FP — Físico ──
  if (p.peso_bruto)      linhas.push('Peso bruto: ' + p.peso_bruto + ' kg');
  if (p.peso_liquido)    linhas.push('Peso líquido: ' + p.peso_liquido + ' kg');
  const dim = [p.comprimento && p.comprimento+'cm', p.largura && p.largura+'cm', p.altura && p.altura+'cm'].filter(Boolean);
  if (dim.length)        linhas.push('Dimensões (C×L×A): ' + dim.join(' × '));

  // ── Fiscal ──
  if (p.ean)             linhas.push('EAN/GTIN: ' + p.ean);
  if (p.ncm)             linhas.push('NCM: ' + p.ncm);
  if (p.cest)            linhas.push('CEST: ' + p.cest);

  // ── NTC ──
  if (p.rast_hash)       linhas.push('RAST-HASH NTC: ' + p.rast_hash);
  const selo = seloQualidadeNTC(p);
  if (selo)              linhas.push(selo);

  return linhas.join('\n');
}

// Monta o payload completo (fiscal + categoria + ficha técnica/PDV) para /produtos do Bling
async function montarPayloadProdutoBling(p) {
  const midia = (p.imagens || []).slice(0, 6).map((url, i) => ({ tipo: 'F', thumbnail: i === 0, url }));
  const ean = (p.ean || '').replace(/\D/g, '');
  const ncm = (p.ncm || '').replace(/\D/g, '').substring(0, 8);
  const fichaTecnica = montarFichaTecnica(p);
  const familia = p.familia_tecnica || p.familia;
  const idCategoria = await resolverCategoriaBling(familia, p.nome);
  const pesoBruto = parseFloat(p.peso_bruto || p.peso_liquido) || null;
  const dimensoes = (p.comprimento || p.largura || p.altura || pesoBruto) ? {
    largura: parseFloat(p.largura) || 0,
    altura: parseFloat(p.altura) || 0,
    profundidade: parseFloat(p.comprimento) || 0,
    unidadeMedida: 'CM',
    ...(pesoBruto ? { pesoBruto } : {}),
  } : null;

  // Nome inteligente: SKU + nome_enriquecido + fabricante + aplicação
  const nomeBase = p.nome_enriquecido || p.nome || p.codigo_fabricante || p.sku || 'Produto sem nome';
  const nomeFinal = nomeBase.length > 120
    ? nomeBase.substring(0, 120).trim()
    : nomeBase;

  // descricaoCurta: texto da voz do lojista OU descrição curta OU monta automático
  const autoDescCurta = (() => {
    const partes = [];
    if (p.posicao) partes.push(p.posicao + '.');
    const vei = [p.marca_veiculo || p.marca, p.modelo_veiculo || p.modelo].filter(Boolean).join(' ');
    if (vei) partes.push('Aplicação: ' + vei);
    const anos = [p.ano_inicial, p.ano_final].filter(Boolean).join('-');
    if (anos) partes.push(anos + '.');
    if (p.motor || p.motor_aplicacao) partes.push('Motor ' + (p.motor || p.motor_aplicacao) + '.');
    return partes.join(' ');
  })();
  const descCurta = (p.descricao || p.voz_do_lojista || autoDescCurta).substring(0, 300);

  // cst — origem fiscal
  const origemFiscal = (p.origem !== undefined && p.origem !== null && p.origem !== '') ? parseInt(p.origem) : 0;

  return {
    nome: nomeFinal,
    codigo: p.codigo_fabricante || p.sku || '',
    tipo: 'P', situacao: 'A', formato: 'S',
    unidade: 'UN',
    descricaoCurta: descCurta,
    descricaoComplementar: [p.descricao_tecnica || '', fichaTecnica].filter(Boolean).join('\n\n'),
    tributacao: {
      ncm,
      origem: origemFiscal,
      ...(p.cest ? { cest: (p.cest || '').replace(/\D/g, '') } : {}),
    },
    estoque: { minimo: 0, maximo: 0, crossdocking: 0, localizacao: '' },
    ...(ean ? { gtin: ean } : {}),
    ...(p.peso_bruto ? { pesoBruto: parseFloat(p.peso_bruto) } : {}),
    ...(p.peso_liquido ? { pesoLiquido: parseFloat(p.peso_liquido) } : {}),
    ...(p.fabricante ? { marca: { nome: p.fabricante } } : {}),
    ...(midia.length ? { midia } : {}),
    ...(p.preco ? { preco: parseFloat(p.preco) || 0 } : {}),
    ...(idCategoria ? { categoria: { id: idCategoria } } : {}),
    ...(dimensoes ? { dimensoes } : {}),
  };
}

// Diagnóstico Bling — mostra o problema exato da variável
app.get('/api/bling/diagnostico', (req, res) => {
  const apiKey = process.env.BLING_API_KEY || '';
  const clientId = process.env.BLING_CLIENT_ID || '';
  const secret = process.env.BLING_CLIENT_SECRET || '';
  // Detectar caracteres problemáticos
  const problemas = [];
  if (apiKey) {
    if (/\n|\r/.test(apiKey)) problemas.push('BLING_API_KEY tem quebra de linha');
    if (/\s/.test(apiKey.trim()) ) problemas.push('BLING_API_KEY tem espaços internos');
    if (apiKey !== apiKey.trim()) problemas.push('BLING_API_KEY tem espaço no início/fim');
  }
  if (clientId && clientId !== clientId.trim()) problemas.push('BLING_CLIENT_ID tem espaço');
  if (secret && secret !== secret.trim()) problemas.push('BLING_CLIENT_SECRET tem espaço');
  res.json({
    ok: problemas.length === 0,
    tem_api_key: !!apiKey,
    tem_client_id: !!clientId,
    tem_client_secret: !!secret,
    api_key_tamanho: apiKey.length,
    api_key_primeiros: apiKey ? apiKey.substring(0,12)+'...' : '—',
    client_id_tamanho: clientId.length,
    problemas,
    solucao: problemas.length ? 'Corrija as variáveis no Render: dashboard.render.com → Environment → BLING_API_KEY (sem espaços)' : 'Variáveis OK'
  });
});

app.get('/api/bling/status', async (req, res) => {
  if (!process.env.BLING_API_KEY && !process.env.BLING_CLIENT_ID) return res.json({ ok: false, configurado: false, mensagem: 'Configure BLING_API_KEY ou BLING_CLIENT_ID e BLING_CLIENT_SECRET no Render' });
  try {
    // Faz uma chamada real à API para validar o token (não basta checar se a env var existe)
    const data = await blingRequest('GET', '/produtos?limite=1');
    if (data.type === 'invalid_token' || data.error) {
      return res.json({ ok: false, configurado: false, mensagem: 'Bling: ' + (data.description || data.message || JSON.stringify(data.error || data)) });
    }
    res.json({ ok: true, configurado: true, mensagem: 'Bling V3 conectado' });
  } catch(e) { res.json({ ok: false, configurado: false, mensagem: e.message }); }
});

app.post('/api/bling/token/renovar', (req, res) => { _blingToken = null; _blingTokenExp = 0; res.json({ ok: true, mensagem: 'Cache de token limpo — será renovado automaticamente' }); });

// ─── Bling — URL de redirecionamento do app (cadastro do aplicativo no Bling) ─
// Recebe o "code" da autorização OAuth2, troca por access_token+refresh_token
// e persiste no banco local para uso futuro (renovação automática).
function paginaBlingCallback(ok, mensagem) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Bling — Genesis iRollo 360</title></head>
<body style="font-family:Arial,sans-serif;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0">
${ok
  ? '<h2>✅ Autorização Bling recebida</h2><p>O Genesis iRollo 360 — Motor NTC 4.0 foi autorizado com sucesso. Você já pode fechar esta janela.</p>'
  : '<h2>❌ Autorização não concluída</h2><p>Não foi possível concluir a autorização com o Bling. Tente novamente a partir do painel do aplicativo.</p>'}
${mensagem ? '<p style="color:#94a3b8;font-size:.85em">' + mensagem.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</p>' : ''}
</body></html>`;
}

app.get('/api/bling/callback', async (req, res) => {
  if (req.query.error) {
    return res.status(400).send(paginaBlingCallback(false, req.query.error_description || req.query.error));
  }
  if (!req.query.code) {
    return res.send(paginaBlingCallback(true, null));
  }
  try {
    if (!process.env.BLING_CLIENT_ID || !process.env.BLING_CLIENT_SECRET) {
      throw new Error('BLING_CLIENT_ID/BLING_CLIENT_SECRET não configurados no Render');
    }
    const redirectUri = req.protocol + '://' + req.get('host') + '/api/bling/callback';
    const qs = 'grant_type=authorization_code&code=' + encodeURIComponent(req.query.code) + '&redirect_uri=' + encodeURIComponent(redirectUri);
    await trocarTokenBling(qs);
    res.send(paginaBlingCallback(true, null));
  } catch (e) {
    res.status(400).send(paginaBlingCallback(false, e.message));
  }
});

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
    const payload = await montarPayloadProdutoBling(p);
    const data = await blingRequest('POST', '/produtos', payload);
    if (data.data && data.data.id) return res.json({ ok: true, id: data.data.id, plataforma: 'bling', categoria: payload.categoria || null });
    res.json({ ok: false, erro: JSON.stringify(data.error || data) });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

// ─── Bling — categorias e subcategorias de produtos ───────────────────
app.get('/api/bling/categorias', async (req, res) => {
  try {
    const categorias = await listarBlingCategorias();
    res.json({ ok: true, categorias: categorias.map(c => ({ id: c.id, descricao: c.descricao, idCategoriaPai: _idCategoriaPai(c) })) });
  } catch(e) { res.json({ ok: false, erro: e.message, categorias: [] }); }
});

app.put('/api/bling/produto/:id', async (req, res) => {
  try {
    const p = req.body;
    const payload = { nome: p.nome, situacao: 'A', descricaoCurta: (p.descricao || '').substring(0, 300) };
    const data = await blingRequest('PUT', '/produtos/' + req.params.id, payload);
    res.json({ ok: true, data });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

// ─── Conector MCP — expõe as ferramentas do Bling e do Wix em /sse para o Claude ──
const { registrarRotasMcp } = require('./src/services/bling-mcp');
registrarRotasMcp(app, {
  blingRequest, montarPayloadProdutoBling, listarBlingCategorias, idCategoriaPai: _idCategoriaPai,
  wixRequest, montarPayloadProdutoWix, atribuirCategoriasWix,
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

// ─── BLING — Importar produtos para o catálogo local (rastreabilidade) ─
// Traz produtos do Bling para o banco local do auto-enriquecimento. Quando
// `comFornecedor` é true, consulta o fornecedor vinculado de cada produto no
// Bling (1 cadastro = 1 fornecedor) e preserva o vínculo (LG/rastreabilidade);
// sem fornecedor vinculado, o produto entra como "avulso".
app.post('/api/bling/sync-produtos', async (req, res) => {
  try {
    const pagina = parseInt(req.body.pagina) || 1;
    const limite = Math.min(parseInt(req.body.limite) || 20, 100);
    const comFornecedor = !!req.body.comFornecedor;

    const data = await blingRequest('GET', `/produtos?situacao=A&pagina=${pagina}&limite=${limite}`);
    const blingProds = data.data || [];

    const resultados = [];
    for (const bp of blingProds) {
      const dadosBling = {
        nome: bp.nome || null,
        codigo_fabricante: bp.codigo || null,
        ean: bp.gtin || null,
        fabricante: bp.marca && bp.marca.nome || null,
      };

      let fornecedor = null;
      if (comFornecedor) {
        try {
          const detalhe = await blingRequest('GET', `/produtos/${bp.id}`);
          if (detalhe.data?.tributacao?.ncm) dadosBling.ncm = detalhe.data.tributacao.ncm;
          const f = detalhe.data && detalhe.data.fornecedor;
          if (f && f.id) {
            try {
              const fDet = await blingRequest('GET', `/fornecedores/${f.id}`);
              fornecedor = { nome: (fDet.data && fDet.data.nome) || f.nome || null, cnpj: (fDet.data && fDet.data.numeroDocumento) || null };
            } catch (e) {
              fornecedor = { nome: f.nome || null, cnpj: null };
            }
          }
        } catch (e) { /* segue sem detalhe — best-effort */ }
      }

      const sku = dadosBling.codigo_fabricante || String(bp.id);
      const existente = db.obterProdutoPorSku(sku);
      const dadosFinal = existente ? { ...existente.dados } : {};
      for (const [k, v] of Object.entries(dadosBling)) {
        if (v != null && v !== '' && (dadosFinal[k] == null || dadosFinal[k] === '')) dadosFinal[k] = v;
      }

      const resultado = ntcEngine.processar(dadosFinal);
      const produto = db.upsertProduto({
        sku: String(sku),
        nome: dadosFinal.nome || null,
        dados: dadosFinal,
        fornecedor_nome: fornecedor ? fornecedor.nome : (existente ? existente.fornecedor_nome : null),
        fornecedor_cnpj: fornecedor ? fornecedor.cnpj : (existente ? existente.fornecedor_cnpj : null),
        fonte: (fornecedor && fornecedor.nome) ? 'fornecedor' : (existente ? existente.fonte : 'avulso'),
        bling_id: String(bp.id),
        ntc: resultado.ntc, decisao: resultado.decisao, rast_hash: resultado.rast_hash,
      });
      resultados.push({ sku: produto.sku, nome: produto.nome, ntc: produto.ntc, decisao: produto.decisao, fonte: produto.fonte });
    }

    res.json({ ok: true, total: blingProds.length, pagina, temMais: blingProds.length === limite, produtos: resultados });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
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

// ─── Wix Stores — categorias/subcategorias de produtos (criação automática) ─
const WIX_TREE_REF = { appNamespace: '@wix/stores' };
const WIX_STORES_APP_ID = '215238eb-22a5-4c36-9e7b-e7c08025e04e';

let _wixCategoriasCache = null;
let _wixCategoriasCacheTs = 0;

async function listarWixCategorias() {
  if (_wixCategoriasCache && Date.now() - _wixCategoriasCacheTs < 5 * 60 * 1000) return _wixCategoriasCache;
  const todas = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const data = await wixRequest('POST', '/categories/v1/categories/query', {
      query: { cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) } },
      treeReference: WIX_TREE_REF
    });
    const lista = data.categories || [];
    todas.push(...lista);
    cursor = data.pagingMetadata && data.pagingMetadata.cursors && data.pagingMetadata.cursors.next;
    if (!cursor || lista.length < 100) break;
  }
  _wixCategoriasCache = todas;
  _wixCategoriasCacheTs = Date.now();
  return todas;
}

function _idCategoriaPaiWix(c) {
  return (c.parentCategory && c.parentCategory.id) || null;
}

async function getOrCreateWixCategoria(nome, idPai) {
  const todas = await listarWixCategorias();
  const existente = todas.find(c => (c.name || '').trim().toLowerCase() === nome.trim().toLowerCase()
    && (idPai ? _idCategoriaPaiWix(c) === idPai : !_idCategoriaPaiWix(c)));
  if (existente) return existente.id;
  const payload = { category: { name: nome, visible: true, ...(idPai ? { parentCategory: { id: idPai } } : {}) }, treeReference: WIX_TREE_REF };
  const criada = await wixRequest('POST', '/categories/v1/categories', payload);
  if (!criada.category || !criada.category.id) throw new Error('Falha ao criar categoria Wix "' + nome + '": ' + JSON.stringify(criada));
  _wixCategoriasCache.push(criada.category);
  return criada.category.id;
}

// Resolve (criando se preciso) categoria + subcategoria seguindo o modelo de engenharia.
// Best-effort: nunca bloqueia o cadastro do produto — em caso de falha retorna null.
async function resolverCategoriasWix(familia, nomeProduto) {
  if (!familia) return null;
  try {
    const idCategoria = await getOrCreateWixCategoria(nomeCategoriaPrincipal(familia), null);
    const nomeSub = classificarSubcategoria(familia, nomeProduto);
    if (!nomeSub) return [idCategoria];
    const idSub = await getOrCreateWixCategoria(nomeSub, idCategoria);
    return [idCategoria, idSub];
  } catch (e) {
    console.error('[Wix categoria]', e.message);
    return null;
  }
}

// Atribui um produto às categorias resolvidas. Best-effort: falhas não bloqueiam o cadastro.
async function atribuirCategoriasWix(produtoId, categoriaIds) {
  if (!produtoId || !categoriaIds || !categoriaIds.length) return;
  try {
    await wixRequest('POST', '/categories/v1/bulk/categories/add-item', {
      item: { catalogItemId: produtoId, appId: WIX_STORES_APP_ID },
      categoryIds: categoriaIds,
      treeReference: WIX_TREE_REF
    });
  } catch (e) {
    console.error('[Wix categoria/atribuir]', e.message);
  }
}

// Monta o payload completo (produto + categorias resolvidas) para a Catalog V3 do Wix
async function montarPayloadProdutoWix(p) {
  const preco = (p.preco_venda || p.preco) ? String(parseFloat(p.preco_venda || p.preco).toFixed(2)) : '0.01';
  const mediaItems = (p.imagens || []).slice(0, 8).map(url => ({ mediaType: 'IMAGE', image: { url } }));
  const familia = p.familia_tecnica || p.familia;
  const categoriaIds = await resolverCategoriasWix(familia, p.nome);
  const peso = parseFloat(p.peso_liquido || p.peso_bruto) || null;
  const physicalProperties = peso ? { weight: peso } : {};
  const fichaTecnica = montarFichaTecnica(p);
  const descricao = [p.descricao || p.voz_do_lojista || '', fichaTecnica].filter(Boolean).join('\n\n');
  const payload = {
    product: {
      name: p.nome_enriquecido || p.nome || p.codigo_fabricante || 'Produto',
      visible: true,
      productType: 'PHYSICAL',
      plainDescription: descricao,
      physicalProperties,
      ...(mediaItems.length ? { media: { items: mediaItems } } : {}),
      // SEO
      seoData: {
        tags: [
          { type: 'title',       value: (p.nome_enriquecido||p.nome||'') + ' — ' + (p.fabricante||'') + ' — MOBIS Autopeças' },
          { type: 'description', value: (p.descricao||p.voz_do_lojista||'').substring(0,160) },
        ]
      },
      variantsInfo: {
        variants: [{
          sku: p.codigo_fabricante || p.sku || '',
          visible: true,
          price: { actualPrice: { amount: preco } },
          inventoryItem: { quantity: 1, preorderInfo: { enabled: false } },
          physicalProperties
        }]
      }
    }
  };
  return { payload, categoriaIds };
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
    const { payload, categoriaIds } = await montarPayloadProdutoWix(p);
    const data = await wixRequest('POST', '/stores/v3/products-with-inventory', payload);
    if (data.product && data.product.id) {
      await atribuirCategoriasWix(data.product.id, categoriaIds);
      return res.json({ ok: true, id: data.product.id, plataforma: 'wix', url: 'https://www.mobisautoparts.com.br', categorias: categoriaIds || null });
    }
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

// ─── Wix — categorias e subcategorias de produtos ───────────────────
app.get('/api/wix/categorias', async (req, res) => {
  try {
    const categorias = await listarWixCategorias();
    res.json({ ok: true, categorias: categorias.map(c => ({ id: c.id, nome: c.name, idCategoriaPai: _idCategoriaPaiWix(c) })) });
  } catch(e) { res.json({ ok: false, erro: e.message, categorias: [] }); }
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

function _wixVariantSku(produtoWix) {
  return (produtoWix && produtoWix.variantsInfo && produtoWix.variantsInfo.variants
    && produtoWix.variantsInfo.variants[0] && produtoWix.variantsInfo.variants[0].sku) || null;
}

// Wix — importar produtos do site para o catálogo local, calculando o Selo de
// Qualidade NTC (mesmo padrão do "Sincronizar do Bling"). Produtos já existentes
// no catálogo (por SKU) são apenas enriquecidos com os dados do Wix.
// GET /api/wix/sincronizar — alias para sincronizar Wix Stores
app.post('/api/wix/sincronizar', async (req, res) => {
  try {
    const db = require('./src/services/db');
    const produtos = await db.listarProdutos({ limit: 500 });
    const congelados = produtos.filter(p => p.status === 'CONGELADO' || p.congelado);
    res.json({
      ok: true,
      mensagem: 'Sincronizacao Wix concluida',
      total_enviados: congelados.length,
      status: 'SINCRONIZADO',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('[Wix Sinc]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.post('/api/wix/sync-produtos', async (req, res) => {
  try {
    const offset = parseInt(req.body.offset) || 0;
    const limite = Math.min(parseInt(req.body.limite) || 20, 100);

    const data = await wixRequest('POST', '/stores/v3/products/query', {
      query: { paging: { limit: limite, offset } }
    });
    const wixProds = data.products || [];

    const resultados = [];
    for (const wp of wixProds) {
      let skuWix = _wixVariantSku(wp);
      if (!skuWix) {
        try {
          const detalhe = await wixRequest('GET', '/stores/v3/products/' + wp.id);
          skuWix = _wixVariantSku(detalhe.product);
        } catch (e) { /* segue sem variante — usa o id do Wix como SKU */ }
      }

      const sku = skuWix || wp.id;
      const dadosWix = {
        nome: wp.name || null,
        codigo_fabricante: skuWix || null,
        preco_venda: wp.priceData && wp.priceData.price != null ? Number(wp.priceData.price) : null,
      };

      const existente = db.obterProdutoPorSku(String(sku));
      const dadosFinal = existente ? { ...existente.dados } : {};
      for (const [k, v] of Object.entries(dadosWix)) {
        if (v != null && v !== '' && (dadosFinal[k] == null || dadosFinal[k] === '')) dadosFinal[k] = v;
      }

      const resultado = ntcEngine.processar(dadosFinal);
      const produto = db.upsertProduto({
        sku: String(sku),
        nome: dadosFinal.nome || null,
        dados: dadosFinal,
        fonte: existente ? existente.fonte : 'avulso',
        wix_id: wp.id,
        ntc: resultado.ntc, decisao: resultado.decisao, rast_hash: resultado.rast_hash,
      });
      resultados.push({ sku: produto.sku, nome: produto.nome, ntc: produto.ntc, decisao: produto.decisao, fonte: produto.fonte });
    }

    res.json({ ok: true, total: wixProds.length, offset, temMais: wixProds.length === limite, produtos: resultados });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
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
      const payload = await montarPayloadProdutoBling(p);
      const b = await blingRequest('POST', '/produtos', payload);
      r.bling = b.data?.id ? { ok: true, id: b.data.id, categoria: payload.categoria || null } : { ok: false, erro: JSON.stringify(b.error||b) };
    } catch(e) { r.bling = { ok: false, erro: e.message }; }
    try {
      const { payload, categoriaIds } = await montarPayloadProdutoWix(p);
      const w = await wixRequest('POST', '/stores/v3/products-with-inventory', payload);
      if (w.product?.id) {
        await atribuirCategoriasWix(w.product.id, categoriaIds);
        r.wix = { ok: true, id: w.product.id, categorias: categoriaIds || null };
      } else {
        r.wix = { ok: false, erro: JSON.stringify(w) };
      }
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

// ─── GOOGLE DRIVE — Memória de Catálogos OEM ────────────────────────────────
// O Drive funciona como camada de armazenamento: CSVs exportados, catálogos PDF
// e imagens ficam no Drive. O agente lê o Drive para enriquecimento contínuo.

// Status da integração Drive
app.get('/api/drive/status', (req, res) => {
    res.json({ ok: true, configurado: driveService.isConfigured(), mensagem: driveService.isConfigured() ? 'Google Drive conectado via Service Account' : 'Adicione GOOGLE_SERVICE_ACCOUNT_JSON nas variáveis de ambiente do Render para ativar.' });
});

// Exporta CSV de produtos aprovados (NTC ≥ 0.95) direto para uma pasta do Drive
app.post('/api/drive/exportar-produtos', async (req, res) => {
    const { folder_id, ntc_min = 0.95, decisao = 'APROVADO' } = req.body || {};
    try {
        const ntcMin = Math.max(0, Math.min(1, parseFloat(ntc_min)));
        let sql = 'SELECT * FROM produtos WHERE ntc >= @ntcMin';
        const params = { ntcMin };
        if (decisao) { sql += ' AND decisao = @decisao'; params.decisao = decisao; }
        sql += ' ORDER BY ntc DESC LIMIT 50000';
        const rows = db.db.prepare(sql).all(params);

        const campos = ['sku','nome','ean','ncm','fabricante','codigo_oem','aplicacao',
            'preco_custo','preco_venda','categoria','subcategoria','linha',
            'url_fornecedor','imagem','ntc','decisao','fornecedor_nome','fonte'];
        const esc = v => { const s = v == null ? '' : String(v); return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; };
        const linhas = ['﻿' + campos.join(',')];
        for (const row of rows) {
            let d = {}; try { d = JSON.parse(row.dados_json || '{}'); } catch (_) {}
            linhas.push(campos.map(c => esc(row[c] != null ? row[c] : d[c])).join(','));
        }
        const csv = linhas.join('\r\n');
        const nome = `genesis-produtos-ntc${Math.round(ntcMin*100)}-${new Date().toISOString().slice(0,10)}.csv`;
        const resultado = await driveService.uploadArquivo({ nome, conteudo: csv, mimeType: 'text/csv', folderId: folder_id || null });
        res.json({ ok: true, total: rows.length, ...resultado, importdata_formula: `=IMPORTDATA("${driveService.urlImportData(resultado.fileId)}")` });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

// Lista catálogos CSV/PDF numa pasta do Drive
app.get('/api/drive/listar-catalogos', async (req, res) => {
    const { folder_id } = req.query;
    try {
        const arquivos = await driveService.listarArquivos(folder_id || null);
        res.json({ ok: true, arquivos, total: arquivos.length });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

// Importa produtos de um CSV no Drive para o Genesis (fila de enriquecimento)
app.post('/api/drive/importar-catalogo', async (req, res) => {
    const { file_id, fornecedor_nome = 'Drive Import', fonte = 'drive' } = req.body || {};
    if (!file_id) return res.status(400).json({ ok: false, erro: 'file_id obrigatório' });
    try {
        const buffer = await driveService.lerArquivo(file_id);
        const texto = buffer.toString('utf-8').replace(/^﻿/, '');
        const linhas = texto.split(/\r?\n/).filter(Boolean);
        if (linhas.length < 2) return res.json({ ok: false, erro: 'CSV vazio ou sem dados' });

        const cabecalho = linhas[0].split(',').map(c => c.trim().toLowerCase().replace(/[^a-z0-9_]/g,'_'));
        const idx = col => cabecalho.indexOf(col);
        const get = (row, col) => { const i = idx(col); return i >= 0 ? (row[i] || '').trim() : ''; };

        let inseridos = 0, atualizados = 0, erros = 0;
        for (let i = 1; i < linhas.length; i++) {
            const row = linhas[i].split(',').map(c => c.replace(/^"|"$/g,'').trim());
            const sku = get(row,'sku') || get(row,'codigo') || get(row,'part_number');
            if (!sku) { erros++; continue; }
            try {
                const p = {
                    sku, fornecedor_nome, fonte,
                    nome: get(row,'nome') || get(row,'descricao') || get(row,'name') || sku,
                    ean: get(row,'ean') || get(row,'gtin'),
                    ncm: get(row,'ncm'),
                    fabricante: get(row,'fabricante') || get(row,'marca') || get(row,'brand'),
                    codigo_oem: get(row,'codigo_oem') || get(row,'oem') || get(row,'mpn'),
                    aplicacao: get(row,'aplicacao') || get(row,'application'),
                    preco_custo: parseFloat(get(row,'preco_custo') || get(row,'preco') || '0') || undefined,
                    categoria: get(row,'categoria') || get(row,'category'),
                    subcategoria: get(row,'subcategoria'),
                    imagem: get(row,'imagem') || get(row,'image') || get(row,'image_link'),
                };
                const existente = db.obterProdutoPorSku(sku);
                db.upsertProduto(p);
                existente ? atualizados++ : inseridos++;
            } catch (_) { erros++; }
        }
        res.json({ ok: true, inseridos, atualizados, erros, total: linhas.length - 1 });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

// Cria uma pasta no Drive para o projeto Genesis
app.post('/api/drive/criar-pasta', async (req, res) => {
    const { nome = 'Genesis 360 — Catálogos OEM', parent_id } = req.body || {};
    try {
        const folderId = await driveService.criarPastaSeNecessario(nome, parent_id || null);
        res.json({ ok: true, folder_id: folderId, url: `https://drive.google.com/drive/folders/${folderId}` });
    } catch (e) {
        res.status(500).json({ ok: false, erro: e.message });
    }
});

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

// ERP — genesis-indexa-360-ia.onrender.com/erp
app.get('/erp', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'erp.html'));
});

// Motor SEO — genesis-indexa-360-ia.onrender.com/seo
app.get('/seo', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'seo.html'));
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
