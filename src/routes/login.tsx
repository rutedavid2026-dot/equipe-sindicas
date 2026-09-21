import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { Masthead } from "@/components/report/Masthead";
import { pageMeta } from "@/lib/page-meta";
import { getCurrentUser } from "@/lib/auth.functions";

const searchSchema = z.object({
  error: z.enum(["state", "login_failed", "denied"]).optional(),
  reason: z.string().optional(),
  status: z.coerce.string().optional(),
});

const errorMessages: Record<string, string> = {
  state: "A sessão de login expirou ou é inválida. Tente novamente.",
  login_failed: "Não foi possível concluir o login com o Google. Tente novamente.",
  denied: "Esse e-mail não tem acesso autorizado a este painel.",
};

export const Route = createFileRoute("/login")({
  validateSearch: (s) => searchSchema.parse(s),
  beforeLoad: async () => {
    const user = await getCurrentUser();
    if (user) throw redirect({ to: "/admin", replace: true });
  },
  head: () => ({
    meta: pageMeta("Equipe Síndicas — Login", "Acesso restrito ao painel da Equipe Síndicas."),
  }),
  component: LoginForm,
});

function LoginForm() {
  const { error, reason, status } = Route.useSearch();

  return (
    <main className="bg-background flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-5">
        <Masthead condominio="" />

        <div className="bg-card space-y-4 rounded-xl border p-6 text-center shadow-sm">
          <p className="text-sm text-muted-foreground">
            Acesso restrito. Entre com uma conta Google autorizada.
          </p>

          {error && (
            <p className="text-destructive rounded-md bg-destructive/10 p-2 text-xs">
              {errorMessages[error]}
              {reason && (
                <span className="mt-1 block opacity-70">
                  ({reason}
                  {status ? ` · HTTP ${status}` : ""})
                </span>
              )}
            </p>
          )}

          <a
            href="/auth/google/start"
            className="border-brand-border bg-background hover:bg-accent inline-flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors"
          >
            Entrar com Google
          </a>
        </div>
      </div>
    </main>
  );
}
