import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, Download, X, ImageOff, CheckSquare, Square } from "lucide-react";
import { useProducts } from "@/lib/store";
import { generateDescription } from "@/lib/enrich";
import { NTC_META, type Product } from "@/lib/types";
import { cn } from "@/lib/utils";

// Galeria de produtos certificados (status approved + NTC >= meta) — para o
// lojista exportar para ERP com descrição SEO já pronta, e auditar o DNA
// técnico completo (aplicações, cross-codes) antes de publicar em marketplace.
export function CatalogoCertificado() {
  const products = useProducts((s) => s.products);
  const loaded = useProducts((s) => s.loaded);
  const loadFromServer = useProducts((s) => s.loadFromServer);

  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [detalhe, setDetalhe] = useState<Product | null>(null);

  useEffect(() => {
    if (!loaded) loadFromServer();
  }, [loaded, loadFromServer]);

  const certificados = useMemo(
    () => products.filter((p) => p.status === "approved" && p.ntc >= NTC_META),
    [products],
  );

  const metricas = useMemo(() => {
    const total = products.length;
    const aprovados = products.filter((p) => p.status === "approved").length;
    const reprovados = products.filter((p) => p.status === "rejected").length;
    const mediaNtc = total ? Math.round(products.reduce((s, p) => s + p.ntc, 0) / total) : 0;
    return { total, aprovados, reprovados, mediaNtc, certificados: certificados.length };
  }, [products, certificados.length]);

  function alternarSelecao(id: string) {
    setSelecionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selecionarTodos() {
    setSelecionados(selecionados.size === certificados.length ? new Set() : new Set(certificados.map((p) => p.id)));
  }

  function exportar(formato: "csv" | "json") {
    const lista = selecionados.size > 0 ? certificados.filter((p) => selecionados.has(p.id)) : certificados;
    if (lista.length === 0) return;

    const linhas = lista.map((p) => ({
      sku: p.sku,
      nome: p.nome,
      fabricante: p.fabricante,
      familia: p.familia,
      oem: p.oem,
      ncm: p.ncm,
      ean: p.ean,
      aplicacao: p.motor,
      material: p.material,
      crossCodes: p.crossCodes.join(", "),
      preco: p.preco,
      ntc: p.ntc,
      descricao_seo: generateDescription(p, "seo"),
      imagem_principal: p.images[0] || "",
    }));

    let blob: Blob;
    let nomeArquivo: string;
    if (formato === "json") {
      blob = new Blob([JSON.stringify(linhas, null, 2)], { type: "application/json" });
      nomeArquivo = "catalogo-certificado.json";
    } else {
      const colunas = Object.keys(linhas[0]);
      const csv = [colunas.join(";"), ...linhas.map((l) => colunas.map((c) => String((l as Record<string, unknown>)[c] ?? "").replace(/;/g, ",")).join(";"))].join("\n");
      blob = new Blob([csv], { type: "text/csv" });
      nomeArquivo = "catalogo-certificado.csv";
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nomeArquivo;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-5 flex items-center gap-2">
        <BadgeCheck className="h-5 w-5 text-primary" />
        <h1 className="font-display text-2xl font-bold md:text-3xl">Catálogo Certificado</h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Produtos já aprovados com NTC ≥ {NTC_META}% — prontos para publicação/exportação para o ERP, com descrição SEO
        técnica gerada automaticamente.
      </p>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Metric label="Certificados" value={String(metricas.certificados)} />
        <Metric label="Total cadastrado" value={String(metricas.total)} />
        <Metric label="Aprovados" value={String(metricas.aprovados)} />
        <Metric label="Reprovados" value={String(metricas.reprovados)} />
        <Metric label="NTC médio" value={`${metricas.mediaNtc}%`} />
      </div>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <button
          onClick={selecionarTodos}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {selecionados.size === certificados.length && certificados.length > 0 ? (
            <CheckSquare className="h-4 w-4" />
          ) : (
            <Square className="h-4 w-4" />
          )}
          {selecionados.size > 0 ? `${selecionados.size} selecionado(s)` : "Selecionar todos"}
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => exportar("csv")}
            disabled={certificados.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:border-primary/40 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> Exportar CSV
          </button>
          <button
            onClick={() => exportar("json")}
            disabled={certificados.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:border-primary/40 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> Exportar JSON
          </button>
        </div>
      </div>

      {certificados.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-5 py-12 text-center text-sm text-muted-foreground">
          Nenhum produto certificado ainda — aprove produtos com NTC ≥ {NTC_META}% na tela de Aprovação.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {certificados.map((p) => (
            <div
              key={p.id}
              className={cn(
                "group relative overflow-hidden rounded-xl border bg-card transition",
                selecionados.has(p.id) ? "border-primary ring-1 ring-primary/30" : "border-border hover:border-primary/40",
              )}
            >
              <button
                onClick={() => alternarSelecao(p.id)}
                className="absolute left-2 top-2 z-10 rounded-md bg-background/80 p-1 backdrop-blur"
              >
                {selecionados.has(p.id) ? (
                  <CheckSquare className="h-4 w-4 text-primary" />
                ) : (
                  <Square className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
              <button onClick={() => setDetalhe(p)} className="block w-full text-left">
                <div className="flex aspect-square items-center justify-center bg-muted/30">
                  {p.images[0] ? (
                    <img src={p.images[0]} alt={p.nome} className="h-full w-full object-cover" />
                  ) : (
                    <ImageOff className="h-8 w-8 text-muted-foreground/50" />
                  )}
                </div>
                <div className="p-3">
                  <div className="truncate text-sm font-medium">{p.nome || "(sem nome)"}</div>
                  <div className="mt-0.5 font-mono text-xs text-muted-foreground">{p.sku}</div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{p.familia || "—"}</span>
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-semibold text-success">
                      {p.ntc}%
                    </span>
                  </div>
                </div>
              </button>
            </div>
          ))}
        </div>
      )}

      {detalhe && <DetalheModal produto={detalhe} onClose={() => setDetalhe(null)} />}
    </div>
  );
}

function DetalheModal({ produto, onClose }: { produto: Product; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl border border-border bg-card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold">{produto.nome || "(sem nome)"}</h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-muted/40">
            <X className="h-4 w-4" />
          </button>
        </div>

        {produto.images.length > 0 && (
          <div className="mb-4 flex gap-2 overflow-x-auto">
            {produto.images.map((url, i) => (
              <img key={i} src={url} alt="" className="h-24 w-24 shrink-0 rounded-lg object-cover" />
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Campo label="SKU" value={produto.sku} />
          <Campo label="Fabricante" value={produto.fabricante} />
          <Campo label="Família" value={produto.familia} />
          <Campo label="Código OEM" value={produto.oem} />
          <Campo label="NCM" value={produto.ncm} />
          <Campo label="EAN" value={produto.ean} />
          <Campo label="Aplicação/Motor" value={produto.motor} />
          <Campo label="Material" value={produto.material} />
          <Campo label="Dimensões" value={produto.dimensoes} />
          <Campo label="NTC" value={`${produto.ntc}%`} />
        </div>

        {produto.crossCodes.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 text-xs font-semibold text-muted-foreground">Cross-codes / Cambiados</div>
            <div className="flex flex-wrap gap-1.5">
              {produto.crossCodes.map((c, i) => (
                <span key={i} className="rounded-full bg-muted/40 px-2 py-0.5 font-mono text-xs">
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4">
          <div className="mb-1 text-xs font-semibold text-muted-foreground">Descrição SEO (gerada)</div>
          <p className="rounded-lg border border-border bg-background p-3 text-xs leading-relaxed text-muted-foreground">
            {generateDescription(produto, "seo")}
          </p>
        </div>
      </div>
    </div>
  );
}

function Campo({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value || "—"}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 text-center">
      <div className="font-display text-xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
