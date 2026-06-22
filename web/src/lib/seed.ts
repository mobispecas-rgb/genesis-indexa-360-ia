import { emptyProduct, type Product } from "./types";
import { calcNtc } from "./ntc";
import { useProducts } from "./store";

const SEED_FLAG = "irollo360-seeded";

const raw: Array<Partial<Product>> = [
  {
    sku: "MB0086",
    fabricante: "TRIMGO",
    nome: "Eixo Comando de Válvulas Hyundai H100 2.5 8v D4BH",
    familia: "Motor",
    oem: "24100-42540",
    ncm: "84099190",
    ean: "7898637610086",
    motor: "Hyundai H100 2.5 8v D4BH (Turbo Diesel)",
    material: "Aço forjado temperado",
    dimensoes: "510 mm × 60 mm × 60 mm — 4,8 kg",
    crossCodes: ["24100-42541", "CAM-4D56"],
    descricao:
      "Eixo Comando de Válvulas TRIMGO para Hyundai H100 2.5 8v D4BH. Código OEM 24100-42540. Aço forjado temperado, encaixe direto.",
    images: ["📦"],
    status: "approved",
    enriched: true,
  },
  {
    sku: "FRN-2210",
    fabricante: "Bosch",
    nome: "Pastilha de Freio Dianteira Hyundai HB20 1.6",
    familia: "Freios",
    oem: "58101-1RA00",
    ncm: "87083090",
    ean: "7891460019221",
    motor: "Hyundai HB20 1.6 (2013-2019)",
    material: "Cerâmica de baixa poeira",
    dimensoes: "131 mm × 59 mm × 17 mm",
    crossCodes: ["FDB4321"],
    status: "pending",
    enriched: true,
  },
  {
    sku: "FLT-7008",
    fabricante: "Mann",
    nome: "Filtro de Óleo Hyundai Tucson 2.0",
    familia: "Filtros",
    oem: "26300-35505",
    ncm: "84212300",
    ean: "",
    motor: "Hyundai Tucson 2.0 16v",
    material: "Celulose / mídia sintética",
    dimensoes: "",
    status: "pending",
    enriched: true,
  },
  {
    sku: "SUS-9931",
    fabricante: "Cofap",
    nome: "Amortecedor Dianteiro Kia Sportage",
    familia: "Suspensão",
    oem: "",
    ncm: "",
    ean: "",
    motor: "Kia Sportage 2.0",
    material: "",
    status: "pending",
    enriched: false,
  },
];

export function seedIfEmpty() {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(SEED_FLAG)) return;
  const store = useProducts.getState();
  if (store.products.length > 0) {
    localStorage.setItem(SEED_FLAG, "1");
    return;
  }
  for (const r of raw) {
    const p = { ...emptyProduct(), ...r } as Product;
    p.ntc = calcNtc(p);
    store.upsert(p);
  }
  localStorage.setItem(SEED_FLAG, "1");
}
