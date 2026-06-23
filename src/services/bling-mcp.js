// ============================================================
// Conector MCP — expõe a integração com Bling e Wix Stores como
// ferramentas (tools) que o Claude pode chamar via SSE.
// ============================================================
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');

// Monta o McpServer com as tools que dão acesso ao Bling e ao Wix Stores
// via funções já existentes em server.js (OAuth2, montagem de payload, categorias).
function criarServidorMcp({
  blingRequest, montarPayloadProdutoBling, listarBlingCategorias, idCategoriaPai,
  wixRequest, montarPayloadProdutoWix, atribuirCategoriasWix,
}) {
  const server = new McpServer({ name: 'genesis-indexa-360-ia', version: '1.0.0' });

  server.tool(
    'listar_produtos',
    'Lista produtos ativos cadastrados no Bling, com paginação.',
    { pagina: z.number().int().min(1).default(1), limite: z.number().int().min(1).max(100).default(20) },
    async ({ pagina, limite }) => {
      const data = await blingRequest('GET', `/produtos?situacao=A&pagina=${pagina}&limite=${limite}`);
      const produtos = (data.data || []).map(p => ({ id: p.id, nome: p.nome, codigo: p.codigo, preco: p.preco, situacao: p.situacao }));
      return { content: [{ type: 'text', text: JSON.stringify({ produtos, total: produtos.length, pagina }, null, 2) }] };
    }
  );

  server.tool(
    'consultar_produto',
    'Consulta os dados completos de um produto do Bling pelo ID.',
    { id: z.number().int() },
    async ({ id }) => {
      const data = await blingRequest('GET', `/produtos/${id}`);
      if (!data.data) return { content: [{ type: 'text', text: 'Produto não encontrado: ' + JSON.stringify(data.error || data) }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(data.data, null, 2) }] };
    }
  );

  server.tool(
    'criar_produto',
    'Cadastra um novo produto no Bling a partir dos dados do Motor NTC (nome, sku/código, fabricante, OEM, EAN, NCM, aplicação veicular etc.). Categoria e ficha técnica são montadas automaticamente.',
    { dados: z.record(z.any()).describe('Objeto com os campos do produto (nome, sku, fabricante, part_number_automotivo, ean, ncm, familia_tecnica, marca_veiculo, modelo_veiculo, motorizacao_alvo_veiculo, preco, imagens, etc.)') },
    async ({ dados }) => {
      const payload = await montarPayloadProdutoBling(dados);
      const data = await blingRequest('POST', '/produtos', payload);
      if (!data.data || !data.data.id) return { content: [{ type: 'text', text: 'Falha ao criar produto: ' + JSON.stringify(data.error || data) }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: data.data.id, categoria: payload.categoria || null }, null, 2) }] };
    }
  );

  server.tool(
    'atualizar_produto',
    'Atualiza nome e descrição curta de um produto existente no Bling.',
    { id: z.number().int(), nome: z.string().optional(), descricao: z.string().optional() },
    async ({ id, nome, descricao }) => {
      const payload = { situacao: 'A' };
      if (nome) payload.nome = nome;
      if (descricao) payload.descricaoCurta = descricao.substring(0, 300);
      const data = await blingRequest('PUT', '/produtos/' + id, payload);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'listar_categorias',
    'Lista as categorias e subcategorias de produtos cadastradas no Bling.',
    {},
    async () => {
      const categorias = await listarBlingCategorias();
      const lista = categorias.map(c => ({ id: c.id, descricao: c.descricao, idCategoriaPai: idCategoriaPai(c) }));
      return { content: [{ type: 'text', text: JSON.stringify(lista, null, 2) }] };
    }
  );

  server.tool(
    'cadastrar_produto_completo',
    'Cadastra um produto (já enriquecido pelo Motor NTC 4.0) simultaneamente no Bling e na loja Wix Stores (mobisautoparts.com.br), com categoria/ficha técnica resolvidas automaticamente em cada plataforma.',
    { dados: z.record(z.any()).describe('Objeto com os campos do produto (nome, sku, fabricante, part_number_automotivo, ean, ncm, familia_tecnica, marca_veiculo, modelo_veiculo, motorizacao_alvo_veiculo, preco, imagens, rast_hash, ntc, etc.)') },
    async ({ dados }) => {
      const resultado = { bling: null, wix: null };

      try {
        const payload = await montarPayloadProdutoBling(dados);
        const b = await blingRequest('POST', '/produtos', payload);
        resultado.bling = (b.data && b.data.id)
          ? { ok: true, id: b.data.id, categoria: payload.categoria || null }
          : { ok: false, erro: JSON.stringify(b.error || b) };
      } catch (e) {
        resultado.bling = { ok: false, erro: e.message };
      }

      try {
        const { payload, categoriaIds } = await montarPayloadProdutoWix(dados);
        const w = await wixRequest('POST', '/stores/v3/products-with-inventory', payload);
        if (w.product && w.product.id) {
          await atribuirCategoriasWix(w.product.id, categoriaIds);
          resultado.wix = { ok: true, id: w.product.id, categorias: categoriaIds || null };
        } else {
          resultado.wix = { ok: false, erro: JSON.stringify(w) };
        }
      } catch (e) {
        resultado.wix = { ok: false, erro: e.message };
      }

      return { content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }] };
    }
  );

  server.tool(
    'sincronizar_bling_wix',
    'Importa produtos ativos do Bling para a loja Wix Stores (mobisautoparts.com.br), ignorando os que já existem por nome.',
    { pagina: z.number().int().min(1).default(1), limite: z.number().int().min(1).max(100).default(50) },
    async ({ pagina, limite }) => {
      const blingData = await blingRequest('GET', `/produtos?situacao=A&pagina=${pagina}&limite=${limite}`);
      const blingProds = blingData.data || [];
      if (!blingProds.length) return { content: [{ type: 'text', text: JSON.stringify({ ok: true, criados: 0, ignorados: 0, erros: 0, total: 0 }, null, 2) }] };

      const wixQuery = await wixRequest('POST', '/stores/v3/products/query', { query: { paging: { limit: 100, offset: 0 } } });
      const wixNomes = new Set((wixQuery.products || []).map(p => p.name));
      const novos = blingProds.filter(p => !wixNomes.has(p.nome));

      let criados = 0, erros = 0;
      const resultados = [];
      const LOTE = 10;
      for (let i = 0; i < novos.length; i += LOTE) {
        const lote = novos.slice(i, i + LOTE);
        const products = lote.map(p => ({
          name: p.nome || p.codigo || 'Produto',
          visible: true,
          productType: 'PHYSICAL',
          physicalProperties: {},
          variantsInfo: { variants: [{
            choices: [],
            price: { actualPrice: { amount: p.preco ? String(parseFloat(p.preco).toFixed(2)) : '0.01' } },
            visible: true,
            inventoryItem: { quantity: 1, preorderInfo: { enabled: false } },
            physicalProperties: {}
          }] }
        }));
        try {
          await wixRequest('POST', '/stores/v3/bulk/products-with-inventory/create', { products, returnEntity: true });
          lote.forEach(p => { resultados.push({ nome: p.nome, acao: 'criado', bling_id: p.id }); criados++; });
        } catch (e) {
          lote.forEach(p => { resultados.push({ nome: p.nome, acao: 'erro', erro: e.message.substring(0, 80), bling_id: p.id }); erros++; });
        }
      }

      const ignorados = blingProds.length - novos.length;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, criados, ignorados, erros, total: blingProds.length, pagina, resultados }, null, 2) }] };
    }
  );

  server.tool(
    'consultar_produto_wix',
    'Consulta os dados completos de um produto na loja Wix Stores (mobisautoparts.com.br) pelo ID.',
    { id: z.string() },
    async ({ id }) => {
      const data = await wixRequest('GET', '/stores/v3/products/' + id);
      if (!data.product) return { content: [{ type: 'text', text: 'Produto não encontrado: ' + JSON.stringify(data) }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(data.product, null, 2) }] };
    }
  );

  return server;
}

// Registra os endpoints MCP (/sse e /messages) no app Express.
// Protegido por token: exige header Authorization: Bearer <MCP_AUTH_TOKEN>
// (ou query ?token=) quando a variável de ambiente MCP_AUTH_TOKEN está definida.
function registrarRotasMcp(app, deps) {
  const transports = {};

  function autenticado(req) {
    const token = process.env.MCP_AUTH_TOKEN;
    if (!token) return true;
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    return bearer === token || req.query.token === token;
  }

  app.get('/sse', async (req, res) => {
    if (!autenticado(req)) return res.status(401).end('Token MCP inválido ou ausente');
    const server = criarServidorMcp(deps);
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    res.on('close', () => { delete transports[transport.sessionId]; });
    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    if (!autenticado(req)) return res.status(401).end('Token MCP inválido ou ausente');
    const transport = transports[req.query.sessionId];
    if (!transport) return res.status(400).send('Sessão MCP não encontrada — conecte em /sse primeiro');
    await transport.handlePostMessage(req, res, req.body);
  });
}

module.exports = { registrarRotasMcp };
