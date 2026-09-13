import { createFileRoute } from "@tanstack/react-router";
import { getCookie, deleteCookie, getSession } from "@tanstack/react-start/server";
import {
  STATE_COOKIE_NAME,
  getGoogleClientId,
  getGoogleClientSecret,
  getSessionConfig,
  type AuthSessionData,
} from "@/lib/auth";

// Mostra o refresh_token uma vez só, pra copiar como secret
// GOOGLE_DRIVE_REFRESH_TOKEN no Cloudflare — não é salvo em lugar nenhum por
// este app (mesmo padrão de "credencial configurada manualmente" já usado
// pros outros tokens do projeto).
export const Route = createFileRoute("/auth/drive/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await getSession<AuthSessionData>(getSessionConfig());
        if (!session.data.email) {
          return new Response(null, { status: 302, headers: { Location: "/admin" } });
        }

        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const expectedState = getCookie(STATE_COOKIE_NAME);
        deleteCookie(STATE_COOKIE_NAME, { path: "/" });

        if (!code || !state || !expectedState || state !== expectedState) {
          return new Response("Estado inválido — tente de novo em /auth/drive/start.", {
            status: 400,
          });
        }

        const redirectUri = `${url.origin}/auth/drive/callback`;
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: getGoogleClientId(),
            client_secret: getGoogleClientSecret(),
            code,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        });

        if (!tokenRes.ok) {
          const detalhe = await tokenRes.text();
          return new Response(`Falha ao trocar o código: ${tokenRes.status}\n${detalhe}`, {
            status: 500,
          });
        }

        const tokenJson = (await tokenRes.json()) as { refresh_token?: string };
        if (!tokenJson.refresh_token) {
          return new Response(
            "O Google não retornou um refresh_token (normalmente porque esse app já foi autorizado " +
              "antes). Revogue o acesso em https://myaccount.google.com/permissions (procure pelo nome " +
              "do app) e tente de novo em /auth/drive/start.",
            { status: 400 },
          );
        }

        const html = `<!doctype html>
<html>
<body style="font-family: monospace; white-space: pre-wrap; padding: 24px; line-height: 1.6;">
Copie o valor abaixo e configure como secret GOOGLE_DRIVE_REFRESH_TOKEN no Cloudflare.
Ele não será mostrado de novo — se perder, revogue o acesso em
https://myaccount.google.com/permissions e repita esse fluxo em /auth/drive/start.

GOOGLE_DRIVE_REFRESH_TOKEN=${tokenJson.refresh_token}
</body>
</html>`;
        return new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
  },
});
