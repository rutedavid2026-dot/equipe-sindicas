// Alerta de alteração em tarefa: quando uma tarefa em que a pessoa é
// "Responsável" muda no Notion, o bot avisa no Telegram o que mudou (valor
// antigo → novo), quando mudou e de qual condomínio é.
//
// Chamado por src/routes/webhooks/notion.ts a cada evento de página. A Notion
// não expõe o valor antigo de uma propriedade (nem no webhook nem na API —
// ver nota em preencherDataConclusaoSeNecessario), então guardamos um
// "retrato" de cada tarefa na aba "_retratos" da planilha e comparamos o
// retrato novo com o anterior a cada evento.
//
// Roda em edge (Cloudflare via Nitro): só fetch/Web APIs, sem node:*.

export const NOTION_VERSION = "2022-06-28";
export const TELEGRAM_DB_ID = "3dae69ba114f812eb8b7f78e6d98c9f5";
export const PROP_ALERTAR_MINHAS = "Alertar Minhas Tarefas";
export const PROP_NOMES_RESPONSAVEL = "Nomes de Responsável";
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
  // Nome da propriedade -> valor como texto. Só propriedades que a pessoa
  // edita: fórmulas ("Situação do Prazo" muda todo dia sozinha), rollups e
  // metadados automáticos ficam de fora pra não gerar alerta falso.
  props: Record<string, string>;
};

type PropNotion = {
  type: string;
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  select?: { name: string } | null;
  multi_select?: { name: string }[];
  status?: { name: string } | null;
  people?: { name?: string }[];
  date?: { start: string; end?: string | null } | null;
  number?: number | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  files?: { name: string }[];
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

function textoDaPropriedade(prop: PropNotion): string {
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
export function nomesResponsaveis(prop: PropNotion | undefined): string[] {
  if (!prop) return [];
  const texto = textoDaPropriedade(prop);
  if (!texto) return [];
  // Em "Jean/Juliano" a barra separa duas pessoas.
  return texto
    .split(/[,/;]/)
    .map((n) => n.trim())
    .filter(Boolean);
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
    props,
  };
}

// ---------------------------------------------------------------------------
// Comparação e "é uma tarefa dessa pessoa?"
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

// A pessoa cadastrou um ou mais nomes (ex.: "Roberto"). Uma tarefa é dela se
// algum responsável tem exatamente esse nome, ou se o nome dela aparece como
// palavra inteira no responsável ("Roberto Silva" casa com "Roberto";
// "Robertson" não casa).
export function ehResponsavel(nomesDaPessoa: string[], responsaveis: string[]): boolean {
  const alvos = nomesDaPessoa.map(normalizar).filter(Boolean);
  if (alvos.length === 0) return false;
  return responsaveis.some((resp) => {
    const r = normalizar(resp);
    return alvos.some((alvo) => r === alvo || ` ${r} `.includes(` ${alvo} `));
  });
}

// ---------------------------------------------------------------------------
// Mensagem
// ---------------------------------------------------------------------------

export type DadosAviso = {
  condominio: string;
  tarefa: string;
  url: string;
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
  linhas.push(d.tipo === "criada" ? "🆕 Nova tarefa sua" : "🔔 Tarefa sua foi alterada");
  linhas.push(`🏢 ${d.condominio}`);
  linhas.push(`📋 ${d.tarefa}`);
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

  const texto = linhas.join("\n");
  return texto.length > MAX_CHARS_MENSAGEM ? `${texto.slice(0, MAX_CHARS_MENSAGEM - 1)}…` : texto;
}

// ---------------------------------------------------------------------------
// Retratos na planilha (aba "_retratos": A = page id, B = JSON, C = quando)
// ---------------------------------------------------------------------------

type ContextoSheets = { token: string; spreadsheetId: string };

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

async function lerRetrato(
  ctx: ContextoSheets,
  pageId: string,
): Promise<{ linha: number; retrato: Retrato } | null> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values/${encodeURIComponent(`'${RETRATOS_SHEET_NAME}'!A:B`)}`,
    { headers: { Authorization: `Bearer ${ctx.token}` } },
  );
  if (!res.ok) return null; // aba ainda não existe
  const json = (await res.json()) as { values?: string[][] };
  const linhas = json.values ?? [];
  for (let i = 0; i < linhas.length; i++) {
    if (linhas[i][0] === pageId) {
      try {
        return { linha: i + 1, retrato: JSON.parse(linhas[i][1] ?? "") as Retrato };
      } catch {
        return { linha: i + 1, retrato: { titulo: "", responsaveis: [], props: {} } };
      }
    }
  }
  return null;
}

async function gravarRetrato(
  ctx: ContextoSheets,
  pageId: string,
  retrato: Retrato,
  linhaExistente: number | null,
): Promise<void> {
  const valores = [[pageId, JSON.stringify(retrato), new Date().toISOString()]];
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values`;
  const cabecalhos = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  if (linhaExistente) {
    const faixa = encodeURIComponent(
      `'${RETRATOS_SHEET_NAME}'!A${linhaExistente}:C${linhaExistente}`,
    );
    const res = await fetch(`${base}/${faixa}?valueInputOption=RAW`, {
      method: "PUT",
      headers: cabecalhos,
      body: JSON.stringify({ values: valores }),
    });
    if (!res.ok) throw new Error(`Sheets (atualizar retrato): ${res.status} ${await res.text()}`);
    return;
  }
  await garantirAbaRetratos(ctx);
  const faixa = encodeURIComponent(`'${RETRATOS_SHEET_NAME}'!A:C`);
  const res = await fetch(`${base}/${faixa}:append?valueInputOption=RAW`, {
    method: "POST",
    headers: cabecalhos,
    body: JSON.stringify({ values: valores }),
  });
  if (!res.ok) throw new Error(`Sheets (gravar retrato): ${res.status} ${await res.text()}`);
}

async function nomeDoCondominioNaPlanilha(
  ctx: ContextoSheets,
  databaseId: string,
): Promise<string | null> {
  const alvo = databaseId.replace(/-/g, "").toLowerCase();
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
    if (m && m[0].replace(/-/g, "").toLowerCase() === alvo && row[0]) return String(row[0]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Quem quer ser avisada (base "Telegram")
// ---------------------------------------------------------------------------

type PessoaAlvo = { chatId: number; nomes: string[] };

function chaveTelegramNotion(): string | null {
  return process.env.NOTION_API_KEY_ALERTAS ?? null;
}

async function pessoasComAlertaMinhasTarefas(): Promise<PessoaAlvo[]> {
  const chave = chaveTelegramNotion();
  if (!chave) return [];
  const res = await fetch(`https://api.notion.com/v1/databases/${TELEGRAM_DB_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${chave}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filter: { property: PROP_ALERTAR_MINHAS, checkbox: { equals: true } } }),
  });
  // 400 aqui = a propriedade ainda não existe (ninguém ativou o alerta).
  if (!res.ok) return [];
  const json = (await res.json()) as {
    results: { properties: Record<string, PropNotion> }[];
  };
  const pessoas: PessoaAlvo[] = [];
  for (const page of json.results) {
    const chatIdTexto = textoDaPropriedade(page.properties["Telegram Chat ID"] ?? { type: "" });
    const chatId = Number(chatIdTexto);
    const nomes = textoDaPropriedade(page.properties[PROP_NOMES_RESPONSAVEL] ?? { type: "" })
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    if (chatId && nomes.length > 0) pessoas.push({ chatId, nomes });
  }
  return pessoas;
}

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
  // "Responsável". Isso deixa de fora, por exemplo, a base "Telegram" e a de
  // sessões do bot (que mudam a cada mensagem e encheriam a planilha).
  const props = pagina.properties;
  if (props["Status"]?.type !== "status" || !props["Responsável"]) return;

  const novo = montarRetrato(props);
  const anterior = await lerRetrato(sheets, pageId);

  const criada = tipoEvento === "page.created";
  const mudancas = anterior ? compararRetratos(anterior.retrato, novo) : [];
  const semNovidade = anterior ? mudancas.length === 0 : !criada;

  if (anterior && mudancas.length > 0) {
    await gravarRetrato(sheets, pageId, novo, anterior.linha);
  } else if (!anterior) {
    // Primeira vez que vemos essa tarefa: não há como saber o que mudou,
    // então só guarda o retrato pra comparar da próxima vez.
    await gravarRetrato(sheets, pageId, novo, null);
  }
  if (semNovidade) return;
  if (criada && novo.titulo === "(sem título)") return;

  const pessoas = await pessoasComAlertaMinhasTarefas();
  if (pessoas.length === 0) return;

  // Avisa quem é (ou era) responsável: se a pessoa foi tirada da tarefa,
  // também precisa saber.
  const responsaveisEnvolvidos = [...novo.responsaveis, ...(anterior?.retrato.responsaveis ?? [])];
  const destinatarias = pessoas.filter((p) => ehResponsavel(p.nomes, responsaveisEnvolvidos));
  if (destinatarias.length === 0) return;

  const databaseId = pagina.parent.database_id ?? "";
  const condominio =
    novo.props["Condomínio"] ||
    (await nomeDoCondominioNaPlanilha(sheets, databaseId)) ||
    "Condomínio não identificado";
  const quem = (await buscarNomeAutor(evento.authors?.[0]?.id, tokensNotion)) ?? "Alguém da equipe";
  const quando = evento.timestamp ? new Date(evento.timestamp) : new Date();

  const texto = montarMensagemAviso({
    condominio,
    tarefa: novo.titulo,
    url: pagina.url ?? `https://www.notion.so/${pageId.replace(/-/g, "")}`,
    quando: Number.isNaN(quando.getTime()) ? new Date() : quando,
    quem,
    tipo: criada && !anterior ? "criada" : "alterada",
    mudancas,
    campos: novo.props,
  });

  for (const p of destinatarias) {
    await enviarAvisoTelegram(
      p.chatId,
      texto,
      pagina.url ?? `https://www.notion.so/${pageId.replace(/-/g, "")}`,
    );
  }
}
