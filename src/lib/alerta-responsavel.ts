// Alertar Tarefas de um Responsável: quando uma tarefa em que alguém que a
// pessoa acompanha é "Responsável" muda no Notion, o bot avisa no Telegram o
// que mudou (valor antigo → novo), quando mudou e de qual condomínio é.
//
// Três peças, todas neste arquivo (o script de sincronização em
// scripts/sincronizar-responsaveis.mjs importa daqui, por isso nada de
// import de "@/..."):
//   1. Banco de Responsáveis (Notion): cadastro único de quem aparece no
//      campo Responsável dos 29 condomínios — o mesmo nome em vários
//      condomínios vira UMA linha, e cada usuário do bot escolhe quais
//      responsáveis acompanhar (relação "Responsáveis que acompanho" na base
//      "Telegram").
//   2. Retratos das tarefas (aba "_retratos" da planilha): a Notion não expõe
//      o valor antigo de uma propriedade (nem no webhook nem na API — ver nota
//      em preencherDataConclusaoSeNecessario, webhooks/notion.ts), então
//      guardamos um retrato de cada tarefa e comparamos com o novo a cada
//      evento.
//   3. tratarEventoAlertaResponsavel: chamado pelo webhook do Notion a cada
//      evento de página.
//
// Roda em edge (Cloudflare via Nitro) e em Node 22: só fetch/Web APIs.

export const NOTION_VERSION = "2022-06-28";
export const TELEGRAM_DB_ID = "3dae69ba114f812eb8b7f78e6d98c9f5";
export const RESPONSAVEIS_DB_ID = "f68f926a514547778301134a960454ea";
// Propriedades de relação na base "Telegram" (criadas junto com o Banco de
// Responsáveis, ver a relação dupla "Acompanhado por" / "Usuário do bot").
export const PROP_ACOMPANHO = "Responsáveis que acompanho";
export const PROP_VINCULADO = "Responsável vinculado";
const RETRATOS_SHEET_NAME = "_retratos";

// Cada valor guardado no retrato é cortado aqui — uma célula do Sheets
// aceita 50 mil caracteres e "Histórico" pode ser longo.
const MAX_CHARS_VALOR = 400;
// Limite do Telegram é 4096 por mensagem; sobra folga pro cabeçalho.
const MAX_CHARS_MENSAGEM = 3800;

// ---------------------------------------------------------------------------
// Retrato da tarefa (propriedade -> texto de exibição)
// ---------------------------------------------------------------------------

export type Retrato = {
  titulo: string;
  responsaveis: string[];
  // Ids de usuário do Notion quando o campo Responsável é do tipo Pessoa.
  responsaveisIds?: string[];
  // Nome da propriedade -> valor como texto. Só propriedades que a pessoa
  // edita: fórmulas ("Situação do Prazo" muda todo dia sozinha), rollups e
  // metadados automáticos ficam de fora pra não gerar alerta falso.
  props: Record<string, string>;
};

export type PropNotion = {
  type: string;
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  select?: { name: string } | null;
  multi_select?: { name: string }[];
  status?: { name: string } | null;
  people?: { id?: string; name?: string }[];
  date?: { start: string; end?: string | null } | null;
  number?: number | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  files?: { name: string }[];
  relation?: { id: string }[];
};

const TIPOS_IGNORADOS = new Set([
  "formula",
  "rollup",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "unique_id",
  "relation",
  "button",
  "verification",
]);

// "2026-09-29" -> "29/09/2026"; datetime ISO -> "29/09/2026 14:32" (fuso de
// São Paulo, que é onde as síndicas estão).
export function formatarDataNotion(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [a, m, d] = iso.split("-");
    return `${d}/${m}/${a}`;
  }
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return iso;
  return formatarQuando(data);
}

export function formatarQuando(data: Date): string {
  const partes = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(data);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? "";
  return `${p("day")}/${p("month")}/${p("year")} ${p("hour")}:${p("minute")}`;
}

export function textoDaPropriedade(prop: PropNotion): string {
  switch (prop.type) {
    case "title":
      return (prop.title ?? []).map((t) => t.plain_text).join("");
    case "rich_text":
      return (prop.rich_text ?? []).map((t) => t.plain_text).join("");
    case "select":
      return prop.select?.name ?? "";
    case "multi_select":
      return (prop.multi_select ?? []).map((o) => o.name).join(", ");
    case "status":
      return prop.status?.name ?? "";
    case "people":
      return (prop.people ?? [])
        .map((p) => p.name)
        .filter(Boolean)
        .join(", ");
    case "date": {
      if (!prop.date?.start) return "";
      const ini = formatarDataNotion(prop.date.start);
      return prop.date.end ? `${ini} → ${formatarDataNotion(prop.date.end)}` : ini;
    }
    case "number":
      return prop.number == null ? "" : String(prop.number);
    case "checkbox":
      return prop.checkbox ? "Sim" : "Não";
    case "url":
      return prop.url ?? "";
    case "email":
      return prop.email ?? "";
    case "phone_number":
      return prop.phone_number ?? "";
    case "files":
      return (prop.files ?? []).map((f) => f.name).join(", ");
    default:
      return "";
  }
}

function cortar(texto: string, max: number): string {
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
}

// Nomes de quem está no "Responsável", em qualquer tipo de propriedade que
// as databases dos condomínios usam (people, multi_select, select, texto).
// Em "Jean/Juliano" a barra separa duas pessoas — o banco cadastra cada uma.
export function nomesResponsaveis(prop: PropNotion | undefined): string[] {
  if (!prop) return [];
  const texto = textoDaPropriedade(prop);
  if (!texto) return [];
  return texto
    .split(/[,/;]/)
    .map((n) => n.trim())
    .filter(Boolean);
}

export function idsUsuariosResponsaveis(prop: PropNotion | undefined): string[] {
  if (prop?.type !== "people") return [];
  return (prop.people ?? []).map((p) => p.id ?? "").filter(Boolean);
}

export function montarRetrato(properties: Record<string, PropNotion>): Retrato {
  const props: Record<string, string> = {};
  let titulo = "";
  for (const [nome, prop] of Object.entries(properties)) {
    if (prop.type === "title") titulo = textoDaPropriedade(prop);
    if (TIPOS_IGNORADOS.has(prop.type)) continue;
    props[nome] = cortar(textoDaPropriedade(prop), MAX_CHARS_VALOR);
  }
  return {
    titulo: titulo || "(sem título)",
    responsaveis: nomesResponsaveis(properties["Responsável"]),
    responsaveisIds: idsUsuariosResponsaveis(properties["Responsável"]),
    props,
  };
}

// ---------------------------------------------------------------------------
// Comparação
// ---------------------------------------------------------------------------

export type Mudanca = { campo: string; antes: string; depois: string };

export function compararRetratos(antigo: Retrato, novo: Retrato): Mudanca[] {
  const mudancas: Mudanca[] = [];
  const campos = new Set([...Object.keys(antigo.props), ...Object.keys(novo.props)]);
  for (const campo of campos) {
    const antes = antigo.props[campo] ?? "";
    const depois = novo.props[campo] ?? "";
    if (antes !== depois) mudancas.push({ campo, antes, depois });
  }
  return mudancas;
}

export function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

export function semTracos(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Banco de Responsáveis (Notion)
// ---------------------------------------------------------------------------

export type TipoResponsavel = "Pessoa da equipe" | "Grupo" | "Empresa" | "";

export type Responsavel = {
  id: string;
  nome: string;
  tipo: TipoResponsavel;
  estado: string;
  apelidos: string[];
  usuariosNotion: string[];
  condominios: string;
};

type PaginaBanco = { id: string; properties: Record<string, PropNotion> };

export async function notionReq(
  chave: string,
  caminho: string,
  init: RequestInit = {},
  tentativa = 0,
): Promise<Response> {
  const res = await fetch(`https://api.notion.com/v1/${caminho}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${chave}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  // Limite de taxa do Notion (~3 req/s): espera o que ele pedir e tenta de novo.
  if (res.status === 429 && tentativa < 3) {
    const espera = Number(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, Math.max(1, espera) * 1000));
    return notionReq(chave, caminho, init, tentativa + 1);
  }
  return res;
}

function listaPorVirgula(texto: string): string[] {
  return texto
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Sem `incluirInativos`, é a lista que o bot mostra. Com ele, é o cadastro
// completo: quem reconhece nomes (webhook e sincronização) precisa enxergar
// também os inativos, senão recriaria como "A classificar" um nome que a
// equipe já arquivou de propósito.
export async function listarResponsaveis(
  chave: string,
  opcoes: { incluirInativos?: boolean } = {},
): Promise<Responsavel[]> {
  const lista: Responsavel[] = [];
  let cursor: string | undefined;
  do {
    const res = await notionReq(chave, `databases/${RESPONSAVEIS_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!res.ok) {
      throw new Error(`Banco de Responsáveis: HTTP ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      results: PaginaBanco[];
      has_more: boolean;
      next_cursor: string | null;
    };
    for (const p of json.results) {
      const estado = p.properties["Estado"]?.select?.name ?? "";
      if (estado === "Inativo" && !opcoes.incluirInativos) continue;
      const nome = textoDaPropriedade(p.properties["Nome"] ?? { type: "" }).trim();
      if (!nome) continue;
      lista.push({
        id: p.id,
        nome,
        tipo: (p.properties["Tipo"]?.select?.name ?? "") as TipoResponsavel,
        estado,
        apelidos: listaPorVirgula(textoDaPropriedade(p.properties["Apelidos"] ?? { type: "" })),
        usuariosNotion: listaPorVirgula(
          textoDaPropriedade(p.properties["Usuário Notion"] ?? { type: "" }),
        ),
        condominios: textoDaPropriedade(p.properties["Condomínios"] ?? { type: "" }),
      });
    }
    cursor = json.has_more ? (json.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return lista;
}

// Pessoas primeiro, depois grupos, depois empresas; dentro de cada um, ordem
// alfabética. Linha ainda sem Tipo ("A classificar") conta como pessoa.
export function ordenarResponsaveis(lista: Responsavel[]): Responsavel[] {
  const rank = (r: Responsavel) => (r.tipo === "Grupo" ? 1 : r.tipo === "Empresa" ? 2 : 0);
  return [...lista].sort(
    (a, b) => rank(a) - rank(b) || a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }),
  );
}

export type IndiceResponsaveis = {
  porNome: Map<string, string[]>; // nome/apelido normalizado -> ids de responsáveis
  porUsuario: Map<string, string>; // id de usuário do Notion (sem traços) -> id
};

export function indexarResponsaveis(lista: Responsavel[]): IndiceResponsaveis {
  const porNome = new Map<string, string[]>();
  const porUsuario = new Map<string, string>();
  for (const r of lista) {
    for (const chave of [r.nome, ...r.apelidos].map(normalizar).filter(Boolean)) {
      const ids = porNome.get(chave) ?? [];
      if (!ids.includes(r.id)) ids.push(r.id);
      porNome.set(chave, ids);
    }
    for (const u of r.usuariosNotion) porUsuario.set(semTracos(u), r.id);
  }
  return { porNome, porUsuario };
}

// Quem, no banco, corresponde a esses nomes/ids de usuário do Notion.
export function resolverResponsaveis(
  indice: IndiceResponsaveis,
  nomes: string[],
  idsUsuarios: string[] = [],
): { ids: Set<string>; semCadastro: string[] } {
  const ids = new Set<string>();
  const semCadastro: string[] = [];
  for (const u of idsUsuarios) {
    const achado = indice.porUsuario.get(semTracos(u));
    if (achado) ids.add(achado);
  }
  for (const nome of nomes) {
    const achados = indice.porNome.get(normalizar(nome));
    if (achados) achados.forEach((id) => ids.add(id));
    else semCadastro.push(nome);
  }
  return { ids, semCadastro };
}

export async function criarResponsavel(
  chave: string,
  dados: { nome: string; condominios?: string; usuarioNotion?: string },
): Promise<string | null> {
  const propriedades: Record<string, unknown> = {
    Nome: { title: [{ text: { content: dados.nome } }] },
    Estado: { select: { name: "A classificar" } },
  };
  if (dados.condominios) {
    propriedades["Condomínios"] = {
      rich_text: [{ text: { content: cortar(dados.condominios, 1900) } }],
    };
  }
  if (dados.usuarioNotion) {
    propriedades["Usuário Notion"] = {
      rich_text: [{ text: { content: dados.usuarioNotion } }],
    };
  }
  const res = await notionReq(chave, "pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: RESPONSAVEIS_DB_ID },
      properties: propriedades,
    }),
  });
  if (!res.ok) {
    console.warn(`alerta-responsavel: criar responsável "${dados.nome}": HTTP ${res.status}`);
    return null;
  }
  return ((await res.json()) as { id: string }).id;
}

export async function atualizarCondominiosResponsavel(
  chave: string,
  id: string,
  condominios: string,
): Promise<void> {
  await notionReq(chave, `pages/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        Condomínios: { rich_text: [{ text: { content: cortar(condominios, 1900) } }] },
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Quem acompanha quem (base "Telegram")
// ---------------------------------------------------------------------------

export type Seguidora = { chatId: number; nome: string; acompanha: string[] };

export async function seguidoras(chave: string): Promise<Seguidora[]> {
  const lista: Seguidora[] = [];
  let cursor: string | undefined;
  do {
    const res = await notionReq(chave, `databases/${TELEGRAM_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify({
        page_size: 100,
        filter: { property: PROP_ACOMPANHO, relation: { is_not_empty: true } },
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    // 400 = a relação ainda não existe na base; ninguém acompanha ninguém.
    if (!res.ok) return lista;
    const json = (await res.json()) as {
      results: { properties: Record<string, PropNotion> }[];
      has_more: boolean;
      next_cursor: string | null;
    };
    for (const page of json.results) {
      const props = page.properties;
      const chatId = Number(textoDaPropriedade(props["Telegram Chat ID"] ?? { type: "" }));
      const nome = Object.values(props)
        .filter((p) => p.type === "title")
        .map(textoDaPropriedade)
        .join("");
      const acompanha = (props[PROP_ACOMPANHO]?.relation ?? []).map((r) => semTracos(r.id));
      if (chatId && acompanha.length > 0) lista.push({ chatId, nome, acompanha });
    }
    cursor = json.has_more ? (json.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return lista;
}

// ---------------------------------------------------------------------------
// Mensagem
// ---------------------------------------------------------------------------

export type DadosAviso = {
  condominio: string;
  tarefa: string;
  responsaveis: string[];
  // Nomes dos responsáveis que ESTA pessoa acompanha nessa tarefa.
  acompanha: string[];
  quando: Date;
  quem: string;
  tipo: "criada" | "alterada";
  mudancas: Mudanca[];
  // Só na criação: resumo dos campos preenchidos.
  campos?: Record<string, string>;
};

function vazio(v: string): string {
  return v === "" ? "(vazio)" : v;
}

export function montarMensagemAviso(d: DadosAviso): string {
  const linhas: string[] = [];
  linhas.push(d.tipo === "criada" ? "🆕 Nova tarefa" : "🔔 Tarefa alterada");
  linhas.push(`🏢 ${d.condominio}`);
  linhas.push(`📋 ${d.tarefa}`);
  if (d.responsaveis.length > 0) linhas.push(`👤 Responsável: ${d.responsaveis.join(", ")}`);
  linhas.push(`🕒 ${formatarQuando(d.quando)}`);
  linhas.push(`✍️ ${d.quem}`);
  linhas.push("");

  if (d.tipo === "criada") {
    linhas.push("Informações:");
    for (const [campo, valor] of Object.entries(d.campos ?? {})) {
      if (valor && campo !== "Tarefas") linhas.push(`• ${campo}: ${valor}`);
    }
  } else {
    linhas.push("O que mudou:");
    for (const m of d.mudancas) {
      linhas.push(`• ${m.campo}: ${vazio(m.antes)} → ${vazio(m.depois)}`);
    }
  }
  if (d.acompanha.length > 0) {
    linhas.push("");
    linhas.push(`👁 Você acompanha: ${d.acompanha.join(", ")}`);
  }

  const texto = linhas.join("\n");
  return texto.length > MAX_CHARS_MENSAGEM ? `${texto.slice(0, MAX_CHARS_MENSAGEM - 1)}…` : texto;
}

// ---------------------------------------------------------------------------
// Retratos na planilha (aba "_retratos": A = page id, B = JSON, C = quando)
// ---------------------------------------------------------------------------

export type ContextoSheets = { token: string; spreadsheetId: string };

async function garantirAbaRetratos(ctx: ContextoSheets): Promise<void> {
  // "already exists" é o caso normal depois da primeira vez — mesmo padrão
  // de garantirAbaWebhook em webhooks/notion.ts.
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: RETRATOS_SHEET_NAME } } }],
    }),
  });
}

// Só a coluna A (ids) pra achar a linha, e depois só a célula B daquela
// linha — a aba tem uma linha por tarefa dos 29 condomínios, ler tudo a cada
// evento seria pesado.
export async function idsDosRetratos(ctx: ContextoSheets): Promise<string[]> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values/${encodeURIComponent(`'${RETRATOS_SHEET_NAME}'!A:A`)}`,
    { headers: { Authorization: `Bearer ${ctx.token}` } },
  );
  if (!res.ok) return []; // aba ainda não existe
  const json = (await res.json()) as { values?: string[][] };
  return (json.values ?? []).map((l) => l[0] ?? "");
}

async function lerRetrato(
  ctx: ContextoSheets,
  pageId: string,
): Promise<{ linha: number; retrato: Retrato } | null> {
  const ids = await idsDosRetratos(ctx);
  const indice = ids.indexOf(pageId);
  if (indice < 0) return null;
  const linha = indice + 1;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values/${encodeURIComponent(`'${RETRATOS_SHEET_NAME}'!B${linha}`)}`,
    { headers: { Authorization: `Bearer ${ctx.token}` } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { values?: string[][] };
  try {
    return { linha, retrato: JSON.parse(json.values?.[0]?.[0] ?? "") as Retrato };
  } catch {
    return { linha, retrato: { titulo: "", responsaveis: [], props: {} } };
  }
}

export async function anexarRetratos(
  ctx: ContextoSheets,
  itens: { pageId: string; retrato: Retrato }[],
): Promise<void> {
  if (itens.length === 0) return;
  await garantirAbaRetratos(ctx);
  const agora = new Date().toISOString();
  const faixa = encodeURIComponent(`'${RETRATOS_SHEET_NAME}'!A:C`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values/${faixa}:append?valueInputOption=RAW`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        values: itens.map((i) => [i.pageId, JSON.stringify(i.retrato), agora]),
      }),
    },
  );
  if (!res.ok) throw new Error(`Sheets (anexar retratos): ${res.status} ${await res.text()}`);
}

async function atualizarRetrato(
  ctx: ContextoSheets,
  pageId: string,
  retrato: Retrato,
  linha: number,
): Promise<void> {
  const faixa = encodeURIComponent(`'${RETRATOS_SHEET_NAME}'!A${linha}:C${linha}`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values/${faixa}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        values: [[pageId, JSON.stringify(retrato), new Date().toISOString()]],
      }),
    },
  );
  if (!res.ok) throw new Error(`Sheets (atualizar retrato): ${res.status} ${await res.text()}`);
}

async function nomeDoCondominioNaPlanilha(
  ctx: ContextoSheets,
  databaseId: string,
): Promise<string | null> {
  const alvo = semTracos(databaseId);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values/${encodeURIComponent("'_configuracao'!A2:B")}`,
    { headers: { Authorization: `Bearer ${ctx.token}` } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { values?: string[][] };
  for (const row of json.values ?? []) {
    const m = String(row[1] ?? "").match(
      /[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/,
    );
    if (m && semTracos(m[0]) === alvo && row[0]) return String(row[0]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function enviarAvisoTelegram(
  chatId: number,
  texto: string,
  urlTarefa: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN_ALERTAS;
  if (!token) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: texto,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Abrir tarefa", url: urlTarefa }],
          [{ text: "🔙 Voltar ao início", callback_data: "inicio" }],
        ],
      },
    }),
  });
  if (!res.ok) {
    console.warn(`alerta-responsavel: Telegram ${res.status} para ${chatId}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Ponto de entrada (chamado por webhooks/notion.ts a cada evento de página)
// ---------------------------------------------------------------------------

type PaginaNotion = {
  id: string;
  url?: string;
  parent?: { type?: string; database_id?: string };
  properties: Record<string, PropNotion>;
};

async function buscarNomeAutor(
  autorId: string | undefined,
  tokens: string[],
): Promise<string | null> {
  if (!autorId) return null;
  for (const token of tokens) {
    const res = await fetch(`https://api.notion.com/v1/users/${autorId}`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
    });
    if (!res.ok) continue;
    const u = (await res.json()) as { name?: string; type?: string };
    if (u.name) return u.type === "bot" ? `${u.name} (automático)` : u.name;
  }
  return null;
}

export async function tratarEventoAlertaResponsavel(args: {
  evento: {
    type?: string;
    timestamp?: string;
    entity?: { id?: string; type?: string };
    authors?: { id?: string; type?: string }[];
  };
  tokensNotion: string[];
  sheets: ContextoSheets | null;
}): Promise<void> {
  const { evento, tokensNotion, sheets } = args;
  const pageId = evento.entity?.type === "page" ? evento.entity.id : undefined;
  if (!pageId || !sheets) return;
  const tipoEvento = evento.type ?? "";
  if (!tipoEvento.startsWith("page.")) return;
  if (tipoEvento === "page.deleted" || tipoEvento === "page.content_updated") return;

  let pagina: PaginaNotion | null = null;
  for (const token of tokensNotion) {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
    });
    if (res.ok) {
      pagina = (await res.json()) as PaginaNotion;
      break;
    }
  }
  if (!pagina || pagina.parent?.type !== "database_id") return;

  // Só linhas de tarefa: as bases de condomínio têm "Status" (status) e
  // "Responsável". Isso deixa de fora, por exemplo, a base "Telegram", o
  // Banco de Responsáveis e a de sessões do bot (que mudam a cada mensagem e
  // encheriam a planilha).
  const props = pagina.properties;
  if (props["Status"]?.type !== "status" || !props["Responsável"]) return;

  const novo = montarRetrato(props);
  const chaveNotion = process.env.NOTION_API_KEY_ALERTAS;
  const databaseId = pagina.parent.database_id ?? "";

  // Banco de responsáveis: cadastra nomes que ainda não existem (entram como
  // "A classificar" e já aparecem na lista do bot) e descobre a quem a
  // tarefa pertence.
  let indice: IndiceResponsaveis | null = null;
  let banco: Responsavel[] = [];
  if (chaveNotion) {
    try {
      banco = await listarResponsaveis(chaveNotion, { incluirInativos: true });
      indice = indexarResponsaveis(banco);
      const { semCadastro } = resolverResponsaveis(indice, novo.responsaveis, novo.responsaveisIds);
      const condominio =
        novo.props["Condomínio"] || (await nomeDoCondominioNaPlanilha(sheets, databaseId)) || "";
      const jaCriados = new Set<string>();
      for (const nome of semCadastro) {
        if (jaCriados.has(normalizar(nome))) continue;
        jaCriados.add(normalizar(nome));
        const id = await criarResponsavel(chaveNotion, { nome, condominios: condominio });
        if (id)
          banco.push({
            id,
            nome,
            tipo: "",
            estado: "A classificar",
            apelidos: [],
            usuariosNotion: [],
            condominios: condominio,
          });
      }
      indice = indexarResponsaveis(banco);
    } catch (err) {
      console.warn("alerta-responsavel: falha ao consultar o Banco de Responsáveis:", err);
    }
  }

  const anterior = await lerRetrato(sheets, pageId);
  const criada = tipoEvento === "page.created";
  const mudancas = anterior ? compararRetratos(anterior.retrato, novo) : [];
  const semNovidade = anterior ? mudancas.length === 0 : !criada;

  if (anterior && mudancas.length > 0) {
    await atualizarRetrato(sheets, pageId, novo, anterior.linha);
  } else if (!anterior) {
    // Primeira vez que vemos essa tarefa: não há como saber o que mudou,
    // então só guarda o retrato pra comparar da próxima vez.
    await anexarRetratos(sheets, [{ pageId, retrato: novo }]);
  }
  if (semNovidade || !indice || !chaveNotion) return;
  if (criada && novo.titulo === "(sem título)") return;

  // Quem é (ou era) responsável: quem foi tirado da tarefa também precisa
  // saber.
  const envolvidos = resolverResponsaveis(
    indice,
    [...novo.responsaveis, ...(anterior?.retrato.responsaveis ?? [])],
    [...(novo.responsaveisIds ?? []), ...(anterior?.retrato.responsaveisIds ?? [])],
  ).ids;
  if (envolvidos.size === 0) return;

  const todas = await seguidoras(chaveNotion);
  const envolvidosSemTracos = new Set([...envolvidos].map(semTracos));
  const nomePorId = new Map(banco.map((r) => [semTracos(r.id), r.nome]));
  const destinatarias = todas
    .map((s) => ({
      ...s,
      motivo: s.acompanha.filter((id) => envolvidosSemTracos.has(id)),
    }))
    .filter((s) => s.motivo.length > 0);
  if (destinatarias.length === 0) return;

  const condominio =
    novo.props["Condomínio"] ||
    (await nomeDoCondominioNaPlanilha(sheets, databaseId)) ||
    "Condomínio não identificado";
  const quem = (await buscarNomeAutor(evento.authors?.[0]?.id, tokensNotion)) ?? "Alguém da equipe";
  const quando = evento.timestamp ? new Date(evento.timestamp) : new Date();
  const url = pagina.url ?? `https://www.notion.so/${semTracos(pageId)}`;

  for (const s of destinatarias) {
    const texto = montarMensagemAviso({
      condominio,
      tarefa: novo.titulo,
      responsaveis: novo.responsaveis,
      acompanha: s.motivo.map((id) => nomePorId.get(id) ?? "").filter(Boolean),
      quando: Number.isNaN(quando.getTime()) ? new Date() : quando,
      quem,
      tipo: criada && !anterior ? "criada" : "alterada",
      mudancas,
      campos: novo.props,
    });
    await enviarAvisoTelegram(s.chatId, texto, url);
  }
}
