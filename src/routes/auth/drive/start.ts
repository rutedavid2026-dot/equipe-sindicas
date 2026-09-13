import { createFileRoute } from "@tanstack/react-router";
import { getSession, setCookie } from "@tanstack/react-start/server";
import {
  STATE_COOKIE_NAME,
  getGoogleClientId,
  getSessionConfig,
  type AuthSessionData,
} from "@/lib/auth";

// Autorização única (feita por um admin logado) pra permitir que o bot do
// Telegram suba anexos pro Drive da sua conta pessoal em nome dela — ver
// src/routes/auth/drive/callback.ts pro resto do fluxo e o porquê de não usar
// conta de serviço (contas de serviço não têm cota de armazenamento própria;
// numa conta Gmail comum, sem Drive Compartilhado, os uploads falhariam por
// "cota excedida").
export const Route = createFileRoute("/auth/drive/start")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await getSession<AuthSessionData>(getSessionConfig());
        if (!session.data.email) {
          return new Response(null, { status: 302, headers: { Location: "/admin" } });
        }

        const state = crypto.randomUUID();
        setCookie(STATE_COOKIE_NAME, state, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 10,
        });

        const redirectUri = `${new URL(request.url).origin}/auth/drive/callback`;
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        url.searchParams.set("client_id", getGoogleClientId());
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("scope", "https://www.googleapis.com/auth/drive.file");
        url.searchParams.set("access_type", "offline");
        url.searchParams.set("prompt", "consent");
        url.searchParams.set("state", state);

        return new Response(null, { status: 302, headers: { Location: url.toString() } });
      },
    },
  },
});
