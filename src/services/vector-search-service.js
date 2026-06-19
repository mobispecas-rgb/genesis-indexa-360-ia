'use strict';

// Busca Vetorial (Vector Search) do Genesis — gera embeddings via Gemini
// (@google/genai, mesma GEMINI_API_KEY do enriquecimento de DNA) e faz busca
// por similaridade de cosseno sobre os vetores persistidos no SQLite
// (tabela produto_embeddings). Não depende de infraestrutura externa
// (BigQuery/Vertex AI Vector Search) — tudo roda dentro do próprio Genesis,
// alimentando o Motor DNA/NTC (módulos CC/AV/LG) e o fluxo de
// reenriquecimento com matching semântico de OEM, aplicação veicular e
// cross-codes.
const db = require('./db');

const MODELO_EMBEDDING = process.env.EMBEDDING_MODEL || 'text-embedding-004';

// Campos vetoriais indexáveis e o texto composto que cada um representa,
// extraído do mesmo objeto `dados` usado pelo NTC engine / DNA enricher.
const CAMPOS_VETOR = ['dna', 'oem', 'aplicacao', 'cross_codes'];

function arr(v) { return Array.isArray(v) ? v : []; }

function textoDna(dados) {
    return [
        dados.nome, dados.fabricante, dados.linhagem_fabricante, dados.linhagem_montadora,
        dados.codigo_oem, dados.motor, dados.codigo_motor, dados.marca, dados.modelo, dados.versao,
        dados.material, dados.funcao, dados.posicao,
    ].filter(Boolean).join(' | ');
}

function textoOem(dados) {
    return [dados.codigo_oem, ...arr(dados.cc_oem), ...arr(dados.cc_importadores)].filter(Boolean).join(' ');
}

function textoAplicacao(dados) {
    const periodo = dados.ano_inicial && dados.ano_final ? `${dados.ano_inicial}-${dados.ano_final}` : (dados.ano_inicial || '');
    return [dados.marca, dados.modelo, dados.versao, dados.motor, dados.codigo_motor, dados.cilindrada, periodo,
        ...arr(dados.aplicacoes_adicionais)].filter(Boolean).join(' ');
}

function textoCrossCodes(dados) {
    return [...arr(dados.cc_aftermarket), ...arr(dados.substituicoes)].filter(Boolean).join(' ');
}

const GERADORES_TEXTO = { dna: textoDna, oem: textoOem, aplicacao: textoAplicacao, cross_codes: textoCrossCodes };

// Gera o vetor de embedding de um texto via Gemini. Lança erro se
// GEMINI_API_KEY não estiver configurada ou se a chamada falhar.
async function gerarEmbedding(texto) {
    if (!texto || !texto.trim()) return null;
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não configurada');

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.embedContent({ model: MODELO_EMBEDDING, contents: texto });

    const valores = response?.embeddings?.[0]?.values || response?.embedding?.values;
    if (!Array.isArray(valores) || !valores.length) throw new Error('Resposta de embedding vazia');
    return valores;
}

function similaridadeCosseno(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Indexa (ou reindexa) os embeddings de um produto para todos os campos
// vetoriais com texto disponível. Chamado pelo job de auto-enriquecimento
// depois do DNA preenchido, para manter a busca vetorial sempre atualizada.
async function indexarProduto(row) {
    if (!process.env.GEMINI_API_KEY) return { ok: false, erro: 'GEMINI_API_KEY não configurada', indexados: [] };
    const dados = row.dados || {};
    const indexados = [];
    for (const campo of CAMPOS_VETOR) {
        const texto = GERADORES_TEXTO[campo](dados);
        if (!texto || !texto.trim()) continue;
        try {
            const embedding = await gerarEmbedding(texto);
            if (!embedding) continue;
            db.salvarEmbeddingProduto({
                produto_id: row.id, sku: row.sku, campo, texto,
                embedding: JSON.stringify(embedding), modelo: MODELO_EMBEDDING,
            });
            indexados.push(campo);
        } catch (e) {
            console.error('[Vector Search] indexar', row.sku, campo, e.message);
        }
    }
    return { ok: true, indexados };
}

// Busca por similaridade de cosseno entre o texto de busca e os embeddings
// já indexados de um campo (dna | oem | aplicacao | cross_codes). Retorna os
// produtos mais próximos (similaridade >= threshold), ordenados desc.
async function buscarSimilaridade(texto, { campo = 'dna', limit = 5, threshold = 0.85 } = {}) {
    if (!CAMPOS_VETOR.includes(campo)) throw new Error(`campo inválido: ${campo}`);
    const embeddingBusca = await gerarEmbedding(texto);
    if (!embeddingBusca) return [];

    const linhas = db.listarEmbeddingsPorCampo(campo);
    const resultados = linhas.map(l => {
        let embedding = [];
        try { embedding = JSON.parse(l.embedding); } catch (e) { /* linha corrompida — similaridade 0 */ }
        return {
            produto_id: l.produto_id, sku: l.sku, campo, texto: l.texto,
            similaridade: similaridadeCosseno(embeddingBusca, embedding),
        };
    });

    return resultados
        .filter(r => r.similaridade >= threshold)
        .sort((a, b) => b.similaridade - a.similaridade)
        .slice(0, limit);
}

function buscarOEM(texto, opts = {}) { return buscarSimilaridade(texto, { ...opts, campo: 'oem' }); }
function buscarAplicacaoMotor(texto, opts = {}) { return buscarSimilaridade(texto, { ...opts, campo: 'aplicacao' }); }
function buscarCodigosCambiados(texto, opts = {}) { return buscarSimilaridade(texto, { ...opts, campo: 'cross_codes' }); }
function buscarDNA(texto, opts = {}) { return buscarSimilaridade(texto, { ...opts, campo: 'dna' }); }

module.exports = {
    CAMPOS_VETOR,
    gerarEmbedding,
    similaridadeCosseno,
    indexarProduto,
    buscarSimilaridade,
    buscarOEM,
    buscarAplicacaoMotor,
    buscarCodigosCambiados,
    buscarDNA,
};
