import { createServerFn } from "@tanstack/react-start";
import { getSession } from "@tanstack/react-start/server";
import { getSessionConfig, type AuthSessionData } from "./auth";
import { getCondominiosRegistry } from "./sheets.functions";

export type AtividadeItem = {
  tarefa: string;
  tipo: "nova" | "editada";
  status: string;
  responsavel: string;
  quando: string; // ISO
  url: string;
};

export type AtividadeCondominio = {
  condominio: string;
  id: string;
  itens: AtividadeItem[];
  erro: string | null;
};

export type GetAtividadeResult = {
  desde: string; // ISO
  geradoEm: string; // ISO
  data: AtividadeCondominio[];
  error: string | null;
};

// Mesma estratégia multi-token de notion.functions.ts: cada database responde
// só pra integração que tem acesso a ela (o Mobby, por ex., só pela _2).
function tokens(): string[] {
  return [
    process.env.NOTION_API_KEY,
    process.env.NOTION_API_KEY_2,
    process.env.NOTION_API_KEY_3,
  ].filter((t): t is string => !!t);
}

// Meia-noite de hoje em Brasília (UTC-3, sem horário de verão) menos
// (dias - 1) dias: dias=1 → "hoje", dias=2 → "ontem e hoje".
function inicioDoPeriodo(dias: number): Date {
  const agora = new Date();
  const brt = new Date(agora.getTime() - 3 * 3600_000);
  brt.setUTCHours(0, 0, 0, 0);
  brt.setUTCDate(brt.getUTCDate() - (dias - 1));
  return new Date(brt.getTime() + 3 * 3600_000);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function texto(prop: any): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((prop?.title ?? prop?.rich_text ?? []) as any[]).map((t) => t.plain_text ?? "").join("");
}

async function notion(token: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `Notion ${res.status}`);
  return json;
}

async function atividadeDoBanco(
  token: string,
  dbId: string,
  desde: string,
): Promise<AtividadeItem[]> {
  const itens: AtividadeItem[] = [];
  let cursor: string | undefined;
  do {
    const json = await notion(token, `databases/${dbId}/query`, {
      page_size: 100,
      filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: desde } },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const page of json.results ?? []) {
      const p = page.properties ?? {};
      const titulo = Object.values(p).find((v) => (v as { type?: string }).type === "title");
      itens.push({
        tarefa: texto(titulo) || "(sem título)",
        tipo: page.created_time >= desde ? "nova" : "editada",
        status: p["Status"]?.status?.name ?? p["Status"]?.select?.name ?? "",
        responsavel: (p["Responsável"]?.multi_select ?? [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((o: any) => o.name)
          .join(", "),
        quando: page.last_edited_time,
        url: page.url,
      });
    }
    cursor = json.has_more ? json.next_cursor : undefined;
  } while (cursor);
  return itens;
}

async function atividadeAnyToken(dbId: string, desde: string): Promise<AtividadeItem[]> {
  let ultimo: unknown = new Error("Nenhuma chave do Notion configurada.");
  for (const token of tokens()) {
    try {
      return await atividadeDoBanco(token, dbId, desde);
    } catch (err) {
      ultimo = err;
      // O registro às vezes guarda o link da PÁGINA do condomínio, não da
      // database (ver resolverDatabaseDaPagina em notion.functions.ts).
      if (err instanceof Error && err.message.includes("is a page, not a database")) {
        try {
          const filhos = await notion(token, `blocks/${dbId}/children?page_size=100`);
          const bloco = (filhos.results ?? []).find(
            (b: { type?: string }) => b.type === "child_database",
          );
          if (bloco) return await atividadeDoBanco(token, bloco.id, desde);
        } catch (err2) {
          ultimo = err2;
        }
      }
    }
  }
  throw ultimo;
}

export const getAtividade = createServerFn({ method: "GET" })
  .inputValidator((d: { dias: number }) => d)
  .handler(async ({ data }): Promise<GetAtividadeResult> => {
    const dias = Math.min(Math.max(Math.floor(data.dias) || 2, 1), 30);
    const desde = inicioDoPeriodo(dias).toISOString();
    const base = { desde, geradoEm: new Date().toISOString() };

    const session = await getSession<AuthSessionData>(getSessionConfig());
    if (!session.data.email) return { ...base, data: [], error: "Não autenticado." };

    const registro = await getCondominiosRegistry();
    if (registro.error) return { ...base, data: [], error: registro.error };

    const resultado: AtividadeCondominio[] = new Array(registro.data.length);
    let proximo = 0;
    // 6 bancos em paralelo — rápido sem estourar o limite de ~3 req/s do Notion
    // com folga (cada banco costuma ser 1 consulta só).
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (proximo < registro.data.length) {
          const i = proximo++;
          const c = registro.data[i];
          try {
            resultado[i] = {
              condominio: c.condominio,
              id: c.id,
              itens: await atividadeAnyToken(c.notionDatabaseId, desde),
              erro: null,
            };
          } catch (err) {
            resultado[i] = {
              condominio: c.condominio,
              id: c.id,
              itens: [],
              erro: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }),
    );
    return { ...base, data: resultado, error: null };
  });
