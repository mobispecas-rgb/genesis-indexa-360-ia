import { Outlet } from "@tanstack/react-router";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Toaster } from "@/components/ui/sonner";

export function RootLayout() {
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur">
            <SidebarTrigger />
            <div className="flex items-center gap-2 text-sm">
              <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
              <span className="text-muted-foreground">
                Sistema Online — <span className="text-foreground">iRollo 360</span> · Motor NTC 4.0
              </span>
            </div>
            <span className="ml-auto rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-success">
              DNA OEM ativo
            </span>
          </header>
          <main className="flex-1">
            <Outlet />
          </main>
        </div>
      </div>
      <Toaster />
    </SidebarProvider>
  );
}
