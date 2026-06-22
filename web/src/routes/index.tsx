import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { Boxes, CheckCircle2, Clock, XCircle, Sparkles, ArrowRight } from "lucide-react";
import { useProducts } from "@/lib/store";
import { NtcBar } from "@/components/ntc-gauge";
import { StatusBadge } from "@/components/status-badge";

export function Dashboard() {
  const products = useProducts((s) => s.products);
  const loaded = useProducts((s) => s.loaded);
  const loadFromServer = useProducts((s) => s.loadFromServer);

  useEffect(() => {
    if (!loaded) loadFromServer();
  }, [loaded, loadFromServer]);

  const total = products.length;
  const approved = products.filter((p) => p.status === "approved" || p.status === "frozen").length;
  const pending = products.filter((p) => p.status === "pending").length;
  const rejected = products.filter((p) => p.status === "rejected").length;
  const avgNtc = total ? Math.round(products.reduce((s, p) => s + p.ntc, 0) / total) : 0;

  const stats = [
    { label: "Produtos", value: total, icon: Boxes, color: "text-primary" },
    { label: "Aprovados", value: approved, icon: CheckCircle2, color: "text-success" },
    { label: "Pendentes", value: pending, icon: Clock, color: "text-warning" },
    { label: "Reprovados", value: rejected, icon: XCircle, color: "text-destructive" },
  ];

  const latest = [...products].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold md:text-3xl">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            NTC médio do catálogo: <span className="font-mono font-semibold text-foreground">{avgNtc}%</span>
          </p>
        </div>
        <Link
          to="/enriquecimento"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
        >
          <Sparkles className="h-4 w-4" />
          Enriquecer com IA
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-border bg-card p-5 transition hover:border-primary/30"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{s.label}</span>
              <s.icon className={`h-4 w-4 ${s.color}`} />
            </div>
            <div className={`mt-3 font-display text-4xl font-bold tabular-nums ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <h2 className="font-display text-base font-semibold">Últimos Produtos</h2>
            <Link
              to="/aprovacao"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Ver fila de aprovação <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {latest.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-muted-foreground">
              Nenhum produto cadastrado ainda.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-2.5 font-medium">SKU</th>
                    <th className="px-3 py-2.5 font-medium">Nome</th>
                    <th className="px-3 py-2.5 font-medium">Marca</th>
                    <th className="px-3 py-2.5 font-medium">NTC</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.map((p) => (
                    <tr key={p.id} className="border-t border-border/60 hover:bg-accent/40">
                      <td className="px-5 py-3 font-mono text-xs">{p.sku || "—"}</td>
                      <td className="max-w-[260px] truncate px-3 py-3">{p.nome}</td>
                      <td className="px-3 py-3 text-muted-foreground">{p.fabricante || "—"}</td>
                      <td className="w-32 px-3 py-3">
                        <NtcBar value={p.ntc} />
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-display text-base font-semibold">Ações Rápidas</h2>
          <div className="mt-4 space-y-2.5">
            <Link
              to="/enriquecimento"
              className="flex items-center gap-3 rounded-lg border border-border bg-background p-3 transition hover:border-primary/40"
            >
              <Sparkles className="h-5 w-5 text-primary" />
              <div>
                <div className="text-sm font-medium">Cadastrar com IA</div>
                <div className="text-xs text-muted-foreground">Buscar DNA OEM 360 na web</div>
              </div>
            </Link>
            <Link
              to="/aprovacao"
              className="flex items-center gap-3 rounded-lg border border-border bg-background p-3 transition hover:border-primary/40"
            >
              <CheckCircle2 className="h-5 w-5 text-success" />
              <div>
                <div className="text-sm font-medium">Aprovar cadastros</div>
                <div className="text-xs text-muted-foreground">{pending} pendente(s) na fila</div>
              </div>
            </Link>
          </div>
          <div className="mt-5 rounded-lg border border-border bg-background p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Motor NTC 4.0</div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              O NTC mede a completude e confiabilidade técnica de cada cadastro. Itens com{" "}
              <span className="text-success">NTC ≥ 95%</span> ficam prontos para publicação.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
