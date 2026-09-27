#!/usr/bin/env node
// Teste de regressão pra duas coisas de uma vez, condomínio por condomínio:
//
//   1. A propriedade "Atualizado em:" (last_edited_time) existe em toda
//      database de tarefas cadastrada na planilha índice — adicionada nos 26
//      condomínios que não tinham (só Miragio Cacupé, Jazz Club e Bossa Nova
//      já tinham, conversa de 2026-09-27).
//   2. O script de captura (capturar-historico-sheets.mjs) continua
//      funcionando em todos eles depois dessa mudança — ou seja, dá pra
//      autenticar com algum dos tokens Notion e consultar a database sem
//      erro. Não escreve na planilha nem no Notion; só lê, então roda sem
//      GOOGLE_SERVICE_ACCOUNT_KEY/_FILE.
//
// Uso:
//   NOTION_API_KEY=ntn_... [NOTION_API_KEY_2=ntn_...] \
//   [REGISTRY_SPREADSHEET_ID=...] \
//   node scripts/testar-atualizado-em.mjs
//
// Sai com código != 0 se qualquer condomínio falhar em qualquer um dos dois
// testes — pra dar pra rodar em CI/gatilho automático, não só manual.

const SPREADSHEET_ID =
  process.env.REGISTRY_SPREADSHEET_ID || "1fEkPgTf6oGYknWEP6zzi8eyBTpoDDQR0goJg1D_Wed0";
const CONFIG_SHEET_NAME = "_configuracao";
const NOTION_VERSION = "2022-06-28";

function getNotionTokens() {
  return ["NOTION_API_KEY", "NOTION_API_KEY_2", "NOTION_API_KEY_3"]
    .map((key) => process.env[key])
    .filter(Boolean);
}

// Lê a aba índice via export CSV público (mesmo endpoint que
// src/lib/sheets.functions.ts usa pra getCondominiosRegistry — não é
// segredo, então esse teste não precisa de credencial do Google pra rodar).
async function lerRegistro() {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(CONFIG_SHEET_NAME)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao ler a planilha índice: HTTP ${res.status}`);
  const linhas = (await res.text())
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean)
    .map(parseCsvLine);
  const entradas = [];
  for (const [condominio, url, , id] of linhas) {
    if (!condominio || !url) continue;
    const dbId = url.match(/[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/)?.[0]?.replace(/-/g, "");
    if (!dbId) continue;
    entradas.push({ condominio, dbId, id: id || condominio });
  }
  return entradas;
}

// Parser CSV mínimo (RFC4180), igual ao de src/lib/sheets.functions.ts —
// duplicado de propósito, esse script roda isolado.
function parseCsvLine(linha) {
  const campos = [];
  let campo = "";
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (aspas) {
      if (c === '"') {
        if (linha[i + 1] === '"') {
          campo += '"';
          i++;
        } else aspas = false;
      } else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ",") {
      campos.push(campo);
      campo = "";
    } else campo += c;
  }
  campos.push(campo);
  return campos;
}

async function notionFetch(token, path) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
  });
  const json = await res.json();
  if (json.object === "error") throw new Error(json.message);
  return json;
}

async function notionQueryUmaLinha(token, dbId) {
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page_size: 1 }),
  });
  const json = await res.json();
  if (json.object === "error") throw new Error(json.message);
  return json;
}

// Tenta cada token até um funcionar pra essa database — mesmo padrão de
// buscarDemandasComTokens em capturar-historico-sheets.mjs (o erro
// "object_not_found" é igual tanto pra ID errado quanto pra database de um
// workspace que aquele token não alcança).
async function comAlgumToken(tokens, fn) {
  let ultimoErro = null;
  for (const token of tokens) {
    try {
      return { ok: true, valor: await fn(token) };
    } catch (err) {
      ultimoErro = err;
    }
  }
  return { ok: false, erro: ultimoErro };
}

async function main() {
  const tokens = getNotionTokens();
  if (tokens.length === 0) {
    throw new Error("Defina NOTION_API_KEY (e opcionalmente _2/_3).");
  }

  console.log("Lendo planilha índice...");
  const registro = await lerRegistro();
  console.log(`${registro.length} condomínio(s) cadastrado(s).\n`);

  const resultados = [];
  for (const { condominio, dbId, id } of registro) {
    const linha = { condominio, id, colunaOk: false, scriptOk: false, detalhe: "" };

    const db = await comAlgumToken(tokens, (t) => notionFetch(t, `databases/${dbId}`));
    if (!db.ok) {
      linha.detalhe = `banco inacessível: ${db.erro.message}`;
      resultados.push(linha);
      continue;
    }
    const prop = db.valor.properties?.["Atualizado em:"];
    linha.colunaOk = prop?.type === "last_edited_time";
    if (!linha.colunaOk) {
      linha.detalhe = prop
        ? `'Atualizado em:' existe mas é tipo '${prop.type}', esperado 'last_edited_time'`
        : "propriedade 'Atualizado em:' não encontrada";
    }

    const query = await comAlgumToken(tokens, (t) => notionQueryUmaLinha(t, dbId));
    linha.scriptOk = query.ok;
    if (!query.ok) {
      linha.detalhe = (linha.detalhe ? linha.detalhe + " | " : "") + `consulta à database falhou: ${query.erro.message}`;
    }

    resultados.push(linha);
  }

  let falhas = 0;
  for (const r of resultados) {
    const status = r.colunaOk && r.scriptOk ? "OK" : "FALHOU";
    if (status === "FALHOU") falhas++;
    console.log(
      `[${status}] ${r.condominio.padEnd(24)} coluna=${r.colunaOk ? "sim" : "NÃO"}  script=${r.scriptOk ? "sim" : "NÃO"}${r.detalhe ? "  — " + r.detalhe : ""}`,
    );
  }

  console.log(`\n${resultados.length - falhas}/${resultados.length} condomínios OK.`);
  if (falhas > 0) {
    console.log(`${falhas} condomínio(s) com falha — ver detalhes acima.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exitCode = 1;
});
