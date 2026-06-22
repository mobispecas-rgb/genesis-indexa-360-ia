import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Product, ProductStatus } from "./types";
import { apiAtualizarStatus, apiExcluirProduto, apiListarProdutos, apiSalvarProduto } from "./api";

interface ProductState {
  products: Product[];
  loaded: boolean;
  loadFromServer: () => Promise<void>;
  upsert: (p: Product) => Promise<Product>;
  remove: (id: string) => Promise<void>;
  setStatus: (id: string, status: ProductStatus) => Promise<void>;
  bulkStatus: (ids: string[], status: ProductStatus) => Promise<void>;
  get: (id: string) => Product | undefined;
  clear: () => void;
}

export const useProducts = create<ProductState>()(
  persist(
    (set, get) => ({
      products: [],
      loaded: false,
      // Carrega o catálogo real do servidor (SQLite via /api/produtos).
      // Sem isso a tela fica mostrando só o cache local do navegador.
      loadFromServer: async () => {
        try {
          const products = await apiListarProdutos();
          set({ products, loaded: true });
        } catch (e) {
          console.error("Falha ao carregar produtos do servidor:", e);
          set({ loaded: true });
        }
      },
      // Persiste no backend (SQLite + Motor NTC 4.0) e substitui a entrada local
      // pelo registro retornado (que tem o id real do servidor).
      upsert: async (p) => {
        const saved = await apiSalvarProduto(p);
        set((state) => {
          const withoutOld = state.products.filter((x) => x.id !== p.id && x.id !== saved.id);
          return { products: [saved, ...withoutOld] };
        });
        return saved;
      },
      remove: async (id) => {
        await apiExcluirProduto(id);
        set((state) => ({ products: state.products.filter((p) => p.id !== id) }));
      },
      setStatus: async (id, status) => {
        const current = get().products.find((p) => p.id === id);
        if (!current) return;
        const saved = await apiAtualizarStatus(current, status);
        set((state) => ({ products: state.products.map((p) => (p.id === id ? saved : p)) }));
      },
      bulkStatus: async (ids, status) => {
        const targets = get().products.filter((p) => ids.includes(p.id));
        const saved = await Promise.all(targets.map((p) => apiAtualizarStatus(p, status)));
        set((state) => ({
          products: state.products.map((p) => saved.find((s) => s.id === p.id) ?? p),
        }));
      },
      get: (id) => get().products.find((p) => p.id === id),
      clear: () => set({ products: [] }),
    }),
    { name: "irollo360-products" },
  ),
);
