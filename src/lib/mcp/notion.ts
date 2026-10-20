// Server-only Notion data helper for MCP tools. Import lazily inside handlers.
// Duplicado (não importa de src/lib/notion.functions.ts) de propósito: esse
// arquivo não deve puxar as dependências do @tanstack/react-start pro bundle
// do endpoint MCP.

// Mesmos fallbacks fixos de src/lib/sheets.functions.ts e
// src/lib/notion.functions.ts (duplicados de propósito, ver comentário
// acima) — não são segredo, evita exigir env var em todo ambiente.
const REGISTRY_SPREADSHEET_ID_PADRAO = "1fEkPgTf6oGYknWEP6zzi8eyBTpoDDQR0goJg1D_Wed0";
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function prioridadeValue(prop: any): string {
  if (!prop) return "";
  return multiSelectJoined(prop) || prop.select?.name || "";
}
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
function createdValue(prop: any): string | null {
  if (!prop) return null;
  if (typeof prop.created_time === "string") return prop.created_time;
  return prop.date?.start ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dateValue(prop: any): string | null {
  return prop?.date?.start ?? null;
}

function extractNotionDatabaseId(url: string): string | null {
  const match = url.match(
    /[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/,
  );
  if (!match) return null;
  return match[0].replace(/-/g, "");
}

function parseCsvLine(line: string): string[] {
  // Split simples (sem suporte a vírgula dentro de aspas) — suficiente pro
  // registro, cujos valores (nome, URL) não costumam ter vírgula.
  return line.split(",").map((v) => v.replace(/^"|"$/g, "").trim());
}

async function fetchRegistryEntries(): Promise<{ condominio: string; dbId: string }[]> {
  const spreadsheetId = process.env.REGISTRY_SPREADSHEET_ID ?? REGISTRY_SPREADSHEET_ID_PADRAO;
  const gid = process.env.REGISTRY_GID ?? "0";
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const lines = (await res.text()).split(/\r?\n/).filter(Boolean);
  const [headerLine, ...rows] = lines;
  if (!headerLine) return [];
  const header = parseCsvLine(headerLine);
  const iCondominio = header.findIndex((h) => h === "Condomínio" || h === "Condominio");
  const iUrl = header.findIndex((h) => h === "URL");
  if (iCondominio === -1 || iUrl === -1) return [];

  const entries: { condominio: string; dbId: string }[] = [];
  for (const line of rows) {
    const cols = parseCsvLine(line);
    const condominio = cols[iCondominio] ?? "";
    const dbId = extractNotionDatabaseId(cols[iUrl] ?? "");
    if (!condominio || !dbId) continue;
    entries.push({ condominio, dbId });
  }
  return entries;
}

// Mesmo motivo do notion.functions.ts: integrações do Notion são presas a um
// único workspace, e condomínios podem viver em workspaces diferentes —
// tenta cada token configurado até um conseguir ler a database.
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

async function fetchDemandasFromDbAnyToken(
  dbId: string,
  condominioOverride?: string,
): Promise<{ data: Demanda[]; error: string | null }> {
  const tokens = getNotionTokens();
  if (tokens.length === 0) {
    return { data: [], error: "NOTION_API_KEY not configured" };
  }
  let last: { data: Demanda[]; error: string | null } = {
    data: [],
    error: "NOTION_API_KEY not configured",
  };
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
): Promise<{ data: Demanda[]; error: string | null }> {
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
        return { data: [], error: `Notion API ${res.status}: ${(await res.text()).slice(0, 300)}` };
      }
      const json = await res.json();
      for (const page of json.results ?? []) {
        const p = page.properties ?? {};
        all.push({
          id: page.id,
          demanda:
            richText(p["Demanda"]) ||
            richText(p["Tarefas"]) ||
            richText(p["TAREFAS"]) ||
            "(sem título)",
          responsavel: personValue(p["Pessoa"]) || personValue(p["Responsável"]) || "Não atribuído",
          status: statusValue(p["Status"]) || statusValue(p["Status "]) || "Não iniciado",
          prioridade: prioridadeValue(p["Prioridade"]) || "Baixa",
          condominio: condominioOverride || selectName(p["Condomínio"]) || "—",
          area:
            richText(p["Área"]) ||
            selectName(p["Área"]) ||
            multiSelectJoined(p["Setor/Demanda"]) ||
            multiSelectJoined(p["Setor"]) ||
            selectName(p["Setor"]) ||
            "Sem categoria",
          criadaEm:
            dateValue(p["Data de Início"]) ??
            dateValue(p["Início"]) ??
            createdValue(p["Criada em"]) ??
            createdValue(p["Criado em"]),
          ultimaAtualizacao: richText(p["Última Atualização"]) || richText(p["Última Ação"]),
          historico: richText(p["Histórico"]) || richText(p["Histórico/Evidências"]),
          dataUltimaEdicao: page.last_edited_time,
          url: page.url,
        });
      }
      hasMore = json.has_more;
      cursor = json.next_cursor ?? undefined;
    }
    return { data: all, error: null };
  } catch (e) {
    return { data: [], error: e instanceof Error ? e.message : "Unknown error" };
  }
}

// Agrega todos os condomínios cadastrados na planilha índice; sem registro
// configurado, cai pra database única (env var), igual ao relatório web.
export async function fetchDemandas(): Promise<{ data: Demanda[]; error: string | null }> {
  if (getNotionTokens().length === 0) {
    return { data: [], error: "NOTION_API_KEY not configured" };
  }

  const registryEntries = await fetchRegistryEntries();
  const entries =
    registryEntries.length > 0
      ? registryEntries
      : [{ condominio: "", dbId: process.env.NOTION_DATABASE_ID ?? NOTION_DATABASE_ID_LEGADO }];

  if (entries.length === 0) {
    return { data: [], error: "No condominium registered (empty index sheet / env var)" };
  }

  const results = await Promise.all(
    entries.map((e) => fetchDemandasFromDbAnyToken(e.dbId, e.condominio || undefined)),
  );

  const data: Demanda[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.error) {
      errors.push(`${entries[i].condominio || "(single)"}: ${r.error}`);
      return;
    }
    data.push(...r.data);
  });

  // Erro em uma database isolada não derruba o resultado todo — só reporta
  // erro "fatal" quando nenhum condomínio pôde ser lido.
  return { data, error: data.length === 0 && errors.length > 0 ? errors.join(" | ") : null };
}
