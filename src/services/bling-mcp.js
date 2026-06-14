// ============================================================
// Conector MCP — expõe a integração com o Bling como ferramentas
// (tools) que o Claude pode chamar via SSE.
// ============================================================
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');

// Monta o McpServer com as tools que dão acesso ao Bling via funções já
// existentes em server.js (token OAuth2, montagem de payload, categorias).
function criarServidorMcp({ blingRequest, montarPayloadProdutoBling, listarBlingCategorias, idCategoriaPai }) {
  const server = new McpServer({ name: 'genesis-indexa-360-bling', version: '1.0.0' });

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
    { dados: z.record(z.any()).describe('Objeto com os campos do produto (nome, sku, fabricante, codigo_oem, ean, ncm, familia_tecnica, marca_veiculo, modelo_veiculo, motor, preco, imagens, etc.)') },
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
