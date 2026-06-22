import type { Product } from "./types";
import { NTC_META } from "./types";

/**
 * Motor NTC 4.0 — Nível Técnico de Cadastro.
 * Pontua a completude e confiabilidade do DNA do produto (0-100).
 * 100% local, sem cobrança de token.
 */
interface NtcCriterion {
  key: string;
  label: string;
  weight: number;
  check: (p: Product) => boolean;
}

export const NTC_CRITERIA: NtcCriterion[] = [
  { key: "sku", label: "SKU / Part Number", weight: 8, check: (p) => p.sku.trim().length >= 3 },
  { key: "fabricante", label: "Fabricante / Marca", weight: 8, check: (p) => p.fabricante.trim().length >= 2 },
  { key: "nome", label: "Nome do produto", weight: 10, check: (p) => p.nome.trim().length >= 5 },
  { key: "familia", label: "Família técnica", weight: 7, check: (p) => p.familia.trim().length > 0 },
  { key: "oem", label: "Código OEM (montadora)", weight: 14, check: (p) => p.oem.trim().length >= 4 },
  { key: "ncm", label: "NCM (8 dígitos)", weight: 12, check: (p) => /^\d{8}$/.test(p.ncm.replace(/\D/g, "")) },
  { key: "ean", label: "EAN / GTIN", weight: 12, check: (p) => /^\d{8,14}$/.test(p.ean.replace(/\D/g, "")) },
  { key: "motor", label: "Motor / Aplicação veicular", weight: 10, check: (p) => p.motor.trim().length >= 3 },
  { key: "material", label: "Material / Composição", weight: 5, check: (p) => p.material.trim().length >= 3 },
  { key: "dimensoes", label: "Dimensões / Peso", weight: 4, check: (p) => p.dimensoes.trim().length >= 2 },
  { key: "crossCodes", label: "Cross-codes (equivalentes)", weight: 4, check: (p) => p.crossCodes.length > 0 },
  { key: "images", label: "Imagem do produto", weight: 4, check: (p) => p.images.length > 0 },
  { key: "descricao", label: "Descrição técnica", weight: 2, check: (p) => p.descricao.trim().length >= 40 },
];

const TOTAL_WEIGHT = NTC_CRITERIA.reduce((s, c) => s + c.weight, 0);

export function calcNtc(p: Product): number {
  const earned = NTC_CRITERIA.filter((c) => c.check(p)).reduce((s, c) => s + c.weight, 0);
  return Math.round((earned / TOTAL_WEIGHT) * 100);
}

export function missingCriteria(p: Product): NtcCriterion[] {
  return NTC_CRITERIA.filter((c) => !c.check(p));
}

export function canPublish(p: Product): boolean {
  return calcNtc(p) >= NTC_META;
}

export function ntcLabel(ntc: number): { label: string; tone: "success" | "warning" | "destructive" } {
  if (ntc >= NTC_META) return { label: "PRONTO", tone: "success" };
  if (ntc >= 60) return { label: "QUASE LÁ", tone: "warning" };
  return { label: "INSUFICIENTE", tone: "destructive" };
}
