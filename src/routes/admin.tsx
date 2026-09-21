import { createFileRoute, Link } from "@tanstack/react-router";
import { Masthead } from "@/components/report/Masthead";
import { pageMeta } from "@/lib/page-meta";
import { requireAuth } from "@/lib/auth.functions";

export const Route = createFileRoute("/admin")({
  beforeLoad: requireAuth,
  head: () => ({
    meta: pageMeta(
      "Equipe Síndicas — Relatório Semanal",
      "Dashboard consolidado e gerenciamento de links dos condomínios.",
    ),
  }),
  component: AdminPage,
});

function AdminPage() {
  const { user } = Route.useRouteContext();

  return <Dashboard email={user.email} />;
}

function Dashboard({ email }: { email: string }) {
  return (
    <main className="bg-background min-h-screen">
      <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 md:px-8 md:py-10">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Conectado como {email}</span>
          <a href="/auth/logout" className="hover:text-brand-green transition-colors">
            Sair
          </a>
        </div>

        <Masthead condominio="" />

        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            to="/relatorio-geral"
            className="bg-card hover:border-brand-green group flex items-center justify-between rounded-xl border p-5 shadow-sm transition-colors"
          >
            <div>
              <p className="text-brand-green text-base font-bold tracking-tight">
                Dashboard (Relatório Geral)
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                KPIs e demandas consolidadas de todos os condomínios.
              </p>
            </div>
            <span
              aria-hidden
              className="text-brand-green group-hover:translate-x-0.5 transition-transform"
            >
              →
            </span>
          </Link>

          <Link
            to="/gerenciar"
            className="bg-card hover:border-brand-green group flex items-center justify-between rounded-xl border p-5 shadow-sm transition-colors"
          >
            <div>
              <p className="text-brand-green text-base font-bold tracking-tight">Gerenciar Links</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Links dos follow-ups semanais de cada condomínio.
              </p>
            </div>
            <span
              aria-hidden
              className="text-brand-green group-hover:translate-x-0.5 transition-transform"
            >
              →
            </span>
          </Link>

          <Link
            to="/outros-follow-ups"
            className="bg-card hover:border-brand-green group flex items-center justify-between rounded-xl border p-5 shadow-sm transition-colors"
          >
            <div>
              <p className="text-brand-green text-base font-bold tracking-tight">
                Outros Follow-ups
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                Relatórios de acompanhamento que não são o follow-up semanal padrão.
              </p>
            </div>
            <span
              aria-hidden
              className="text-brand-green group-hover:translate-x-0.5 transition-transform"
            >
              →
            </span>
          </Link>
        </div>
      </div>
    </main>
  );
}
