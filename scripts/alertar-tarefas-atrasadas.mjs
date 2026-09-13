#!/usr/bin/env node
// Alerta via Telegram quando uma tarefa entra em atraso em qualquer database
// Notion de condomínio ("Situação do Prazo" = "Atrasada"). Substitui o
// protótipo que foi validado manualmente no n8n (MVP Equipe Síndicas) —
// mesma lógica, sem precisar manter um servidor n8n rodando.
//
// Deduplicação: cada tarefa alertada vira uma página na database "Alertas
// Enviados" (Notion), indexada pelo Task Page ID da tarefa original. Antes
// de mandar mensagem, checa se já existe — nunca reenvia a mesma tarefa.
//
// Roda via GitHub Actions (.github/workflows/alertar-tarefas-atrasadas.yml).
//
// Uso local:
//   NOTION_API_KEY=ntn_... TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
//     node scripts/alertar-tarefas-atrasadas.mjs

const NOTION_VERSION = "2022-06-28";
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALERTAS_ENVIADOS_DB_ID = "3d9e69ba114f81c0b568eabc3e254819";

if (!NOTION_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error(
    "Defina NOTION_API_KEY, TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID (secrets do GitHub Actions ou variáveis de ambiente locais).",
  );
  process.exit(1);
}

// database_id de cada condomínio no workspace Notion "Notion de Síndicas
// Profissionais". Moana e Saint Exupéry ficavam numa Teamspace que não
// herdou o compartilhamento em lote do resto do workspace — foram
// compartilhadas manualmente com a integração "equipe-sindicas-alertas".
const CONDOMINIOS = [
  { nome: "Miragio Cacupé", databaseId: "3bae69ba114f804b8f22e2ce314226c8" },
  { nome: "Jazz Club", databaseId: "3bae69ba114f80ea98bde507ad0a0c83" },
  { nome: "Las Rozas", databaseId: "3bbe69ba114f808394e9fa22a19ef6d2" },
  { nome: "Vivendas", databaseId: "3bbe69ba114f80519085edf0384e1e38" },
  { nome: "Iconic", databaseId: "3bbe69ba114f80359dc2c50baa98302f" },
  { nome: "Porto dos Açores", databaseId: "3bbe69ba114f80539d80dae69b97eb43" },
  { nome: "Thai Beach", databaseId: "54ce69ba114f834baeb8817600c95070" },
  { nome: "Bossa Nova", databaseId: "3c3e69ba114f8001a9e0d4ddde3f8fb5" },
  { nome: "Boulevard Atlantique", databaseId: "371dabc8b02d4e40a94a75670e080151" },
  { nome: "Palm Beach", databaseId: "3c3e69ba114f81dfbf61dfee1f3bb64d" },
  { nome: "Malibu", databaseId: "3bbe69ba114f8070b9a9e0c43e39e6f6" },
  { nome: "Encantos do Mar", databaseId: "3c3e69ba114f81739c7dfe12c44934cc" },
  { nome: "Mar Aberto", databaseId: "3c3e69ba114f812c84afc22527799c51" },
  { nome: "Contemporâneo", databaseId: "8a345139cef14f7d8c2777c3e9058675" },
  { nome: "Rivière", databaseId: "3c3e69ba114f81098890f38772e06395" },
  { nome: "Saint Exupéry", databaseId: "3c3e69ba114f810d93b0e9bc37d51b06" },
  { nome: "La Plage", databaseId: "3c3e69ba114f81f98d72f0337e5cd6cf" },
  { nome: "Absoluto", databaseId: "3c3e69ba114f818a9154c637ec23dd42" },
  { nome: "Dunas do Leste", databaseId: "3c4e69ba114f81bb8b83f4127872e7af" },
  { nome: "Riozinho Style", databaseId: "3c4e69ba114f81e18b67f69ca39fe4b0" },
  { nome: "Pátéo Campeche", databaseId: "3c4e69ba114f81aab7c7e127f4ff0b94" },
  { nome: "Infiniti", databaseId: "3c4e69ba114f810daf4bcdbbb4768619" },
  { nome: "Luiza Napoli", databaseId: "3c4e69ba114f817ebc73c88e47f71b25" },
  { nome: "Cora Campeche", databaseId: "3c4e69ba114f81c196d2e5acbe817fab" },
  { nome: "Atlantis", databaseId: "3c4e69ba114f818b8cade08fea1aba12" },
  { nome: "Carrara", databaseId: "3c4e69ba114f812bb5a2fa3ceb5b4f47" },
  { nome: "Residencial Saffira", databaseId: "3c4e69ba114f8136a0bdc40866f167a4" },
  { nome: "Moana", databaseId: "3bbe69ba114f8019a7c7d2f640784338" },
  { nome: "Sunset", databaseId: "3c4e69ba114f81699ccaeb754c5d7305" },
];

async function notionFetch(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const json = await res.json();
  if (json.object === "error") {
    throw new Error(`Notion API: ${json.message || res.statusText}`);
  }
  return json;
}

async function buscarTarefasAtrasadas(databaseId) {
  const resultados = [];
  let cursor;
  do {
    const body = {
      filter: { property: "Situação do Prazo", formula: { string: { equals: "Atrasada" } } },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const json = await notionFetch(`databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    resultados.push(...json.results);
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);
  return resultados;
}

// Pagina a database de alertas já enviados uma única vez e monta um Set de
// Task Page IDs — evita uma query de dedup por tarefa (mesma otimização de
// fetchTodasPaginasExistentes em sync-followups-notion.mjs).
async function buscarPageIdsJaAlertados() {
  const idsAlertados = new Set();
  let cursor;
  do {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const json = await notionFetch(`databases/${ALERTAS_ENVIADOS_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    for (const page of json.results) {
      const rt = page.properties["Task Page ID"]?.rich_text ?? [];
      if (rt.length > 0) idsAlertados.add(rt[0].plain_text);
    }
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);
  return idsAlertados;
}

function nomeDaTarefa(page) {
  const title = page.properties["Tarefas"]?.title ?? [];
  return title.length > 0 ? title[0].plain_text : "(sem título)";
}

function condominioDaTarefa(page, nomeConfig) {
  const prop = page.properties["Condomínio"];
  return prop?.select?.name || prop?.multi_select?.[0]?.name || nomeConfig;
}

function prazoDaTarefa(page) {
  return page.properties["Data Prevista de Conclusão"]?.formula?.string || "(sem data)";
}

async function enviarTelegram(texto) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram API: ${json.description || res.statusText}`);
}

function montarMensagem({ tarefa, condominio, prazo, link }) {
  return (
    `🚨 TAREFA ATRASADA\n\n` +
    `📌 Tarefa: ${tarefa}\n\n` +
    `🏢 Condomínio: ${condominio}\n\n` +
    `📅 Prazo: ${prazo}\n\n` +
    `A tarefa está atrasada e precisa de atenção.\n\n` +
    `🔗 Abrir tarefa:\n${link}`
  );
}

async function registrarAlerta({ tarefa, condominio, pageId }) {
  await notionFetch("pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: ALERTAS_ENVIADOS_DB_ID },
      properties: {
        Nome: { title: [{ text: { content: tarefa } }] },
        "Task Page ID": { rich_text: [{ text: { content: pageId } }] },
        Condominio: { rich_text: [{ text: { content: condominio } }] },
        "Data do Alerta": { date: { start: new Date().toISOString() } },
        "Chat ID": { rich_text: [{ text: { content: String(TELEGRAM_CHAT_ID) } }] },
      },
    }),
  });
}

async function main() {
  console.log("Buscando tarefas já alertadas (deduplicação)...");
  const jaAlertados = await buscarPageIdsJaAlertados();
  console.log(`${jaAlertados.size} tarefa(s) já alertada(s) anteriormente.`);

  let enviados = 0;
  const erros = [];

  for (const { nome, databaseId } of CONDOMINIOS) {
    let tarefas;
    try {
      tarefas = await buscarTarefasAtrasadas(databaseId);
    } catch (err) {
      erros.push(`${nome}: falha ao consultar database (${err.message})`);
      continue;
    }

    for (const page of tarefas) {
      if (jaAlertados.has(page.id)) continue;

      const dados = {
        tarefa: nomeDaTarefa(page),
        condominio: condominioDaTarefa(page, nome),
        prazo: prazoDaTarefa(page),
        link: page.url,
        pageId: page.id,
      };

      try {
        await enviarTelegram(montarMensagem(dados));
        await registrarAlerta(dados);
        enviados++;
        // Espaça os envios pra não estourar rate-limit da API do Telegram.
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        erros.push(`${nome} — ${dados.tarefa}: ${err.message}`);
      }
    }
  }

  console.log(`✅ ${enviados} alerta(s) novo(s) enviado(s).`);
  if (erros.length > 0) {
    console.log(`❌ ${erros.length} falha(s):`);
    erros.forEach((e) => console.log(" - " + e));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
