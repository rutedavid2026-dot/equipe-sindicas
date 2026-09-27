import { createFileRoute } from "@tanstack/react-router";
import { getCondominiosRegistry } from "@/lib/sheets.functions";
import { dispararCaptura } from "@/routes/webhooks/notion";

// "Botão" de atualização manual: um link dentro da própria página/database
// de cada condomínio no Notion (a API do Notion não cria blocos de Button de
// verdade — ver nota em webhooks/notion.ts), que qualquer pessoa da equipe
// pode clicar quando desconfiar que uma edição não chegou na fotografia (o
// problema recorrente do webhook do Notion ficando mudo, ver conversa de
// 2026-09-19/25). Clicar aqui dispara exatamente a mesma captura que o
// webhook dispararia — só muda quem chama.
//
// É uma rota GET porque um link do Notion só sabe abrir URL (não dá pra
// fazer POST a partir de um clique). Não é "seguro" no sentido HTTP estrito
// (tem efeito colateral), mas o efeito é sempre o mesmo — reler o Notion e
// regravar a semana atual — nunca destrutivo, então repetir o clique à toa
// não faz mal nenhum.

function paginaHtml(opts: { titulo: string; mensagem: string; ok: boolean }): string {
  const { titulo, mensagem, ok } = opts;
  const cor = ok ? "#173F35" : "#7A2E3A";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${titulo}</title>
<style>
  body { font: 16px/1.6 system-ui, -apple-system, sans-serif; background: #F7F3EC; color: #2b2b26; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
  .card { max-width: 26rem; width: 100%; text-align: center; background: #fff; border: 1px solid #E4DCCB; border-radius: 0.75rem; padding: 2.25rem 1.75rem; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .selo { font-size: 2.5rem; margin-bottom: 0.75rem; }
  h1 { font-size: 1.15rem; margin: 0 0 0.75rem; color: ${cor}; }
  p { color: #4b5544; margin: 0; font-size: 0.95rem; }
</style>
</head>
<body>
  <div class="card">
    <div class="selo">${ok ? "✅" : "⚠️"}</div>
    <h1>${titulo}</h1>
    <p>${mensagem}</p>
  </div>
</body>
</html>`;
}

function resposta(html: string, status: number): Response {
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export const Route = createFileRoute("/atualizar/$condominio")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slug = params.condominio?.trim().toLowerCase();
        if (!slug) {
          return resposta(
            paginaHtml({ titulo: "Link incompleto", mensagem: "Falta o identificador do condomínio na URL.", ok: false }),
            400,
          );
        }

        const registro = await getCondominiosRegistry();
        const entrada = registro.data.find((r) => r.id.toLowerCase() === slug);
        if (!entrada) {
          return resposta(
            paginaHtml({
              titulo: "Condomínio não encontrado",
              mensagem: `Não encontrei "${slug}" na planilha índice. Confirme o link deste botão com quem cuida do sistema.`,
              ok: false,
            }),
            404,
          );
        }

        const resultado = await dispararCaptura(slug);
        if (!resultado.disparado) {
          return resposta(
            paginaHtml({
              titulo: "Não consegui atualizar agora",
              mensagem: `${entrada.condominio}: ${resultado.motivo}. Tente de novo em alguns minutos, ou avise quem cuida do sistema.`,
              ok: false,
            }),
            502,
          );
        }

        const agora = new Date().toLocaleString("pt-BR", {
          timeZone: "America/Sao_Paulo",
          dateStyle: "short",
          timeStyle: "short",
        });
        return resposta(
          paginaHtml({
            titulo: "Atualização disparada!",
            mensagem: `${entrada.condominio} está sendo atualizado agora (${agora}). Leva cerca de 1 a 2 minutos pra refletir no link semanal — pode fechar esta aba.`,
            ok: true,
          }),
          200,
        );
      },
    },
  },
});
