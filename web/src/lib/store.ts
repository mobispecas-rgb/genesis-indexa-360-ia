import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Product, ProductStatus } from "./types";
import { calcNtc } from "./ntc";

interface ProductState {
  products: Product[];
  upsert: (p: Product) => void;
  remove: (id: string) => void;
  setStatus: (id: string, status: ProductStatus) => void;
  bulkStatus: (ids: string[], status: ProductStatus) => void;
  get: (id: string) => Product | undefined;
  clear: () => void;
}

function withNtc(p: Product): Product {
  return { ...p, ntc: calcNtc(p), updatedAt: Date.now() };
}

export const useProducts = create<ProductState>()(
  persist(
    (set, get) => ({
      products: [],
      upsert: (p) =>
        set((state) => {
          const next = withNtc(p);
          const exists = state.products.some((x) => x.id === next.id);
          return {
            products: exists
              ? state.products.map((x) => (x.id === next.id ? next : x))
              : [next, ...state.products],
          };
        }),
      remove: (id) => set((state) => ({ products: state.products.filter((p) => p.id !== id) })),
      setStatus: (id, status) =>
        set((state) => ({
          products: state.products.map((p) =>
            p.id === id ? { ...p, status, updatedAt: Date.now() } : p,
          ),
        })),
      bulkStatus: (ids, status) =>
        set((state) => ({
          products: state.products.map((p) =>
            ids.includes(p.id) ? { ...p, status, updatedAt: Date.now() } : p,
          ),
        })),
      get: (id) => get().products.find((p) => p.id === id),
      clear: () => set({ products: [] }),
    }),
    { name: "irollo360-products" },
  ),
);
