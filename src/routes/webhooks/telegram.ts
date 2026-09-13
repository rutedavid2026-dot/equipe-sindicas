import { createFileRoute } from "@tanstack/react-router";

// Recebe mensagens do bot do Telegram (@equipesindicas_bot) e permite criar
// tarefas direto pelo chat, sem abrir o Notion.
//
// Camada 2: fluxo com botões — /novatarefa (sem argumentos) pergunta o
// condomínio (só os que a síndica gerencia, via database "Síndicas"), depois
// o nome da tarefa e a previsão em dias, um passo por mensagem. O estado
// entre uma mensagem e outra fica na database "Sessões (bot Telegram)" (1
// linha por chat_id) — necessário porque cada mensagem chega como uma
// requisição HTTP separada e isolada (sem memória em processo entre elas,
// rodando em edge/serverless).
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
  "contemporâneo": "8a345139cef14f7d8c2777c3e9058675",
  "rivière": "3c3e69ba114f81098890f38772e06395",
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

// Botão "Nova Tarefa" como inline_keyboard (grudado na própria mensagem) em
// vez de ReplyKeyboardMarkup (teclado por baixo da caixa de texto) — o
// teclado por baixo alterna com o teclado do sistema (some sempre que o bot
// espera texto livre, tipo "qual o nome da tarefa?", exigindo tocar num ícone
// pra voltar); o botão inline fica sempre visível na última mensagem do bot,
// sem depender do estado do teclado do celular.
const BOTAO_NOVA_TAREFA = { text: "🆕 Nova Tarefa", callback_data: "novatarefa" };
const MENU_PRINCIPAL = { inline_keyboard: [[BOTAO_NOVA_TAREFA]] };

type ReplyMarkup = { inline_keyboard: { text: string; callback_data: string }[][] };

async function responderTelegram(chatId: number, texto: string, replyMarkup?: ReplyMarkup): Promise<void> {
  await fetch(`https://api.telegram.org/bot${telegramToken()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, reply_markup: replyMarkup ?? MENU_PRINCIPAL }),
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

type Sessao = { step: "aguardando_tarefa" | "aguardando_dias"; condominio: string; tarefa?: string };

// 1 linha por chat_id na database "Sessões (bot Telegram)" — busca a
// existente (se houver) pra decidir entre criar ou atualizar, mesmo padrão
// de fetchTodasPaginasExistentes em sync-followups-notion.mjs.
async function buscarLinhaSessao(chatId: number): Promise<{ pageId: string; sessao: Sessao | null } | null> {
  const json = (await notionFetch(`databases/${SESSOES_DB_ID}/query`, {
    method: "POST",
    body: JSON.stringify({ filter: { property: "ChatId", title: { equals: String(chatId) } } }),
  })) as { results: { id: string; properties: Record<string, { rich_text?: { plain_text: string }[] }> }[] };

  if (json.results.length === 0) return null;
  const page = json.results[0];
  const texto = page.properties["Estado"]?.rich_text?.[0]?.plain_text;
  return { pageId: page.id, sessao: texto ? (JSON.parse(texto) as Sessao) : null };
}

async function salvarSessao(chatId: number, sessao: Sessao): Promise<void> {
  const existente = await buscarLinhaSessao(chatId);
  const properties = { Estado: { rich_text: [{ text: { content: JSON.stringify(sessao) } }] } };
  if (existente) {
    await notionFetch(`pages/${existente.pageId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
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
    return { erro: `Previsão em dias inválida: "${diasTexto}" (precisa ser um número maior que zero).` };
  }
  return { condominio, tarefa, dias };
}

async function criarTarefa({ condominio, tarefa, dias }: ComandoNovaTarefa): Promise<string> {
  const databaseId = CONDOMINIOS[condominio.toLowerCase()];
  if (!databaseId) {
    const nomes = Object.keys(CONDOMINIOS).join(", ");
    throw new Error(`Condomínio "${condominio}" não reconhecido. Condomínios válidos: ${nomes}`);
  }

  const hoje = new Date().toISOString().slice(0, 10);
  const pagina = (await notionFetch("pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        Tarefas: { title: [{ text: { content: tarefa } }] },
        "Data de Início": { date: { start: hoje } },
        "Previsão (em dias)": { number: dias },
      },
    }),
  })) as { url: string };

  return pagina.url;
}

async function iniciarEscolhaCondominio(chatId: number): Promise<void> {
  const condominios = await condominiosDaSindica(chatId);
  if (condominios.length === 0) {
    await responderTelegram(
      chatId,
      "Você não está cadastrada como síndica ativa de nenhum condomínio. Fale com a equipe pra ser adicionada.",
    );
    return;
  }
  if (condominios.length === 1) {
    await salvarSessao(chatId, { step: "aguardando_tarefa", condominio: condominios[0] });
    await responderTelegram(chatId, `🏢 ${condominios[0]}\n\n📝 Qual o nome da tarefa?`);
    return;
  }
  await responderTelegram(chatId, "🏢 Qual condomínio?", {
    inline_keyboard: condominios.map((nome) => [{ text: nome, callback_data: `condo:${nome}` }]),
  });
}

async function tratarCallbackQuery(callbackQuery: {
  id: string;
  data?: string;
  message?: { chat?: { id?: number } };
}): Promise<void> {
  await responderCallback(callbackQuery.id);
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId || !callbackQuery.data) return;

  if (callbackQuery.data === "novatarefa") {
    await iniciarEscolhaCondominio(chatId);
    return;
  }

  if (!callbackQuery.data.startsWith("condo:")) return;
  const condominio = callbackQuery.data.slice("condo:".length);
  await salvarSessao(chatId, { step: "aguardando_tarefa", condominio });
  await responderTelegram(chatId, `🏢 ${condominio}\n\n📝 Qual o nome da tarefa?`);
}

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
    );
    return;
  }

  if (/^\/novatarefa(@\w+)?\s*$/i.test(texto) || texto === "🆕 Nova Tarefa") {
    await iniciarEscolhaCondominio(chatId);
    return;
  }

  const linhaSessao = await buscarLinhaSessao(chatId);
  const sessao = linhaSessao?.sessao;
  if (!sessao) {
    // Nenhuma conversa em andamento e não é um comando reconhecido — ignora
    // silenciosamente (evita responder a qualquer mensagem solta no chat).
    return;
  }

  if (sessao.step === "aguardando_tarefa") {
    await salvarSessao(chatId, { step: "aguardando_dias", condominio: sessao.condominio, tarefa: texto });
    await responderTelegram(chatId, "📅 Previsão em quantos dias?");
    return;
  }

  if (sessao.step === "aguardando_dias") {
    const dias = Number(texto.trim());
    if (!Number.isFinite(dias) || dias <= 0) {
      await responderTelegram(chatId, `Previsão inválida: "${texto}". Manda só o número de dias (ex: 3).`);
      return;
    }
    const url = await criarTarefa({ condominio: sessao.condominio, tarefa: sessao.tarefa!, dias });
    await limparSessao(chatId);
    await responderTelegram(
      chatId,
      `✅ Tarefa criada: ${sessao.tarefa}\n🏢 ${sessao.condominio}\n📅 Previsão: ${dias} dia(s)\n\n🔗 ${url}`,
    );
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

          const message = update.message as { chat?: { id?: number }; text?: string } | undefined;
          const chatId = message?.chat?.id;
          const texto = message?.text ?? "";
          if (chatId && texto) {
            await tratarMensagem(chatId, texto);
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
