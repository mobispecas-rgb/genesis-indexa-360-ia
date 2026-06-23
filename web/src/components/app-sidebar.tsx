import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Sparkles,
  CheckCircle2,
  Boxes,
  Image,
  ScanLine,
  Tag,
  Activity,
  Plug,
  Dna,
  BadgeCheck,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useProducts } from "@/lib/store";

const main = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Enriquecimento", url: "/enriquecimento", icon: Sparkles },
  { title: "Aprovação & NTC", url: "/aprovacao", icon: CheckCircle2 },
];

const plataforma = [
  { title: "Catálogo", url: "/catalogo", icon: Boxes },
  { title: "Catálogo Certificado", url: "/catalogo-certificado", icon: BadgeCheck },
  { title: "Imagens", url: "/imagens", icon: Image },
  { title: "DNA OEM 360", url: "/dna", icon: Dna },
  { title: "Mapeador Universal", url: "/mapeador-universal", icon: ScanLine },
  { title: "Integrações", url: "/integracoes", icon: Plug },
  { title: "Performance", url: "/performance", icon: Activity },
];

const soon = [
  { title: "EAN Scanner GS1", icon: ScanLine },
  { title: "Precificação", icon: Tag },
];

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pending = useProducts((s) => s.products.filter((p) => p.status === "pending").length);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border px-3 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary font-display text-base font-bold text-primary-foreground">
            iR
          </div>
          <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="font-display text-sm font-semibold text-sidebar-foreground">
              iRollo 360
            </span>
            <span className="text-[11px] text-muted-foreground">Motor NTC 4.0</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Qualidade NTC</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {main.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={pathname === item.url} tooltip={item.title}>
                    <Link to={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                      {item.url === "/aprovacao" && pending > 0 && (
                        <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground group-data-[collapsible=icon]:hidden">
                          {pending}
                        </span>
                      )}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Plataforma</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {plataforma.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={pathname === item.url} tooltip={item.title}>
                    <Link to={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {soon.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    tooltip={`${item.title} — em breve`}
                    className="cursor-not-allowed opacity-45"
                    aria-disabled
                  >
                    <item.icon />
                    <span>{item.title}</span>
                    <span className="ml-auto text-[9px] uppercase tracking-wide text-muted-foreground group-data-[collapsible=icon]:hidden">
                      breve
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">
          <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
          MOBIS Autopeças · Online
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
