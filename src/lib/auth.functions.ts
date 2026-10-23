import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader, getSession } from "@tanstack/react-start/server";
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

// Robôs de preview de link (WhatsApp, Telegram, Slack...) não têm sessão: sem
// isso eles tomam o redirect pro /login e mostram o preview do login em
// qualquer link interno (visto em 2026-10-23 com /atividade). Só serve pra
// páginas que NÃO carregam dado no servidor — o dado vem depois, por
// server function que checa a sessão de verdade.
const ROBOS_DE_PREVIEW =
  /whatsapp|facebookexternalhit|telegrambot|slackbot|twitterbot|linkedinbot|discordbot|skypeuripreview|googlebot/i;

const ehRoboDePreview = createServerFn({ method: "GET" }).handler(async (): Promise<boolean> =>
  ROBOS_DE_PREVIEW.test(getRequestHeader("user-agent") ?? ""),
);

// Como requireAuth, mas deixa o robô de preview ler o <head> da própria
// página (título/descrição/og:*) em vez do /login. Usar só em rotas sem loader
// de dados.
export async function requireAuthComPreview() {
  const user = await getCurrentUser();
  if (user) return { user };
  if (await ehRoboDePreview()) return { user: { email: "" } };
  throw redirect({ to: "/login" });
}
