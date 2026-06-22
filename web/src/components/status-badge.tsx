import type { ProductStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const map: Record<ProductStatus, { label: string; className: string }> = {
  pending: { label: "Pendente", className: "bg-warning/15 text-warning border-warning/30" },
  approved: { label: "Aprovado", className: "bg-success/15 text-success border-success/30" },
  rejected: { label: "Reprovado", className: "bg-destructive/15 text-destructive border-destructive/30" },
  frozen: { label: "Congelado", className: "bg-info/15 text-info border-info/30" },
};

export function StatusBadge({ status }: { status: ProductStatus }) {
  const s = map[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}
