import { useEffect, useState } from "react";
import { Activity, RefreshCw, Wifi, WifiOff, AlertTriangle } from "lucide-react";
import { apiPerformance, type PerformanceSistema } from "@/lib/api";
import { cn } from "@/lib/utils";

const NIVEL_COR: Record<string, string> = {
  ÓTIMO: "text-success",
  BOM: "text-success",
  ATENÇÃO: "text-warning",
  CRÍTICO: "text-destructive",
};

export function Performance() {
  const [data, setData] = useState<PerformanceSistema | null>(null);
  const [loading, setLoading] = useState(false);

  async function carregar() {
    setLoading(true);
    try {
      setData(await apiPerformance());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <h1 className="font-display text-2xl font-bold md:text-3xl">Performance</h1>
        </div>
        <button
          onClick={carregar}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium transition hover:border-primary/40 disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Atualizar
        </button>
      </div>

      {!data ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-muted-foreground">Índice geral de qualidade</div>
                <div className={cn("font-display text-4xl font-bold", NIVEL_COR[data.nivel] || "")}>
                  {data.indice_qualidade}
                  <span className="text-base text-muted-foreground">/100</span>
                </div>
              </div>
              <span className={cn("rounded-full border px-3 py-1 text-xs font-semibold", NIVEL_COR[data.nivel] || "")}>
                {data.nivel}
              </span>
            </div>
            {data.risco_alucinacao && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Risco de alucinação elevado — IA secundária ou internet podem estar indisponíveis.
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Metric label="CPU" value={`${data.sistema.cpu_uso_pct}%`} sub={`${data.sistema.cpu_nucleos} núcleos`} />
            <Metric label="Memória" value={`${data.sistema.mem_uso_pct}%`} sub={`${data.sistema.mem_livre_mb} MB livres`} />
            <Metric label="Uptime" value={formatUptime(data.sistema.uptime_s)} sub={`processo: ${data.sistema.processo_rss_mb} MB`} />
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              {data.internet.online ? <Wifi className="h-4 w-4 text-success" /> : <WifiOff className="h-4 w-4 text-destructive" />}
              Internet {data.internet.online ? `online — ${data.internet.latencia_ms}ms` : "offline"}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Object.entries(data.conectividade).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
                  <span className={cn("h-1.5 w-1.5 rounded-full", v ? "bg-success" : "bg-destructive")} />
                  {k}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 text-sm font-semibold">Enriquecimento</div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Produtos" value={String(data.enriquecimento.total)} />
              <Metric label="NTC médio" value={`${Math.round(data.enriquecimento.media_ntc * 100)}%`} />
              <Metric label="Pendentes" value={String(data.enriquecimento.pendentes_enriquecer)} />
              <Metric label="Taxa erro (recente)" value={`${data.enriquecimento.taxa_erro_pct_recente}%`} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-display text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
