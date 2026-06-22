import { useEffect, useState } from "react";
import { Gauge, AlertTriangle } from "lucide-react";
import { apiQuotaIa, type QuotaIa } from "@/lib/api";
import { cn } from "@/lib/utils";

// Mostra ao lojista quantas chamadas de IA (Gemini/Claude) já foram usadas
// hoje no enriquecimento DNA e quantas ainda restam, para calcular quantos
// produtos ainda pode cadastrar/enriquecer no dia antes de bater a cota.
export function QuotaIaWidget() {
  const [quota, setQuota] = useState<QuotaIa | null>(null);

  useEffect(() => {
    let alive = true;
    function load() {
      apiQuotaIa()
        .then((q) => alive && setQuota(q))
        .catch(() => alive && setQuota({ ok: false, configurado: false, mensagem: "Falha ao consultar cota." }));
    }
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!quota) return null;

  if (!quota.configurado) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/5 p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-warning">
          <AlertTriangle className="h-3.5 w-3.5" />
          Motor de IA não configurado
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{quota.mensagem}</p>
      </div>
    );
  }

  const pct = quota.percentual ?? 0;
  const sobrando = quota.restante;

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
          <Gauge className="h-3.5 w-3.5" /> Cota de IA hoje
        </span>
        <span className="text-xs font-medium text-foreground">{quota.provedor}</span>
      </div>
      {quota.limite_diario ? (
        <>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-border">
            <div
              className={cn(
                "h-full transition-all",
                pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-success",
              )}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {quota.usado_hoje} de {quota.limite_diario} usadas
            </span>
            <span className="font-mono font-semibold text-foreground">{sobrando} restantes</span>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Estimativa: ainda dá para enriquecer cerca de{" "}
            <span className="font-semibold text-foreground">{sobrando}</span> produto(s) hoje.
          </p>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {quota.usado_hoje} chamada(s) hoje — sem limite diário fixo configurado.
        </p>
      )}
    </div>
  );
}
