import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  XCircle,
  Snowflake,
  Trash2,
  Pencil,
  Search,
  ListFilter,
} from "lucide-react";
import { useProducts } from "@/lib/store";
import { seedIfEmpty } from "@/lib/seed";
import type { Product, ProductStatus } from "@/lib/types";
import { missingCriteria } from "@/lib/ntc";
import { NtcBar, NtcGauge } from "@/components/ntc-gauge";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

type Filter = "all" | ProductStatus;

const filters: { key: Filter; label: string }[] = [
  { key: "all", label: "Todos" },
  { key: "pending", label: "Pendentes" },
  { key: "approved", label: "Aprovados" },
  { key: "frozen", label: "Congelados" },
  { key: "rejected", label: "Reprovados" },
];

export function Aprovacao() {
  const products = useProducts((s) => s.products);
  const setStatus = useProducts((s) => s.setStatus);
  const bulkStatus = useProducts((s) => s.bulkStatus);
  const remove = useProducts((s) => s.remove);
  const navigate = useNavigate();

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    seedIfEmpty();
  }, []);

  const list = useMemo(() => {
    return products
      .filter((p) => (filter === "all" ? true : p.status === filter))
      .filter((p) =>
        query
          ? `${p.nome} ${p.sku} ${p.fabricante} ${p.oem}`.toLowerCase().includes(query.toLowerCase())
          : true,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [products, filter, query]);

  const active = products.find((p) => p.id === activeId) ?? null;
  const allSelected = list.length > 0 && selected.length === list.length;

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function toggleAll() {
    setSelected(allSelected ? [] : list.map((p) => p.id));
  }

  function act(status: ProductStatus, id?: string) {
    if (id) {
      setStatus(id, status);
    } else {
      if (selected.length === 0) return toast.error("Selecione ao menos um produto.");
      bulkStatus(selected, status);
      setSelected([]);
    }
    toast.success(`Status atualizado para "${status}".`);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-5 flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-success" />
        <h1 className="font-display text-2xl font-bold md:text-3xl">Aprovação &amp; NTC</h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Revise os produtos enriquecidos pelo Motor NTC 4.0, aprove ou reprove. Sem cobrança de token —
        100% local e auditável.
      </p>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 rounded-xl border border-border bg-card">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar SKU, nome, OEM…"
                className="w-full rounded-lg border border-input bg-background py-2 pl-8 pr-3 text-sm outline-none focus:border-primary/60"
              />
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1">
              <ListFilter className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
              {filters.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition",
                    filter === f.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {/* Bulk bar */}
          {selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent/40 px-3 py-2 text-sm">
              <span className="text-xs text-muted-foreground">{selected.length} selecionado(s)</span>
              <button
                onClick={() => act("approved")}
                className="inline-flex items-center gap-1 rounded-md bg-success/15 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/25"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Aprovar
              </button>
              <button
                onClick={() => act("rejected")}
                className="inline-flex items-center gap-1 rounded-md bg-destructive/15 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/25"
              >
                <XCircle className="h-3.5 w-3.5" /> Reprovar
              </button>
              <button
                onClick={() => act("frozen")}
                className="inline-flex items-center gap-1 rounded-md bg-info/15 px-2.5 py-1 text-xs font-medium text-info hover:bg-info/25"
              >
                <Snowflake className="h-3.5 w-3.5" /> Congelar
              </button>
            </div>
          )}
          {/* Table */}
          {list.length === 0 ? (
            <p className="px-5 py-16 text-center text-sm text-muted-foreground">
              Nenhum produto nesta visão.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2.5">
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-[var(--primary)]" />
                    </th>
                    <th className="px-3 py-2.5 font-medium">Nome / SKU</th>
                    <th className="px-3 py-2.5 font-medium">Marca</th>
                    <th className="px-3 py-2.5 font-medium">NTC</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => setActiveId(p.id)}
                      className={cn(
                        "cursor-pointer border-t border-border/60 transition hover:bg-accent/40",
                        activeId === p.id && "bg-accent/50",
                      )}
                    >
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.includes(p.id)}
                          onChange={() => toggle(p.id)}
                          className="accent-[var(--primary)]"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <div className="max-w-[260px] truncate font-medium">{p.nome}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{p.sku}</div>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{p.fabricante}</td>
                      <td className="w-32 px-3 py-3">
                        <NtcBar value={p.ntc} />
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          <IconBtn title="Aprovar" onClick={() => act("approved", p.id)} className="text-success">
                            <CheckCircle2 className="h-4 w-4" />
                          </IconBtn>
                          <IconBtn title="Reprovar" onClick={() => act("rejected", p.id)} className="text-destructive">
                            <XCircle className="h-4 w-4" />
                          </IconBtn>
                          <IconBtn
                            title="Editar / Reenriquecer"
                            onClick={() => navigate({ to: "/enriquecimento", search: { id: p.id } })}
                          >
                            <Pencil className="h-4 w-4" />
                          </IconBtn>
                          <IconBtn
                            title="Excluir"
                            onClick={() => {
                              remove(p.id);
                              if (activeId === p.id) setActiveId(null);
                            }}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </IconBtn>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {/* Detail */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <DetailPanel
            product={active}
            onApprove={() => active && act("approved", active.id)}
            onReject={() => active && act("rejected", active.id)}
            onEdit={() => active && navigate({ to: "/enriquecimento", search: { id: active.id } })}
          />
        </aside>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  className,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn("rounded-md p-1.5 transition hover:bg-background", className)}
    >
      {children}
    </button>
  );
}

function DetailPanel({
  product,
  onApprove,
  onReject,
  onEdit,
}: {
  product: Product | null;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
}) {
  if (!product) {
    return (
      <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card p-6 text-center">
        <Search className="mb-2 h-6 w-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Selecione um produto para revisar o DNA.</p>
      </div>
    );
  }

  const missing = missingCriteria(product);
  const rows: [string, string][] = [
    ["OEM", product.oem],
    ["NCM", product.ncm],
    ["EAN", product.ean],
    ["Família", product.familia],
    ["Motor", product.motor],
    ["Material", product.material],
    ["Dimensões", product.dimensoes],
  ];

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-sm font-semibold leading-snug">{product.nome}</h3>
          <p className="font-mono text-xs text-muted-foreground">{product.sku} · {product.fabricante}</p>
        </div>
        <StatusBadge status={product.status} />
      </div>
      <div className="flex justify-center">
        <NtcGauge value={product.ntc} size={120} />
      </div>
      <dl className="space-y-1.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-border/50 pb-1.5">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="truncate text-right font-mono text-foreground">{v || "—"}</dd>
          </div>
        ))}
      </dl>
      {missing.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
          <div className="text-xs font-semibold text-warning">Pendências NTC</div>
          <ul className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
            {missing.slice(0, 5).map((c) => (
              <li key={c.key}>• {c.label}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onApprove}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-success px-3 py-2 text-sm font-semibold text-success-foreground transition hover:opacity-90"
        >
          <CheckCircle2 className="h-4 w-4" /> Aprovar
        </button>
        <button
          onClick={onReject}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive transition hover:bg-destructive/20"
        >
          <XCircle className="h-4 w-4" /> Reprovar
        </button>
      </div>
      <button
        onClick={onEdit}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium transition hover:border-primary/40"
      >
        <Pencil className="h-4 w-4" /> Editar / Reenriquecer
      </button>
    </div>
  );
}
