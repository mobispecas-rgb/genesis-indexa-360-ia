import type { Product } from "./types";

// Geração de descrição por template local — usa só campos já confirmados no
// cadastro (nunca busca/inventa dado novo). A busca de DNA real (OEM/NCM/EAN)
// é feita pelo backend em lib/api.ts (apiEnriquecerDna), não aqui.
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
