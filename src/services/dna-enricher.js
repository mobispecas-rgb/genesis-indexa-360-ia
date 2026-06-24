'use strict';

// ============================================================
// Agente DNA OEM 360 — Motor NTC 4.0  ·  v6.0 (2026-06-23)
// LLM   : DeepSeek Chat (DEEPSEEK_API_KEY) — agente universal único
// Busca : Serper → DuckDuckGo HTML (sem chave, gratuito)
// ============================================================
const https = require('https');
const { validarGTIN, validarNCM, consultarNCMOficial, httpsJSON, fetchHtmlSeguro, htmlParaTexto } = require('./web-utils');
const { listarSimilaresConfirmados, registrarUsoApi } = require('./db');
const { validarRespostaAgente } = require('./ntc-normalizer-patch');
const { chamarLLM: chamarLLMUniversal } = require('./llm');

// Campos elegíveis para herança por família técnica (nunca cross-codes/EAN —
// são específicos demais por peça para herdar de um produto "parecido").
const CAMPOS_HERDAVEIS = ['codigo_ncm', 'codigo_cest', 'composicao_material_peca', 'comprimento', 'largura', 'altura', 'peso_bruto', 'peso_liquido'];

// Quando a IA não encontra nenhum campo confiável (0 fontes na web e sem
// conhecimento de treinamento), sugere valores herdados de peças JÁ
// CONFIRMADAS da mesma família técnica/fabricante — sempre rotulado como
// "família" (nunca "confirmado") e nunca aplicado automaticamente ao NTC.
function herdarDeFamiliaTecnica({ fabricante, nome, sku }) {
  let similares = [];
  try { similares = listarSimilaresConfirmados({ fabricante, nome, excluirSku: sku, limit: 5 }); }
  catch (e) { console.error('[DNA] herança família:', e.message); return null; }
  if (!similares.length) return null;

  const campos = camposVazios();
  let preenchidos = 0;
  for (const campo of CAMPOS_HERDAVEIS) {
    for (const doador of similares) {
      const valor = doador.dados?.[campo];
      if (valor != null && valor !== '') {
        campos[campo] = {
          valor,
          fonte: null,
          confianca: 'baixa',
          motivo: `Herdado da peça similar ${doador.sku} (família técnica) — PENDENTE de confirmação`,
        };
        preenchidos++;
        break;
      }
    }
  }
  if (!preenchidos) return null;
  return { ok: true, encontrado: true, campos, campos_preenchidos: preenchidos, total_campos: CAMPOS_DNA.length, fontes_consultadas: [], pendente_confirmacao: true, herdado_de_familia: true };
}

// ─────────────────────────────────────────────────────────────
// BUSCA WEB: Serper (primário) → DuckDuckGo HTML (fallback)
// ─────────────────────────────────────────────────────────────
async function buscarSerper(query, num) {
  if (!process.env.SERPER_API_KEY) return [];
  try {
    const body = JSON.stringify({ q: query, num, gl: 'br', hl: 'pt-br' });
    const data = await httpsJSON({
      hostname: 'google.serper.dev', path: '/search', method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, body, 10000);
    return (data.organic || []).filter(i => i.title && i.snippet)
      .map(i => ({ titulo: i.title, fonte: i.link, trecho: i.snippet }));
  } catch (e) {
    console.error('[DNA] Serper:', e.message);
    return [];
  }
}

async function buscarBrave(query, num) {
  if (!process.env.BRAVE_API_KEY) return [];
  try {
    const data = await httpsJSON({
      hostname: 'api.search.brave.com',
      path: '/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + Math.min(num, 20) + '&country=br&search_lang=pt',
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY.trim() }
    }, null, 10000);
    if (data.type === 'ErrorResponse' || data.message) {
      console.error('[DNA] Brave erro:', data.message || JSON.stringify(data));
      return [];
    }
    return (data.web?.results || []).filter(i => i.title && i.description)
      .map(i => ({ titulo: i.title, fonte: i.url, trecho: i.description }));
  } catch (e) {
    console.error('[DNA] Brave:', e.message);
    return [];
  }
}

async function buscarDDG(query, num) {
  return new Promise(resolve => {
    const q = encodeURIComponent(query);
    const opts = {
      hostname: 'html.duckduckgo.com', path: `/html/?q=${q}`, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'text/html', 'Accept-Language': 'pt-BR,pt;q=0.9'
      }
    };
    const req = https.request(opts, res => {
      let html = '';
      res.on('data', d => { if (html.length < 200000) html += d; });
      res.on('end', () => {
        const results = [];
        // DDG HTML muda a estrutura de divs com frequência; em vez de tentar
        // casar um bloco aninhado inteiro (frágil — quebra com qualquer div
        // extra entre título e snippet), casamos título+href e snippet em
        // sequência direto no HTML, na ordem em que aparecem.
        const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const titles = []; let tm;
        while ((tm = titleRe.exec(html)) !== null) titles.push({ href: tm[1], titulo: strip(tm[2]) });
        const snippets = []; let sm;
        while ((sm = snippetRe.exec(html)) !== null) snippets.push(strip(sm[1]));
        for (let i = 0; i < titles.length && results.length < num; i++) {
          if (!titles[i].titulo || !snippets[i]) continue;
          let url = titles[i].href;
          if (url.startsWith('//duckduckgo.com/l/?') || url.startsWith('/l/?')) {
            const uddg = url.match(/uddg=([^&]+)/);
            if (uddg) url = decodeURIComponent(uddg[1]);
          }
          results.push({ titulo: titles[i].titulo, fonte: url, trecho: snippets[i] });
        }
        resolve(results);
      });
      res.on('error', () => resolve([]));
    });
    req.on('error', () => resolve([]));
    req.setTimeout(12000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

// Conjunto de queries cobrindo catálogos técnicos, fontes fiscais, aplicação
// veicular (cruzada com motor/ano/modelo/cilindrada) e os grandes marketplaces
// (Mercado Livre, Amazon, Shopee) — onde fabricantes/lojistas costumam publicar
// a ficha técnica completa e os códigos OEM/cross-reference de peças
// equivalentes. Em "agressivo" inclui também catálogos em PDF de
// fabricantes/montadoras e importadores certificados.
function montarQueries(base, nivel_busca) {
  const queries = [
    base + ' ficha tecnica especificacoes autopecas catalogo',
    base + ' NCM EAN codigo fiscal tributario',
    base + ' aplicacao veicular motor montadora ano modelo cilindrada',
    base + ' OEM cross reference codigo original equivalente substituicao',
    base + ' codigo motor bloco motor aplicacao montadora compartilhado',
    base + ' Metal Leve KS MAHLE SABO LUK INA tabela equivalencia',
    base + ' site:mercadolivre.com.br',
    base + ' site:amazon.com.br',
  ];
  if (nivel_busca === 'agressivo') {
    queries.push(
      base + ' catalogo tecnico filetype:pdf',
      base + ' peca cambiada equivalente importador certificado cross code',
      base + ' site:shopee.com.br',
    );
  }
  return nivel_busca === 'discreto' ? queries.slice(0, 4) : queries;
}

// Snippet do Google/DDG tem ~150 chars — tabelas de "Códigos Externos",
// lista completa de aplicações e Ficha Técnica de páginas de distribuidor só
// aparecem no corpo real da página. Busca o HTML real dos melhores resultados
// (anti-SSRF via fetchHtmlSeguro) e substitui o trecho pelo texto completo.
async function enriquecerComPaginaReal(resultados, max = 8) {
  const candidatos = resultados.slice(0, max);
  await Promise.all(candidatos.map(async (item) => {
    try {
      const html = await fetchHtmlSeguro(item.fonte);
      const textoCompleto = htmlParaTexto(html, 6000);
      if (textoCompleto.length > item.trecho.length) {
        item.trecho = textoCompleto;
        item.trecho_completo = true;
      }
    } catch (e) {
      // Silencia erro de fetch individual — snippet original ainda está disponível
    }
  }));
  return resultados;
}

async function buscarMultiQuery({ fabricante, sku, nome, numResultados = 10, nivel_busca }) {
  const base = [fabricante, sku, nome].filter(Boolean).join(' ');
  const queries = montarQueries(base, nivel_busca);
  const seen = new Set(); const all = [];
  for (const q of queries) {
    let res = await buscarSerper(q, numResultados);
    if (res.length === 0) res = await buscarBrave(q, numResultados);
    if (res.length === 0) res = await buscarDDG(q, numResultados);
    for (const r of res) {
      if (r.fonte && !seen.has(r.fonte)) { seen.add(r.fonte); all.push(r); }
    }
  }
  await enriquecerComPaginaReal(all, nivel_busca === 'agressivo' ? 12 : 8);
  console.log(`[DNA v5.3] ${all.length} fontes encontradas (${queries.length} queries)`);
  return all;
}

// ─────────────────────────────────────────────────────────────
// REGRAS CANÔNICAS NTC
// ─────────────────────────────────────────────────────────────
const NTC_SYSTEM = `Você é o agente "DNA OEM 360" do Genesis iRollo 360 (NTC Engine 4.0), especializado em CATALOGAÇÃO TÉCNICA AUTOMOTIVA (autopeças de reposição) para sincronização com Bling e Wix. Todo campo de código que você preencher (part_number_automotivo, cc_oem, cc_aftermarket, cc_importadores) é uma REFERÊNCIA DE PEÇA AUTOMOTIVA — original do fabricante do veículo ou de fabricante de autopeças — nunca um código genérico de catálogo interno. Toda motorização (motorizacao_alvo_veiculo) e posição de montagem (posicao_montagem_peca) descrevem a aplicação real da peça no veículo, não uma característica do produto isolada do contexto automotivo.

REGRAS ABSOLUTAS:
1. NUNCA invente dados sem fonte nos trechos fornecidos. Sem evidência = null.
2. Três níveis: "confirmado" (2+ fontes independentes específicas), "familia" (código vizinho), "nulo" (sem fonte). Home page de marca NUNCA é fonte válida.
3. Código incompleto? status="codigo_incompleto" + variantes_possiveis. Não escolha sufixo.
4. Motorização compartilhada entre montadoras? Explique triangulação em mecanismo_triangulacao.
5. fontes[]: URLs EXATAS do dado específico.
6. NUNCA misture código original/cross-reference (part_number_automotivo, cc_oem, cc_aftermarket, cc_importadores) de uma categoria de peça diferente da peça pesquisada (ex.: pastilha de freio não é cross-reference de cilindro mestre de embreagem, mesmo que apareçam no mesmo resultado de busca). Se a categoria do trecho não corresponder à categoria do produto de entrada, descarte o código e retorne null.
7. bta.instrucoes_instalacao: só preencha com texto de boletim técnico/manual de instalação do fabricante encontrado nas fontes — nunca generalize um procedimento padrão de oficina.
8. Cruzamento de aplicação (av.aplicacoes): um código original/cross-reference só é válido para uma aplicação (montadora/modelo/motorizacao_alvo_veiculo/ano/cilindrada) se o BLOCO DO MOTOR (código do motor) ou a aplicação real bater entre as fontes — nunca herde aplicação só porque o nome da peça é parecido. Catálogos de marketplaces (Mercado Livre, Amazon, Shopee) e blogs de autopeças são fontes válidas de aplicação/cross-reference, mas description de vendedor sem ficha técnica visível não conta como fonte específica.
9. cc_oem/cc_aftermarket/cc_importadores: cruze o código da peça pesquisada com catálogos de OUTROS fabricantes de autopeças, montadoras e importadores certificados — um código só entra como cross-reference confirmado se pelo menos uma fonte mostrar explicitamente a equivalência (tabela de substituição, "equivalente a", "substitui", "cross reference"), nunca por mera coincidência de aplicação.
10. MOTOR COMO ÓRGÃO COMPARTILHADO ENTRE MONTADORAS: motorizações nascem de um único projeto de engenharia e são licenciadas/homologadas por múltiplas montadoras — ex.: o motor Mitsubishi 4D56 (também grafado 4DR5/4D56T) equipa o Hyundai HR/H100 (homologado no Brasil pela Hyundai Caoa) E o Kia Bongo K2500, entre outros, porque é o MESMO bloco de motor sob marcas/homologações diferentes. Quando a fonte identificar o código do motor (ex.: "4D56", "4D56T") batendo entre duas montadoras, isso é EVIDÊNCIA VÁLIDA de triangulação — preencha av.mecanismo_triangulacao explicando o compartilhamento, e registre cada montadora/modelo como aplicação própria (nunca descarte uma aplicação só porque o nome comercial do veículo difere entre marcas).
11. Fabricantes de autopeças (Metal Leve, KS, MAHLE, SABO, LUK, INA, Schaeffler, Fras-le, Cofap etc.) publicam tabelas de equivalência/cross-reference usando o CÓDIGO OEM da montadora como referência-mestre — uma tabela dessas mostrando o código pesquisado ligado ao OEM é fonte válida de aplicação e de cc_oem, mesmo que o item do fabricante de autopeças tenha SKU próprio sem homologação direta da montadora (o SKU do fabricante de peças não é "menos confiável", ele só usa numeração própria; o que importa é se a tabela cita o OEM/motor explicitamente). Importadores não-certificados que vendem pelo próprio SKU sem citar o código OEM/motor de origem NÃO contam como fonte de aplicação — só como fonte de cc_importadores se o anúncio citar a equivalência.
12. Saída: SOMENTE o JSON. Sem markdown. Sem texto antes ou depois.`;

const NTC_SCHEMA = `{"codigo_entrada":"<exato>","status":"ok|codigo_incompleto|nao_encontrado","variantes_possiveis":[],"dna":{"fabricante_original":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"part_number_automotivo":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"codigo_fabricante_normalizado":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"ean":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"categoria_produto":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"fm":{"nome_tecnico_completo":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"funcao_tecnica":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"av":{"aplicacoes":[{"montadora":null,"modelo":null,"motorizacao_alvo_veiculo":null,"ano_inicial":null,"ano_final":null,"cilindrada":null,"confianca":"confirmado|familia|nulo","fontes":[]}],"mecanismo_triangulacao":null},"co":{"ncm":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]},"cest":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"mc":{"material":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"ec":{"engenharia_detalhe":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"bta":{"boletins":[],"substituicoes":[],"instrucoes_instalacao":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"cc":{"cc_oem":[{"marca":null,"codigo":null,"confianca":"confirmado|familia|nulo"}],"cc_aftermarket":[{"marca":null,"codigo":null,"confianca":"confirmado|familia|nulo"}],"cc_importadores":[{"marca":null,"codigo":null,"confianca":"confirmado|familia|nulo"}]},"lg":{"linhagem":{"valor":null,"confianca":"confirmado|familia|nulo","fontes":[]}},"fi_fp":{"peso_bruto":null,"peso_liquido":null,"comprimento":null,"largura":null,"altura":null}}`;

const CAMPOS_DNA = [
  'part_number_automotivo','codigo_ean','codigo_ncm','codigo_cest','motorizacao_alvo_veiculo','codigo_identificador_motor',
  'montadora_veiculo','modelo_veiculo','versao_acabamento_veiculo','ano_inicial','ano_final','cilindrada',
  'composicao_material_peca','posicao_montagem_peca','fmsi','comprimento','largura','altura',
  'cross_codes','concorrentes','aplicacoes_adicionais','funcao_tecnica',
  'boletins','substituicoes','instrucoes_instalacao','fabricante_original','montadora',
  'cc_oem','cc_importadores','peso_bruto','peso_liquido'
];

function camposVazios() {
  const v = {};
  CAMPOS_DNA.forEach(c => { v[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte nao encontrada' }; });
  return v;
}

function auditarConfianca(campo) {
  if (!campo || campo.confianca !== 'confirmado') return campo;
  const fontes = (campo.fontes || []).filter(f => f && f.startsWith('http'));
  const doms = new Set();
  for (const f of fontes) { try { doms.add(new URL(f).hostname.replace(/^www\./, '')); } catch (_) {} }
  if (doms.size < 2) campo.confianca = 'familia';
  return campo;
}

function auditarCanonicoCompleto(can) {
  if (!can) return can;
  for (const k of Object.keys(can.dna || {})) auditarConfianca(can.dna[k]);
  for (const k of Object.keys(can.fm  || {})) auditarConfianca(can.fm[k]);
  for (const ap of (can.av?.aplicacoes || [])) {
    const doms = new Set();
    for (const f of (ap.fontes || [])) { try { doms.add(new URL(f).hostname.replace(/^www\./, '')); } catch (_) {} }
    if (ap.confianca === 'confirmado' && doms.size < 2) ap.confianca = 'familia';
  }
  for (const sec of [can.co, can.mc, can.ec, can.lg]) {
    if (!sec) continue;
    for (const k of Object.keys(sec)) auditarConfianca(sec[k]);
  }
  if (can.bta?.instrucoes_instalacao) auditarConfianca(can.bta.instrucoes_instalacao);
  return can;
}

function canonParaLegado(can) {
  if (!can) return camposVazios();
  const C  = { confirmado: 'alta', familia: 'media', nulo: 'baixa' };
  const g  = f => (f && f.confianca !== 'nulo' && f.valor != null) ? f.valor : null;
  const gf = f => (Array.isArray(f?.fontes) && f.fontes.length) ? f.fontes[0] : null;
  const av0 = Array.isArray(can.av?.aplicacoes) ? can.av.aplicacoes[0] : null;
  const ac  = av0?.confianca || 'nulo';
  const af  = (Array.isArray(av0?.fontes) && av0.fontes.length) ? av0.fontes[0] : null;
  const avRest = (can.av?.aplicacoes?.length > 1)
    ? can.av.aplicacoes.slice(1).map(a =>
        [a.montadora, a.modelo, a.motorizacao_alvo_veiculo, a.cilindrada,
         (a.ano_inicial && a.ano_final) ? `${a.ano_inicial}-${a.ano_final}` : a.ano_inicial
        ].filter(Boolean).join(' ')
      ).join('\n')
    : null;
  const oe = (can.cc?.cc_oem         || []).filter(c => c?.codigo).map(c => `${c.marca||''} ${c.codigo}`.trim());
  const am = (can.cc?.cc_aftermarket  || []).filter(c => c?.codigo).map(c => `${c.marca||''} ${c.codigo}`.trim());
  const im = (can.cc?.cc_importadores || []).filter(c => c?.codigo).map(c => `${c.marca||''} ${c.codigo}`.trim());
  const mk = (valor, k, f) => ({ valor, fonte: f, confianca: C[k] || 'baixa', motivo: null });
  const ma = v => mk(v, ac, af);
  // Campos sem objeto { confianca, fontes } próprio (listas derivadas de
  // cc_oem/cc_aftermarket/cc_importadores, boletins, substituições, dimensões
  // herdadas por família): confiança só existe se houver valor — campo vazio
  // nunca pode carregar confiança "media"/"familia" (regra de ouro: sem
  // evidência = null, sem confiança associada).
  const mkLista = (valor, confiancaSeTemValor) => ({ valor, fonte: null, confianca: valor ? confiancaSeTemValor : 'baixa', motivo: null });
  return {
    part_number_automotivo: mk(g(can.dna?.part_number_automotivo), can.dna?.part_number_automotivo?.confianca, gf(can.dna?.part_number_automotivo)),
    codigo_ean:            mk(g(can.dna?.ean),                can.dna?.ean?.confianca,                 gf(can.dna?.ean)),
    codigo_ncm:            mk(g(can.co?.ncm),                 can.co?.ncm?.confianca,                  gf(can.co?.ncm)),
    codigo_cest:           mk(g(can.co?.cest),                can.co?.cest?.confianca,                 gf(can.co?.cest)),
    motorizacao_alvo_veiculo: ma(av0?.motorizacao_alvo_veiculo || null),
    codigo_identificador_motor: mk(null, 'nulo', null),
    montadora_veiculo:     ma(av0?.montadora  || null),
    modelo_veiculo:        ma(av0?.modelo     || null),
    versao_acabamento_veiculo: mk(null, 'nulo', null),
    ano_inicial:           ma(av0?.ano_inicial || null),
    ano_final:             ma(av0?.ano_final   || null),
    cilindrada:            ma(av0?.cilindrada  || null),
    composicao_material_peca: mk(g(can.mc?.material),         can.mc?.material?.confianca,             gf(can.mc?.material)),
    posicao_montagem_peca: mk(null, 'nulo', null),
    fmsi:                  mk(null, 'nulo', null),
    comprimento:           mkLista(can.fi_fp?.comprimento || null, 'familia'),
    largura:               mkLista(can.fi_fp?.largura     || null, 'familia'),
    altura:                mkLista(can.fi_fp?.altura      || null, 'familia'),
    cross_codes:           mkLista(am.length ? am : null, 'media'),
    concorrentes:          mkLista(am.length ? am : null, 'media'),
    aplicacoes_adicionais: mkLista(avRest, 'media'),
    funcao_tecnica:        mk(g(can.fm?.funcao_tecnica),       can.fm?.funcao_tecnica?.confianca,       gf(can.fm?.funcao_tecnica)),
    boletins:              mkLista(can.bta?.boletins?.length    ? can.bta.boletins    : null, 'media'),
    substituicoes:         mkLista(can.bta?.substituicoes?.length ? can.bta.substituicoes : null, 'media'),
    instrucoes_instalacao: mk(g(can.bta?.instrucoes_instalacao), can.bta?.instrucoes_instalacao?.confianca, gf(can.bta?.instrucoes_instalacao)),
    fabricante_original:   mk(g(can.dna?.fabricante_original), can.dna?.fabricante_original?.confianca, gf(can.dna?.fabricante_original)),
    montadora:             ma(av0?.montadora || null),
    cc_oem:                mkLista(oe.length ? oe : null, 'media'),
    cc_importadores:       mkLista(im.length ? im : null, 'media'),
    peso_bruto:            mkLista(can.fi_fp?.peso_bruto   || null, 'familia'),
    peso_liquido:          mkLista(can.fi_fp?.peso_liquido || null, 'familia'),
  };
}

// ─────────────────────────────────────────────────────────────
// AGENTE PRINCIPAL — DeepSeek (agente universal único) + busca web (Serper/DDG)
// ─────────────────────────────────────────────────────────────
async function chamarLLM({ system, userContent, maxTokens }) {
  const { texto, motor } = await chamarLLMUniversal({ system, userContent, maxTokens });
  registrarUsoApi('deepseek');
  return { texto, motor };
}

async function enriquecerDnaViaWeb({ sku, fabricante, nome, nivel_busca }) {
  if (!sku && !nome) return { ok: false, erro: 'SKU ou Nome obrigatorio', campos: camposVazios(), pendente_confirmacao: true, usou_busca_web: usouBusca };
  if (!process.env.DEEPSEEK_API_KEY) {
    return { ok: false, erro: 'DEEPSEEK_API_KEY nao configurada', campos: camposVazios(), pendente_confirmacao: true };
  }

  const codigoEntrada = sku || nome;
  const termoBase    = [fabricante, sku, nome].filter(Boolean).join(' ');
  const numResultados = nivel_busca === 'agressivo' ? 15 : nivel_busca === 'discreto' ? 5 : 10;
  const maxTokens    = nivel_busca === 'agressivo' ? 4000 : nivel_busca === 'discreto' ? 1500 : 2500;

  let trechos = [];
  try { trechos = await buscarMultiQuery({ fabricante, sku, nome, numResultados, nivel_busca }); }
  catch (e) { console.error('[DNA v5.3] busca:', e.message); }

  // 2. LLM — SEMPRE com base nos resultados de busca real. Conhecimento de
  // treinamento do DeepSeek NUNCA é usado como substituto de fonte web: a
  // regra de ouro do NTC ("sem evidência = null") não admite excecão para
  // "lembrar" um catálogo de memória, porque não há como auditar/citar a URL
  // exata — é exatamente esse tipo de "lembrança" que produz dado errado
  // (cross-reference, NCM, aplicação) sem nenhuma fonte real por trás.
  const usouBusca = trechos.length > 0;
  try {
    const contexto = usouBusca
      ? `Resultados de busca (${trechos.length} fontes):\n` +
        trechos.map((t, i) => `[${i+1}] ${t.titulo}\nURL: ${t.fonte}\n${t.trecho}`).join('\n\n')
      : `Nenhum resultado de busca disponível para este produto. NÃO use conhecimento de treinamento/memória ` +
        `para preencher campos — isso viola a regra de ouro do NTC (nunca inventar sem fonte real auditável). ` +
        `Retorne TODOS os campos com confianca="nulo", valor=null e fontes=[], e status="nao_encontrado".`;

    const userContent =
      `CÓDIGO: ${codigoEntrada}\nPRODUTO: ${termoBase}\n\n` +
      contexto +
      `\n\nESQUEMA DE SAÍDA (retorne SOMENTE este JSON):\n${NTC_SCHEMA}`

    const { texto: rawText, motor } = await chamarLLM({ system: NTC_SYSTEM, userContent, maxTokens });
    console.log(`[DNA v5.3] ${motor} ${rawText.length} chars | ${codigoEntrada}`);

    let canonico;
    try {
      const cleaned = rawText.trim().replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      canonico = JSON.parse(m ? m[0] : cleaned);
    } catch (e) {
      console.error('[DNA v5.3] parse:', e.message);
      return { ok: false, erro: 'Parse JSON: ' + e.message, campos: camposVazios(), pendente_confirmacao: true };
    }

    if (!canonico.codigo_entrada) canonico.codigo_entrada = codigoEntrada;
    auditarCanonicoCompleto(canonico);

    // Camada extra de validação: rebaixa "confirmado" para "familia"/"nulo"
    // quando as fontes citadas não são URLs específicas de produto (ex.: home
    // page institucional da marca, domínio raiz) — auditarCanonicoCompleto já
    // rebaixa por contagem de domínios, isto reforça pela qualidade da URL.
    const { dados: canonicoValidado, auditoria } = validarRespostaAgente(canonico);
    if (auditoria?.modificado) {
      console.log(`[DNA v5.3] validarRespostaAgente rebaixou ${auditoria.total_rebaixamentos} campo(s) | ${codigoEntrada}`);
    }
    canonico = canonicoValidado;

    if (canonico.dna?.ean?.valor != null) {
      const s = String(canonico.dna.ean.valor).replace(/\D/g, '');
      if (!validarGTIN(s)) canonico.dna.ean = { valor: null, confianca: 'nulo', fontes: [] };
      else canonico.dna.ean.valor = s;
    }

    if (canonico.co?.ncm?.valor != null) {
      const l = validarNCM(canonico.co.ncm.valor);
      if (!l) { canonico.co.ncm = { valor: null, confianca: 'nulo', fontes: [] }; }
      else {
        canonico.co.ncm.valor = l;
        try { const desc = await consultarNCMOficial(l); if (desc) { canonico.co.ncm.confianca = 'confirmado'; canonico.co.ncm._tipi = desc; } } catch (_) {}
      }
    }

    if (Array.isArray(canonico.av?.aplicacoes)) {
      for (const ap of canonico.av.aplicacoes) {
        for (const f of ['ano_inicial', 'ano_final']) {
          if (ap[f] != null && ap[f] !== 'atual') { const n = parseInt(ap[f],10); ap[f] = (!isNaN(n)&&n>=1950&&n<=2035)?n:null; }
        }
      }
    }

    const camposLegado      = canonParaLegado(canonico);
    let campos_preenchidos = CAMPOS_DNA.filter(c => camposLegado[c]?.valor != null).length;
    console.log(`[DNA v5.3] ${campos_preenchidos}/${CAMPOS_DNA.length} | status: ${canonico.status||'ok'}`);

    // Nem busca web nem conhecimento de treinamento renderam campo algum —
    // plano B: herdar sugestões (rotuladas, não confirmadas) de peças da
    // mesma família técnica já validadas, para não deixar a tela em 0%.
    if (campos_preenchidos === 0) {
      const heranca = herdarDeFamiliaTecnica({ fabricante, nome, sku });
      if (heranca) {
        return { ...heranca, campos_canonico: canonico, fontes_consultadas: trechos.map(t => t.fonte) };
      }
    }

    return { ok: true, encontrado: campos_preenchidos > 0, campos: camposLegado, campos_canonico: canonico, fontes_consultadas: trechos.map(t => t.fonte), campos_preenchidos, total_campos: CAMPOS_DNA.length, pendente_confirmacao: true };

  } catch (e) {
    console.error('[DNA v5.3] LLM:', e.message);
    // Erros de cota (429) trazem o corpo bruto da API (JSON gigante) na
    // mensagem — nunca repassar isso ao frontend, só uma mensagem curta e
    // o motivo, para não quebrar o layout com um bloco de texto técnico.
    const cotaExcedida = /RESOURCE_EXHAUSTED|429|quota/i.test(e.message || '');
    const erro = cotaExcedida
      ? 'Cota diária de IA esgotada — tente novamente mais tarde ou configure um plano pago no Google AI Studio.'
      : String(e.message || 'Falha ao consultar a IA').slice(0, 200);
    return { ok: false, erro, cota_excedida: cotaExcedida, campos: camposVazios(), pendente_confirmacao: true };
  }
}

module.exports = { enriquecerDnaViaWeb, CAMPOS_DNA, camposVazios, canonParaLegado };
