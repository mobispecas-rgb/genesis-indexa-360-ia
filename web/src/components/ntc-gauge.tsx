import { NTC_META } from "@/lib/types";
import { ntcLabel } from "@/lib/ntc";
import { cn } from "@/lib/utils";

const toneColor: Record<string, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
};

export function NtcGauge({ value, size = 132 }: { value: number; size?: number }) {
  const { label, tone } = ntcLabel(value);
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (value / 100) * c;
  const color = toneColor[tone];

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          style={{ transition: "stroke-dasharray 0.6s cubic-bezier(0.4,0,0.2,1)" }}
        />
        {/* meta marker */}
        <circle
          cx={size / 2 + r * Math.cos((NTC_META / 100) * 2 * Math.PI)}
          cy={size / 2 + r * Math.sin((NTC_META / 100) * 2 * Math.PI)}
          r={3}
          fill="var(--foreground)"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-3xl font-bold tabular-nums" style={{ color }}>
          {value}%
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>
          {label}
        </span>
        <span className="mt-0.5 text-[9px] text-muted-foreground">Meta {NTC_META}%</span>
      </div>
    </div>
  );
}

export function NtcBar({ value, className }: { value: number; className?: string }) {
  const { tone } = ntcLabel(value);
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${value}%`, background: toneColor[tone] }}
        />
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums" style={{ color: toneColor[tone] }}>
        {value}%
      </span>
    </div>
  );
}
