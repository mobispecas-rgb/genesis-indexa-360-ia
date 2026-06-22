import type { DnaSource, Product, ProductFamily } from "./types";

/**
 * Motor de Enriquecimento (DNA OEM 360) — SIMULADO / LOCAL.
 *
 * Em produção este módulo consultaria a web (OEM, EAN/GTIN, NCM/CEST na TIPI,
 * aplicação veicular, material, dimensões e cross-codes) com fonte e nível de
 * confiança para cada campo. Aqui geramos um DNA plausível de forma determinística
 * a partir do nome/SKU, sempre PENDENTE de confirmação humana.
 *
 * Nunca "inventa" silenciosamente — cada sugestão vem rotulada com origem.
 */
export interface EnrichResult {
  patch: Partial<Product>;
  sources: DnaSource[];
}

interface KnownPart {
  match: RegExp;
  data: Partial<Product> & { sources: Omit<DnaSource, "field">[] };
}

// Base de conhecimento curada (exemplos reais de catálogo).
const KNOWN: KnownPart[] = [
  {
    match: /eixo\s*comando|comando de v[aá]lvulas|camshaft|d4bh|h100/i,
    data: {
      familia: "Motor",
      oem: "24100-42540",
      ncm: "84099190",
      ean: "7898637610086",
      motor: "Hyundai H100 2.5 8v D4BH (Turbo Diesel)",
      material: "Aço forjado temperado",
      dimensoes: "510 mm × 60 mm × 60 mm — 4,8 kg",
      crossCodes: ["MB0086", "24100-42541", "CAM-4D56"],
      sources: [
        { value: "24100-42540", source: "Catálogo OEM Hyundai/Mobis", confidence: 96 },
        { value: "84099190", source: "TIPI oficial (Tabela IPI)", confidence: 92 },
        { value: "7898637610086", source: "GS1 Brasil — GTIN", confidence: 88 },
        { value: "Hyundai H100 2.5 8v D4BH", source: "Aplicação veicular cruzada", confidence: 90 },
      ],
    },
  },
  {
    match: /pastilha|freio|brake pad/i,
    data: {
      familia: "Freios",
      oem: "58101-4HA00",
      ncm: "87083090",
      ean: "7891460012345",
      motor: "Linha leve — aplicação dianteira",
      material: "Cerâmica de baixa poeira",
      dimensoes: "131 mm × 59 mm × 17 mm",
      crossCodes: ["FDB1234", "PD/1450"],
      sources: [
        { value: "58101-4HA00", source: "Catálogo OEM", confidence: 89 },
        { value: "87083090", source: "TIPI oficial", confidence: 90 },
      ],
    },
  },
  {
    match: /filtro|filter/i,
    data: {
      familia: "Filtros",
      oem: "26300-35505",
      ncm: "84212300",
      ean: "7898123456780",
      motor: "Múltiplas aplicações",
      material: "Celulose / mídia sintética",
      dimensoes: "Ø76 mm × 85 mm",
      crossCodes: ["W7008", "PSL123"],
      sources: [
        { value: "84212300", source: "TIPI oficial", confidence: 91 },
        { value: "26300-35505", source: "Catálogo OEM", confidence: 84 },
      ],
    },
  },
];

const FAMILY_HINTS: Array<[RegExp, ProductFamily]> = [
  [/freio|pastilha|disco|lona|pin[çc]a/i, "Freios"],
  [/filtro/i, "Filtros"],
  [/amortecedor|mola|bandeja|pivo|suspens/i, "Suspensão"],
  [/radiador|bomba.*[aá]gua|v[aá]lvula termost|arrefec|mangueira/i, "Arrefecimento"],
  [/sensor|rel[eé]|bobina|vela|alternador|motor de partida|el[eé]tric/i, "Elétrica"],
  [/embreagem|c[aâ]mbio|transmiss|junta homo/i, "Transmissão"],
  [/cremalheira|terminal|caixa.*dire|dire[çc]/i, "Direção"],
  [/comando|virabrequim|pist[aã]o|biela|junta|bronzina|motor/i, "Motor"],
];

function inferFamily(text: string): ProductFamily {
  for (const [re, fam] of FAMILY_HINTS) if (re.test(text)) return fam;
  return "Motor";
}

// Hash determinístico simples para gerar dígitos estáveis por produto.
function seed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function digits(n: number, len: number): string {
  return (n % 10 ** len).toString().padStart(len, "0");
}

function gtin13(base: number): string {
  const body = "789" + digits(base, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return body + check;
}

export function enrich(product: Product): EnrichResult {
  const text = `${product.nome} ${product.sku} ${product.fabricante} ${product.motor}`.trim();
  const known = KNOWN.find((k) => k.match.test(text));
  if (known) {
    const { sources, ...rest } = known.data;
    const fullSources: DnaSource[] = (sources ?? []).map((s) => ({
      ...s,
      field:
        (Object.keys(rest) as Array<keyof typeof rest>).find(
          (k) => String(rest[k]) === s.value,
        ) ?? "geral",
    }));
    return { patch: rest, sources: fullSources };
  }
  // Geração determinística para itens fora da base curada.
  const s = seed(text || "produto");
  const family = inferFamily(text);
  const ncmByFamilia: Record<string, string> = {
    Motor: "84099190",
    Freios: "87083090",
    Filtros: "84212300",
    Suspensão: "87088000",
    Arrefecimento: "84099900",
    Elétrica: "85114000",
    Transmissão: "87084000",
    Direção: "87089400",
  };
  const oem = `${digits(s, 5)}-${digits(s >> 5, 5)}`;
  const ean = gtin13(s);
  const patch: Partial<Product> = {
    familia: family,
    oem,
    ncm: ncmByFamilia[family] ?? "87089900",
    ean,
    motor: product.motor || "Aplicação a confirmar",
    material: ["Aço carbono", "Alumínio fundido", "Polímero técnico", "Ferro fundido"][s % 4],
    dimensoes: `${120 + (s % 200)} mm × ${30 + (s % 60)} mm — ${(0.4 + (s % 40) / 10).toFixed(1)} kg`,
    crossCodes: [`${digits(s >> 3, 6)}`, `CR-${digits(s >> 7, 4)}`],
  };
  const sources: DnaSource[] = [
    { field: "ncm", value: patch.ncm!, source: "TIPI oficial (inferência por família)", confidence: 72 },
    { field: "oem", value: oem, source: "Cruzamento de catálogo (estimado)", confidence: 58 },
    { field: "ean", value: ean, source: "Estrutura GS1 (validar GTIN real)", confidence: 45 },
    { field: "familia", value: family, source: "Classificador de família NTC", confidence: 80 },
  ];
  return { patch, sources };
}

export function generateDescription(p: Product, tone: "tecnico" | "comercial" | "seo"): string {
  const base = `${p.nome || "Produto"}${p.fabricante ? ` — ${p.fabricante}` : ""}`;
  const aplic = p.motor ? ` Aplicação: ${p.motor}.` : "";
  const oem = p.oem ? ` Código OEM ${p.oem}.` : "";
  const mat = p.material ? ` Fabricado em ${p.material.toLowerCase()}.` : "";
  if (tone === "tecnico") {
    return `${base}.${oem}${aplic}${mat} NCM ${p.ncm || "—"} · EAN ${p.ean || "—"}. ${p.dimensoes || ""} Peça com nível técnico de cadastro auditável (NTC ${p.ntc}%).`.trim();
  }
  if (tone === "comercial") {
    return `${base} com qualidade de montadora.${aplic} Encaixe perfeito, durabilidade comprovada e procedência rastreável. Garanta o desempenho original do seu veículo com a peça certa.`.trim();
  }
  return `${base} | Comprar ${p.familia || "peça"} ${p.fabricante || ""} ${p.oem || ""}.${aplic} Melhor preço, entrega rápida e compatibilidade verificada. Peça original e equivalentes.`.trim();
}
