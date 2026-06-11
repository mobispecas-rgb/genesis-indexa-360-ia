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
const dns = require('dns').promises;
const net = require('net');
const zlib = require('zlib');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

// Status do Motor IA (Claude Sonnet) — usado pela Voz do Lojista e demais motores de IA
app.get('/api/ia/status', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, configurado: false, mensagem: 'Configure ANTHROPIC_API_KEY no Render' });
    try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        await client.models.retrieve('claude-sonnet-4-6');
        res.json({ ok: true, configurado: true, mensagem: 'Motor IA conectado — Claude Sonnet 4.6' });
    } catch (e) {
        res.json({ ok: false, configurado: false, mensagem: e.message });
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
        aviso: resultado.impedimentos.length > 0
            ? resultado.impedimentos.join(' | ')
            : null,
    });
});

// Motor Extração Técnica — busca web (Serper) + IA extraem OEM/NCM/EAN/Motor/Material
// NUNCA inventa: campo fica null se não estiver explícito nos resultados de busca
app.post('/api/motor/extrair-tecnico', async (req, res) => {
    const { sku, fabricante, nome } = req.body;
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
            model: 'claude-sonnet-4-6',
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
const CAMPOS_DNA = [
    'codigo_oem', 'ean', 'ncm', 'cest', 'motor', 'codigo_motor',
    'marca_veiculo', 'modelo_veiculo', 'versao_veiculo', 'ano_inicial', 'ano_final',
    'cilindrada', 'material', 'posicao', 'fmsi', 'comprimento', 'largura', 'altura',
    'cross_codes', 'aplicacoes_adicionais'
];

app.post('/api/motor/enriquecer-dna', async (req, res) => {
    const { sku, fabricante, nome } = req.body;
    if (!sku && !nome) return res.status(400).json({ ok: false, erro: 'SKU ou Nome obrigatório' });

    const vazio = {};
    CAMPOS_DNA.forEach(c => { vazio[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte não encontrada' }; });

    if (!process.env.ANTHROPIC_API_KEY) {
        return res.json({ ok: false, erro: 'ANTHROPIC_API_KEY não configurada', campos: vazio, pendente_confirmacao: true });
    }

    const q = [fabricante, sku, nome].filter(Boolean).join(' ');
    let trechos = [];
    try {
        trechos = await buscarWeb(q, 10);
    } catch (e) {
        console.error('[Enriquecer DNA] busca:', e.message);
    }

    if (trechos.length === 0) {
        return res.json({
            ok: true, encontrado: false, campos: vazio, fontes_consultadas: [], pendente_confirmacao: true,
            mensagem: 'Sem resultados de busca — nenhuma fonte encontrada.'
        });
    }

    try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1500,
            system: `Você é um especialista técnico e fiscal em autopeças automotivas. Vai receber dados de um produto (nome, marca, SKU) e uma lista numerada de resultados de busca na web sobre esse produto.

Sua tarefa: para CADA campo abaixo, procurar evidência EXPLÍCITA nos resultados numerados e retornar um objeto {"valor": ..., "fonte_idx": N, "confianca": "alta"|"media"|"baixa"}.

Campos:
- codigo_oem: código OEM / part number de referência do fabricante do veículo
- ean: código EAN/GTIN do produto (8, 12, 13 ou 14 dígitos numéricos)
- ncm: código NCM (8 dígitos numéricos)
- cest: código CEST (formato NN.NNN.NN), se aplicável
- motor: aplicação de motor/veículo (texto livre, ex: "1.0 12V Flex")
- codigo_motor: código interno do motor (ex: "EA211", "1GD-FTV")
- marca_veiculo: marca do veículo de aplicação (ex: "Toyota")
- modelo_veiculo: modelo do veículo (ex: "Hilux")
- versao_veiculo: versão/trim do veículo (ex: "SRV", "SR")
- ano_inicial: ano inicial de aplicação (número de 4 dígitos)
- ano_final: ano final de aplicação (número de 4 dígitos)
- cilindrada: cilindrada em cm³ (número)
- material: material/composição da peça
- posicao: posição de montagem (ex: "Dianteiro", "Traseiro Esquerdo")
- fmsi: código de referência FMSI (padrão usado em pastilhas/lonas de freio)
- comprimento: comprimento em cm (número)
- largura: largura em cm (número)
- altura: altura em cm (número)
- cross_codes: códigos equivalentes/substitutos (cross-reference) desta peça em OUTRAS marcas aftermarket. Use as marcas adequadas à categoria do produto — ex: filtros (Fram, Mann Filter, Mahle, Wega, Tecfil), correias/tensores/rolamentos (Gates, Dayco, INA, SKF, ContiTech), freios (TRW, Frasle, Bosch, Fras-le), ignição/elétrica (NGK, Bosch, Magneti Marelli). Formato: string com itens "MARCA CÓDIGO" separados por "; " (ex: "Fram CA10262; Mann Filter CU2939; Mahle LAK295; Wega AKX31361")
- aplicacoes_adicionais: MUITOS produtos (filtros, correias, pastilhas etc.) servem para vários veículos/motores/anos diferentes — não apenas um. Os campos marca_veiculo/modelo_veiculo/versao_veiculo/motor/codigo_motor/cilindrada/ano_inicial/ano_final acima devem trazer a aplicação MAIS REPRESENTATIVA (ex: a mais citada nos resultados ou a primeira/principal). Todas as OUTRAS aplicações encontradas (combinações diferentes de marca/modelo/motor/ano) devem ser listadas aqui. Formato: string com uma aplicação por linha (separadas por "\n"), no padrão "Marca Modelo Motor (AnoInicial-AnoFinal)" (ex: "Jeep Compass 2.0 16V Flex (2017-2023)\nJeep Renegade 1.8 16V Flex (2015-2022)\nJeep Commander 1.3 Turbo Flex (2022-2024)").

REGRAS ABSOLUTAS:
1. NUNCA invente, estime ou deduza valores que não estejam EXPLICITAMENTE escritos nos resultados.
2. Se não houver evidência clara para um campo, retorne {"valor": null, "fonte_idx": null, "confianca": "baixa"}.
3. "fonte_idx" é o número do resultado de busca (1 a N) de onde o valor foi extraído. Se "valor" for null, "fonte_idx" também deve ser null. Para "aplicacoes_adicionais", use o fonte_idx do primeiro resultado onde uma aplicação adicional foi encontrada.
4. "confianca": "alta" = valor explícito e específico para este produto/SKU; "media" = valor encontrado mas para produto genérico/equivalente; "baixa" = indício fraco ou ausente.
5. Responda APENAS com um objeto JSON válido, sem markdown, sem texto adicional, com TODAS as chaves listadas acima.`,
            messages: [{
                role: 'user',
                content: `Produto: ${[fabricante, sku, nome].filter(Boolean).join(' | ')}\n\nResultados de busca numerados:\n`
                    + trechos.map((t, i) => `${i + 1}. ${t.titulo}\n${t.trecho}\nFonte: ${t.fonte}`).join('\n\n')
            }]
        });
        const texto = msg.content?.[0]?.text || '{}';
        let bruto;
        try {
            const jsonMatch = texto.match(/\{[\s\S]*\}/);
            bruto = JSON.parse(jsonMatch ? jsonMatch[0] : texto);
        } catch (e) {
            bruto = {};
        }

        const campos = {};
        CAMPOS_DNA.forEach(c => {
            const item = bruto[c];
            if (!item || item.valor == null || item.valor === '') {
                campos[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte não encontrada' };
                return;
            }
            const idx = Number(item.fonte_idx);
            const fonte = (idx >= 1 && idx <= trechos.length) ? trechos[idx - 1].fonte : null;
            let valor = item.valor;
            let confianca = ['alta', 'media', 'baixa'].includes(item.confianca) ? item.confianca : 'media';
            let motivo = null;

            if (c === 'ean') {
                if (!validarGTIN(valor)) { valor = null; confianca = 'baixa'; motivo = 'GTIN inválido (checksum)'; }
            }
            if (c === 'ncm') {
                const ncmLimpo = validarNCM(valor);
                if (!ncmLimpo) { confianca = 'baixa'; motivo = 'requer confirmação fiscal — NCM deve ter 8 dígitos'; }
                else valor = ncmLimpo;
            }
            campos[c] = { valor, fonte: fonte || null, confianca, motivo };
        });

        // Confirma o NCM contra a tabela TIPI oficial (BrasilAPI) — eleva a confiança
        // se o código existir oficialmente, ou sinaliza confirmação fiscal se não existir
        if (campos.ncm.valor) {
            const descOficial = await consultarNCMOficial(campos.ncm.valor);
            if (descOficial) {
                campos.ncm.confianca = 'alta';
                campos.ncm.motivo = 'confirmado na TIPI: ' + descOficial;
            } else {
                campos.ncm.confianca = 'baixa';
                campos.ncm.motivo = 'NCM não encontrado na tabela TIPI oficial — requer confirmação fiscal';
            }
        }

        const encontrado = CAMPOS_DNA.some(c => campos[c].valor != null);
        res.json({ ok: true, encontrado, campos, fontes_consultadas: trechos.map(t => t.fonte), pendente_confirmacao: true });
    } catch (e) {
        console.error('[Enriquecer DNA] IA:', e.message);
        res.json({ ok: false, erro: e.message, campos: vazio, pendente_confirmacao: true });
    }
});

// Extração de texto de PDF — permite importar catálogos/notas de fornecedor em PDF
// no Catálogo de Produtos (o texto extraído é processado pelo parser de texto livre).
app.post('/api/catalogo/extrair-pdf', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Arquivo PDF obrigatório' });
    const parser = new PDFParse({ data: req.file.buffer });
    try {
        const resultado = await parser.getText();
        const texto = resultado.text.replace(/\n*-- \d+ of \d+ --\n*/g, '\n\n');

        // Tenta detectar tabelas (catálogos tabulares: SKU/Descrição/Marca/Preço em colunas).
        // Quando há tabela, ela é convertida em CSV — muito mais confiável para o
        // parser de catálogo do que o texto corrido extraído do PDF.
        let tabela = null;
        try {
            const resultadoTabelas = await parser.getTable();
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

        res.json({ ok: true, texto, tabela, paginas: resultado.pages ? resultado.pages.length : (resultado.total || null) });
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
            model: 'claude-sonnet-4-6',
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
            model: 'claude-sonnet-4-6',
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

// Monta a descrição complementar (ficha técnica) usada no PDV/Bling
function montarFichaTecnica(p) {
  const linhas = [];
  if (p.codigo_oem) linhas.push('Código OEM: ' + p.codigo_oem);
  if (p.motor) linhas.push('Motor/Aplicação: ' + p.motor);
  if (p.material) linhas.push('Material: ' + p.material);
  if (p.ean) linhas.push('EAN/GTIN: ' + p.ean);
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
  return {
    nome: p.nome || p.codigo_fabricante || p.sku || 'Produto sem nome',
    codigo: p.codigo_fabricante || p.sku || '',
    tipo: 'P', situacao: 'A', formato: 'S',
    unidade: 'UN',
    descricaoCurta: (p.descricao || p.voz_do_lojista || '').substring(0, 300),
    descricaoComplementar: [p.descricao_tecnica || '', fichaTecnica].filter(Boolean).join('\n\n'),
    tributacao: { ncm, origem: (p.origem !== undefined && p.origem !== null && p.origem !== '') ? parseInt(p.origem) : 0 },
    estoque: { minimo: 0, maximo: 0, crossdocking: 0, localizacao: '' },
    ...(ean ? { gtin: ean } : {}),
    ...(p.fabricante ? { marca: { nome: p.fabricante } } : {}),
    ...(midia.length ? { midia } : {}),
    ...(p.preco ? { preco: parseFloat(p.preco) || 0 } : {}),
    ...(idCategoria ? { categoria: { id: idCategoria } } : {})
  };
}

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
  const payload = {
    product: {
      name: p.nome || p.codigo_fabricante || 'Produto',
      visible: true,
      productType: 'PHYSICAL',
      plainDescription: p.descricao || p.voz_do_lojista || '',
      physicalProperties: {},
      ...(mediaItems.length ? { media: { items: mediaItems } } : {}),
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
