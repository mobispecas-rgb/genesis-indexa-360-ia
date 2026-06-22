import type { DnaSource, Product } from "./types";
import { emptyProduct } from "./types";
import { calcNtc } from "./ntc";

// Ponte entre o frontend (web/) e o backend real (server.js + dna-enricher.js
// + ntc-engine.js). Sem isso o app fica só uma demo local — nada chega ao
// SQLite nem passa pela busca web/IA de verdade.

interface BackendProdutoRow {
  id: number;
  sku: string;
  nome: string | null;
  dados: Record<string, unknown>;
  ntc: number | null; // 0-1
  decisao: string | null; // 'APROVADO' | 'REPROVADO' | 'PENDENTE' | 'CONGELADO'
  criado_em?: string;
  atualizado_em?: string;
}

function statusParaDecisao(status: Product["status"]): string {
  if (status === "approved") return "APROVADO";
  if (status === "rejected") return "REPROVADO";
  if (status === "frozen") return "CONGELADO";
  return "PENDENTE";
}

function decisaoParaStatus(decisao: string | null): Product["status"] {
  if (decisao === "APROVADO") return "approved";
  if (decisao === "REPROVADO") return "rejected";
  if (decisao === "CONGELADO") return "frozen";
  return "pending";
}

function rowParaProduct(row: BackendProdutoRow): Product {
  const d = row.dados || {};
  const base = emptyProduct();
  const p: Product = {
    ...base,
    id: String(row.id),
    sku: row.sku || "",
    fabricante: String(d.fabricante || d.marca || ""),
    nome: row.nome || String(d.nome || ""),
    familia: (String(d.familia_tecnica || d.familia || "") as Product["familia"]) || "",
    oem: String(d.codigo_oem || d.oem || ""),
    ncm: String(d.ncm || ""),
    ean: String(d.ean || ""),
    motor: String(d.aplicacao_veicular || d.motor || ""),
    material: String(d.material || ""),
    aplicacao: String(d.aplicacao_veicular || ""),
    dimensoes: String(d.dimensoes || ""),
    preco: typeof d.preco === "number" ? d.preco : null,
    crossCodes: Array.isArray(d.cc_oem) ? (d.cc_oem as string[]) : Array.isArray(d.crossCodes) ? (d.crossCodes as string[]) : [],
    descricao: String(d.descricao || ""),
    images: Array.isArray(d.images) ? (d.images as string[]) : [],
    ntc: row.ntc != null ? Math.round(row.ntc * 100) : 0,
    status: decisaoParaStatus(row.decisao),
    createdAt: row.criado_em ? new Date(row.criado_em).getTime() : base.createdAt,
    updatedAt: row.atualizado_em ? new Date(row.atualizado_em).getTime() : base.updatedAt,
    enriched: !!d.codigo_oem || !!d.oem,
    dnaSources: [],
  };
  return p;
}

function productParaDados(p: Product): Record<string, unknown> {
  return {
    nome: p.nome,
    fabricante: p.fabricante,
    marca: p.fabricante,
    familia_tecnica: p.familia,
    codigo_oem: p.oem,
    ncm: p.ncm,
    ean: p.ean,
    aplicacao_veicular: p.motor,
    material: p.material,
    dimensoes: p.dimensoes,
    preco: p.preco,
    cc_oem: p.crossCodes,
    descricao: p.descricao,
    images: p.images,
  };
}

export async function apiListarProdutos(): Promise<Product[]> {
  const r = await fetch("/api/produtos?limite=200");
  const json = await r.json();
  if (!json.ok) throw new Error(json.erro || "Falha ao listar produtos");
  return (json.produtos as BackendProdutoRow[]).map(rowParaProduct);
}

export async function apiSalvarProduto(p: Product): Promise<Product> {
  const r = await fetch("/api/produtos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku: p.sku, dados: productParaDados(p), fonte: "manual" }),
  });
  const json = await r.json();
  if (!json.ok) throw new Error(json.erro || "Falha ao salvar produto");
  return rowParaProduct(json.produto);
}

export async function apiAtualizarStatus(p: Product, status: Product["status"]): Promise<Product> {
  const r = await fetch("/api/produtos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku: p.sku, dados: productParaDados(p), fonte: "manual" }),
  });
  const json = await r.json();
  if (!json.ok) throw new Error(json.erro || "Falha ao atualizar status");
  // O backend recalcula a decisão via NTC 4.0; status manual (congelar) é só local
  // até existir um endpoint de override — refletimos a intenção mesmo assim.
  const saved = rowParaProduct(json.produto);
  return { ...saved, status: status === "frozen" ? "frozen" : saved.status };
}

export async function apiExcluirProduto(id: string): Promise<void> {
  const r = await fetch(`/api/produtos/${id}`, { method: "DELETE" });
  const json = await r.json();
  if (!json.ok) throw new Error(json.erro || "Falha ao excluir produto");
}

export interface EnrichApiResult {
  patch: Partial<Product>;
  sources: DnaSource[];
  ntcReal: number | null; // 0-100, calculado pelo Motor NTC 4.0 real (não o cálculo local de ntc.ts)
}

// Busca DNA real na web (Serper/DuckDuckGo + IA) via dna-enricher.js. Cada
// campo retornado já vem com fonte e nível de confiança — nunca inventa.
export async function apiEnriquecerDna(p: Product): Promise<EnrichApiResult> {
  const r = await fetch("/api/motor/enriquecer-dna", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku: p.sku, fabricante: p.fabricante, nome: p.nome }),
  });
  const json = await r.json();
  if (!json.ok) throw new Error(json.erro || "Falha ao buscar DNA na web");

  const patch: Partial<Product> = {};
  const sources: DnaSource[] = [];
  const campoParaProduct: Record<string, keyof Product> = {
    codigo_oem: "oem",
    ncm: "ncm",
    ean: "ean",
    familia_tecnica: "familia",
    aplicacao_veicular: "motor",
    material: "material",
    dimensoes: "dimensoes",
    descricao: "descricao",
  };

  for (const [campo, info] of Object.entries(json.campos || {})) {
    const dado = info as { valor?: unknown; fonte?: string; confianca?: string };
    if (dado.valor == null) continue;
    const key = campoParaProduct[campo];
    if (key) (patch as Record<string, unknown>)[key] = dado.valor;
    sources.push({
      field: campo,
      value: String(dado.valor),
      source: dado.fonte || "fonte não identificada",
      confidence: dado.confianca === "confirmado" ? 95 : dado.confianca === "familia" ? 70 : 40,
    });
  }

  const ntcReal = json.ntc && typeof json.ntc.ntc === "number" ? Math.round(json.ntc.ntc * 100) : null;
  return { patch, sources, ntcReal };
}

export { calcNtc };
