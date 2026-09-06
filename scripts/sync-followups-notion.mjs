#!/usr/bin/env node
// Sincroniza as abas "Follow-up da semana" e "Outros Follow-ups" (Google
// Sheets, lidas via export CSV público — sem credenciais do Google) com a
// database "Gestão em Movimento - Relatórios Semanais" no Notion.
//
// "Outros Follow-ups" (Plano de Ação Vivendas) foi adicionada em 2026-09-05
// — faltava desde sempre esse espelho (nem o Apps Script antigo fazia isso
// pro Plano de Ação, só pros condomínios normais em "Follow-up da semana");
// a linha "Residencial Vivendas Home Club — Relatório Gerencial do Plano de
// Ação" tinha ficado parada numa semana antiga sem link até o backfill
// manual + esta correção.
//
// Roda via GitHub Actions (.github/workflows/sync-followups-notion.yml),
// independente do Apps Script — o Apps Script tem cota diária de
// UrlFetchApp (20 mil chamadas/dia numa conta free) que estourou fazendo o
// backfill do histórico completo; aqui não há esse limite, e dá pra rodar a
// qualquer momento pelo botão "Run workflow" no GitHub, sem depender do
// editor do Apps Script.
//
// Uso local: NOTION_TOKEN=ntn_... node scripts/sync-followups-notion.mjs

const SPREADSHEET_ID =
  process.env.REGISTRY_SPREADSHEET_ID || "1fEkPgTf6oGYknWEP6zzi8eyBTpoDDQR0goJg1D_Wed0";
const FOLLOWUPS_GID = process.env.FOLLOWUPS_GID || "1720412368";
const OUTROS_FOLLOWUPS_GID = process.env.OUTROS_FOLLOWUPS_GID || "22211610";
const NOTION_FOLLOWUPS_DB_ID = "3c1e69ba114f8020b465f0db2be179ee";
const NOTION_VERSION = "2022-06-28";
const NOTION_TOKEN = process.env.NOTION_TOKEN;

if (!NOTION_TOKEN) {
  console.error("Defina NOTION_TOKEN (secret do GitHub Actions ou variável de ambiente local).");
  process.exit(1);
}

// Mesmo parser CSV mínimo (RFC4180) de src/lib/sheets.functions.ts, duplicado
// de propósito pra manter este script standalone (sem depender do runtime do
// TanStack Start pra rodar em CI).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // ignora, o \n seguinte fecha a linha
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function fetchCsv(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao ler planilha (gid ${gid}): HTTP ${res.status}`);
  return parseCsv(await res.text());
}

function col(header, ...names) {
  for (const name of names) {
    const i = header.indexOf(name);
    if (i !== -1) return i;
  }
  return -1;
}

async function notionFetch(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
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

// Pagina a database inteira uma vez e monta um mapa "condominio|||semana" ->
// pageId, pra decidir criar/atualizar sem uma query por linha (mesma
// otimização de apps-script/NotionFollowups.gs).
async function fetchTodasPaginasExistentes() {
  const mapa = new Map();
  let cursor;
  do {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const json = await notionFetch(`databases/${NOTION_FOLLOWUPS_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    for (const page of json.results) {
      const titulo = page.properties.Condominio.title;
      const nome = titulo.length > 0 ? titulo[0].plain_text : "";
      const semana = page.properties.Semana.number;
      if (nome && semana != null) mapa.set(`${nome}|||${semana}`, page.id);
    }
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);
  return mapa;
}

function montarPropriedades(condominio, semana, dataInicio, dataFim, link) {
  return {
    Condominio: { title: [{ text: { content: condominio } }] },
    Semana: { number: semana },
    "Intervalo de Semana": { date: { start: dataInicio, end: dataFim } },
    "Link do Report": { url: link },
  };
}

// "nome" na aba "Outros Follow-ups" é um rótulo curto pra exibição na
// planilha ("Vivendas - Plano de Ação") — diferente do título já cadastrado
// na linha correspondente na database Notion ("Residencial Vivendas Home
// Club — Relatório Gerencial do Plano de Ação", criada manualmente antes
// desta automação). Sem esse mapeamento, sincronizaria como uma linha nova
// duplicada em vez de atualizar a existente.
const NOME_NOTION_POR_NOME_PLANILHA = {
  "Vivendas - Plano de Ação": "Residencial Vivendas Home Club — Relatório Gerencial do Plano de Ação",
};

// "Follow-up da semana" usa a coluna "condominio"; "Outros Follow-ups" usa
// "nome" (mesmo dado — nome de exibição —, header diferente porque essa aba
// não é exclusiva de condomínio). col() aceita os dois.
function linhasDoCsv([header, ...body]) {
  if (!header) return [];
  const iCondominio = col(header, "condominio", "condomínio", "Condominio", "Condomínio", "nome");
  const iSemana = col(header, "semana", "Semana");
  const iLink = col(header, "link-follow-up", "URL");
  const iInicio = col(header, "data-inicio", "Data Início");
  const iTermino = col(header, "data-termino", "Data Término");

  return body
    .map((r) => {
      const nomePlanilha = (r[iCondominio] ?? "").trim();
      return {
        condominio: NOME_NOTION_POR_NOME_PLANILHA[nomePlanilha] || nomePlanilha,
        semana: Number((r[iSemana] ?? "").trim()),
        link: (r[iLink] ?? "").trim(),
        dataInicio: (r[iInicio] ?? "").trim(),
        dataFim: (r[iTermino] ?? "").trim(),
      };
    })
    .filter((r) => r.condominio && Number.isFinite(r.semana) && r.link);
}

async function main() {
  console.log("Lendo planilhas de follow-ups...");
  const linhas = [
    ...linhasDoCsv(await fetchCsv(FOLLOWUPS_GID)),
    ...linhasDoCsv(await fetchCsv(OUTROS_FOLLOWUPS_GID)),
  ];

  console.log(`${linhas.length} linha(s) nas planilhas.`);

  console.log("Buscando páginas já existentes no Notion...");
  const existentes = await fetchTodasPaginasExistentes();
  console.log(`${existentes.size} página(s) já existentes na database.`);

  let criadas = 0;
  let atualizadas = 0;
  const erros = [];

  for (const linha of linhas) {
    const chave = `${linha.condominio}|||${linha.semana}`;
    const properties = montarPropriedades(
      linha.condominio,
      linha.semana,
      linha.dataInicio,
      linha.dataFim,
      linha.link,
    );
    try {
      const pageId = existentes.get(chave);
      if (pageId) {
        await notionFetch(`pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
        atualizadas++;
      } else {
        const pagina = await notionFetch("pages", {
          method: "POST",
          body: JSON.stringify({ parent: { database_id: NOTION_FOLLOWUPS_DB_ID }, properties }),
        });
        existentes.set(chave, pagina.id);
        criadas++;
      }
    } catch (err) {
      erros.push(`${linha.condominio} (semana ${linha.semana}): ${err.message}`);
    }
  }

  console.log(`✅ ${criadas} criada(s), ${atualizadas} atualizada(s).`);
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
