#!/usr/bin/env node
// Cadastra um condomínio na planilha índice: cria a aba de histórico (cabeçalho
// copiado de uma aba existente), preenche Aba(gid) e id na aba _configuracao.
// Equivale ao que apps-script/GerenciarCondominios.gs faz quando alguém digita
// nome + link na planilha — usado quando não dá pra editar a planilha à mão.
// Idempotente: se o condomínio já está na _configuracao, não faz nada.
//
// Uso: CONDOMINIO="Mobby" NOTION_URL="https://app.notion.com/p/<id>" \
//      GOOGLE_SERVICE_ACCOUNT_KEY=... node scripts/cadastrar-condominio.mjs
import { createSign } from "node:crypto";

const SPREADSHEET_ID = process.env.REGISTRY_SPREADSHEET_ID || "1fEkPgTf6oGYknWEP6zzi8eyBTpoDDQR0goJg1D_Wed0";
const nome = process.env.CONDOMINIO;
const url = process.env.NOTION_URL;
if (!nome || !url) throw new Error("Defina CONDOMINIO e NOTION_URL.");
const slug = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");

const b64 = (b) => Buffer.from(b).toString("base64url");
async function token() {
  const c = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: c.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }))}`;
  const jwt = `${input}.${createSign("RSA-SHA256").update(input).sign(c.private_key, "base64url")}`;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  return (await r.json()).access_token;
}
const tk = await token();
async function sh(path, init) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`, { ...init, headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

const cfg = (await sh(`/values/${encodeURIComponent("_configuracao")}!A2:D`)).values ?? [];
if (cfg.some((r) => (r[0] ?? "").trim().toLowerCase() === nome.toLowerCase() || r[3] === slug)) {
  console.log(`${nome} já está na _configuracao — nada a fazer.`);
  process.exit(0);
}
const header = (await sh(`/values/${encodeURIComponent("la-perle")}!1:1`)).values?.[0];
if (!header) throw new Error("Não achei o cabeçalho de referência (aba la-perle).");
const meta = await sh("?fields=sheets.properties");
let aba = meta.sheets.find((s) => s.properties.title === slug)?.properties;
if (!aba) {
  const r = await sh(":batchUpdate", { method: "POST", body: JSON.stringify({ requests: [{ addSheet: { properties: { title: slug, gridProperties: { frozenRowCount: 1 } } } }] }) });
  aba = r.replies[0].addSheet.properties;
  await sh(`/values/${encodeURIComponent(slug)}!A1?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [header] }) });
}
await sh(`/values/${encodeURIComponent("_configuracao")}!A:D:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: "POST", body: JSON.stringify({ values: [[nome, url, aba.sheetId, slug]] }) });
console.log(`Cadastrado: ${nome} | aba ${slug} (gid ${aba.sheetId}) | id ${slug}`);
