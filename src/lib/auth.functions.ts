import { createServerFn } from "@tanstack/react-start";
import { getSession } from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import { getSessionConfig, type AuthSessionData } from "./auth";
import { emailLiberado } from "./usuarios";

export const getCurrentUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthSessionData | null> => {
    const session = await getSession<AuthSessionData>(getSessionConfig());
    const email = session.data.email;
    // Quem foi removido da lista perde o acesso sem esperar o cookie (30 dias) expirar.
    return email && (await emailLiberado(email)) ? { email } : null;
  },
);

// Usar como `beforeLoad: requireAuth` em rotas de configuração/gestão interna
// (não nas páginas de relatório final por condomínio, que continuam públicas).
export async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) {
    throw redirect({ to: "/login" });
  }
  return { user };
}
