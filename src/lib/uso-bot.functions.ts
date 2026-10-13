import { createServerFn } from "@tanstack/react-start";

// Base "Uso do Bot" (workspace "Notion de Síndicas Profissionais", mesma
// integração "equipe-sindicas-alertas" usada pelo bot em
// src/routes/webhooks/telegram.ts) — 1 linha por interação, gravada
// automaticamente pelo bot (ver registrarUso lá). Lida aqui só pra montar o
// monitor de uso local, sem nenhuma escrita.
const NOTION_VERSION = "2022-06-28";
const USO_BOT_DB_ID = "3ebe69ba114f8179ad50cced10481d20";

export type UsoBotEntry = {
  pessoa: string;
  chatId: string;
  tipo: string;
  resumo: string;
  data: string; // ISO
};

export type GetUsoBotResult = {
  data: UsoBotEntry[];
  error: string | null;
};

function notionKey(): string | undefined {
  return process.env.NOTION_API_KEY_ALERTAS;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function richText(prop: any): string {
  const arr = prop?.rich_text ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return arr.map((t: any) => t.plain_text ?? "").join("");
}

export const getUsoBot = createServerFn({ method: "GET" }).handler(
  async (): Promise<GetUsoBotResult> => {
    const key = notionKey();
    if (!key) {
      return { data: [], error: "NOTION_API_KEY_ALERTAS não configurada." };
    }

    try {
      const resultados: UsoBotEntry[] = [];
      let cursor: string | undefined;
      do {
        const res = await fetch(`https://api.notion.com/v1/databases/${USO_BOT_DB_ID}/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            page_size: 100,
            sorts: [{ property: "Data", direction: "descending" }],
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        });
        const json = (await res.json()) as {
          object: string;
          message?: string;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          results: any[];
          has_more: boolean;
          next_cursor: string | null;
        };
        if (json.object === "error") {
          return { data: [], error: `Notion API: ${json.message ?? "erro desconhecido"}` };
        }

        for (const page of json.results) {
          const props = page.properties;
          resultados.push({
            pessoa: richText(props["Pessoa"]) || "(desconhecido)",
            chatId: richText(props["Chat ID"]),
            tipo: props["Tipo"]?.select?.name ?? "texto",
            resumo: richText(props["Resumo"]),
            data: props["Data"]?.date?.start ?? page.created_time,
          });
        }
        cursor = json.has_more ? (json.next_cursor ?? undefined) : undefined;
      } while (cursor);

      return { data: resultados, error: null };
    } catch (e) {
      return { data: [], error: e instanceof Error ? e.message : "Erro desconhecido" };
    }
  },
);
