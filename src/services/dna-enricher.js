'use strict';

// Agente de Enriquecimento de DNA via Web — busca na web os campos dos módulos
// CO/AV/FM/MC/FP do NTC (código OEM, EAN/GTIN, NCM/CEST, aplicação veicular,
// material, dimensões, FMSI etc.) e devolve, para cada campo, o valor, a fonte
// (URL) e a confiança (alta/media/baixa). NUNCA inventa: sem fonte, o campo
// volta null com confiança "baixa" e motivo "fonte não encontrada". EAN passa
// por checksum GTIN e NCM precisa ter 8 dígitos — senão é marcado para
// confirmação fiscal. Resultado sempre "pendente_confirmacao": nunca auto-aprova.
const { buscarWeb, validarGTIN, validarNCM, consultarNCMOficial } = require('./web-utils');

const CAMPOS_DNA = [
    'codigo_oem', 'ean', 'ncm', 'cest', 'motor', 'codigo_motor',
    'marca_veiculo', 'modelo_veiculo', 'versao_veiculo', 'ano_inicial', 'ano_final',
    'cilindrada', 'material', 'posicao', 'fmsi', 'comprimento', 'largura', 'altura',
    'cross_codes', 'aplicacoes_adicionais',
    // NTC completo — módulos EC, BTA, LG, FI, CC-OEM
    'funcao_tecnica', 'boletins', 'substituicoes',
    'fabricante_original', 'montadora',
    'cc_oem', 'peso_bruto', 'peso_liquido'
];

function camposVazios() {
    const vazio = {};
    CAMPOS_DNA.forEach(c => { vazio[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte não encontrada' }; });
    return vazio;
}

// Busca na web + IA o DNA completo de um produto (sku/fabricante/nome).
// Retorna { ok, encontrado, campos, fontes_consultadas, pendente_confirmacao, mensagem?, erro? }
async function enriquecerDnaViaWeb({ sku, fabricante, nome }) {
    if (!sku && !nome) return { ok: false, erro: 'SKU ou Nome obrigatório', campos: camposVazios(), pendente_confirmacao: true };

    const vazio = camposVazios();

    if (!process.env.ANTHROPIC_API_KEY) {
        return { ok: false, erro: 'ANTHROPIC_API_KEY não configurada', campos: vazio, pendente_confirmacao: true };
    }

    const q = [fabricante, sku, nome].filter(Boolean).join(' ');
    let trechos = [];
    try {
        trechos = await buscarWeb(q, 10);
    } catch (e) {
        console.error('[Enriquecer DNA] busca:', e.message);
    }

    if (trechos.length === 0) {
        return {
            ok: true, encontrado: false, campos: vazio, fontes_consultadas: [], pendente_confirmacao: true,
            mensagem: 'Sem resultados de busca — nenhuma fonte encontrada.'
        };
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
- funcao_tecnica: descrição técnica da função da peça em 1-2 frases claras (ex: "Absorve impactos e vibrações da suspensão dianteira, garantindo estabilidade e conforto." ou "Filtra impurezas do óleo lubrificante, protegendo o motor contra desgaste prematuro.")
- boletins: boletins técnicos do fabricante, homologações ou normas aplicáveis. Um item por linha separado por "\n". Ex: "Homologado VW AG\nAtende norma ABNT NBR 6560\nBoletim COFAP BT-2022-014". Null se não houver evidência.
- substituicoes: códigos de peças substituídas ou substitutas (mesmo fit). Um código por linha separado por "\n". Null se não houver.
- fabricante_original: nome do fabricante original da peça (ex: "COFAP", "INA", "Mann Filter", "Bosch", "Gates", "Mahle"). Extraia do SKU, nome ou resultados de busca.
- montadora: nome do fabricante do veículo (montadora) para o qual esta peça foi originalmente projetada (ex: "Toyota Motor Corporation", "Volkswagen AG", "Hyundai Motor Company"). Se atende múltiplas, coloque a principal.
- cc_oem: código(s) OEM de catálogo oficial da montadora para esta peça. Um por linha separado por "\n". Ex: "58101-2BA70\nMB 012 988 17 20". Null se não encontrado.
- peso_bruto: peso bruto do produto com embalagem em kg, número decimal (ex: 0.380). Null se não encontrado.
- peso_liquido: peso líquido do produto sem embalagem em kg, número decimal (ex: 0.280). Null se não encontrado.

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
        return { ok: true, encontrado, campos, fontes_consultadas: trechos.map(t => t.fonte), pendente_confirmacao: true };
    } catch (e) {
        console.error('[Enriquecer DNA] IA:', e.message);
        return { ok: false, erro: e.message, campos: vazio, pendente_confirmacao: true };
    }
}

module.exports = { enriquecerDnaViaWeb, CAMPOS_DNA, camposVazios };
