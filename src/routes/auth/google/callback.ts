import { createFileRoute } from "@tanstack/react-router";
import { getCookie, deleteCookie, updateSession } from "@tanstack/react-start/server";
import {
  STATE_COOKIE_NAME,
  buildRedirectUri,
  getGoogleClientId,
  getGoogleClientSecret,
  getSessionConfig,
  isEmailAllowed,
  type AuthSessionData,
} from "@/lib/auth";

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function decodeIdToken(idToken: string): {
  email?: string;
  email_verified?: boolean | string;
  aud?: string;
  exp?: number;
} {
  const payload = idToken.split(".")[1];
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  return JSON.parse(json);
}

export const Route = createFileRoute("/auth/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const origin = url.origin;
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const expectedState = getCookie(STATE_COOKIE_NAME);
        deleteCookie(STATE_COOKIE_NAME, { path: "/" });

        if (!code || !state || !expectedState || state !== expectedState) {
          return redirectTo(`${origin}/login?error=state`);
        }

        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: getGoogleClientId(),
            client_secret: getGoogleClientSecret(),
            code,
            redirect_uri: buildRedirectUri(request.url),
            grant_type: "authorization_code",
          }),
        });

        if (!tokenRes.ok) {
          const detail = await tokenRes.text();
          console.error("Google token exchange failed:", tokenRes.status, detail);
          return redirectTo(
            `${origin}/login?error=login_failed&reason=token_exchange&status=${tokenRes.status}`,
          );
        }

        const tokenJson = (await tokenRes.json()) as { id_token?: string };
        if (!tokenJson.id_token) {
          return redirectTo(`${origin}/login?error=login_failed&reason=no_id_token`);
        }

        const claims = decodeIdToken(tokenJson.id_token);
        const emailVerified = claims.email_verified === true || claims.email_verified === "true";
        const validAudience = claims.aud === getGoogleClientId();
        const notExpired = !!claims.exp && claims.exp * 1000 > Date.now();

        if (!claims.email || !emailVerified || !validAudience || !notExpired) {
          const reason = !claims.email
            ? "no_email"
            : !emailVerified
              ? "email_unverified"
              : !validAudience
                ? "bad_audience"
                : "expired";
          return redirectTo(`${origin}/login?error=login_failed&reason=${reason}`);
        }

        if (!isEmailAllowed(claims.email)) {
          return redirectTo(`${origin}/login?error=denied`);
        }

        await updateSession<AuthSessionData>(getSessionConfig(), { email: claims.email });

        return redirectTo(`${origin}/admin`);
      },
    },
  },
});
