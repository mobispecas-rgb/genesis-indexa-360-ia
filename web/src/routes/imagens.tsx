import { useState } from "react";
import { Image as ImageIcon, Search, Loader2 } from "lucide-react";
import { apiBuscarImagens, type ImagemBusca } from "@/lib/api";

export function Imagens() {
  const [query, setQuery] = useState("");
  const [imagens, setImagens] = useState<ImagemBusca[]>([]);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function buscar() {
    if (!query.trim()) return;
    setLoading(true);
    setMensagem(null);
    try {
      const r = await apiBuscarImagens(query.trim());
      setImagens(r.imagens);
      if (r.mensagem) setMensagem(r.mensagem);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-5 flex items-center gap-2">
        <ImageIcon className="h-5 w-5 text-primary" />
        <h1 className="font-display text-2xl font-bold md:text-3xl">Imagens</h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Busca real de imagens de produto na web (Brave / Serper / Google Custom Search) — a mesma fonte usada
        pelo enriquecimento automático.
      </p>

      <div className="mb-6 flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buscar()}
            placeholder="Ex: filtro de óleo Tecfil PSL123 Gol 1.6"
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

      {mensagem && (
        <div className="mb-6 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {mensagem}
        </div>
      )}

      {imagens.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {imagens.map((img, i) => (
            <a
              key={i}
              href={img.url}
              target="_blank"
              rel="noreferrer"
              className="group overflow-hidden rounded-lg border border-border bg-card"
            >
              <img
                src={`/api/imagens/proxy?url=${encodeURIComponent(img.thumb || img.url)}`}
                alt={img.titulo || ""}
                className="aspect-square w-full object-cover transition group-hover:scale-105"
                loading="lazy"
              />
              {img.fonte && (
                <div className="truncate px-2 py-1 text-[10px] text-muted-foreground">{img.fonte}</div>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
