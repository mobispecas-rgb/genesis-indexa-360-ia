import { useState } from "react";
import { Dna, Search, Loader2, Globe } from "lucide-react";
import { apiVectorBusca, type VectorResultado, type BuscaWebFallback } from "@/lib/api";
import { cn } from "@/lib/utils";

const TIPOS = [
  { id: "oem" as const, label: "Código OEM" },
  { id: "dna" as const, label: "DNA técnico" },
  { id: "application" as const, label: "Aplicação de motor" },
];

export function DnaOem360() {
  const [tipo, setTipo] = useState<typeof TIPOS[number]["id"]>("oem");
  const [query, setQuery] = useState("");
  const [resultados, setResultados] = useState<VectorResultado[]>([]);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [buscou, setBuscou] = useState(false);
  const [buscaWeb, setBuscaWeb] = useState<BuscaWebFallback | null>(null);

  async function buscar() {
    if (!query.trim()) return;
    setLoading(true);
    setErro(null);
    setBuscaWeb(null);
    try {
      const { resultados: r, buscaWeb: bw } = await apiVectorBusca(tipo, query.trim());
      setResultados(r);
      setBuscaWeb(bw);
    } catch (e) {
      setErro((e as Error).message);
      setResultados([]);
    } finally {
      setLoading(false);
      setBuscou(true);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-5 flex items-center gap-2">
        <Dna className="h-5 w-5 text-primary" />
        <h1 className="font-display text-2xl font-bold md:text-3xl">DNA OEM 360</h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Busca por similaridade no índice vetorial técnico aprendido a partir do catálogo já enriquecido —
        encontra produtos com o mesmo DNA (OEM, família técnica, aplicação de motor) mesmo com descrições diferentes.
      </p>

      <div className="mb-4 flex gap-2">
        {TIPOS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTipo(t.id)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition",
              tipo === t.id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mb-6 flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buscar()}
            placeholder="Ex: 90536398 ou descrição técnica do produto"
            className="w-full rounded-lg border border-border bg-card py-2.5 pl-9 pr-3 text-sm outline-none focus:border-primary/50"
          />
        </div>
        <button
          onClick={buscar}
          disabled={loading || !query.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Buscar
        </button>
      </div>

      {erro && <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{erro}</div>}

      {resultados.length === 0 && !loading && !erro ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {buscou
              ? "Nenhum produto similar encontrado no índice — este produto (ou nenhum parecido) ainda foi indexado."
              : "Nenhuma busca realizada ainda."}
          </p>
          {buscaWeb && (
            <div className="rounded-xl border border-info/30 bg-info/5 p-4">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-info" />
                <h3 className="font-display text-sm font-semibold">
                  {buscaWeb.encontrado ? "DNA encontrado na web — confirme antes de cadastrar" : "Busca na web"}
                </h3>
              </div>
              {!buscaWeb.ok || !buscaWeb.encontrado ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {buscaWeb.erro || "Nenhuma fonte confiável encontrada na web para esse produto."}
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Não havia esse produto no catálogo indexado, então buscamos na web. Confirme os dados e cadastre-o na tela de Enriquecimento para ele passar a aparecer aqui também.
                  </p>
                  <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed">
                    {JSON.stringify(buscaWeb.campos, null, 2)}
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border/60 rounded-xl border border-border bg-card">
          {resultados.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{r.nome || r.texto || "—"}</div>
                {r.sku && <div className="font-mono text-xs text-muted-foreground">{r.sku}</div>}
              </div>
              {(r.score != null || r.similaridade != null) && (
                <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                  {Math.round((r.score ?? r.similaridade ?? 0) * 100)}%
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
