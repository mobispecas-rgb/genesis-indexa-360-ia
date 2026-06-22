export type ProductStatus = "pending" | "approved" | "rejected" | "frozen";

export type ProductFamily =
  | "Motor"
  | "Freios"
  | "Suspensão"
  | "Filtros"
  | "Arrefecimento"
  | "Elétrica"
  | "Transmissão"
  | "Direção"
  | "";

export interface DnaSource {
  field: string;
  value: string;
  source: string;
  confidence: number; // 0-100
}

export interface Product {
  id: string;
  sku: string;
  fabricante: string;
  nome: string;
  familia: ProductFamily;
  oem: string;
  ncm: string;
  ean: string;
  motor: string;
  material: string;
  aplicacao: string;
  dimensoes: string;
  preco: number | null;
  crossCodes: string[];
  descricao: string;
  images: string[];
  ntc: number;
  status: ProductStatus;
  createdAt: number;
  updatedAt: number;
  enriched: boolean;
  dnaSources: DnaSource[];
}

export const FAMILIES: ProductFamily[] = [
  "Motor",
  "Freios",
  "Suspensão",
  "Filtros",
  "Arrefecimento",
  "Elétrica",
  "Transmissão",
  "Direção",
];

export const NTC_META = 95;

export function emptyProduct(): Product {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    sku: "",
    fabricante: "",
    nome: "",
    familia: "",
    oem: "",
    ncm: "",
    ean: "",
    motor: "",
    material: "",
    aplicacao: "",
    dimensoes: "",
    preco: null,
    crossCodes: [],
    descricao: "",
    images: [],
    ntc: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    enriched: false,
    dnaSources: [],
  };
}
