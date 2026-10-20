import { createServerFn } from "@tanstack/react-start";
import { getCondominiosRegistry } from "./sheets.functions";
import { slugify } from "./report-utils";

// Fallback legado (deploy single-tenant original, Miragio Cacupé) — usado só
// quando a planilha índice está vazia. Não é segredo (é só um ID de
// database, inútil sem o token), por isso tem valor padrão fixo em vez de
// exigir configuração em todo ambiente.
const NOTION_DATABASE_ID_LEGADO = "2113eaf518c583049f9a01672a68107f";

export type Demanda = {
  id: string;
  demanda: string;
  responsavel: string;
  status: string;
  prioridade: string;
  condominio: string;
  area: string;
  criadaEm: string | null;
  ultimaAtualizacao: string;
  historico: string;
  dataUltimaEdicao: string;
  url: string;
  ordem: number | null;
  previsao: string | null;
  dataPrevista: string | null;
  concluidoEm: string | null;
  situacaoPrazo: string | null;
};

export type GetDemandasResult = {
  data: Demanda[];
  error: string | null;
};

export type CondominioFetchError = {
  condominio: string;
  error: string;
};

export type GetAllDemandasResult = {
  data: Demanda[];
  errors: CondominioFetchError[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function richText(prop: any): string {
  if (!prop) return "";
  const arr = prop.rich_text ?? prop.title ?? [];
  return (
    arr
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((t: any) => t.plain_text ?? "")
      .join("")
      .trim()
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selectName(prop: any): string {
  return prop?.select?.name ?? "";
}

// "Status" pode ser um select clássico ou o tipo "status" mais novo do Notion
// (ex.: Vivendas Home Club) — o shape do JSON muda (`prop.status.name` em vez
// de `prop.select.name`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function statusValue(prop: any): string {
  return prop?.status?.name ?? prop?.select?.name ?? "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function multiSelectJoined(prop: any): string {
  if (!Array.isArray(prop?.multi_select)) return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prop.multi_select.map((s: any) => s.name).join(", ");
}

// Algumas bases (ex.: Vivendas Home Club) usam "Prioridade" como
// multi-seleção — junta os nomes numa string única ("Alta, Grande
// Investimento") pra manter o tipo `Demanda.prioridade` compatível; use
// `prioridadeList()` de report-utils.ts pra checar pertencimento.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function prioridadeValue(prop: any): string {
  if (!prop) return "";
  return multiSelectJoined(prop) || prop.select?.name || "";
}

// "Responsável"/"Pessoa" pode ser texto, pessoa (people), select ou
// multi-seleção dependendo do condomínio — normaliza pra string única.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function personValue(prop: any): string {
  if (!prop) return "";
  if (Array.isArray(prop.people)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return prop.people.map((p: any) => p.name ?? "").join(", ");
  }
  return multiSelectJoined(prop) || prop.select?.name || richText(prop);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function numberValue(prop: any): number | null {
  return typeof prop?.number === "number" ? prop.number : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dateValue(prop: any): string | null {
  return prop?.date?.start ?? null;
}

// "Criada em"/"Criado em" pode ser um campo de data manual ou o
// created_time automático do Notion (shape diferente: string direta, sem
// `.date.start`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createdValue(prop: any): string | null {
  if (!prop) return null;
  if (typeof prop.created_time === "string") return prop.created_time;
  return prop.date?.start ?? null;
}

// Campos "Data Prevista"/"Data Prevista de Conclusão" viraram fórmula em
// algumas bases — o resultado pode ser um valor de data (`formula.date`) ou
// texto já formatado (`formula.string`, ex.: "10/05/2026", como configuramos
// pro Miragio Cacupé), dependendo de como a fórmula foi escrita.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formulaValue(prop: any): string | null {
  const f = prop?.formula;
  if (!f) return null;
  if (f.type === "date") return f.date?.start ?? null;
  if (f.type === "string") return f.string ?? null;
  return null;
}

// Integrações do Notion são presas a um único workspace — não existe
// "compartilhar entre workspaces". Como os condomínios podem viver em
// workspaces diferentes (ex.: Jazz Club fica num workspace separado do
// Miragio/Vivendas), suportamos múltiplos tokens via env vars numeradas e
// tentamos cada um até um funcionar pra aquela database específica.
function getNotionTokens(): string[] {
  return [
    process.env.NOTION_API_KEY,
    process.env.NOTION_API_KEY_2,
    process.env.NOTION_API_KEY_3,
  ].filter((t): t is string => !!t);
}

// A planilha índice às vezes recebe o link da PÁGINA do condomínio em vez do
// link da database de tarefas (aconteceu com La Perle, 2026-10-19): a Notion
// responde 400 "is a page, not a database". Em vez de derrubar o condomínio,
// procura a database dentro da página e usa ela.
async function resolverDatabaseDaPagina(token: string, pageId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const bloco = (json.results ?? []).find((b: { type?: string }) => b.type === "child_database");
    return bloco?.id ?? null;
  } catch {
    return null;
  }
}

// Tenta cada token configurado até um conseguir ler a database (o erro
// "object_not_found" do Notion é o mesmo tanto pra ID errado quanto pra
// database de um workspace que aquele token não alcança — não dá pra
// distinguir os dois casos, então tentamos todos os tokens disponíveis).
async function fetchDemandasFromDbAnyToken(
  dbId: string,
  condominioOverride?: string,
): Promise<GetDemandasResult> {
  const tokens = getNotionTokens();
  if (tokens.length === 0) {
    return { data: [], error: "NOTION_API_KEY não configurada." };
  }
  let last: GetDemandasResult = { data: [], error: "NOTION_API_KEY não configurada." };
  for (const token of tokens) {
    last = await fetchDemandasFromDb(token, dbId, condominioOverride);
    if (!last.error) return last;
    if (last.error.includes("is a page, not a database")) {
      const dbDaPagina = await resolverDatabaseDaPagina(token, dbId);
      if (dbDaPagina) {
        last = await fetchDemandasFromDb(token, dbDaPagina, condominioOverride);
        if (!last.error) return last;
      }
    }
  }
  return last;
}

async function fetchDemandasFromDb(
  token: string,
  dbId: string,
  condominioOverride?: string,
): Promise<GetDemandasResult> {
  try {
    const all: Demanda[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;

      const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const txt = await res.text();
        return {
          data: [],
          error: `Notion API ${res.status}: ${txt.slice(0, 300)}`,
        };
      }

      const json = await res.json();

      for (const page of json.results ?? []) {
        const p = page.properties ?? {};
        all.push({
          id: page.id,
          demanda: richText(p["Demanda"]) || richText(p["Tarefas"]) || richText(p["TAREFAS"]) || "",
          // Sem valores inventados pra campo vazio (mesma regra de
          // scripts/capturar-historico-sheets.mjs) — o relatório mostra "—".
          responsavel: personValue(p["Pessoa"]) || personValue(p["Responsável"]) || "",
          status: statusValue(p["Status"]) || statusValue(p["Status "]) || "Não iniciado",
          prioridade: prioridadeValue(p["Prioridade"]) || "",
          condominio: condominioOverride || selectName(p["Condomínio"]) || "—",
          area:
            richText(p["Área"]) ||
            selectName(p["Área"]) ||
            multiSelectJoined(p["Setor/Demanda"]) ||
            multiSelectJoined(p["Setor"]) ||
            selectName(p["Setor"]) ||
            "",
          // Só "Data de Início" (data manual ou created_time automático), sem
          // cair pra "Criado em"/"Criada em" — igual ao Notion.
          criadaEm: createdValue(p["Data de Início"]) ?? dateValue(p["Início"]),
          ultimaAtualizacao:
            richText(p["Última Atualização"]) ||
            richText(p["Ùltima Atualização"]) ||
            richText(p["Última Ação"]),
          historico: richText(p["Histórico"]) || richText(p["Histórico/Evidências"]),
          dataUltimaEdicao: page.last_edited_time,
          url: page.url,
          ordem: numberValue(p["Ordem"]),
          previsao: dateValue(p["Previsão"]) ?? dateValue(p["Previsão (em dias)"]),
          dataPrevista:
            dateValue(p["Data Prevista"]) ??
            formulaValue(p["Data Prevista"]) ??
            formulaValue(p["Data Prevista de Conclusão"]),
          concluidoEm:
            dateValue(p["Concluído em"]) ??
            dateValue(p["Data de conclusão"]) ??
            dateValue(p["Data de Conclusão"]),
          situacaoPrazo:
            formulaValue(p["Situação do Prazo"]) || richText(p["Situação do Prazo"]) || null,
        });
      }

      hasMore = json.has_more;
      cursor = json.next_cursor ?? undefined;
    }

    return { data: all, error: null };
  } catch (e) {
    return {
      data: [],
      error: e instanceof Error ? e.message : "Erro desconhecido ao consultar o Notion",
    };
  }
}

// Mantida para compatibilidade (lê só a database única via env var) — usada
// enquanto um condomínio ainda não está cadastrado na planilha índice.
export const getDemandas = createServerFn({ method: "GET" }).handler(
  async (): Promise<GetDemandasResult> => {
    return fetchDemandasFromDbAnyToken(process.env.NOTION_DATABASE_ID ?? NOTION_DATABASE_ID_LEGADO);
  },
);

// Fluxo padrão do relatório: descobre os condomínios cadastrados na planilha
// índice e consulta a database Notion de cada um em paralelo. Se a planilha
// índice ainda não tiver nenhuma linha, cai de volta pra database única (env
// var), pra não quebrar o condomínio original enquanto os outros não são
// cadastrados. Falha em uma database não derruba as demais — cada erro fica
// isolado em `errors`, carimbado com o nome do condomínio.
export const getAllDemandas = createServerFn({ method: "GET" }).handler(
  async (): Promise<GetAllDemandasResult> => {
    if (getNotionTokens().length === 0) {
      return { data: [], errors: [{ condominio: "—", error: "NOTION_API_KEY não configurada." }] };
    }

    const registry = await getCondominiosRegistry();
    const entries =
      registry.data.length > 0
        ? registry.data.map((r) => ({ condominio: r.condominio, dbId: r.notionDatabaseId }))
        : [{ condominio: "", dbId: process.env.NOTION_DATABASE_ID ?? NOTION_DATABASE_ID_LEGADO }];

    if (entries.length === 0) {
      return {
        data: [],
        errors: [
          {
            condominio: "—",
            error: registry.error ?? "Nenhum condomínio cadastrado (planilha índice vazia).",
          },
        ],
      };
    }

    const results = await Promise.all(
      entries.map(async (entry) => ({
        condominio: entry.condominio,
        result: await fetchDemandasFromDbAnyToken(entry.dbId, entry.condominio || undefined),
      })),
    );

    const data: Demanda[] = [];
    const errors: CondominioFetchError[] = [];
    for (const { condominio, result } of results) {
      if (result.error) {
        errors.push({ condominio: condominio || "condomínio sem nome", error: result.error });
        continue;
      }
      data.push(...result.data);
    }

    return { data, errors };
  },
);

export type GetDemandasCondominioResult = GetDemandasResult & { condominio: string | null };

// Fluxo por página de condomínio: resolve o slug da URL (ex.: "vivendas-home-club")
// pra database Notion certa via planilha índice, e consulta só essa — não faz
// sentido buscar todas as databases pra renderizar a página de uma só.
export const getDemandasByCondominio = createServerFn({ method: "GET" })
  .validator((input: unknown) => input as { slug: string })
  .handler(async ({ data }): Promise<GetDemandasCondominioResult> => {
    if (getNotionTokens().length === 0) {
      return { data: [], error: "NOTION_API_KEY não configurada.", condominio: null };
    }

    const registry = await getCondominiosRegistry();
    const entry = registry.data.find((r) => r.id === data.slug);

    if (entry) {
      const result = await fetchDemandasFromDbAnyToken(entry.notionDatabaseId, entry.condominio);
      return { ...result, condominio: entry.condominio };
    }

    // Planilha índice ainda vazia — cai pro fallback legado de database única
    // e confirma que o nome do condomínio ali bate com o slug pedido.
    if (registry.data.length === 0) {
      const result = await fetchDemandasFromDbAnyToken(
        process.env.NOTION_DATABASE_ID ?? NOTION_DATABASE_ID_LEGADO,
      );
      const nomeReal = result.data[0]?.condominio ?? null;
      if (nomeReal && slugify(nomeReal) === data.slug) {
        return { ...result, condominio: nomeReal };
      }
    }

    return { data: [], error: `Condomínio "${data.slug}" não encontrado.`, condominio: null };
  });
