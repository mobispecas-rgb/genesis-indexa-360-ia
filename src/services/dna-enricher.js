'use strict';

// Agente de Enriquecimento de DNA via Web — usa o Gemini com Grounding nativo
// (Google Search em tempo real) para preencher os campos dos módulos
// CO/AV/FM/MC/FP do NTC (código OEM, EAN/GTIN, NCM/CEST, aplicação veicular,
// material, dimensões, FMSI etc.) e devolve, para cada campo, o valor, a fonte
// (URL) e a confiança (alta/media/baixa). NUNCA inventa: sem fonte, o campo
// volta null com confiança "baixa" e motivo "fonte não encontrada". EAN passa
// por checksum GTIN e NCM precisa ter 8 dígitos — senão é marcado para
// confirmação fiscal. Resultado sempre "pendente_confirmacao": nuhnca auto-aprova.
const { validarGTIN, validarNCM, consultarNCMOficial } = require('./web-utils');

const CAMPOS_DNA = [
    'codigo_oem', 'ean', 'ncm', 'cest', 'motor', 'codigo_motor',
    'marca_veiculo', 'modelo_veiculo', 'versao_veiculo', 'ano_inicial', 'ano_final',
    'cilindrada', 'material', 'posicao', 'fmsi', 'comprimento', 'largura', 'altura',
    'cross_codes', 'aplicacoes_adicionais',
    // NTC completo — módulos EC, BTA, LG, FI, CC-OEM
    'funcao_tecnica', 'boletins', 'substituicoes',
    'fabricante_original', 'montadora',
    'cc_oem', 'cc_importadores', 'peso_bruto', 'peso_liquido'
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

    if (!process.env.GEMINI_API_KEY) {
        return { ok: false, erro: 'GEMINI_API_KEY não configurada', campos: vazio, pendente_confirmacao: true };
    }

    const termoBase = [fabricante, sku, nome].filter(Boolean).join(' ');

    try {
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: `Produto: ${termoBase}\n\nUse o buscador do Google (Grounding) para encontrar o catálogo oficial da marca, lojas especializadas, marketplaces e fichas técnicas sobre esse produto, e então preencha o JSON conforme as instruções do sistema.`,
            config: {
                tools: [{ googleSearch: {} }],
                systemInstruction: `Você é um especialista técnico e fiscal em autopeças automotivas. Vai receber o nome/marca/SKU de um produto. Use OBRIGATORIAMENTE o buscador do Google (Grounding) para localizar evidências reais na web antes de responder — não responda de memória.

Sua tarefa: para CADA campo abaixo, procurar evidência EXPLÍCITA nas páginas encontradas pela busca e retornar um objeto {"valor": ..., "fonte_url": "https://...", "confianca": "alta"|"media"|"baixa", "motivo": "..."}. "motivo" é opcional, exceto para "cc_oem" e "fabricante_original" quando "confianca" não for "alta" (ver REGRA 7). "fonte_url" deve ser a URL real da página onde o valor foi encontrado; se "valor" for null, "fonte_url" também deve ser null.

Campos:
- codigo_oem: código OEM / part number de referência do fabricante do veículo
- ean: código EAN/GTIN do produto (8, 12, 13 ou 14 dígitos numéricos)
- ncm: código NCM (8 dígitos numéricos)
- cest: código CEST (formato NN.NNN.NN), se aplicável
- motor: aplicação de motor/veículo (texto livre, ex: "1.0 12V Flex")
- codigo_motor: código interno do motor (ex: "EA211", "1GD-FTV", "D4BH", "J2"). Para Hyundai HR procure "D4BH". Para Kia Bongo procure "J2". Verifique a aplicação completa nos resultados — muitas lojas incluem o código do motor na descrição
- marca_veiculo: marca do veículo de aplicação (ex: "Toyota")
- modelo_veiculo: modelo do veículo (ex: "Hilux")
- versao_veiculo: versão/trim do veículo (ex: "SRV", "SR", "STD GL", "LX"). PRESTE ATENÇÃO a padrões como "CHASSIS ALTO STD GL", "LONGUE DECK STD" nos resultados de autopeças — extraia a versão da string de aplicação completa
- ano_inicial: ano inicial de aplicação (número de 4 dígitos)
- ano_final: ano final de aplicação (número de 4 dígitos)
- cilindrada: cilindrada em cm³ (número)
- material: material/composição da peça
- posicao: posição de montagem (ex: "Dianteiro", "Traseiro Esquerdo")
- fmsi: código de referência FMSI (padrão usado em pastilhas/lonas de freio)
- comprimento: comprimento em cm (número)
- largura: largura em cm (número)
- altura: altura em cm (número)
- cross_codes: códigos equivalentes/substitutos (cross-reference) desta peça em OUTRAS marcas aftermarket. PRESTE ATENÇÃO ESPECIAL a seções com títulos como "Similares", "Similar", "Equivalentes", "Cross-reference", "Substitutos", "Aplicação", ou padrões como "MARCA CÓDIGO · MARCA CÓDIGO" nos trechos. Ex de padrão a detectar: "Similares> AC31146 - NAKATA 42835 - CORVEN N444128 - KYB 543104F000" → extrair NAKATA 42835; CORVEN N444128; KYB 543104F000. Use as marcas adequadas à categoria — filtros (Fram, Mann, Mahle, Wega, Tecfil), correias/rolamentos (Gates, Dayco, INA, SKF, ContiTech), freios (TRW, Frasle, Bosch), amortecedores (Nakata, Monroe, Gabriel, Sachs, KYB), ignição (NGK, Bosch). Formato: string com itens "MARCA CÓDIGO" separados por "; "
- aplicacoes_adicionais: MUITOS produtos (filtros, correias, pastilhas etc.) servem para vários veículos/motores/anos diferentes — não apenas um. Os campos marca_veiculo/modelo_veiculo/versao_veiculo/motor/codigo_motor/cilindrada/ano_inicial/ano_final acima devem trazer a aplicação MAIS REPRESENTATIVA (ex: a mais citada nos resultados ou a primeira/principal). Todas as OUTRAS aplicações encontradas (combinações diferentes de marca/modelo/motor/ano) devem ser listadas aqui. Formato: string com uma aplicação por linha (separadas por "\n"), no padrão "Marca Modelo Motor (AnoInicial-AnoFinal)" (ex: "Jeep Compass 2.0 16V Flex (2017-2023)\nJeep Renegade 1.8 16V Flex (2015-2022)\nJeep Commander 1.3 Turbo Flex (2022-2024)").
- funcao_tecnica: descrição técnica da função da peça em 1-2 frases claras (ex: "Absorve impactos e vibrações da suspensão dianteira, garantindo estabilidade e conforto." ou "Filtra impurezas do óleo lubrificante, protegendo o motor contra desgaste prematuro.")
- boletins: boletins técnicos do fabricante, homologações ou normas aplicáveis. Um item por linha separado por "\n". Ex: "Homologado VW AG\nAtende norma ABNT NBR 6560\nBoletim COFAP BT-2022-014". Null se não houver evidência.
- substituicoes: códigos de peças substituídas ou substitutas (mesmo fit). Um código por linha separado por "\n". Null se não houver.
- fabricante_original: nome do fabricante original da peça (ex: "COFAP", "INA", "Mann Filter", "Bosch", "Gates", "Mahle"). Extraia do SKU, nome ou resultados de busca.
- montadora: nome do fabricante do veículo (montadora) para o qual esta peça foi originalmente projetada (ex: "Toyota Motor Corporation", "Volkswagen AG", "Hyundai Motor Company"). Se atende múltiplas, coloque a principal.
- cc_oem: código(s) OEM de catálogo oficial da montadora para esta peça. PRESTE ATENÇÃO ao padrão "CÓDIGO - OE" nos resultados (ex: "543104F000 - OE" ou "KYB 543104F000 - OE"), que indica o código OEM original da montadora. Também verifique URLs de produtos que contenham o código no slug (ex: ".../b50994m-ac31146-543104f000"). Um código por linha separado por "\n". Ex: "58101-2BA70\n543104F000". Null se não encontrado.
- cc_importadores: código(s) usados por IMPORTADORES/DISTRIBUIDORES PARALELOS para anunciar esta MESMA peça (caso (d) do CONTEXTO — DNA GENEALÓGICO abaixo: "IMPORTADOS COM CÓDIGO ADULTERADO") — ex: códigos próprios de importadoras de peças chinesas/genéricas, ou códigos de catálogo de distribuidoras paralelas (não fabricantes certificados) que revendem essa peça. Esta é uma GAVETA SEPARADA de cc_oem (código oficial da montadora) e de cross_codes (fabricantes aftermarket reconhecidos como Nakata, Gates, INA etc.) — NÃO repita aqui códigos já listados em cc_oem ou cross_codes. Um código por linha separado por "\n". Ex: "NYTRON-BR-KIT9063\nIMP-58101-CN". Null se não encontrado.
- peso_bruto: peso bruto do produto com embalagem em kg, número decimal (ex: 0.380). Null se não encontrado.
- peso_liquido: peso líquido do produto sem embalagem em kg, número decimal (ex: 0.280). Null se não encontrado.

CONTEXTO — DNA GENEALÓGICO AUTOMOTIVO (peça original × clone certificado × veículo-irmão × clone aftermarket × importado com código adulterado):
Toda peça nasce de um projeto de uma montadora para um veículo específico (código OEM/CC-OEM original). A partir daí ela se multiplica em:
 a) CLONES CERTIFICADOS — fabricantes de autopeças licenciados/homologados pela própria montadora para produção no Brasil (ex.: COFAP, Nakata, Mahle, Bosch, Frasle, Wega, ZF, TRW, Magneti Marelli, Sabó, MTE-Thomson) fabricam a MESMA peça com qualidade homologada; cc_oem continua sendo o código da montadora, fabricante_original é o fabricante certificado.
 b) VEÍCULOS-IRMÃOS (parcerias/plataformas compartilhadas entre montadoras — "badge engineering") — a MESMA peça física atende veículos de marcas diferentes, cada um com seu próprio código OEM. Famílias conhecidas no mercado brasileiro:
    - Hyundai HR ↔ Kia Bongo K2500 (Hyundai Motor Group — motor/plataforma compartilhados)
    - Fiat Ducato ↔ Peugeot Boxer ↔ Citroën Jumper (trio Stellantis)
    - Fiat Doblo (geração antiga) ↔ Citroën Berlingo / Peugeot Partner (geração antiga)
    - Fiat Toro ↔ Jeep Compass / Renegade / Commander (plataforma Small-Wide 4x4 — Stellantis, motores Firefly/T270/T350/T370/GSE T6)
    - Ford Ranger (2ª/3ª geração) ↔ Mazda BT-50
    - Volkswagen Amarok (2ª geração, 2023+) ↔ Ford Ranger (plataforma T6.2)
    - Chevrolet S10 / TrailBlazer (motor 2.8 Duramax/4JJ) ↔ Isuzu D-Max / MU-X
    - Renault Master ↔ Nissan NV400/Interstar ↔ Opel/Vauxhall Movano (trio de furgões — Aliança Renault-Nissan)
    - Toyota Hilux ↔ Toyota Fortuner/SW4 (plataforma IMV)
 c) CLONES AFTERMARKET (cross-reference) — fabricantes independentes (Nakata, Monroe, TRW, Frasle, Gates, Dayco, INA, SKF, NGK, Fram, Mann, Mahle, Tecfil, Wega, ContiTech, KYB, Sachs, Gabriel, Corven etc.) produzem peças equivalentes SEM licença da montadora — vão para cross_codes/substituicoes.
 d) IMPORTADOS COM CÓDIGO ADULTERADO — importadores de peças genéricas (frequentemente chinesas) anunciam códigos OEM de montadoras apenas para indicar "compatibilidade/aplicação", sem a peça ser genuína, clone certificado ou aftermarket de fabricante reconhecido. Esses anúncios NÃO são fonte confiável para fabricante_original/cc_oem com confiança alta.

COMO USAR ESSE CONTEXTO (sem inventar):
- Use o conhecimento acima SOMENTE para INTERPRETAR e CONECTAR evidências que já apareceram nas páginas encontradas pela busca — ex.: se uma página diz que a peça serve "Hyundai HR 2.5 2006-2012" e outra página (do mesmo SKU ou de um cross-code já identificado) menciona "Kia Bongo K2500 2.5 2006-2012", registre AMBAS as aplicações em aplicacoes_adicionais e os respectivos códigos em cc_oem — pois fazem parte da mesma família genealógica.
- NUNCA adicione aplicação, código ou fabricante de veículo-irmão que não tenha aparecido em NENHUMA página encontrada — o conhecimento de parcerias serve para reconhecer/relacionar evidências já textuais, nunca para criar dados novos.
- Para fabricante_original, priorize fabricantes certificados/licenciados citados explicitamente (catálogos oficiais, lojas especializadas) sobre anúncios genéricos de marketplace sem menção de marca/fabricante (caso (d) acima).

REGRAS ABSOLUTAS:
1. PROIBIDO ALUCINAR OU DEDUZIR: nunca invente, estime ou deduza valores que não estejam EXPLICITAMENTE escritos nas páginas retornadas pela busca do Google.
2. Se não houver evidência clara para um campo, retorne {"valor": null, "fonte_url": null, "confianca": "baixa"}.
3. "fonte_url" é a URL real da página de onde o valor foi extraído. Se "valor" for null, "fonte_url" também deve ser null.
4. "confianca": "alta" = valor explícito e específico para este produto/SKU; "media" = valor encontrado mas para produto genérico/equivalente; "baixa" = indício fraco ou ausente.
5. Responda APENAS com um objeto JSON válido, sem markdown, sem texto adicional, com TODAS as chaves listadas acima.
6. NUNCA preencha "marca_veiculo" ou "montadora" com o nome do FABRICANTE DA PEÇA (ex: VALEO, Bosch, Mahle, NGK, TRW, Magneti Marelli, Delphi, Denso, Continental são fabricantes de autopeças — NÃO são montadoras de veículo). Esses nomes pertencem apenas a "fabricante_original". "marca_veiculo"/"montadora" só podem ser marcas de veículos (ex: Toyota, Volkswagen, Fiat, Chevrolet, Hyundai, Ford).
7. Antes de extrair "cc_oem"/"fabricante_original" com confiança "alta", avalie a fonte conforme o CONTEXTO — DNA GENEALÓGICO acima: catálogos oficiais, fabricantes certificados e lojas especializadas que citam "OEM"/"original"/"homologado" têm prioridade. Anúncios genéricos de marketplace (especialmente de peças importadas/genéricas sem marca/fabricante identificado) que apenas citam um código OEM para indicar aplicação devem entrar com confiança "media" ou "baixa", e o "motivo" deve indicar que o código pode ser de aplicação cruzada e não de origem genuína.`
            }
        });

        const texto = response.text || '{}';
        let bruto;
        try {
            const jsonMatch = texto.match(/\{[\s\S]*\}/);
            bruto = JSON.parse(jsonMatch ? jsonMatch[0] : texto);
        } catch (e) {
            bruto = {};
        }

        // Fontes citadas pelo Grounding (Google Search) na resposta — usadas
        // como "fontes_consultadas" e como fallback quando o modelo não citar
        // uma fonte_url específica para um campo.
        const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const fontesGrounding = groundingChunks.map(g => g.web?.uri).filter(Boolean);

        const campos = {};
        CAMPOS_DNA.forEach(c => {
            const item = bruto[c];
            if (!item || item.valor == null || item.valor === '') {
                campos[c] = { valor: null, fonte: null, confianca: 'baixa', motivo: 'fonte não encontrada' };
                return;
            }
            let valor = item.valor;
            const fonte = (typeof item.fonte_url === 'string' && item.fonte_url.trim()) ? item.fonte_url.trim() : null;
            let confianca = ['alta', 'media', 'baixa'].includes(item.confianca) ? item.confianca : 'media';
            let motivo = (typeof item.motivo === 'string' && item.motivo.trim()) ? item.motivo.trim() : null;

            if (c === 'ean') {
                if (!validarGTIN(valor)) { valor = null; confianca = 'baixa'; motivo = 'GTIN inválido (checksum)'; }
            }
            if (c === 'ncm') {
                const ncmLimpo = validarNCM(valor);
                if (!ncmLimpo) { confianca = 'baixa'; motivo = 'requer confirmação fiscal — NCM deve ter 8 dígitos'; }
                else valor = ncmLimpo;
            }
            campos[c] = { valor, fonte, confianca, motivo };
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
        if (!encontrado && fontesGrounding.length === 0) {
            return {
                ok: true, encontrado: false, campos: vazio, fontes_consultadas: [], pendente_confirmacao: true,
                mensagem: 'Sem resultados de busca — nenhuma fonte encontrada.'
            };
        }
        return { ok: true, encontrado, campos, fontes_consultadas: fontesGrounding, pendente_confirmacao: true };
    } catch (e) {
        console.error('[Enriquecer DNA] IA:', e.message);
        return { ok: false, erro: e.message, campos: vazio, pendente_confirmacao: true };
    }
}

module.exports = { enriquecerDnaViaWeb, CAMPOS_DNA, camposVazios };
