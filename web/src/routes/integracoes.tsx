import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Loader2, Plug, RefreshCw } from "lucide-react";
import { useProducts } from "@/lib/store";
import { apiSincronizarProduto, apiStatusBling, apiStatusWix, type IntegracaoStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

type Plataforma = "wix" | "bling";

export function Integracoes() {
  const products = useProducts((s) => s.products);
  const loaded = useProducts((s) => s.loaded);
  const loadFromServer = useProducts((s) => s.loadFromServer);

  const [wix, setWix] = useState<IntegracaoStatus | null>(null);
  const [bling, setBling] = useState<IntegracaoStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) loadFromServer();
  }, [loaded, loadFromServer]);

  async function checarStatus() {
    setChecking(true);
    try {
      const [w, b] = await Promise.all([apiStatusWix(), apiStatusBling()]);
      setWix(w);
      setBling(b);
    } catch (e) {
      toast.error(`Falha ao checar integrações: ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    checarStatus();
  }, []);

  const approved = products.filter((p) => p.status === "approved");

  async function sincronizar(id: string) {
    setSyncingId(id);
    try {
      const r = await apiSincronizarProduto(id);
      const partes: string[] = [];
      if (r.wix) partes.push(r.wix.ok ? "Wix: publicado" : `Wix: ${r.wix.erro}`);
      if (r.bling) partes.push(r.bling.ok ? "Bling: publicado" : `Bling: ${r.bling.erro}`);
      const sucesso = (r.wix?.ok ?? false) || (r.bling?.ok ?? false);
      if (sucesso) toast.success(partes.join(" · "));
      else toast.error(partes.join(" · ") || "Falha ao sincronizar.");
    } catch (e) {
      toast.error(`Falha ao sincronizar: ${(e as Error).message}`);
    } finally {
      setSyncingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-5 flex items-center gap-2">
        <Plug className="h-5 w-5 text-primary" />
        <h1 className="font-display text-2xl font-bold md:text-3xl">Integrações</h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Conexão real com Wix Stores e Bling V3 — publica produtos aprovados com Selo de Qualidade NTC,
        código de rastreio e categorias resolvidas automaticamente.
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <StatusCard plataforma="wix" status={wix} checking={checking} />
        <StatusCard plataforma="bling" status={bling} checking={checking} />
      </div>

      <button
        onClick={checarStatus}
        disabled={checking}
        className="mb-6 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium transition hover:border-primary/40 disabled:opacity-50"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} /> Verificar conexões
      </button>

      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border p-3 text-sm font-semibold">
          Produtos aprovados — prontos para publicar ({approved.length})
        </div>
        {approved.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">
            Nenhum produto aprovado ainda. Aprove produtos em &quot;Aprovação &amp; NTC&quot; para publicá-los aqui.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {approved.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{p.nome}</div>
                  <div className="font-mono text-xs text-muted-foreground">{p.sku}</div>
                </div>
                <button
                  onClick={() => sincronizar(p.id)}
                  disabled={syncingId === p.id}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                >
                  {syncingId === p.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plug className="h-3.5 w-3.5" />
                  )}
                  Publicar Wix + Bling
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusCard({
  plataforma,
  status,
  checking,
}: {
  plataforma: Plataforma;
  status: IntegracaoStatus | null;
  checking: boolean;
}) {
  const nome = plataforma === "wix" ? "Wix Stores" : "Bling V3";
  const conectado = status?.configurado ?? false;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{nome}</span>
        {checking ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : conectado ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <XCircle className="h-4 w-4 text-destructive" />
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {checking ? "Verificando…" : status?.mensagem || "Status desconhecido."}
      </p>
    </div>
  );
}
