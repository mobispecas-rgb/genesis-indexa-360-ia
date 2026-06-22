import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "@/components/layout";
import { Dashboard } from "@/routes/index";
import { Enriquecimento } from "@/routes/enriquecimento";
import { Aprovacao } from "@/routes/aprovacao";
import { Integracoes } from "@/routes/integracoes";

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});

const enriquecimentoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/enriquecimento",
  validateSearch: (s: Record<string, unknown>): { id?: string } => ({
    id: typeof s.id === "string" ? s.id : undefined,
  }),
  component: Enriquecimento,
});

const aprovacaoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/aprovacao",
  component: Aprovacao,
});

const integracoesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integracoes",
  component: Integracoes,
});

const routeTree = rootRoute.addChildren([indexRoute, enriquecimentoRoute, aprovacaoRoute, integracoesRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
