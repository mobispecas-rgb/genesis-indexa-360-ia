import * as React from "react";
import { PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarContextValue {
  collapsed: boolean;
  toggle: () => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within SidebarProvider");
  return ctx;
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const value = React.useMemo(
    () => ({ collapsed, toggle: () => setCollapsed((c) => !c) }),
    [collapsed],
  );
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function SidebarTrigger({ className }: { className?: string }) {
  const { toggle } = useSidebar();
  return (
    <button
      onClick={toggle}
      className={cn("rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground", className)}
      title="Alternar menu"
    >
      <PanelLeft className="h-4 w-4" />
    </button>
  );
}

export function Sidebar({
  children,
  collapsible,
}: {
  children: React.ReactNode;
  collapsible?: "icon" | "none";
}) {
  const { collapsed } = useSidebar();
  const isIconMode = collapsible === "icon" && collapsed;
  return (
    <div
      data-collapsible={isIconMode ? "icon" : undefined}
      className={cn(
        "group flex h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all",
        isIconMode ? "w-[64px]" : "w-[260px]",
      )}
      style={{ "--is-collapsed": isIconMode ? "1" : "0" } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

export function SidebarHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

export function SidebarContent({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 overflow-y-auto px-2 py-3">{children}</div>;
}

export function SidebarFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

export function SidebarGroup({ children }: { children: React.ReactNode }) {
  return <div className="mb-4">{children}</div>;
}

export function SidebarGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

export function SidebarGroupContent({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}

export function SidebarMenu({ children }: { children: React.ReactNode }) {
  return <ul className="space-y-0.5">{children}</ul>;
}

export function SidebarMenuItem({ children }: { children: React.ReactNode }) {
  return <li>{children}</li>;
}

export function SidebarMenuButton({
  children,
  asChild,
  isActive,
  tooltip,
  className,
  ...props
}: {
  children: React.ReactNode;
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = cn(
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition",
    isActive ? "bg-sidebar-primary text-sidebar-primary-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent",
    className,
  );
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement, {
      className: cn(classes, (children as React.ReactElement).props.className),
      title: tooltip,
    });
  }
  return (
    <button className={classes} title={tooltip} {...props}>
      {children}
    </button>
  );
}
