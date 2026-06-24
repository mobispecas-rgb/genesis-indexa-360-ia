'use strict';

// Busca Vetorial (Vector Search) do Genesis — usa o mesmo motor único de IA
// (DeepSeek, src/services/llm.js) para comparação semântica entre o texto de
// busca e os textos já indexados de cada produto. Não depende de embeddings
// nem de infraestrutura externa (BigQuery/Vertex AI Vector Search) — tudo
// roda dentro do próprio Genesis, com uma única API/chave (DEEPSEEK_API_KEY).
//
// REGRA NTC PARA VECTOR SEARCH (não violar):
// Este módulo NUNCA cria/confirma sozinho aplicação veicular (AV), código OEM
// ou cross-code (CC), dado fiscal (CO) ou qualquer campo do DNA. Ele apenas
// SUGERE candidatos por similaridade semântica — toda saída de busca vem com
// `valor: null`, `fonte: null`, `url_origem: null` e `status: "Sugestão
// Vetorial"`. Esses campos só passam a ter `valor`/`fonte`/`url_origem`
// reais depois de validação documental (ex.: confirmados via
// dna-enricher.js, que sempre exige fonte_url). Só então o dado pode
// alimentar os módulos AV/CC/CO/DNA do ntc-engine.js. A `confianca` aqui é
// derivada PURAMENTE da similaridade semântica (não é confiança documental) e
// NUNCA deve ser usada para aumentar o score NTC.
const db = require('./db');
const { chamarLLM } = require('./llm');

const MODELO_EMBEDDING = 'deepseek-semantic-match';

// Campos vetoriais indexáveis e o texto composto que cada um representa,
// extraído do mesmo objeto `dados` usado pelo NTC engine / DNA enricher.
const CAMPOS_VETOR = ['dna', 'oem', 'aplicacao', 'cross_codes'];

function arr(v) { return Array.isArray(v) ? v : []; }

// Remove duplicatas antes de montar o texto vetorial — um mesmo código
// (ex.: codigo_oem repetido dentro de cc_oem) não deve inflar o texto nem
// distorcer a similaridade de cosseno.
function dedup(itens) { return [...new Set(itens.filter(Boolean))]; }

function textoDna(dados) {
    return dedup([
        dados.nome, dados.fabricante, dados.linhagem_fabricante, dados.linhagem_montadora,
        dados.part_number_automotivo || dados.codigo_oem, dados.motorizacao_alvo_veiculo || dados.motor, dados.codigo_motor, dados.marca, dados.modelo, dados.versao,
        dados.material, dados.funcao, dados.posicao_montagem_peca || dados.posicao,
    ]).join(' | ');
}

function textoOem(dados) {
    return dedup([dados.part_number_automotivo || dados.codigo_oem, ...arr(dados.cc_oem), ...arr(dados.cc_importadores)]).join(' ');
}

function textoAplicacao(dados) {
    const periodo = dados.ano_inicial && dados.ano_final ? `${dados.ano_inicial}-${dados.ano_final}` : (dados.ano_inicial || '');
    return dedup([dados.marca, dados.modelo, dados.versao, dados.motorizacao_alvo_veiculo || dados.motor, dados.codigo_motor, dados.cilindrada, periodo,
        ...arr(dados.aplicacoes_adicionais)]).join(' ');
}

function textoCrossCodes(dados) {
    return dedup([...arr(dados.cc_aftermarket), ...arr(dados.substituicoes)]).join(' ');
}

const GERADORES_TEXTO = { dna: textoDna, oem: textoOem, aplicacao: textoAplicacao, cross_codes: textoCrossCodes };

// Indexa (ou reindexa) os textos compostos de um produto para todos os
// campos vetoriais com texto disponível. Chamado pelo job de
// auto-enriquecimento depois do DNA preenchido, para manter a busca
// sempre atualizada. Não chama IA — só persiste o texto composto; a
// comparação semântica acontece em buscarSimilaridade, no momento da busca.
async function indexarProduto(row) {
    const dados = row.dados || {};
    const indexados = [];
    for (const campo of CAMPOS_VETOR) {
        const texto = GERADORES_TEXTO[campo](dados);
        if (!texto || !texto.trim()) continue;
        try {
            db.salvarEmbeddingProduto({
                produto_id: row.id, sku: row.sku, campo, texto,
                embedding: JSON.stringify([]), modelo: MODELO_EMBEDDING,
            });
            indexados.push(campo);
        } catch (e) {
            console.error('[Vector Search] indexar', row.sku, campo, e.message);
        }
    }
    return { ok: true, indexados };
}

// Classifica a confiança PURAMENTE vetorial (similaridade de cosseno) de uma
// sugestão. Não tem relação com a confiança documental usada pelo DNA/NTC
// (dna-enricher.js) e não pode substituí-la nem somar ao score NTC.
function classificarConfiancaVetorial(similaridade) {
    if (similaridade >= 0.95) return 'alta';
    if (similaridade >= 0.85) return 'media';
    return 'baixa';
}

// Busca por similaridade semântica (via DeepSeek) entre o texto de busca e
// os textos já indexados de um campo (dna | oem | aplicacao | cross_codes).
// Retorna SUGESTÕES (não dados confirmados) dos produtos mais próximos
// (similaridade >= threshold), ordenados desc. Cada sugestão tem
// `valor: null`, `fonte: null`, `url_origem: null` e
// `status: "Sugestão Vetorial"` — só uma validação documental posterior
// (ex.: dna-enricher.js) pode promover o `valor_sugerido` a dado real e
// alimentar os módulos AV/CC/CO/DNA do NTC.
async function buscarSimilaridade(texto, { campo = 'dna', limit = 5, threshold = 0.85 } = {}) {
    if (!CAMPOS_VETOR.includes(campo)) throw new Error(`campo inválido: ${campo}`);
    if (!texto || !texto.trim()) return [];

    const linhas = db.listarEmbeddingsPorCampo(campo);
    if (!linhas.length) return [];

    const candidatos = linhas.map((l, i) => `${i}: ${l.texto}`).join('\n');
    const system = 'Voce e um motor de similaridade semantica para pecas automotivas (autopecas). ' +
        'Compare o texto de busca com cada candidato numerado da lista e responda APENAS com um JSON array ' +
        '(sem markdown, sem comentarios) no formato [{"indice":N,"similaridade":0.0a1.0}], contendo somente ' +
        'os candidatos cuja similaridade tecnica (mesmo codigo/peca/fabricante/aplicacao) seja >= ' + threshold + '. ' +
        'Nunca invente correspondencia — se nenhum candidato for realmente similar, responda [].';
    const userContent = `Texto de busca: "${texto}"\n\nCandidatos:\n${candidatos}`;

    let resposta;
    try {
        ({ texto: resposta } = await chamarLLM({ system, userContent, maxTokens: 1500 }));
    } catch (e) {
        console.error('[Vector Search] buscarSimilaridade DeepSeek:', e.message);
        return [];
    }

    let pares = [];
    try {
        const jsonStr = resposta.match(/\[[\s\S]*\]/)?.[0] || '[]';
        pares = JSON.parse(jsonStr);
    } catch (e) {
        console.error('[Vector Search] resposta DeepSeek invalida:', e.message);
        return [];
    }

    return pares
        .filter(p => Number.isInteger(p.indice) && linhas[p.indice] && typeof p.similaridade === 'number' && p.similaridade >= threshold)
        .sort((a, b) => b.similaridade - a.similaridade)
        .slice(0, limit)
        .map(p => {
            const l = linhas[p.indice];
            return {
                produto_id: l.produto_id,
                sku: l.sku,
                campo,
                valor_sugerido: l.texto,
                similaridade: p.similaridade,
                valor: null,
                fonte: null,
                url_origem: null,
                confianca: classificarConfiancaVetorial(p.similaridade),
                status: 'Sugestão Vetorial',
            };
        });
}

function buscarOEM(texto, opts = {}) { return buscarSimilaridade(texto, { ...opts, campo: 'oem' }); }
function buscarAplicacaoMotor(texto, opts = {}) { return buscarSimilaridade(texto, { ...opts, campo: 'aplicacao' }); }
function buscarCodigosCambiados(texto, opts = {}) { return buscarSimilaridade(texto, { ...opts, campo: 'cross_codes' }); }
function buscarDNA(texto, opts = {}) { return buscarSimilaridade(texto, { ...opts, campo: 'dna' }); }

module.exports = {
    CAMPOS_VETOR,
    classificarConfiancaVetorial,
    indexarProduto,
    buscarSimilaridade,
    buscarOEM,
    buscarAplicacaoMotor,
    buscarCodigosCambiados,
    buscarDNA,
};
