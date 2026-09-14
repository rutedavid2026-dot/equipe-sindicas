import { createFileRoute } from "@tanstack/react-router";
import { isFechada, normalizeForMatch } from "@/lib/report-utils";

// Recebe mensagens do bot do Telegram (@equipesindicas_bot) e permite criar e
// atualizar tarefas direto pelo chat, sem abrir o Notion.
//
// Menu principal: "🆕 Nova Tarefa" e "🔄 Atualizar Tarefa" (mostrado em
// /start, /menu, ou tocando em "🔙 Voltar ao início" — botão anexado por
// padrão em toda mensagem enviada em algum fluxo em andamento). O estado
// entre uma mensagem e outra fica na database "Sessões (bot Telegram)" (1
// linha por chat_id) — necessário porque cada mensagem chega como uma
// requisição HTTP separada e isolada (sem memória em processo entre elas,
// rodando em edge/serverless).
//
// Nova Tarefa: condomínio → nome da tarefa → prazo (botões pré-definidos) →
// responsável → prioridade → setor — todas as opções de cada passo (exceto
// prazo) são lidas do schema real da database do condomínio escolhido, nunca
// hardcoded, porque o vocabulário de Status/Prioridade/Setor diverge entre
// condomínios (confirmado database por database antes de implementar isso).
//
// Atualizar Tarefa: condomínio → tarefa em aberto → novo status (opcional) →
// texto da última atualização → (anexos: ainda não implementado, depende de
// integração futura com Google Drive).
//
// Camada 1 (comando único, ainda funciona): /novatarefa Condomínio | Tarefa
// | Dias — atalho pra quem já sabe o formato, sem passar pelos botões.
//
// Autorização: só responde a chat_ids cadastrados como síndica ativa na
// database "Síndicas" (mesma usada pela automação de alertas em
// scripts/alertar-tarefas-atrasadas.mjs) — evita que qualquer pessoa que
// descubra o bot crie tarefas.
//
// Setup necessário (variáveis de ambiente nesta implantação):
//   TELEGRAM_BOT_TOKEN_ALERTAS — token do bot @equipesindicas_bot
//   NOTION_API_KEY_ALERTAS — integração "equipe-sindicas-alertas" (workspace
//     "Notion de Síndicas Profissionais", diferente do NOTION_API_KEY
//     principal deste app)
//
// Depois de publicado, registrar o webhook uma vez (rodar localmente):
//   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN_ALERTAS/setWebhook?url=https://SEU_DOMINIO/webhooks/telegram"

const NOTION_VERSION = "2022-06-28";
const SINDICAS_DB_ID = "3dae69ba114f812eb8b7f78e6d98c9f5";
const SESSOES_DB_ID = "3dae69ba114f8170aea1c56a019ed184";

// Mesma lista de scripts/alertar-tarefas-atrasadas.mjs — duplicada de
// propósito (runtimes diferentes: Cloudflare Worker aqui, Node no GitHub
// Actions lá; mesmo padrão de apps-script/Config.gs vs
// src/lib/report-utils.ts, que também duplicam de propósito por rodarem em
// ambientes separados).
const CONDOMINIOS: Record<string, string> = {
  "miragio cacupé": "3bae69ba114f804b8f22e2ce314226c8",
  "jazz club": "3bae69ba114f80ea98bde507ad0a0c83",
  "las rozas": "3bbe69ba114f808394e9fa22a19ef6d2",
  vivendas: "3bbe69ba114f80519085edf0384e1e38",
  iconic: "3bbe69ba114f80359dc2c50baa98302f",
  "porto dos açores": "3bbe69ba114f80539d80dae69b97eb43",
  "thai beach": "54ce69ba114f834baeb8817600c95070",
  "bossa nova": "3c3e69ba114f8001a9e0d4ddde3f8fb5",
  "boulevard atlantique": "371dabc8b02d4e40a94a75670e080151",
  "palm beach": "3c3e69ba114f81dfbf61dfee1f3bb64d",
  malibu: "3bbe69ba114f8070b9a9e0c43e39e6f6",
  "encantos do mar": "3c3e69ba114f81739c7dfe12c44934cc",
  "mar aberto": "3c3e69ba114f812c84afc22527799c51",
  contemporâneo: "8a345139cef14f7d8c2777c3e9058675",
  rivière: "3c3e69ba114f81098890f38772e06395",
  "saint exupéry": "3c3e69ba114f810d93b0e9bc37d51b06",
  "la plage": "3c3e69ba114f81f98d72f0337e5cd6cf",
  absoluto: "3c3e69ba114f818a9154c637ec23dd42",
  "dunas do leste": "3c4e69ba114f81bb8b83f4127872e7af",
  "riozinho style": "3c4e69ba114f81e18b67f69ca39fe4b0",
  "pátéo campeche": "3c4e69ba114f81aab7c7e127f4ff0b94",
  infiniti: "3c4e69ba114f810daf4bcdbbb4768619",
  "luiza napoli": "3c4e69ba114f817ebc73c88e47f71b25",
  "cora campeche": "3c4e69ba114f81c196d2e5acbe817fab",
  atlantis: "3c4e69ba114f818b8cade08fea1aba12",
  carrara: "3c4e69ba114f812bb5a2fa3ceb5b4f47",
  "residencial saffira": "3c4e69ba114f8136a0bdc40866f167a4",
  moana: "3bbe69ba114f8019a7c7d2f640784338",
  sunset: "3c4e69ba114f81699ccaeb754c5d7305",
};

// Nome de exibição exato (e valor gravado no campo "Condomínio" do Notion)
// pra cada chave de CONDOMINIOS — checado database por database via API, não
// adivinhado, porque a grafia real do Notion diverge da chave em alguns casos
// (ex.: "Saint Exupery" sem acento, "Páteo Campeche" com acento diferente do
// esperado, "SUNSET" em caixa alta). "Iconic", "Thai Beach" e "Boulevard
// Atlantique" não puderam ser confirmados (databases não compartilhadas com a
// integração usada pra essa checagem) — grafia mais provável usada.
const NOMES_CONDOMINIOS: Record<string, string> = {
  "miragio cacupé": "Miragio Cacupé",
  "jazz club": "Jazz Club",
  "las rozas": "Las Rozas",
  vivendas: "Vivendas",
  iconic: "Iconic",
  "porto dos açores": "Porto dos Açores",
  "thai beach": "Thai Beach",
  "bossa nova": "Bossa Nova",
  "boulevard atlantique": "Boulevard Atlantique",
  "palm beach": "Palm Beach",
  malibu: "Malibu",
  "encantos do mar": "Encantos do Mar",
  "mar aberto": "Mar Aberto",
  contemporâneo: "Contemporâneo",
  rivière: "Rivière",
  "saint exupéry": "Saint Exupery",
  "la plage": "La Plage",
  absoluto: "Absoluto",
  "dunas do leste": "Dunas do Leste",
  "riozinho style": "Riozinho Style",
  "pátéo campeche": "Páteo Campeche",
  infiniti: "Infiniti",
  "luiza napoli": "Luiza Napoli",
  "cora campeche": "Cora Campeche",
  atlantis: "Atlantis",
  carrara: "Carrara",
  "residencial saffira": "Residencial Saffira",
  moana: "Moana",
  sunset: "SUNSET",
};

// A propriedade "Condomínio" quase sempre é select, mas a Bossa Nova é
// multi_select — sem isso, criar tarefa lá falharia por incompatibilidade de
// tipo.
const CONDOMINIO_MULTI_SELECT = new Set(["bossa nova"]);

function notionKey(): string {
  const key = process.env.NOTION_API_KEY_ALERTAS;
  if (!key) throw new Error("NOTION_API_KEY_ALERTAS não configurado nesta implantação.");
  return key;
}

function telegramToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN_ALERTAS;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN_ALERTAS não configurado nesta implantação.");
  return token;
}

async function notionFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${notionKey()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.object === "error") {
    throw new Error(`Notion API: ${(json.message as string) || res.statusText}`);
  }
  return json;
}

function truncar(texto: string, tamanho: number): string {
  return texto.length > tamanho ? `${texto.slice(0, tamanho - 1)}…` : texto;
}

// Botões inline (grudados na própria mensagem) em vez de ReplyKeyboardMarkup
// (teclado por baixo da caixa de texto) — o teclado por baixo alterna com o
// teclado do sistema (some sempre que o bot espera texto livre, exigindo
// tocar num ícone pra voltar); o botão inline fica sempre visível na última
// mensagem do bot, sem depender do estado do teclado do celular.
const BOTAO_VOLTAR = { text: "🔙 Voltar ao início", callback_data: "inicio" };
const MENU_VOLTAR = { inline_keyboard: [[BOTAO_VOLTAR]] };
const MENU_PRINCIPAL = {
  inline_keyboard: [
    [{ text: "🆕 Nova Tarefa", callback_data: "novatarefa" }],
    [{ text: "🔄 Atualizar Tarefa", callback_data: "atualizartarefa" }],
  ],
};

type ReplyMarkup = { inline_keyboard: { text: string; callback_data: string }[][] };

async function responderTelegram(
  chatId: number,
  texto: string,
  replyMarkup?: ReplyMarkup,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${telegramToken()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: texto,
      reply_markup: replyMarkup ?? MENU_VOLTAR,
    }),
  });
}

// Tira o "carregando..." do botão no app do Telegram — não afeta a lógica,
// só a experiência de quem clicou (sem isso o botão fica "pensando" até dar
// timeout no cliente).
async function responderCallback(callbackQueryId: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${telegramToken()}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

async function mostrarMenuInicial(chatId: number): Promise<void> {
  await responderTelegram(chatId, "O que você quer fazer?", MENU_PRINCIPAL);
}

// Retorna os condomínios que essa síndica gerencia (vazio = não autorizada
// ou nenhum condomínio mapeado — os dois casos tratados como "não pode usar
// o bot" pelo chamador).
async function condominiosDaSindica(chatId: number): Promise<string[]> {
  const json = (await notionFetch(`databases/${SINDICAS_DB_ID}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        and: [
          { property: "Ativo", checkbox: { equals: true } },
          { property: "Telegram Chat ID", rich_text: { equals: String(chatId) } },
        ],
      },
    }),
  })) as { results: { properties: Record<string, { multi_select?: { name: string }[] }> }[] };

  const nomes = new Set<string>();
  for (const page of json.results) {
    for (const opt of page.properties["Condominios"]?.multi_select ?? []) {
      nomes.add(opt.name);
    }
  }
  return [...nomes];
}

// ---------------------------------------------------------------------------
// Schema da database do condomínio: Status, Prioridade, Setor e Responsável
// variam de condomínio pra condomínio (confirmado database por database) —
// por isso as opções de cada passo do fluxo são sempre lidas daqui, nunca
// hardcoded. Buscado uma vez só (ao escolher o condomínio) e guardado na
// sessão, pra não repetir a chamada à API a cada pergunta.
// ---------------------------------------------------------------------------

type OpcoesEscolha = { tipo: "select" | "multi_select"; opcoes: string[] };
type OpcoesResponsavel =
  | { tipo: "select" | "multi_select"; opcoes: string[] }
  | { tipo: "people"; opcoes: { id: string; nome: string }[] };

type OpcoesCondominio = {
  statusOptions: string[];
  statusPadrao?: string;
  prioridade: OpcoesEscolha;
  setor: OpcoesEscolha;
  responsavel: OpcoesResponsavel;
  condominioTipo: "select" | "multi_select";
};

// Pessoas do tipo "people" não têm opções fixas no schema (é uma referência a
// usuários do Notion, não uma lista pré-definida) — em vez de listar o
// workspace inteiro, levanta quem já foi responsável nas tarefas mais
// recentes dessa base específica, uma aproximação razoável de "responsáveis
// desse condomínio".
async function opcoesResponsavelPeople(
  databaseId: string,
): Promise<{ id: string; nome: string }[]> {
  const json = (await notionFetch(`databases/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({
      page_size: 50,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    }),
  })) as {
    results: { properties: Record<string, { people?: { id: string; name?: string }[] }> }[];
  };

  const vistos = new Map<string, string>();
  for (const page of json.results) {
    for (const pessoa of page.properties["Responsável"]?.people ?? []) {
      if (pessoa.id && pessoa.name) vistos.set(pessoa.id, pessoa.name);
    }
  }
  return [...vistos.entries()].map(([id, nome]) => ({ id, nome }));
}

async function buscarSchemaCondominio(
  databaseId: string,
  chave: string,
): Promise<OpcoesCondominio> {
  type PropDef = {
    type: string;
    status?: { options: { name: string }[] };
    select?: { options: { name: string }[] };
    multi_select?: { options: { name: string }[] };
  };
  const db = (await notionFetch(`databases/${databaseId}`)) as {
    properties: Record<string, PropDef>;
  };
  const props = db.properties;

  function opcoesEscolha(nome: string): OpcoesEscolha {
    const prop = props[nome];
    if (prop?.type === "multi_select") {
      return { tipo: "multi_select", opcoes: prop.multi_select?.options.map((o) => o.name) ?? [] };
    }
    if (prop?.type === "select") {
      return { tipo: "select", opcoes: prop.select?.options.map((o) => o.name) ?? [] };
    }
    return { tipo: "select", opcoes: [] };
  }

  const statusOptions = props["Status"]?.status?.options.map((o) => o.name) ?? [];
  const statusPadrao = statusOptions.find((s) => normalizeForMatch(s).startsWith("nao iniciad"));

  const responsavelProp = props["Responsável"];
  let responsavel: OpcoesResponsavel;
  if (responsavelProp?.type === "people") {
    responsavel = { tipo: "people", opcoes: await opcoesResponsavelPeople(databaseId) };
  } else {
    responsavel = opcoesEscolha("Responsável");
  }

  return {
    statusOptions,
    statusPadrao,
    prioridade: opcoesEscolha("Prioridade"),
    setor: opcoesEscolha("Setor"),
    responsavel,
    condominioTipo: CONDOMINIO_MULTI_SELECT.has(chave) ? "multi_select" : "select",
  };
}

function valorEscolha(tipo: "select" | "multi_select", nome: string): Record<string, unknown> {
  return tipo === "multi_select" ? { multi_select: [{ name: nome }] } : { select: { name: nome } };
}

// ---------------------------------------------------------------------------
// Sessão — 1 linha por chat_id na database "Sessões (bot Telegram)". Busca a
// existente (se houver) pra decidir entre criar ou atualizar, mesmo padrão de
// fetchTodasPaginasExistentes em sync-followups-notion.mjs.
// ---------------------------------------------------------------------------

type ResponsavelValor =
  | { tipo: "people"; id: string; nome: string }
  | { tipo: "select" | "multi_select"; nome: string };

type PassoNovaTarefa = "tarefa" | "prazo" | "responsavel" | "prioridade" | "setor";

type SessaoNovaTarefa = {
  fluxo: "nova";
  step: PassoNovaTarefa;
  condominio: string;
  databaseId: string;
  opcoes: OpcoesCondominio;
  tarefa?: string;
  dias?: number;
  responsavelValor?: ResponsavelValor;
  prioridade?: string;
  setor?: string;
  // Passos já respondidos (por botão OU já preenchidos pela IA) — sem isso,
  // ao responder manualmente um passo que a IA deixou em branco, o próximo
  // passo perguntado seria sempre o seguinte da lista fixa, mesmo que outro
  // campo já resolvido pela IA (confirmado em teste real: perguntava
  // Prioridade de novo depois de responder Responsável, mesmo a IA já tendo
  // entendido "média" antes).
  resolvidos: PassoNovaTarefa[];
};

type SessaoAtualizarTarefa = {
  fluxo: "atualizar";
  step: "tarefa" | "status" | "texto" | "anexo" | "recebendo_anexo" | "confirmar_audio";
  condominio: string;
  databaseId: string;
  statusOptions: string[];
  pageId?: string;
  tarefaTitulo?: string;
  novoStatus?: string;
  pastaDriveId?: string;
  pastaDriveUrl?: string;
  anexosRecebidos?: number;
  // Só usados quando a tarefa foi encontrada/atualizada via áudio: o texto
  // fica "pendente" até a confirmação final (✅/❌) — só grava no Notion
  // depois que a pessoa confirmar, nunca direto.
  textoPendente?: string;
  viaAudio?: boolean;
};

// Guarda o que a IA já extraiu de um áudio quando o condomínio não foi
// identificado — sem isso, a pessoa teria que repetir tudo de novo só porque
// faltou o condomínio. Assim que ela escolhe manualmente (callback "condo:"),
// o fluxo retoma esses dados em vez de começar do zero.
type SessaoNovaPendente = {
  fluxo: "nova_pendente";
  tarefa?: string;
  dias?: number;
  // Guarda a transcrição bruta (não um "chute" de responsável/prioridade/
  // setor) — esses três só são mapeados DEPOIS que o condomínio for
  // conhecido (manualmente aqui), contra as opções REAIS daquela base, em
  // vez de adivinhados às cegas antes.
  transcricao: string;
};

// Mesma ideia de SessaoNovaPendente, mas pro fluxo de Atualizar: guarda a
// transcrição + o que já foi entendido (descrição da tarefa, status, texto)
// enquanto o condomínio ainda não foi escolhido manualmente.
type SessaoAtualizarPendente = {
  fluxo: "atualizar_pendente";
  transcricao: string;
  tarefaDescricao?: string;
  statusTexto?: string;
  textoAtualizacao?: string;
};

// Quando um áudio chega mas a IA não tem confiança se é "criar" ou
// "atualizar" — guarda tudo que já foi entendido (incluindo o condomínio, se
// identificado) até a pessoa escolher por botão, sem perder nada dito.
type SessaoIndefinidaPendente = {
  fluxo: "indefinida_pendente";
  transcricao: string;
  condominioChave?: string;
  tarefaDescricao?: string;
  prazoDias?: number;
  statusTexto?: string;
  textoAtualizacao?: string;
};

type Sessao =
  | SessaoNovaTarefa
  | SessaoAtualizarTarefa
  | SessaoNovaPendente
  | SessaoAtualizarPendente
  | SessaoIndefinidaPendente;

async function buscarLinhaSessao(
  chatId: number,
): Promise<{ pageId: string; sessao: Sessao | null } | null> {
  const json = (await notionFetch(`databases/${SESSOES_DB_ID}/query`, {
    method: "POST",
    body: JSON.stringify({ filter: { property: "ChatId", title: { equals: String(chatId) } } }),
  })) as {
    results: { id: string; properties: Record<string, { rich_text?: { plain_text: string }[] }> }[];
  };

  if (json.results.length === 0) return null;
  const page = json.results[0];
  const texto = page.properties["Estado"]?.rich_text?.[0]?.plain_text;
  return { pageId: page.id, sessao: texto ? (JSON.parse(texto) as Sessao) : null };
}

async function salvarSessao(chatId: number, sessao: Sessao): Promise<void> {
  const existente = await buscarLinhaSessao(chatId);
  const properties = { Estado: { rich_text: [{ text: { content: JSON.stringify(sessao) } }] } };
  if (existente) {
    await notionFetch(`pages/${existente.pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
  } else {
    await notionFetch("pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: SESSOES_DB_ID },
        properties: { ChatId: { title: [{ text: { content: String(chatId) } }] }, ...properties },
      }),
    });
  }
}

async function limparSessao(chatId: number): Promise<void> {
  const existente = await buscarLinhaSessao(chatId);
  if (existente) {
    await notionFetch(`pages/${existente.pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { Estado: { rich_text: [] } } }),
    });
  }
}

// ---------------------------------------------------------------------------
// Camada 1 — comando de uma linha só, sem passar pelos botões.
// ---------------------------------------------------------------------------

type ComandoNovaTarefa = { condominio: string; tarefa: string; dias: number };

function parsearComando(texto: string): ComandoNovaTarefa | { erro: string } {
  const resto = texto.replace(/^\/novatarefa(@\w+)?\s*/i, "");
  const partes = resto.split("|").map((p) => p.trim());
  if (partes.length !== 3 || partes.some((p) => !p)) {
    return {
      erro:
        "Formato: /novatarefa Nome do Condomínio | Nome da tarefa | Previsão em dias\n\n" +
        "Exemplo: /novatarefa Miragio Cacupé | Trocar lâmpada do hall | 3",
    };
  }
  const [condominio, tarefa, diasTexto] = partes;
  const dias = Number(diasTexto);
  if (!Number.isFinite(dias) || dias <= 0) {
    return {
      erro: `Previsão em dias inválida: "${diasTexto}" (precisa ser um número maior que zero).`,
    };
  }
  return { condominio, tarefa, dias };
}

// ---------------------------------------------------------------------------
// Criação e atualização de tarefa
// ---------------------------------------------------------------------------

type CriarTarefaInput = {
  condominio: string;
  tarefa: string;
  dias: number;
  databaseId?: string;
  condominioTipo?: "select" | "multi_select";
  statusPadrao?: string;
  responsavelValor?: ResponsavelValor;
  prioridade?: string;
  prioridadeTipo?: "select" | "multi_select";
  setor?: string;
  setorTipo?: "select" | "multi_select";
};

async function criarTarefa({
  condominio,
  tarefa,
  dias,
  databaseId: databaseIdInformado,
  condominioTipo,
  statusPadrao,
  responsavelValor,
  prioridade,
  prioridadeTipo,
  setor,
  setorTipo,
}: CriarTarefaInput): Promise<string> {
  // databaseId já vem resolvido do fluxo de botões (evita depender de
  // round-trip por nome, que falha pra condomínios cuja grafia real no Notion
  // diverge da chave — ex.: "Saint Exupery" sem acento); só a camada 1
  // (atalho de texto livre) precisa resolver aqui.
  const databaseId = databaseIdInformado ?? CONDOMINIOS[condominio.toLowerCase()];
  if (!databaseId) {
    const nomes = Object.keys(CONDOMINIOS).join(", ");
    throw new Error(`Condomínio "${condominio}" não reconhecido. Condomínios válidos: ${nomes}`);
  }

  const hoje = new Date().toISOString().slice(0, 10);
  const properties: Record<string, unknown> = {
    Tarefas: { title: [{ text: { content: tarefa } }] },
    "Data de Início": { date: { start: hoje } },
    "Previsão (em dias)": { number: dias },
    Condomínio: valorEscolha(condominioTipo ?? "select", condominio),
  };
  if (statusPadrao) properties["Status"] = { status: { name: statusPadrao } };
  if (prioridade) properties["Prioridade"] = valorEscolha(prioridadeTipo ?? "select", prioridade);
  if (setor) properties["Setor"] = valorEscolha(setorTipo ?? "select", setor);
  if (responsavelValor) {
    properties["Responsável"] =
      responsavelValor.tipo === "people"
        ? { people: [{ id: responsavelValor.id }] }
        : valorEscolha(responsavelValor.tipo, responsavelValor.nome);
  }

  const pagina = (await notionFetch("pages", {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
  })) as { url: string };

  return pagina.url;
}

async function atualizarTarefa(
  pageId: string,
  novoStatus: string | undefined,
  texto: string,
): Promise<void> {
  const properties: Record<string, unknown> = {
    "Última Atualização": { rich_text: [{ text: { content: texto } }] },
  };
  if (novoStatus) properties["Status"] = { status: { name: novoStatus } };
  await notionFetch(`pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
}

// "Histórico" é rich_text simples — o PATCH substitui o conteúdo inteiro, não
// existe "append" nativo, então lê o texto atual antes de reescrever com a
// linha nova no final.
async function anexarHistorico(pageId: string, linha: string): Promise<void> {
  const pagina = (await notionFetch(`pages/${pageId}`)) as {
    properties: Record<string, { rich_text?: { plain_text: string }[] }>;
  };
  const atual = pagina.properties["Histórico"]?.rich_text?.map((t) => t.plain_text).join("") ?? "";
  const novo = atual ? `${atual}\n${linha}` : linha;
  await notionFetch(`pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: { Histórico: { rich_text: [{ text: { content: novo } }] } },
    }),
  });
}

// ---------------------------------------------------------------------------
// Anexos (Google Drive) — usa o refresh_token da sua própria conta (gerado
// uma vez em /auth/drive/start), não uma conta de serviço: contas de serviço
// não têm cota de armazenamento própria, e numa conta Gmail comum (sem Drive
// Compartilhado, recurso do Workspace pago) os uploads falhariam por "cota
// excedida". Escopo drive.file: só enxerga/edita arquivos criados por este
// app, não o Drive inteiro.
// ---------------------------------------------------------------------------

function driveConfigurado(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN &&
    process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID
  );
}

async function obterAccessTokenDrive(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!json.access_token) {
    throw new Error(
      `Falha ao renovar token do Drive: ${json.error_description ?? json.error ?? res.statusText}`,
    );
  }
  return json.access_token;
}

async function buscarOuCriarPastaDrive(
  nomeTarefa: string,
  accessToken: string,
): Promise<{ id: string; url: string }> {
  const parentId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID!;
  const nomeEscapado = nomeTarefa.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = `name = '${nomeEscapado}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const buscaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,webViewLink)`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const busca = (await buscaRes.json()) as { files?: { id: string; webViewLink: string }[] };
  if (busca.files?.[0]) return { id: busca.files[0].id, url: busca.files[0].webViewLink };

  const criaRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,webViewLink", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: nomeTarefa,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const criada = (await criaRes.json()) as { id?: string; webViewLink?: string };
  if (!criada.id || !criada.webViewLink) {
    throw new Error(`Falha ao criar pasta no Drive: ${JSON.stringify(criada)}`);
  }
  return { id: criada.id, url: criada.webViewLink };
}

async function uploadArquivoDrive(
  bytes: ArrayBuffer,
  nomeArquivo: string,
  mimeType: string,
  pastaId: string,
  accessToken: string,
): Promise<void> {
  const metadata = { name: nomeArquivo, parents: [pastaId] };
  const boundary = `-------drivetelegram${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const partes: Uint8Array[] = [
    encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    ),
    encoder.encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    new Uint8Array(bytes),
    encoder.encode(`\r\n--${boundary}--`),
  ];
  const tamanhoTotal = partes.reduce((soma, p) => soma + p.byteLength, 0);
  const corpo = new Uint8Array(tamanhoTotal);
  let offset = 0;
  for (const parte of partes) {
    corpo.set(parte, offset);
    offset += parte.byteLength;
  }

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: corpo,
  });
  if (!res.ok) {
    const detalhe = await res.text();
    throw new Error(`Falha ao enviar arquivo pro Drive: ${res.status} ${detalhe}`);
  }
}

// Bots do Telegram só conseguem baixar arquivos de até 20MB via getFile — um
// vídeo maior que isso falha aqui, com o erro propagado pro chat.
async function baixarArquivoTelegram(fileId: string): Promise<ArrayBuffer> {
  const infoRes = await fetch(
    `https://api.telegram.org/bot${telegramToken()}/getFile?file_id=${fileId}`,
  );
  const info = (await infoRes.json()) as {
    ok?: boolean;
    description?: string;
    result?: { file_path?: string };
  };
  const filePath = info.result?.file_path;
  if (!filePath) {
    throw new Error(
      info.description ?? "Não consegui obter o arquivo do Telegram (maior que 20MB?).",
    );
  }
  const arquivoRes = await fetch(`https://api.telegram.org/file/bot${telegramToken()}/${filePath}`);
  return arquivoRes.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Criação de tarefa por áudio (IA) — usa a API da Groq (free tier, sem
// binding/conta de serviço, só uma API key comum) pra transcrever
// (Whisper) e depois extrair os campos estruturados (Llama) de um áudio
// mandado no lugar de preencher os botões manualmente.
// ---------------------------------------------------------------------------

function groqConfigurado(): boolean {
  return !!process.env.GROQ_API_KEY;
}

async function transcreverAudioGroq(bytes: ArrayBuffer): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY não configurado nesta implantação.");

  const form = new FormData();
  form.append("file", new Blob([bytes]), "audio.ogg");
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "pt");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const json = (await res.json()) as { text?: string; error?: { message?: string } };
  if (!res.ok || json.text === undefined) {
    throw new Error(json.error?.message ?? `Falha ao transcrever o áudio (status ${res.status}).`);
  }
  return json.text;
}

type InterpretacaoInicial = {
  condominio: string | null;
  tarefa: string;
  prazoDias: number | null;
};

// Etapa 1 — só os campos que NÃO dependem de conhecer o condomínio ainda
// (condomínio em si, tarefa, prazo). Responsável/Prioridade/Setor são
// deixados pra etapa 2 (mapearCamposReais), de propósito: essa mesma IA
// "chutando" um valor livre pra esses três campos aqui e só validando depois
// por string era o que causava as inconsistências dos testes anteriores —
// melhor a IA já ver as opções reais e escolher, que é a etapa 2.
async function interpretarCondominioETarefa(transcricao: string): Promise<InterpretacaoInicial> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY não configurado nesta implantação.");
  const nomesCondominios = Object.keys(CONDOMINIOS).map(
    (chave) => NOMES_CONDOMINIOS[chave] ?? chave,
  );

  const prompt = `Você extrai dados de um pedido falado (transcrito automaticamente, pode ter erros fonéticos,
principalmente em nomes próprios) de tarefa de manutenção condominial em português.

Transcrição: "${transcricao.replace(/"/g, '\\"')}"

Responda APENAS com um JSON válido, sem texto antes ou depois, no formato:
{"condominio": string ou null, "tarefa": string, "prazoDias": number ou null}

Regras:
- "condominio": qual destes nomes foi mencionado — reconheça variações fonéticas de transcrição (ex.: "Mirajo Cacupé" ou "Mirage o Cacupé" significam "Miragio Cacupé"). Use EXATAMENTE um destes valores, ou null se nenhum bater nem aproximadamente: ${JSON.stringify(nomesCondominios)}
- "tarefa": descrição curta e objetiva do que precisa ser feito.
- "prazoDias": número de dias até o prazo, se mencionado (ex.: "amanhã"=1, "essa semana"=7, "duas semanas"=14, "um mês"=30). null se não mencionado.
Não invente nada que não tenha sido dito.`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(json.error?.message ?? `Falha ao interpretar o áudio (status ${res.status}).`);
  }
  const conteudo = json.choices?.[0]?.message?.content;
  if (!conteudo) throw new Error("Resposta vazia da IA ao interpretar o áudio.");

  const bruto = JSON.parse(conteudo) as {
    condominio?: string | null;
    tarefa?: string;
    prazoDias?: number | null;
  };

  return {
    condominio: bruto.condominio ?? null,
    tarefa: (bruto.tarefa ?? "").trim(),
    prazoDias:
      typeof bruto.prazoDias === "number" && bruto.prazoDias >= 0
        ? Math.round(bruto.prazoDias)
        : null,
  };
}

type MapeamentoCampos = {
  responsavel: string | null;
  prioridade: string | null;
  setor: string | null;
};

// Etapa 2 — só chamada DEPOIS de saber o condomínio. Manda a mesma
// transcrição de novo, agora junto com as opções REAIS de Responsável/
// Prioridade/Setor daquela base específica, e pede pra IA escolher a mais
// parecida — o "de → para" de verdade, decidido com o contexto completo, em
// vez de a etapa 1 chutar um texto livre e o código tentar casar depois.
async function mapearCamposReais(
  transcricao: string,
  opcoes: OpcoesCondominio,
): Promise<MapeamentoCampos> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY não configurado nesta implantação.");

  const responsaveis =
    opcoes.responsavel.tipo === "people"
      ? opcoes.responsavel.opcoes.map((p) => p.nome)
      : opcoes.responsavel.opcoes;

  const prompt = `Você mapeia um pedido falado (transcrito automaticamente) pras opções REAIS já cadastradas nesse
condomínio específico, em português.

Transcrição: "${transcricao.replace(/"/g, '\\"')}"

Responda APENAS com um JSON válido, sem texto antes ou depois, no formato:
{"responsavel": string ou null, "prioridade": string ou null, "setor": string ou null}

Regras — pra cada campo, se algo relacionado foi mencionado na transcrição, escolha a opção mais parecida da
lista correspondente (reconheça variação fonética/sinônimo, ex.: "urgentíssimo" → "Urgente"); se nada foi
mencionado, ou nada da lista tem relação nenhuma, use null. NUNCA use um valor fora das listas abaixo.
- "responsavel": ${JSON.stringify(responsaveis)}
- "prioridade": ${JSON.stringify(opcoes.prioridade.opcoes)}
- "setor": ${JSON.stringify(opcoes.setor.opcoes)}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(
      json.error?.message ?? `Falha ao mapear os campos do áudio (status ${res.status}).`,
    );
  }
  const conteudo = json.choices?.[0]?.message?.content;
  if (!conteudo) throw new Error("Resposta vazia da IA ao mapear os campos.");

  const bruto = JSON.parse(conteudo) as {
    responsavel?: string | null;
    prioridade?: string | null;
    setor?: string | null;
  };

  return {
    responsavel: bruto.responsavel ?? null,
    prioridade: bruto.prioridade ?? null,
    setor: bruto.setor ?? null,
  };
}

// Confere o valor devolvido pela etapa 2 contra a lista real que foi dada a
// ela — a IA já viu as opções certas, então isso é só uma checagem
// defensiva contra alucinação (nunca deveria divergir), tolerando só
// diferença de acento/maiúscula.
function resolverOpcaoFuzzy(valor: string | null, opcoesValidas: string[]): string | undefined {
  if (!valor) return undefined;
  const alvo = normalizeForMatch(valor);
  return opcoesValidas.find((o) => normalizeForMatch(o) === alvo);
}

// Mesma lógica defensiva de resolverOpcaoFuzzy — a IA da etapa 2 já viu os
// nomes reais, então só tolera diferença de acento/maiúscula.
function resolverResponsavelValor(
  nome: string | null,
  opcoesResp: OpcoesResponsavel,
): ResponsavelValor | undefined {
  if (!nome) return undefined;
  const alvo = normalizeForMatch(nome);
  if (opcoesResp.tipo === "people") {
    const encontrado = opcoesResp.opcoes.find((p) => normalizeForMatch(p.nome) === alvo);
    return encontrado ? { tipo: "people", id: encontrado.id, nome: encontrado.nome } : undefined;
  }
  const encontrado = opcoesResp.opcoes.find((o) => normalizeForMatch(o) === alvo);
  return encontrado ? { tipo: opcoesResp.tipo, nome: encontrado } : undefined;
}

// Retoma o fluxo de Nova Tarefa a partir de campos já conhecidos (vindos de
// IA ou de uma sessão pendente), perguntando por botão só o que realmente
// falta — usado tanto logo após interpretar o áudio (condomínio já
// identificado) quanto ao escolher o condomínio manualmente depois de uma
// tentativa de áudio que não conseguiu identificá-lo.
function passoResolvido(sessao: SessaoNovaTarefa, passo: PassoNovaTarefa): boolean {
  return sessao.resolvidos.includes(passo);
}

// Único lugar que decide "qual é a próxima pergunta" — usado tanto ao
// terminar de interpretar um áudio quanto depois de CADA resposta manual por
// botão. Fundamental: nunca decide pelo valor do campo estar vazio (isso não
// distingue "IA não achou" de "usuário pulou de propósito"), sempre pelo que
// já está marcado em `resolvidos`.
async function continuarNovaTarefa(
  chatId: number,
  base: Omit<SessaoNovaTarefa, "step">,
): Promise<void> {
  let sessao: SessaoNovaTarefa = { ...base, step: "tarefa" };

  if (!passoResolvido(sessao, "tarefa")) {
    await salvarSessao(chatId, sessao);
    await responderTelegram(chatId, "📝 Qual o nome da tarefa?");
    return;
  }
  if (!passoResolvido(sessao, "prazo")) {
    sessao = { ...sessao, step: "prazo" };
    await salvarSessao(chatId, sessao);
    await perguntarPrazo(chatId);
    return;
  }
  if (!passoResolvido(sessao, "responsavel")) {
    sessao = { ...sessao, step: "responsavel" };
    await salvarSessao(chatId, sessao);
    await perguntarResponsavel(chatId, sessao);
    return;
  }
  if (!passoResolvido(sessao, "prioridade")) {
    sessao = { ...sessao, step: "prioridade" };
    await salvarSessao(chatId, sessao);
    await perguntarPrioridade(chatId, sessao);
    return;
  }
  if (!passoResolvido(sessao, "setor")) {
    sessao = { ...sessao, step: "setor" };
    await salvarSessao(chatId, sessao);
    await perguntarSetor(chatId, sessao);
    return;
  }

  await limparSessao(chatId);
  const url = await criarTarefa({
    condominio: sessao.condominio,
    tarefa: sessao.tarefa!,
    dias: sessao.dias!,
    databaseId: sessao.databaseId,
    condominioTipo: sessao.opcoes.condominioTipo,
    statusPadrao: sessao.opcoes.statusPadrao,
    responsavelValor: sessao.responsavelValor,
    prioridade: sessao.prioridade,
    prioridadeTipo: sessao.opcoes.prioridade.tipo,
    setor: sessao.setor,
    setorTipo: sessao.opcoes.setor.tipo,
  });
  await responderTelegram(
    chatId,
    resumoTarefaCriada(sessao, sessao.prioridade, sessao.setor, url),
    MENU_PRINCIPAL,
  );
}

// Calcula quais passos já podem ser considerados resolvidos a partir dos
// campos conhecidos (vindos da IA, de uma sessão pendente, ou de um fluxo
// manual do zero) — um campo "vazio" aqui significa "ainda não sei", não
// "usuário pulou" (isso só acontece quando o próprio callback do botão marca
// o passo como resolvido explicitamente, mesmo com valor undefined).
function resolvidosIniciais(campos: {
  tarefa?: string;
  dias?: number;
  responsavelValor?: ResponsavelValor;
  prioridade?: string;
  setor?: string;
}): PassoNovaTarefa[] {
  const resolvidos: PassoNovaTarefa[] = [];
  if (campos.tarefa) resolvidos.push("tarefa");
  if (campos.dias !== undefined) resolvidos.push("prazo");
  if (campos.responsavelValor) resolvidos.push("responsavel");
  if (campos.prioridade) resolvidos.push("prioridade");
  if (campos.setor) resolvidos.push("setor");
  return resolvidos;
}

type ClassificacaoAudio = {
  intencao: "nova" | "atualizar" | "indefinido";
  condominio: string | null;
  tarefaDescricao: string;
  prazoDias: number | null;
  statusTexto: string | null;
  textoAtualizacao: string | null;
};

// Primeiro passo pra QUALQUER áudio: decide se é criação de tarefa nova ou
// atualização de uma já existente, antes de extrair o resto — palavras como
// "atualizar", "mudar o status", "já resolvi" indicam atualização; um pedido
// descrevendo um problema novo indica criação. Indefinido quando não dá pra
// saber com confiança (o fluxo então pergunta por botão, sem perder nada).
async function classificarIntencaoAudio(transcricao: string): Promise<ClassificacaoAudio> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY não configurado nesta implantação.");
  const nomesCondominios = Object.keys(CONDOMINIOS).map(
    (chave) => NOMES_CONDOMINIOS[chave] ?? chave,
  );

  const prompt = `Você classifica um pedido falado (transcrito automaticamente, pode ter erros fonéticos,
principalmente em nomes próprios) sobre uma tarefa de manutenção condominial em português.

Transcrição: "${transcricao.replace(/"/g, '\\"')}"

Responda APENAS com um JSON válido, sem texto antes ou depois, no formato:
{"intencao": "nova" ou "atualizar" ou "indefinido", "condominio": string ou null, "tarefaDescricao": string, "prazoDias": number ou null, "statusTexto": string ou null, "textoAtualizacao": string ou null}

Regras:
- "intencao": "nova" se a pessoa está pedindo pra registrar um problema/tarefa que ainda NÃO existe no sistema; "atualizar" se está se referindo a uma tarefa JÁ CADASTRADA, pra mudar o status ou registrar um andamento (palavras como "atualizar", "atualização", "mudar o status", "já resolvi", "concluí", "finalizei" indicam isso); "indefinido" só se realmente não der pra saber.
- "condominio": qual destes nomes foi mencionado — reconheça variações fonéticas de transcrição (ex.: "Mirajo Cacupé" ou "Mirage o Cacupé" significam "Miragio Cacupé"). Use EXATAMENTE um destes valores, ou null se nenhum bater nem aproximadamente: ${JSON.stringify(nomesCondominios)}
- "tarefaDescricao": se "nova", a descrição da tarefa a ser criada; se "atualizar", a descrição de QUAL tarefa já existente está sendo mencionada (será usada pra buscar pelo título). Preencha sempre que der pra extrair algo.
- "prazoDias": só relevante se "nova" — número de dias até o prazo, se mencionado (ex.: "amanhã"=1, "essa semana"=7, "duas semanas"=14, "um mês"=30). null caso contrário.
- "statusTexto": só relevante se "atualizar" — nome do novo status mencionado, se houver, senão null.
- "textoAtualizacao": só relevante se "atualizar" — o que deve virar o texto da última atualização (o que foi feito/observado), se houver, senão null.
Não invente nada que não tenha sido dito.`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(json.error?.message ?? `Falha ao interpretar o áudio (status ${res.status}).`);
  }
  const conteudo = json.choices?.[0]?.message?.content;
  if (!conteudo) throw new Error("Resposta vazia da IA ao interpretar o áudio.");

  const bruto = JSON.parse(conteudo) as {
    intencao?: string;
    condominio?: string | null;
    tarefaDescricao?: string;
    prazoDias?: number | null;
    statusTexto?: string | null;
    textoAtualizacao?: string | null;
  };

  const intencao =
    bruto.intencao === "nova" || bruto.intencao === "atualizar" ? bruto.intencao : "indefinido";

  return {
    intencao,
    condominio: bruto.condominio ?? null,
    tarefaDescricao: (bruto.tarefaDescricao ?? "").trim(),
    prazoDias:
      typeof bruto.prazoDias === "number" && bruto.prazoDias >= 0
        ? Math.round(bruto.prazoDias)
        : null,
    statusTexto: bruto.statusTexto ?? null,
    textoAtualizacao: bruto.textoAtualizacao ?? null,
  };
}

async function processarAudioNova(
  chatId: number,
  transcricao: string,
  chave: string | undefined,
  tarefa: string,
  prazoDias: number | null,
): Promise<void> {
  if (!chave) {
    await responderTelegram(
      chatId,
      [
        `🎙️ Entendi: "${transcricao}"`,
        tarefa ? `📝 ${tarefa}` : null,
        prazoDias !== null ? `📅 Previsão: ${prazoDias} dia(s)` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    await salvarSessao(chatId, {
      fluxo: "nova_pendente",
      tarefa: tarefa || undefined,
      dias: prazoDias ?? undefined,
      transcricao,
    });
    await iniciarEscolhaCondominio(chatId, "nova");
    return;
  }
  await processarComCondominioResolvido(chatId, chave, transcricao, tarefa, prazoDias);
}

async function processarAudioAtualizar(
  chatId: number,
  transcricao: string,
  chave: string | undefined,
  tarefaDescricao: string,
  statusTexto: string | null,
  textoAtualizacao: string | null,
): Promise<void> {
  if (!chave) {
    await responderTelegram(chatId, `🎙️ Entendi: "${transcricao}"\n\nQual condomínio?`);
    await salvarSessao(chatId, {
      fluxo: "atualizar_pendente",
      transcricao,
      tarefaDescricao: tarefaDescricao || undefined,
      statusTexto: statusTexto ?? undefined,
      textoAtualizacao: textoAtualizacao ?? undefined,
    });
    await iniciarEscolhaCondominio(chatId, "atualizar");
    return;
  }
  await processarAtualizacaoComCondominioResolvido(
    chatId,
    chave,
    transcricao,
    tarefaDescricao,
    statusTexto,
    textoAtualizacao,
  );
}

async function tratarAudioTarefa(chatId: number, fileId: string): Promise<void> {
  const autorizada = (await condominiosDaSindica(chatId)).length > 0;
  if (!autorizada) {
    await responderTelegram(
      chatId,
      "Você não está cadastrada como síndica ativa. Fale com a equipe pra ser adicionada.",
    );
    return;
  }

  if (!groqConfigurado()) {
    await responderTelegram(
      chatId,
      "🎙️ Criar/atualizar tarefa por áudio ainda não está disponível — em breve!",
    );
    return;
  }

  try {
    const bytes = await baixarArquivoTelegram(fileId);
    const transcricao = await transcreverAudioGroq(bytes);
    if (!transcricao.trim()) {
      await responderTelegram(chatId, "Não consegui entender o áudio — pode tentar de novo?");
      return;
    }

    const classificacao = await classificarIntencaoAudio(transcricao);
    const chave = classificacao.condominio
      ? Object.keys(CONDOMINIOS).find(
          (k) => (NOMES_CONDOMINIOS[k] ?? k) === classificacao.condominio,
        )
      : undefined;

    if (classificacao.intencao === "indefinido") {
      await salvarSessao(chatId, {
        fluxo: "indefinida_pendente",
        transcricao,
        condominioChave: chave,
        tarefaDescricao: classificacao.tarefaDescricao || undefined,
        prazoDias: classificacao.prazoDias ?? undefined,
        statusTexto: classificacao.statusTexto ?? undefined,
        textoAtualizacao: classificacao.textoAtualizacao ?? undefined,
      });
      await responderTelegram(
        chatId,
        `🎙️ Entendi: "${transcricao}"\n\nVocê quer criar uma tarefa nova ou atualizar uma já existente?`,
        {
          inline_keyboard: [
            [
              { text: "🆕 Nova Tarefa", callback_data: "audiointent:nova" },
              { text: "🔄 Atualizar Tarefa", callback_data: "audiointent:atualizar" },
            ],
          ],
        },
      );
      return;
    }

    if (classificacao.intencao === "nova") {
      await processarAudioNova(
        chatId,
        transcricao,
        chave,
        classificacao.tarefaDescricao,
        classificacao.prazoDias,
      );
      return;
    }

    await processarAudioAtualizar(
      chatId,
      transcricao,
      chave,
      classificacao.tarefaDescricao,
      classificacao.statusTexto,
      classificacao.textoAtualizacao,
    );
  } catch (err) {
    console.error("tratarAudioTarefa:", err);
    await responderTelegram(chatId, `❌ Erro ao processar o áudio: ${(err as Error).message}`);
  }
}

// Etapa 2 + montagem da sessão — chamado tanto quando o condomínio já vem
// identificado de cara (tratarAudioNovaTarefa) quanto quando é escolhido
// manualmente depois de uma sessão "nova_pendente" (callback "condo:").
async function processarComCondominioResolvido(
  chatId: number,
  chave: string,
  transcricao: string,
  tarefaTexto: string,
  prazoDias: number | null,
): Promise<void> {
  const databaseId = CONDOMINIOS[chave];
  const condominio = NOMES_CONDOMINIOS[chave] ?? chave;
  const opcoes = await buscarSchemaCondominio(databaseId, chave);
  const mapeamento = await mapearCamposReais(transcricao, opcoes);

  const responsavelValor = resolverResponsavelValor(mapeamento.responsavel, opcoes.responsavel);
  const prioridade = resolverOpcaoFuzzy(mapeamento.prioridade, opcoes.prioridade.opcoes);
  const setor = resolverOpcaoFuzzy(mapeamento.setor, opcoes.setor.opcoes);
  const tarefa = tarefaTexto || undefined;
  const dias = prazoDias ?? undefined;

  const resumo = [`🎙️ Entendi: "${transcricao}"`, `🏢 ${condominio}`];
  if (tarefa) resumo.push(`📝 ${tarefa}`);
  if (dias !== undefined) resumo.push(`📅 Previsão: ${dias} dia(s)`);
  if (responsavelValor) resumo.push(`👤 ${responsavelValor.nome}`);
  if (prioridade) resumo.push(`🎯 ${prioridade}`);
  if (setor) resumo.push(`🗂️ ${setor}`);
  await responderTelegram(chatId, resumo.join("\n"));

  await continuarNovaTarefa(chatId, {
    fluxo: "nova",
    condominio,
    databaseId,
    opcoes,
    tarefa,
    dias,
    prioridade,
    responsavelValor,
    setor,
    resolvidos: resolvidosIniciais({ tarefa, dias, responsavelValor, prioridade, setor }),
  });
}

async function buscarTarefasAbertas(databaseId: string): Promise<{ id: string; titulo: string }[]> {
  const json = (await notionFetch(`databases/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({
      page_size: 30,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    }),
  })) as {
    results: {
      id: string;
      properties: Record<string, { status?: { name: string }; title?: { plain_text: string }[] }>;
    }[];
  };

  return json.results
    .filter((p) => {
      const status = p.properties["Status"]?.status?.name;
      return status && !isFechada(status);
    })
    .slice(0, 15)
    .map((p) => ({
      id: p.id,
      titulo: p.properties["Tarefas"]?.title?.[0]?.plain_text ?? "(sem título)",
    }));
}

// ---------------------------------------------------------------------------
// Fluxo Nova Tarefa
// ---------------------------------------------------------------------------

async function perguntarPrazo(chatId: number): Promise<void> {
  await responderTelegram(chatId, "📅 Qual o prazo?", {
    inline_keyboard: [
      [
        { text: "Hoje", callback_data: "prazo:0" },
        { text: "3 dias", callback_data: "prazo:3" },
      ],
      [
        { text: "7 dias", callback_data: "prazo:7" },
        { text: "15 dias", callback_data: "prazo:15" },
      ],
      [
        { text: "30 dias", callback_data: "prazo:30" },
        { text: "60 dias", callback_data: "prazo:60" },
      ],
    ],
  });
}

async function perguntarResponsavel(chatId: number, sessao: SessaoNovaTarefa): Promise<void> {
  const r = sessao.opcoes.responsavel;
  const botoes: { text: string; callback_data: string }[][] = [];
  if (r.tipo === "people") {
    for (const p of r.opcoes) botoes.push([{ text: p.nome, callback_data: `resp:id:${p.id}` }]);
  } else {
    for (const nome of r.opcoes) botoes.push([{ text: nome, callback_data: `resp:nome:${nome}` }]);
  }
  botoes.push([{ text: "➡️ Pular", callback_data: "resp:pular" }]);
  await responderTelegram(chatId, "👤 Responsável?", { inline_keyboard: botoes });
}

async function perguntarPrioridade(chatId: number, sessao: SessaoNovaTarefa): Promise<void> {
  const opcoes = sessao.opcoes.prioridade.opcoes;
  if (opcoes.length === 0) {
    // Base sem opções de Prioridade cadastradas — marca resolvido (sem
    // valor) e deixa continuarNovaTarefa decidir o próximo passo de verdade,
    // em vez de presumir que é sempre Setor.
    await continuarNovaTarefa(chatId, {
      ...sessao,
      resolvidos: [...sessao.resolvidos, "prioridade"],
    });
    return;
  }
  await responderTelegram(chatId, "🎯 Prioridade?", {
    inline_keyboard: opcoes.map((nome) => [{ text: nome, callback_data: `prioridade:${nome}` }]),
  });
}

async function perguntarSetor(chatId: number, sessao: SessaoNovaTarefa): Promise<void> {
  const opcoes = sessao.opcoes.setor.opcoes;
  const botoes = opcoes.map((nome) => [{ text: nome, callback_data: `setor:${nome}` }]);
  botoes.push([{ text: "➡️ Pular", callback_data: "setor:pular" }]);
  await responderTelegram(chatId, "🗂️ Setor?", { inline_keyboard: botoes });
}

function resumoTarefaCriada(
  sessao: SessaoNovaTarefa,
  prioridade: string | undefined,
  setor: string | undefined,
  url: string,
): string {
  const linhas = [
    `✅ Tarefa criada: ${sessao.tarefa}`,
    `🏢 ${sessao.condominio}`,
    `📅 Previsão: ${sessao.dias} dia(s)`,
  ];
  if (sessao.responsavelValor) linhas.push(`👤 ${sessao.responsavelValor.nome}`);
  if (prioridade) linhas.push(`🎯 ${prioridade}`);
  if (setor) linhas.push(`🗂️ ${setor}`);
  linhas.push("", `🔗 ${url}`);
  return linhas.join("\n");
}

// ---------------------------------------------------------------------------
// Fluxo Atualizar Tarefa
// ---------------------------------------------------------------------------

function resumoConfirmacaoAtualizacao(sessao: SessaoAtualizarTarefa): string {
  const linhas = [`📋 ${sessao.tarefaTitulo}`, `🏢 ${sessao.condominio}`];
  if (sessao.novoStatus) linhas.push(`🔄 Novo status: ${sessao.novoStatus}`);
  if (sessao.textoPendente) linhas.push(`✏️ ${sessao.textoPendente}`);
  linhas.push("", "Confirma?");
  return linhas.join("\n");
}

const BOTOES_CONFIRMAR_AUDIO = {
  inline_keyboard: [
    [
      { text: "✅ Confirmar", callback_data: "confirmaraudio:sim" },
      { text: "❌ Cancelar", callback_data: "confirmaraudio:nao" },
    ],
  ],
};

// Acha, entre as tarefas em aberto, qual bate com a descrição falada — só
// aceita se a IA achar uma correspondência clara (título EXATO da lista);
// null/ambíguo cai na lista manual de sempre, sem arriscar atualizar a
// tarefa errada.
async function identificarTarefaIA(
  descricao: string,
  tarefas: { id: string; titulo: string }[],
): Promise<{ id: string; titulo: string } | undefined> {
  if (!descricao.trim() || tarefas.length === 0 || !groqConfigurado()) return undefined;
  const apiKey = process.env.GROQ_API_KEY!;
  const titulos = tarefas.map((t) => t.titulo);

  const prompt = `Uma pessoa quer atualizar uma tarefa e descreveu ela assim: "${descricao.replace(/"/g, '\\"')}"

Qual destas tarefas em aberto ela quer dizer? Responda APENAS com um JSON no formato {"tarefa": string ou null}, usando EXATAMENTE um destes títulos, ou null se nenhum bater nem aproximadamente:
${JSON.stringify(titulos)}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const conteudo = json.choices?.[0]?.message?.content;
    if (!conteudo) return undefined;
    const bruto = JSON.parse(conteudo) as { tarefa?: string | null };
    if (!bruto.tarefa) return undefined;
    return tarefas.find((t) => t.titulo === bruto.tarefa);
  } catch (err) {
    console.error("identificarTarefaIA:", err);
    return undefined;
  }
}

async function processarAtualizacaoComCondominioResolvido(
  chatId: number,
  chave: string,
  transcricao: string,
  tarefaDescricao: string,
  statusTexto: string | null,
  textoAtualizacao: string | null,
): Promise<void> {
  const databaseId = CONDOMINIOS[chave];
  const condominio = NOMES_CONDOMINIOS[chave] ?? chave;
  const [tarefasAbertas, opcoes] = await Promise.all([
    buscarTarefasAbertas(databaseId),
    buscarSchemaCondominio(databaseId, chave),
  ]);

  if (tarefasAbertas.length === 0) {
    await responderTelegram(chatId, `Nenhuma tarefa em aberto em ${condominio}.`, MENU_PRINCIPAL);
    return;
  }

  const tarefaEscolhida = await identificarTarefaIA(tarefaDescricao, tarefasAbertas);
  const novoStatus = statusTexto
    ? resolverOpcaoFuzzy(statusTexto, opcoes.statusOptions)
    : undefined;
  const textoPendente = textoAtualizacao || undefined;

  if (!tarefaEscolhida) {
    await salvarSessao(chatId, {
      fluxo: "atualizar",
      step: "tarefa",
      condominio,
      databaseId,
      statusOptions: opcoes.statusOptions,
    });
    await responderTelegram(
      chatId,
      `🎙️ Entendi: "${transcricao}"\n\nNão encontrei com certeza qual tarefa é — escolha abaixo.\n\n🏢 ${condominio}\n📋 Qual tarefa?`,
      {
        inline_keyboard: tarefasAbertas.map((t) => [
          { text: truncar(t.titulo, 60), callback_data: `tarefa:${t.id}` },
        ]),
      },
    );
    return;
  }

  const base: SessaoAtualizarTarefa = {
    fluxo: "atualizar",
    step: "status",
    condominio,
    databaseId,
    statusOptions: opcoes.statusOptions,
    pageId: tarefaEscolhida.id,
    tarefaTitulo: tarefaEscolhida.titulo,
    novoStatus,
    textoPendente,
    viaAudio: true,
  };

  if (novoStatus && textoPendente) {
    const confirmando: SessaoAtualizarTarefa = { ...base, step: "confirmar_audio" };
    await salvarSessao(chatId, confirmando);
    await responderTelegram(
      chatId,
      `🎙️ Entendi: "${transcricao}"\n\n${resumoConfirmacaoAtualizacao(confirmando)}`,
      BOTOES_CONFIRMAR_AUDIO,
    );
    return;
  }

  if (!novoStatus) {
    await salvarSessao(chatId, base);
    await responderTelegram(
      chatId,
      `🎙️ Entendi: "${transcricao}"\n\n📋 ${tarefaEscolhida.titulo}\n\nTarefa mudou de status?`,
      {
        inline_keyboard: [
          ...opcoes.statusOptions.map((s) => [{ text: s, callback_data: `status:${s}` }]),
          [{ text: "➡️ Manter o status atual", callback_data: "status:" }],
        ],
      },
    );
    return;
  }

  const semTexto: SessaoAtualizarTarefa = { ...base, step: "texto" };
  await salvarSessao(chatId, semTexto);
  await responderTelegram(
    chatId,
    `🎙️ Entendi: "${transcricao}"\n\n📋 ${tarefaEscolhida.titulo}\n🔄 Novo status: ${novoStatus}\n\n✏️ Descreva a última atualização:`,
  );
}

async function finalizarAtualizacao(chatId: number, sessao: SessaoAtualizarTarefa): Promise<void> {
  if (sessao.pastaDriveUrl) {
    await anexarHistorico(
      sessao.pageId!,
      `📎 ${new Date().toISOString().slice(0, 10)}: ${sessao.anexosRecebidos ?? 0} anexo(s) — ${sessao.pastaDriveUrl}`,
    );
  }
  await limparSessao(chatId);
  const statusTexto = sessao.novoStatus ? `\n🔄 Novo status: ${sessao.novoStatus}` : "";
  const anexoTexto = sessao.pastaDriveUrl ? `\n📎 Anexos: ${sessao.pastaDriveUrl}` : "";
  await responderTelegram(
    chatId,
    `✅ Tarefa atualizada: ${sessao.tarefaTitulo}\n🏢 ${sessao.condominio}${statusTexto}${anexoTexto}`,
    MENU_PRINCIPAL,
  );
}

async function tratarAnexo(
  chatId: number,
  arquivo: { fileId: string; nomeSugerido: string; mimeType: string },
): Promise<void> {
  const linhaSessao = await buscarLinhaSessao(chatId);
  const sessao = linhaSessao?.sessao;
  if (!sessao || sessao.fluxo !== "atualizar" || sessao.step !== "recebendo_anexo") return;

  try {
    const accessToken = await obterAccessTokenDrive();
    let { pastaDriveId, pastaDriveUrl } = sessao;
    if (!pastaDriveId) {
      const pasta = await buscarOuCriarPastaDrive(
        sessao.tarefaTitulo ?? "Tarefa sem título",
        accessToken,
      );
      pastaDriveId = pasta.id;
      pastaDriveUrl = pasta.url;
    }

    const bytes = await baixarArquivoTelegram(arquivo.fileId);
    await uploadArquivoDrive(
      bytes,
      arquivo.nomeSugerido,
      arquivo.mimeType,
      pastaDriveId,
      accessToken,
    );

    const anexosRecebidos = (sessao.anexosRecebidos ?? 0) + 1;
    await salvarSessao(chatId, { ...sessao, pastaDriveId, pastaDriveUrl, anexosRecebidos });
    await responderTelegram(
      chatId,
      `✅ Anexo salvo (${anexosRecebidos}). Manda mais ou toque em "Concluir anexos".`,
      { inline_keyboard: [[{ text: "✅ Concluir anexos", callback_data: "concluiranexos" }]] },
    );
  } catch (err) {
    console.error("tratarAnexo:", err);
    await responderTelegram(chatId, `❌ Erro ao salvar o anexo: ${(err as Error).message}`);
  }
}

async function iniciarEscolhaTarefa(
  chatId: number,
  condominio: string,
  databaseId: string,
  chave: string,
): Promise<void> {
  const [tarefas, schema] = await Promise.all([
    buscarTarefasAbertas(databaseId),
    buscarSchemaCondominio(databaseId, chave),
  ]);
  if (tarefas.length === 0) {
    await responderTelegram(chatId, `Nenhuma tarefa em aberto em ${condominio}.`, MENU_PRINCIPAL);
    return;
  }
  await salvarSessao(chatId, {
    fluxo: "atualizar",
    step: "tarefa",
    condominio,
    databaseId,
    statusOptions: schema.statusOptions,
  });
  await responderTelegram(chatId, `🏢 ${condominio}\n\n📋 Qual tarefa?`, {
    inline_keyboard: tarefas.map((t) => [
      { text: truncar(t.titulo, 60), callback_data: `tarefa:${t.id}` },
    ]),
  });
}

// ---------------------------------------------------------------------------
// Condomínio (compartilhado pelos dois fluxos)
// ---------------------------------------------------------------------------

async function iniciarEscolhaCondominio(
  chatId: number,
  fluxo: "nova" | "atualizar",
): Promise<void> {
  const autorizada = (await condominiosDaSindica(chatId)).length > 0;
  if (!autorizada) {
    await responderTelegram(
      chatId,
      "Você não está cadastrada como síndica ativa. Fale com a equipe pra ser adicionada.",
    );
    return;
  }
  const chaves = Object.keys(CONDOMINIOS).sort((a, b) =>
    NOMES_CONDOMINIOS[a].localeCompare(NOMES_CONDOMINIOS[b], "pt-BR"),
  );
  await responderTelegram(chatId, "🏢 Qual condomínio?", {
    inline_keyboard: chaves.map((chave) => [
      { text: NOMES_CONDOMINIOS[chave], callback_data: `condo:${fluxo}:${chave}` },
    ]),
  });
}

// ---------------------------------------------------------------------------
// Callback queries (cliques em botões)
// ---------------------------------------------------------------------------

async function tratarCallbackQuery(callbackQuery: {
  id: string;
  data?: string;
  message?: { chat?: { id?: number } };
}): Promise<void> {
  await responderCallback(callbackQuery.id);
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data;
  if (!chatId || !data) return;

  if (data === "inicio") {
    await limparSessao(chatId);
    await mostrarMenuInicial(chatId);
    return;
  }

  if (data === "novatarefa") {
    await iniciarEscolhaCondominio(chatId, "nova");
    return;
  }

  if (data === "atualizartarefa") {
    await iniciarEscolhaCondominio(chatId, "atualizar");
    return;
  }

  if (data === "audiointent:nova" || data === "audiointent:atualizar") {
    const linhaAtual = await buscarLinhaSessao(chatId);
    const pendente =
      linhaAtual?.sessao?.fluxo === "indefinida_pendente" ? linhaAtual.sessao : undefined;
    if (!pendente) return;
    await limparSessao(chatId);
    if (data === "audiointent:nova") {
      await processarAudioNova(
        chatId,
        pendente.transcricao,
        pendente.condominioChave,
        pendente.tarefaDescricao ?? "",
        pendente.prazoDias ?? null,
      );
    } else {
      await processarAudioAtualizar(
        chatId,
        pendente.transcricao,
        pendente.condominioChave,
        pendente.tarefaDescricao ?? "",
        pendente.statusTexto ?? null,
        pendente.textoAtualizacao ?? null,
      );
    }
    return;
  }

  if (data === "confirmaraudio:sim" || data === "confirmaraudio:nao") {
    const linhaAtual = await buscarLinhaSessao(chatId);
    const sessaoConfirmar = linhaAtual?.sessao;
    if (sessaoConfirmar?.fluxo !== "atualizar" || sessaoConfirmar.step !== "confirmar_audio")
      return;

    if (data === "confirmaraudio:nao") {
      await limparSessao(chatId);
      await responderTelegram(chatId, "Ok, cancelado.", MENU_PRINCIPAL);
      return;
    }

    await atualizarTarefa(
      sessaoConfirmar.pageId!,
      sessaoConfirmar.novoStatus,
      sessaoConfirmar.textoPendente ?? "",
    );
    const nova: SessaoAtualizarTarefa = { ...sessaoConfirmar, step: "anexo" };
    await salvarSessao(chatId, nova);
    await responderTelegram(chatId, "📎 Quer anexar foto, vídeo ou documento?", {
      inline_keyboard: [
        [
          { text: "Sim", callback_data: "anexar:sim" },
          { text: "Não", callback_data: "anexar:nao" },
        ],
      ],
    });
    return;
  }

  if (data.startsWith("condo:")) {
    const resto = data.slice("condo:".length);
    const separador = resto.indexOf(":");
    const fluxo = resto.slice(0, separador);
    const chave = resto.slice(separador + 1);
    const databaseId = CONDOMINIOS[chave];
    if (!databaseId) return;
    const condominio = NOMES_CONDOMINIOS[chave] ?? chave;

    if (fluxo === "nova") {
      const linhaAtual = await buscarLinhaSessao(chatId);
      const pendente =
        linhaAtual?.sessao?.fluxo === "nova_pendente" ? linhaAtual.sessao : undefined;

      if (pendente) {
        // Retoma o que já tinha sido entendido de um áudio anterior que não
        // conseguiu identificar o condomínio sozinho — roda a etapa 2 agora
        // que já sabemos quais são as opções reais dessa base.
        await processarComCondominioResolvido(
          chatId,
          chave,
          pendente.transcricao,
          pendente.tarefa ?? "",
          pendente.dias ?? null,
        );
      } else {
        const opcoes = await buscarSchemaCondominio(databaseId, chave);
        await continuarNovaTarefa(chatId, {
          fluxo: "nova",
          condominio,
          databaseId,
          opcoes,
          resolvidos: [],
        });
      }
    } else {
      const linhaAtual = await buscarLinhaSessao(chatId);
      const pendenteAtualizar =
        linhaAtual?.sessao?.fluxo === "atualizar_pendente" ? linhaAtual.sessao : undefined;

      if (pendenteAtualizar) {
        await processarAtualizacaoComCondominioResolvido(
          chatId,
          chave,
          pendenteAtualizar.transcricao,
          pendenteAtualizar.tarefaDescricao ?? "",
          pendenteAtualizar.statusTexto ?? null,
          pendenteAtualizar.textoAtualizacao ?? null,
        );
      } else {
        await iniciarEscolhaTarefa(chatId, condominio, databaseId, chave);
      }
    }
    return;
  }

  const linhaSessao = await buscarLinhaSessao(chatId);
  const sessao = linhaSessao?.sessao;
  if (!sessao) return;

  if (data.startsWith("prazo:") && sessao.fluxo === "nova" && sessao.step === "prazo") {
    const dias = Number(data.slice("prazo:".length));
    await continuarNovaTarefa(chatId, {
      ...sessao,
      dias,
      resolvidos: [...sessao.resolvidos, "prazo"],
    });
    return;
  }

  if (data.startsWith("resp:") && sessao.fluxo === "nova" && sessao.step === "responsavel") {
    const resto = data.slice("resp:".length);
    let responsavelValor: ResponsavelValor | undefined;
    if (resto.startsWith("id:")) {
      const id = resto.slice("id:".length);
      const r = sessao.opcoes.responsavel;
      const encontrado = r.tipo === "people" ? r.opcoes.find((p) => p.id === id) : undefined;
      if (encontrado) responsavelValor = { tipo: "people", id, nome: encontrado.nome };
    } else if (resto.startsWith("nome:")) {
      const nome = resto.slice("nome:".length);
      const tipo = sessao.opcoes.responsavel.tipo;
      responsavelValor = { tipo: tipo === "people" ? "select" : tipo, nome };
    }
    await continuarNovaTarefa(chatId, {
      ...sessao,
      responsavelValor,
      resolvidos: [...sessao.resolvidos, "responsavel"],
    });
    return;
  }

  if (data.startsWith("prioridade:") && sessao.fluxo === "nova" && sessao.step === "prioridade") {
    const prioridade = data.slice("prioridade:".length);
    await continuarNovaTarefa(chatId, {
      ...sessao,
      prioridade,
      resolvidos: [...sessao.resolvidos, "prioridade"],
    });
    return;
  }

  if (data.startsWith("setor:") && sessao.fluxo === "nova" && sessao.step === "setor") {
    const valorSetor = data.slice("setor:".length);
    const setor = valorSetor === "pular" ? undefined : valorSetor;
    await continuarNovaTarefa(chatId, {
      ...sessao,
      setor,
      resolvidos: [...sessao.resolvidos, "setor"],
    });
    return;
  }

  if (data.startsWith("tarefa:") && sessao.fluxo === "atualizar" && sessao.step === "tarefa") {
    const pageId = data.slice("tarefa:".length);
    const pagina = (await notionFetch(`pages/${pageId}`)) as {
      properties: Record<string, { title?: { plain_text: string }[] }>;
    };
    const titulo = pagina.properties["Tarefas"]?.title?.[0]?.plain_text ?? "(sem título)";
    const nova: SessaoAtualizarTarefa = { ...sessao, step: "status", pageId, tarefaTitulo: titulo };
    await salvarSessao(chatId, nova);
    await responderTelegram(chatId, `📋 ${titulo}\n\nTarefa mudou de status?`, {
      inline_keyboard: [
        ...sessao.statusOptions.map((s) => [{ text: s, callback_data: `status:${s}` }]),
        [{ text: "➡️ Manter o status atual", callback_data: "status:" }],
      ],
    });
    return;
  }

  if (data.startsWith("status:") && sessao.fluxo === "atualizar" && sessao.step === "status") {
    const novoStatus = data.slice("status:".length) || undefined;
    if (sessao.viaAudio && sessao.textoPendente) {
      // Veio de áudio e o texto da atualização já tinha sido entendido —
      // não precisa perguntar de novo, já vai direto pra confirmação.
      const confirmando: SessaoAtualizarTarefa = { ...sessao, step: "confirmar_audio", novoStatus };
      await salvarSessao(chatId, confirmando);
      await responderTelegram(
        chatId,
        resumoConfirmacaoAtualizacao(confirmando),
        BOTOES_CONFIRMAR_AUDIO,
      );
      return;
    }
    const nova: SessaoAtualizarTarefa = { ...sessao, step: "texto", novoStatus };
    await salvarSessao(chatId, nova);
    await responderTelegram(chatId, "✏️ Descreva a última atualização:");
    return;
  }

  if (data === "anexar:nao" && sessao.fluxo === "atualizar" && sessao.step === "anexo") {
    await finalizarAtualizacao(chatId, sessao);
    return;
  }

  if (data === "anexar:sim" && sessao.fluxo === "atualizar" && sessao.step === "anexo") {
    if (!driveConfigurado()) {
      await responderTelegram(chatId, "📎 Envio de anexos ainda não está disponível — em breve!");
      await finalizarAtualizacao(chatId, sessao);
      return;
    }
    const nova: SessaoAtualizarTarefa = { ...sessao, step: "recebendo_anexo" };
    await salvarSessao(chatId, nova);
    await responderTelegram(
      chatId,
      '📎 Manda a foto, vídeo ou documento agora (pode mandar mais de um). Toque em "✅ Concluir" quando terminar.',
      { inline_keyboard: [[{ text: "✅ Concluir anexos", callback_data: "concluiranexos" }]] },
    );
    return;
  }

  if (
    data === "concluiranexos" &&
    sessao.fluxo === "atualizar" &&
    sessao.step === "recebendo_anexo"
  ) {
    await finalizarAtualizacao(chatId, sessao);
    return;
  }
}

// ---------------------------------------------------------------------------
// Mensagens de texto
// ---------------------------------------------------------------------------

async function tratarMensagem(chatId: number, texto: string): Promise<void> {
  const autorizada = (await condominiosDaSindica(chatId)).length > 0;
  if (!autorizada) {
    await responderTelegram(
      chatId,
      "Você não está cadastrada como síndica ativa. Fale com a equipe pra ser adicionada.",
    );
    return;
  }

  // Atalho camada 1 — comando de uma linha só, sem passar pelo fluxo de botões.
  if (texto.includes("|")) {
    const comando = parsearComando(texto);
    if ("erro" in comando) {
      await responderTelegram(chatId, comando.erro);
      return;
    }
    const url = await criarTarefa(comando);
    await responderTelegram(
      chatId,
      `✅ Tarefa criada: ${comando.tarefa}\n🏢 ${comando.condominio}\n📅 Previsão: ${comando.dias} dia(s)\n\n🔗 ${url}`,
      MENU_PRINCIPAL,
    );
    return;
  }

  if (/^\/(novatarefa|start|menu)(@\w+)?\s*$/i.test(texto) || texto === "🆕 Nova Tarefa") {
    if (/^\/novatarefa/i.test(texto) || texto === "🆕 Nova Tarefa") {
      await iniciarEscolhaCondominio(chatId, "nova");
    } else {
      await mostrarMenuInicial(chatId);
    }
    return;
  }

  if (/^\/atualizartarefa(@\w+)?\s*$/i.test(texto)) {
    await iniciarEscolhaCondominio(chatId, "atualizar");
    return;
  }

  const linhaSessao = await buscarLinhaSessao(chatId);
  const sessao = linhaSessao?.sessao;
  if (!sessao) {
    // Nenhuma conversa em andamento e não é um comando reconhecido — ignora
    // silenciosamente (evita responder a qualquer mensagem solta no chat).
    return;
  }

  if (sessao.fluxo === "nova" && sessao.step === "tarefa") {
    await continuarNovaTarefa(chatId, {
      ...sessao,
      tarefa: texto,
      resolvidos: [...sessao.resolvidos, "tarefa"],
    });
    return;
  }

  if (sessao.fluxo === "atualizar" && sessao.step === "texto") {
    if (sessao.viaAudio) {
      // Veio de áudio (status já resolvido antes de chegar aqui) — confirma
      // antes de gravar, em vez de aplicar direto como no fluxo manual.
      const confirmando: SessaoAtualizarTarefa = {
        ...sessao,
        step: "confirmar_audio",
        textoPendente: texto,
      };
      await salvarSessao(chatId, confirmando);
      await responderTelegram(
        chatId,
        resumoConfirmacaoAtualizacao(confirmando),
        BOTOES_CONFIRMAR_AUDIO,
      );
      return;
    }
    await atualizarTarefa(sessao.pageId!, sessao.novoStatus, texto);
    const nova: SessaoAtualizarTarefa = { ...sessao, step: "anexo" };
    await salvarSessao(chatId, nova);
    await responderTelegram(chatId, "📎 Quer anexar foto, vídeo ou documento?", {
      inline_keyboard: [
        [
          { text: "Sim", callback_data: "anexar:sim" },
          { text: "Não", callback_data: "anexar:nao" },
        ],
      ],
    });
    return;
  }
}

export const Route = createFileRoute("/webhooks/telegram")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let update: Record<string, unknown>;
        try {
          update = await request.json();
        } catch {
          return new Response("JSON inválido", { status: 400 });
        }

        try {
          const callbackQuery = update.callback_query as
            | { id: string; data?: string; message?: { chat?: { id?: number } } }
            | undefined;
          if (callbackQuery) {
            await tratarCallbackQuery(callbackQuery);
            return new Response("ok", { status: 200 });
          }

          const message = update.message as
            | {
                chat?: { id?: number };
                text?: string;
                photo?: { file_id: string }[];
                video?: { file_id: string; file_name?: string; mime_type?: string };
                document?: { file_id: string; file_name?: string; mime_type?: string };
                voice?: { file_id: string; mime_type?: string };
                audio?: { file_id: string; file_name?: string; mime_type?: string };
              }
            | undefined;
          const chatId = message?.chat?.id;

          if (chatId && message?.photo && message.photo.length > 0) {
            await tratarAnexo(chatId, {
              fileId: message.photo[message.photo.length - 1].file_id,
              nomeSugerido: "foto.jpg",
              mimeType: "image/jpeg",
            });
          } else if (chatId && message?.video) {
            await tratarAnexo(chatId, {
              fileId: message.video.file_id,
              nomeSugerido: message.video.file_name ?? "video.mp4",
              mimeType: message.video.mime_type ?? "video/mp4",
            });
          } else if (chatId && message?.document) {
            await tratarAnexo(chatId, {
              fileId: message.document.file_id,
              nomeSugerido: message.document.file_name ?? "documento",
              mimeType: message.document.mime_type ?? "application/octet-stream",
            });
          } else if (chatId && (message?.voice || message?.audio)) {
            // Áudio serve dois propósitos diferentes dependendo do momento:
            // anexo de uma tarefa (fluxo Atualizar, passo "recebendo_anexo")
            // ou criação de tarefa nova por voz (qualquer outro momento) — só
            // dá pra saber qual é olhando a sessão em andamento.
            const linhaSessao = await buscarLinhaSessao(chatId);
            const emAnexo =
              linhaSessao?.sessao?.fluxo === "atualizar" &&
              linhaSessao.sessao.step === "recebendo_anexo";

            if (emAnexo && message.voice) {
              await tratarAnexo(chatId, {
                fileId: message.voice.file_id,
                nomeSugerido: "audio.ogg",
                mimeType: message.voice.mime_type ?? "audio/ogg",
              });
            } else if (emAnexo && message.audio) {
              await tratarAnexo(chatId, {
                fileId: message.audio.file_id,
                nomeSugerido: message.audio.file_name ?? "audio.mp3",
                mimeType: message.audio.mime_type ?? "audio/mpeg",
              });
            } else {
              const fileId = (message.voice ?? message.audio)!.file_id;
              await tratarAudioTarefa(chatId, fileId);
            }
          } else if (chatId && message?.text) {
            await tratarMensagem(chatId, message.text);
          }
        } catch (err) {
          console.error("webhooks/telegram:", err);
          const chatId = (update.message as { chat?: { id?: number } } | undefined)?.chat?.id;
          if (chatId) await responderTelegram(chatId, `❌ Erro: ${(err as Error).message}`);
        }

        // Telegram exige 200 OK mesmo quando ignoramos o evento (tipo de
        // update não tratado, mensagem sem sessão ativa, etc.).
        return new Response("ok", { status: 200 });
      },
    },
  },
});
