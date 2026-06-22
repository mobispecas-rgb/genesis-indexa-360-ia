import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Globe,
  Save,
  Trash2,
  Rocket,
  Snowflake,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ImagePlus,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useProducts } from "@/lib/store";
import { emptyProduct, FAMILIES, NTC_META, type Product, type ProductFamily } from "@/lib/types";
import { calcNtc, missingCriteria, canPublish } from "@/lib/ntc";
import { generateDescription } from "@/lib/enrich";
import { apiEnriquecerDna, apiBuscarImagens, type ImagemBusca } from "@/lib/api";
import { NtcGauge } from "@/components/ntc-gauge";
import { QuotaIaWidget } from "@/components/quota-ia-widget";
import { cn } from "@/lib/utils";

export function Enriquecimento() {
  const { id } = useSearch({ from: "/enriquecimento" }) as { id?: string };
  const navigate = useNavigate();
  const upsert = useProducts((s) => s.upsert);
  const remove = useProducts((s) => s.remove);
  const getProduct = useProducts((s) => s.get);
  const loaded = useProducts((s) => s.loaded);
  const loadFromServer = useProducts((s) => s.loadFromServer);

  const [product, setProduct] = useState<Product>(() => emptyProduct());
  const [enriching, setEnriching] = useState(false);
  const [progress, setProgress] = useState(0);
  const [tone, setTone] = useState<"tecnico" | "comercial" | "seo">("tecnico");
  const [imageResults, setImageResults] = useState<ImagemBusca[]>([]);
  const [searchingImages, setSearchingImages] = useState(false);

  useEffect(() => {
    if (!loaded) loadFromServer();
  }, [loaded, loadFromServer]);

  useEffect(() => {
    if (id) {
      const existing = getProduct(id);
      if (existing) setProduct(existing);
    }
  }, [id, getProduct, loaded]);

  const ntc = useMemo(() => calcNtc(product), [product]);
  const missing = useMemo(() => missingCriteria(product), [product]);
  const publishable = canPublish(product);

  function set<K extends keyof Product>(key: K, value: Product[K]) {
    setProduct((p) => ({ ...p, [key]: value }));
  }

  async function handleEnrich() {
    if (!product.nome && !product.sku) {
      toast.error("Informe ao menos o nome ou o SKU para buscar o DNA.");
      return;
    }
    setEnriching(true);
    setProgress(20);
    try {
      const { patch, sources, ntcReal } = await apiEnriquecerDna(product);
      setProgress(70);
      const merged: Product = {
        ...product,
        ...patch,
        enriched: true,
        dnaSources: sources,
        ntc: ntcReal ?? product.ntc,
      };
      // Com SKU + marca + nome já em mãos, a mesma ação completa também a
      // descrição (template local, só com campos confirmados) e busca as
      // imagens reais do produto — para não exigir 3 cliques separados.
      if (sources.length > 0 && !merged.descricao) {
        merged.descricao = generateDescription(merged, tone);
      }
      setProduct(merged);
      setProgress(90);
      if (sources.length > 0) {
        const query = [merged.fabricante, merged.nome, merged.oem].filter(Boolean).join(" ");
        try {
          const { imagens } = await apiBuscarImagens(query);
          if (imagens.length > 0) setImageResults(imagens);
        } catch { /* busca de imagem é complementar — não bloqueia o enriquecimento */ }
      }
      setProgress(100);
      if (sources.length === 0) {
        toast.warning("Nenhuma fonte confiável encontrada na web — sem evidência, nenhum campo foi preenchido.");
      } else {
        toast.success("DNA, descrição e imagens atualizados — confirme os dados antes de publicar.", {
          description: `${sources.length} campo(s) sugerido(s) com fonte e confiança.`,
        });
      }
    } catch (e) {
      toast.error(`Falha ao buscar DNA na web: ${(e as Error).message}`, {
        description: "Verifique se ANTHROPIC_API_KEY (e SERPER_API_KEY) estão configuradas no Render — sem elas a busca real não funciona.",
      });
    } finally {
      setEnriching(false);
    }
  }

  async function handleSave(status?: Product["status"]) {
    if (!product.nome.trim() || !product.sku.trim() || !product.fabricante.trim()) {
      toast.error("Preencha SKU, Fabricante e Nome para salvar.");
      return;
    }
    const next: Product = { ...product, status: status ?? product.status };
    try {
      const saved = await upsert(next);
      // O backend recalcula a decisão pelo Motor NTC 4.0 real; "congelar" é uma
      // intenção manual que ainda não tem persistência própria no servidor.
      setProduct(status === "frozen" ? { ...saved, status: "frozen" } : saved);
      toast.success(status === "approved" ? "Produto publicado e aprovado." : "Cadastro salvo.");
      if (!id || id !== saved.id) navigate({ to: "/enriquecimento", search: { id: saved.id } });
    } catch (e) {
      toast.error(`Falha ao salvar: ${(e as Error).message}`);
    }
  }

  function handlePublish() {
    if (!publishable) {
      toast.error(`NTC insuficiente para publicar (mínimo ${NTC_META}%).`);
      return;
    }
    handleSave("approved");
  }

  function handleFreeze() {
    if (!publishable) {
      toast.error("Congele apenas produtos com NTC suficiente.");
      return;
    }
    handleSave("frozen");
    toast.info("Produto congelado — bloqueado para edição em massa.");
  }

  async function handleDelete() {
    if (id) await remove(id);
    setProduct(emptyProduct());
    navigate({ to: "/enriquecimento", search: {} });
    toast.success("Cadastro excluído.");
  }

  async function buscarImagens() {
    if (!product.nome.trim()) {
      toast.error("Informe ao menos o nome do produto para buscar imagens.");
      return;
    }
    setSearchingImages(true);
    try {
      const query = [product.fabricante, product.nome, product.oem].filter(Boolean).join(" ");
      const { imagens, mensagem } = await apiBuscarImagens(query);
      setImageResults(imagens);
      if (imagens.length === 0) toast.warning(mensagem || "Nenhuma imagem encontrada.");
    } catch (e) {
      toast.error(`Falha ao buscar imagens: ${(e as Error).message}`);
    } finally {
      setSearchingImages(false);
    }
  }

  function addImage(url: string) {
    if (product.images.includes(url)) return;
    set("images", [...product.images, url]);
  }

  function removeImage(url: string) {
    set("images", product.images.filter((u) => u !== url));
  }

  function genDescription() {
    const d = generateDescription({ ...product, ntc }, tone);
    set("descricao", d);
    toast.success("Descrição gerada pelo template (sem inventar dados).");
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h1 className="font-display text-2xl font-bold md:text-3xl">Enriquecimento</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          DNA OEM 360 + Motor NTC 4.0. A IA busca OEM, NCM/CEST, EAN e aplicação —{" "}
          <span className="text-foreground">nunca inventa</span>, cada sugestão vem com fonte.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* NTC + ações */}
        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="grid-bg flex flex-col items-center gap-4 rounded-xl border border-border bg-card p-6">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Motor NTC 4.0</span>
            <NtcGauge value={ntc} />
            <button
              onClick={handleEnrich}
              disabled={enriching}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {enriching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
              {enriching ? `Buscando… ${progress}%` : "Buscar DNA na Web"}
            </button>
            {enriching && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
            )}
            <div className="grid w-full grid-cols-2 gap-2 text-xs">
              <Mini label="OEM" value={product.oem} />
              <Mini label="EAN" value={product.ean} />
              <Mini label="NCM" value={product.ncm} />
              <Mini label="Família" value={product.familia} />
            </div>
          </div>
          <QuotaIaWidget />
          <div className="space-y-2.5 rounded-xl border border-border bg-card p-4">
            <button
              onClick={handlePublish}
              disabled={!publishable}
              className={cn(
                "flex h-10 w-full items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition",
                publishable
                  ? "bg-success text-success-foreground hover:opacity-90"
                  : "cursor-not-allowed bg-muted text-muted-foreground",
              )}
            >
              <Rocket className="h-4 w-4" /> Publicar
            </button>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                onClick={() => handleSave()}
                className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium transition hover:border-primary/40"
              >
                <Save className="h-4 w-4" /> Salvar
              </button>
              <button
                onClick={handleFreeze}
                className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium transition hover:border-info/40"
              >
                <Snowflake className="h-4 w-4" /> Congelar
              </button>
            </div>
            <button
              onClick={handleDelete}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/20"
            >
              <Trash2 className="h-4 w-4" /> Excluir cadastro
            </button>
          </div>
          {/* O que falta */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              {publishable ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-warning" />
              )}
              <h3 className="font-display text-sm font-semibold">
                {publishable ? "Pronto para aprovação" : "O que falta para aprovação"}
              </h3>
            </div>
            {publishable ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Todos os critérios essenciais do NTC foram atendidos.
              </p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {missing.map((c) => (
                  <li key={c.key} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                    {c.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
        {/* Formulário */}
        <div className="space-y-6">
          {/* Web data */}
          {product.dnaSources.length > 0 && (
            <div className="rounded-xl border border-info/30 bg-info/5 p-4">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-info" />
                <h3 className="font-display text-sm font-semibold">
                  Dados encontrados na web — confirme antes de usar
                </h3>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {product.dnaSources.map((src, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-border bg-card px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-foreground">{src.value}</span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-semibold",
                          src.confidence >= 80
                            ? "bg-success/15 text-success"
                            : src.confidence >= 60
                              ? "bg-warning/15 text-warning"
                              : "bg-destructive/15 text-destructive",
                        )}
                      >
                        {src.confidence}%
                      </span>
                    </div>
                    <div className="mt-0.5 text-muted-foreground">{src.source}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Identificação */}
          <Section title="Identificação do Produto" step={1}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="SKU / Part Number" required>
                <input className={inputCls} value={product.sku} onChange={(e) => set("sku", e.target.value)} />
              </Field>
              <Field label="Fabricante / Marca" required>
                <input
                  className={inputCls}
                  value={product.fabricante}
                  onChange={(e) => set("fabricante", e.target.value)}
                />
              </Field>
              <Field label="Nome do Produto" required className="sm:col-span-2 lg:col-span-1">
                <input className={inputCls} value={product.nome} onChange={(e) => set("nome", e.target.value)} />
              </Field>
              <Field label="Família Técnica">
                <select
                  className={inputCls}
                  value={product.familia}
                  onChange={(e) => set("familia", e.target.value as ProductFamily)}
                >
                  <option value="">— selecione —</option>
                  {FAMILIES.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Código OEM (montadora)">
                <input className={inputCls} value={product.oem} onChange={(e) => set("oem", e.target.value)} />
              </Field>
              <Field label="NCM (8 dígitos)">
                <input
                  className={inputCls}
                  value={product.ncm}
                  maxLength={8}
                  onChange={(e) => set("ncm", e.target.value.replace(/\D/g, ""))}
                />
              </Field>
              <Field label="EAN / GTIN">
                <input
                  className={inputCls}
                  value={product.ean}
                  onChange={(e) => set("ean", e.target.value.replace(/\D/g, ""))}
                />
              </Field>
              <Field label="Motor / Aplicação">
                <input className={inputCls} value={product.motor} onChange={(e) => set("motor", e.target.value)} />
              </Field>
              <Field label="Material / Composição">
                <input
                  className={inputCls}
                  value={product.material}
                  onChange={(e) => set("material", e.target.value)}
                />
              </Field>
              <Field label="Dimensões / Peso" className="sm:col-span-2 lg:col-span-3">
                <input
                  className={inputCls}
                  value={product.dimensoes}
                  onChange={(e) => set("dimensoes", e.target.value)}
                  placeholder="ex.: 510 mm × 60 mm — 4,8 kg"
                />
              </Field>
            </div>
            {product.crossCodes.length > 0 && (
              <div className="mt-4">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">Cross-codes</span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {product.crossCodes.map((c) => (
                    <span
                      key={c}
                      className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-xs"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Section>
          {/* Imagens */}
          <Section title="Imagens do Produto" step={2}>
            <div className="flex flex-wrap gap-3">
              {product.images.map((url) => (
                <div
                  key={url}
                  className="group relative h-20 w-20 overflow-hidden rounded-lg border border-border bg-background"
                >
                  <img src={url} alt="" className="h-full w-full object-cover" />
                  <button
                    onClick={() => removeImage(url)}
                    className="absolute right-0.5 top-0.5 rounded-md bg-background/90 p-1 opacity-0 transition group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </button>
                </div>
              ))}
              <button
                onClick={buscarImagens}
                disabled={searchingImages}
                className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground transition hover:border-primary/50 hover:text-primary disabled:opacity-60"
              >
                {searchingImages ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
                <span className="text-[10px]">{searchingImages ? "Buscando…" : "Buscar na web"}</span>
              </button>
            </div>
            {imageResults.length > 0 && (
              <div className="mt-4">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Resultados — clique para adicionar
                </span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {imageResults.map((img) => (
                    <button
                      key={img.url}
                      type="button"
                      title={img.fonte}
                      onClick={() => addImage(img.url)}
                      className={cn(
                        "h-16 w-16 overflow-hidden rounded-lg border transition",
                        product.images.includes(img.url)
                          ? "border-primary ring-2 ring-primary/30"
                          : "border-border hover:border-primary/50",
                      )}
                    >
                      <img src={img.thumb || img.url} alt="" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Section>
          {/* Descrição */}
          <Section title="Voz do Lojista — Descrição IA" step={3}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {(["tecnico", "comercial", "seo"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTone(t)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition",
                    tone === t
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t === "tecnico" ? "⚙️ Técnico" : t === "comercial" ? "💼 Comercial" : "🔍 SEO"}
                </button>
              ))}
              <button
                onClick={genDescription}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold transition hover:opacity-90"
              >
                <Wand2 className="h-3.5 w-3.5" /> Gerar com Template
              </button>
            </div>
            <textarea
              className={cn(inputCls, "min-h-28 resize-y leading-relaxed")}
              value={product.descricao}
              onChange={(e) => set("descricao", e.target.value)}
              placeholder="Gera descrição técnica com base no DNA confirmado. Nunca inventa dados."
            />
          </Section>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5" />
            Reenriqueça quando atualizar fornecedores ou catálogos. Tudo é auditável (data e responsável).
          </div>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20";

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-2.5 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-xs text-foreground">{value || "—"}</div>
    </div>
  );
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-primary">*</span>}
      </span>
      {children}
    </label>
  );
}

function Section({ title, step, children }: { title: string; step: number; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/15 font-display text-xs font-bold text-primary">
          {step}
        </span>
        <h2 className="font-display text-base font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}
