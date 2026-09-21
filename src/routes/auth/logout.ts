import { createFileRoute } from "@tanstack/react-router";
import { clearSession } from "@tanstack/react-start/server";
import { getSessionConfig } from "@/lib/auth";

export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await clearSession(getSessionConfig());
        return new Response(null, {
          status: 302,
          headers: { Location: new URL("/login", request.url).toString() },
        });
      },
    },
  },
});
