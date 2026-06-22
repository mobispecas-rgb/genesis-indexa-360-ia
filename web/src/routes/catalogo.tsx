import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Boxes, Search } from "lucide-react";
import { useProducts } from "@/lib/store";
import { apiListarCategorias, type CategoriaResumo } from "@/lib/api";
import { cn } from "@/lib/utils";

export function Catalogo() {
  const products = useProducts((s) => s.products);
  const loaded = useProducts((s) => s.loaded);
  const loadFromServer = useProducts((s) => s.loadFromServer);

  const [categorias, setCategorias] = useState<CategoriaResumo[]>([]);
  const [categoriaAtiva, setCategoriaAtiva] = useState<string | null>(null);
  const [busca, setBusca] = useState("");

  useEffect(() => {
    if (!loaded) loadFromServer();
    apiListarCategorias().then(setCategorias).catch(() => setCategorias([]));
  }, [loaded, loadFromServer]);

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return products.filter((p) => {
      if (categoriaAtiva && p.familia !== categoriaAtiva) return false;
      if (termo && !`${p.nome} ${p.sku} ${p.fabricante}`.toLowerCase().includes(termo)) return false;
      return true;
    });
  }, [products, categoriaAtiva, busca]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-5 flex items-center gap-2">
        <Boxes className="h-5 w-5 text-primary" />
        <h1 className="font-display text-2xl font-bold md:text-3xl">Catálogo</h1>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por nome, SKU ou fabricante…"
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm outline-none focus:border-primary/50"
          />
        </div>
        <span className="text-xs text-muted-foreground">{filtrados.length} de {products.length} produtos</span>
      </div>

      {categorias.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          <button
            onClick={() => setCategoriaAtiva(null)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition",
              categoriaAtiva === null ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40",
            )}
          >
            Todas
          </button>
          {categorias.map((c) => (
            <button
              key={`${c.categoria}-${c.subcategoria}`}
              onClick={() => setCategoriaAtiva(c.categoria)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition",
                categoriaAtiva === c.categoria ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40",
              )}
            >
              {c.categoria} <span className="opacity-60">({c.total})</span>
            </button>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {filtrados.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">Nenhum produto encontrado.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Produto</th>
                <th className="px-4 py-2 font-medium">SKU</th>
                <th className="px-4 py-2 font-medium">Família</th>
                <th className="px-4 py-2 font-medium">NTC</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filtrados.map((p) => (
                <tr key={p.id} className="hover:bg-muted/20">
                  <td className="max-w-xs truncate px-4 py-2.5">
                    <Link to="/enriquecimento" search={{ id: p.id }} className="font-medium hover:text-primary">
                      {p.nome || "(sem nome)"}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{p.sku}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{p.familia || "—"}</td>
                  <td className="px-4 py-2.5 text-xs">{p.ntc}%</td>
                  <td className="px-4 py-2.5 text-xs capitalize">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
