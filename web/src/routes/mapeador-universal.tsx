import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ScanLine, Loader2, Trash2 } from "lucide-react";
import { apiExcluirProduto, apiMapeadorUniversalProcessar, type MapeadorUniversalProduto } from "@/lib/api";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<MapeadorUniversalProduto["status"], string> = {
  verde: "Atualizado",
  amarelo: "Revisar",
  vermelho: "Re-enriquecer necessário",
};

const STATUS_CLASSE: Record<MapeadorUniversalProduto["status"], string> = {
  verde: "bg-success/15 text-success",
  amarelo: "bg-warning/15 text-warning",
  vermelho: "bg-destructive/15 text-destructive",
};

export function MapeadorUniversal() {
  const [fornecedorNome, setFornecedorNome] = useState("");
  const [texto, setTexto] = useState("");
  const [produtos, setProdutos] = useState<MapeadorUniversalProduto[]>([]);
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [excluindo, setExcluindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function processar() {
    if (!texto.trim()) return;
    setLoading(true);
    setErro(null);
    try {
      const r = await apiMapeadorUniversalProcessar(texto.trim(), fornecedorNome);
      setProdutos(r);
      setSelecionados(new Set());
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function alternarSelecao(id: number) {
    setSelecionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function alternarTodos() {
    setSelecionados((prev) => (prev.size === produtos.length ? new Set() : new Set(produtos.map((p) => p.id))));
  }

  async function excluirSelecionados() {
    if (selecionados.size === 0) return;
    setExcluindo(true);
    setErro(null);
    try {
      await Promise.all([...selecionados].map((id) => apiExcluirProduto(String(id))));
      setProdutos((prev) => prev.filter((p) => !selecionados.has(p.id)));
      setSelecionados(new Set());
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setExcluindo(false);
    }
  }

  function limparTudo() {
    setTexto("");
    setProdutos([]);
    setSelecionados(new Set());
    setErro(null);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-5 flex items-center gap-2">
        <ScanLine className="h-5 w-5 text-primary" />
        <h1 className="font-display text-2xl font-bold md:text-3xl">Mapeador Universal</h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Cole dados estruturados ou brutos de qualquer fornecedor, fabricante ou catálogo web — a IA extrai
        mídia, dados fiscais (NCM/CEST), dados logísticos (peso/medidas) e cascata de aplicação, e cadastra
        os produtos automaticamente.
      </p>

      <label className="mb-1 block text-xs font-medium text-muted-foreground">Nome do fornecedor (opcional)</label>
      <input
        value={fornecedorNome}
        onChange={(e) => setFornecedorNome(e.target.value)}
        placeholder="Ex: Distribuidora ABC Autopeças"
        className="mb-3 w-full max-w-sm rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/50"
      />

      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder="Cole aqui o texto bruto, HTML, planilha ou payload do fornecedor…"
        rows={10}
        className="mb-3 w-full resize-y rounded-lg border border-border bg-card p-3 font-mono text-xs outline-none focus:border-primary/50"
      />

      {erro && (
        <div key="status-erro" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {erro}
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        <button
          onClick={processar}
          disabled={loading || !texto.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />} Processar e Enriquecer
        </button>
        <button
          onClick={excluirSelecionados}
          disabled={selecionados.size === 0 || excluindo}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground transition hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
        >
          {excluindo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Excluir Selecionados
        </button>
        <button
          onClick={limparTudo}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground transition hover:border-primary/40"
        >
          Limpar Tudo
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {produtos.length === 0 ? (
          <p key="estado-vazio" className="px-5 py-12 text-center text-sm text-muted-foreground">
            {loading ? "Processando…" : "Nenhum produto processado ainda."}
          </p>
        ) : (
          <table key="tabela-produtos" className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-10 px-4 py-2">
                  <input
                    type="checkbox"
                    checked={selecionados.size === produtos.length}
                    onChange={alternarTodos}
                    className="h-4 w-4 rounded border-border"
                  />
                </th>
                <th className="px-4 py-2 font-medium">Produto</th>
                <th className="px-4 py-2 font-medium">SKU</th>
                <th className="px-4 py-2 font-medium">NTC</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {produtos.map((p) => (
                <tr key={`produto-${p.id}`} className="hover:bg-muted/20">
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={selecionados.has(p.id)}
                      onChange={() => alternarSelecao(p.id)}
                      className="h-4 w-4 rounded border-border"
                    />
                  </td>
                  <td className="max-w-xs truncate px-4 py-2.5">
                    <Link to="/enriquecimento" search={{ id: String(p.id) }} className="font-medium hover:text-primary">
                      {p.nome}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{p.sku}</td>
                  <td className="px-4 py-2.5 text-xs">{Math.round(p.ntc * 100)}%</td>
                  <td className="px-4 py-2.5">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", STATUS_CLASSE[p.status])}>
                      {STATUS_LABEL[p.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
