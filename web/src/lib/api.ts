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
    oem: String(d.part_number_automotivo || d.codigo_oem || d.oem || ""),
    ncm: String(d.ncm || ""),
    ean: String(d.ean || ""),
    motor: String(d.aplicacao_veicular || d.motorizacao_alvo_veiculo || d.motor || ""),
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
    enriched: !!d.part_number_automotivo || !!d.codigo_oem || !!d.oem,
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
    part_number_automotivo: p.oem,
    ncm: p.ncm,
    ean: p.ean,
    aplicacao_veicular: p.motor,
    motorizacao_alvo_veiculo: p.motor,
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
  const r = await fetch(`/api/produtos/${p.id}/decisao`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisao: statusParaDecisao(status) }),
  });
  const json = await r.json();
  if (!json.ok) throw new Error(json.erro || "Falha ao atualizar status");
  return rowParaProduct(json.produto);
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
  raw: { campos: Record<string, unknown>; ntc: unknown } | null; // payload completo do backend, para o painel de resultado (hierarquia/aplicações/clones)
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
    part_number_automotivo: "oem",
    codigo_oem: "oem",
    ncm: "ncm",
    ean: "ean",
    familia_tecnica: "familia",
    aplicacao_veicular: "motor",
    motorizacao_alvo_veiculo: "motor",
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
  const raw = json.campos ? { campos: json.campos as Record<string, unknown>, ntc: json.ntc ?? null } : null;
  return { patch, sources, ntcReal, raw };
}

export interface ImagemBusca {
  url: string;
  thumb: string;
  titulo?: string;
  fonte?: string;
}

// Busca imagens reais do produto (Brave/Serper/Google Custom Search) via
// /api/imagens/buscar. Retorna [] se nenhum provedor estiver configurado —
// nesse caso `mensagem` explica o que falta configurar no Render.
export async function apiBuscarImagens(q: string): Promise<{ imagens: ImagemBusca[]; mensagem?: string }> {
  const r = await fetch(`/api/imagens/buscar?q=${encodeURIComponent(q)}`);
  const json = await r.json();
  if (!json.ok) return { imagens: [], mensagem: json.mensagem || json.erro || "Falha ao buscar imagens" };
  return { imagens: json.imagens as ImagemBusca[] };
}

export interface IntegracaoStatus {
  ok: boolean;
  configurado: boolean;
  mensagem: string;
}

export async function apiStatusWix(): Promise<IntegracaoStatus> {
  const r = await fetch("/api/wix/status");
  return r.json();
}

export async function apiStatusBling(): Promise<IntegracaoStatus> {
  const r = await fetch("/api/bling/status");
  return r.json();
}

export interface SincronizarResultado {
  ok: boolean;
  wix: { ok: boolean; id?: string; erro?: string } | null;
  bling: { ok: boolean; id?: string; erro?: string } | null;
}

// Publica um produto já aprovado no Wix Stores e no Bling V3 — leva selo NTC,
// rast-hash e categorias resolvidas automaticamente (lógica já existe no
// backend, isso só chama o endpoint combinado).
export async function apiSincronizarProduto(id: string): Promise<SincronizarResultado> {
  const r = await fetch(`/api/produtos/${id}/sincronizar`, { method: "POST" });
  return r.json();
}

export interface CategoriaResumo {
  categoria: string;
  subcategoria: string | null;
  total: number;
}

export async function apiListarCategorias(): Promise<CategoriaResumo[]> {
  const r = await fetch("/api/categorias");
  const json = await r.json();
  if (!json.ok) throw new Error(json.erro || "Falha ao listar categorias");
  return json.categorias as CategoriaResumo[];
}

export interface PerformanceSistema {
  ok: boolean;
  indice_qualidade: number;
  nivel: string;
  risco_alucinacao: boolean;
  sistema: {
    cpu_uso_pct: number;
    cpu_nucleos: number;
    mem_uso_pct: number;
    mem_total_mb: number;
    mem_livre_mb: number;
    processo_rss_mb: number;
    uptime_s: number;
  };
  internet: { online: boolean; latencia_ms?: number };
  conectividade: Record<string, boolean>;
  enriquecimento: {
    total: number;
    media_ntc: number;
    por_decisao: Record<string, number>;
    pendentes_enriquecer: number;
    taxa_erro_pct_recente: number;
    logs_recentes: number;
  };
}

export async function apiPerformance(): Promise<PerformanceSistema> {
  const r = await fetch("/api/sistema/performance");
  return r.json();
}

export interface QuotaIa {
  ok: boolean;
  configurado: boolean;
  mensagem?: string;
  provedor?: string;
  usado_hoje?: number;
  limite_diario?: number | null;
  restante?: number | null;
  percentual?: number | null;
}

// Cota diária de chamadas de IA gasta no enriquecimento DNA — mostra quanto
// já foi usado hoje e quanto resta, para o lojista calcular quantos produtos
// ainda pode cadastrar/enriquecer no dia.
export async function apiQuotaIa(): Promise<QuotaIa> {
  const r = await fetch("/api/ia/quota");
  return r.json();
}

export interface VectorResultado {
  id?: string | number;
  sku?: string;
  nome?: string;
  texto?: string;
  score?: number;
  similaridade?: number;
}

export interface BuscaWebFallback {
  ok: boolean;
  encontrado: boolean;
  erro?: string | null;
  campos?: Record<string, unknown>;
}

export interface VectorBuscaResultado {
  resultados: VectorResultado[];
  buscaWeb: BuscaWebFallback | null;
}

// Busca por similaridade no "DNA" técnico já aprendido (OEM, família/DNA,
// aplicação de motor) — usa o índice vetorial local (src/services/vector-search.js).
// Quando o índice não tem nada parecido, o backend cai automaticamente para o
// mesmo agente de DNA na Web do Enriquecimento (ver server.js fallbackWebSeVazio).
export async function apiVectorBusca(
  tipo: "oem" | "dna" | "application",
  texto: string,
): Promise<VectorBuscaResultado> {
  const endpoint = tipo === "oem" ? "/api/vector/oem" : tipo === "dna" ? "/api/vector/dna" : "/api/vector/application";
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texto, limit: 15 }),
  });
  const json = await r.json();
  if (!json.ok) throw new Error(json.erro || "Falha na busca DNA");
  return { resultados: json.resultados as VectorResultado[], buscaWeb: (json.busca_web as BuscaWebFallback) ?? null };
}

export { calcNtc };
