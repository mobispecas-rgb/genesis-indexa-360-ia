import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "@/components/layout";
import { Dashboard } from "@/routes/index";
import { Enriquecimento } from "@/routes/enriquecimento";
import { Aprovacao } from "@/routes/aprovacao";
import { Integracoes } from "@/routes/integracoes";
import { Catalogo } from "@/routes/catalogo";
import { CatalogoCertificado } from "@/routes/catalogo-certificado";
import { Imagens } from "@/routes/imagens";
import { DnaOem360 } from "@/routes/dna";
import { MapeadorUniversal } from "@/routes/mapeador-universal";
import { Performance } from "@/routes/performance";

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

const catalogoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/catalogo",
  component: Catalogo,
});

const catalogoCertificadoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/catalogo-certificado",
  component: CatalogoCertificado,
});

const imagensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/imagens",
  component: Imagens,
});

const dnaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dna",
  component: DnaOem360,
});

const mapeadorUniversalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mapeador-universal",
  component: MapeadorUniversal,
});

const performanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/performance",
  component: Performance,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  enriquecimentoRoute,
  aprovacaoRoute,
  integracoesRoute,
  catalogoRoute,
  catalogoCertificadoRoute,
  imagensRoute,
  dnaRoute,
  mapeadorUniversalRoute,
  performanceRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
