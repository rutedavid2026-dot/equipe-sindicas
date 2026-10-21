import { obterTokenSheets } from "./google-sheets-token";
import { getAllowedEmails } from "./auth";

// Lista de usuários liberados no login Google, guardada na aba `_usuarios`
// da planilha índice (por enquanto — ver conversa de 2026-10-21). Os e-mails
// da env ALLOWED_EMAILS continuam valendo sempre (são o "piso" que não se
// perde nem se o Sheets cair) e a aba soma a eles.

const SPREADSHEET_ID = "1fEkPgTf6oGYknWEP6zzi8eyBTpoDDQR0goJg1D_Wed0";
const ABA = "_usuarios";
const CABECALHO = ["Nome", "E-mail", "Adicionado por", "Adicionado em", "Ativo"];

export type Usuario = {
  nome: string;
  email: string;
  adicionadoPor: string;
  adicionadoEm: string;
  ativo: boolean;
  fixo: boolean; // vem da env ALLOWED_EMAILS, não removível pela tela
};

function spreadsheetId(): string {
  return process.env.REGISTRY_SPREADSHEET_ID ?? SPREADSHEET_ID;
}

async function token(): Promise<string> {
  const chave = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!chave) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY não configurada.");
  return obterTokenSheets(chave);
}

async function sheetsFetch(tk: string, path: string, init?: RequestInit) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tk}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message ?? `Sheets HTTP ${res.status}`);
  return json;
}

async function garantirAba(tk: string): Promise<void> {
  const meta = (await sheetsFetch(tk, "?fields=sheets.properties.title")) as {
    sheets?: { properties: { title: string } }[];
  };
  if (meta.sheets?.some((s) => s.properties.title === ABA)) return;
  await sheetsFetch(tk, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: ABA } } }] }),
  });
  await sheetsFetch(tk, `/values/${encodeURIComponent(ABA)}!A1:E1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [CABECALHO] }),
  });
}

type Linha = { linha: number; usuario: Omit<Usuario, "fixo"> };

async function lerLinhas(tk: string): Promise<Linha[]> {
  await garantirAba(tk);
  const json = (await sheetsFetch(tk, `/values/${encodeURIComponent(ABA)}!A2:E`)) as {
    values?: string[][];
  };
  const out: Linha[] = [];
  (json.values ?? []).forEach((v, i) => {
    const email = (v[1] ?? "").trim().toLowerCase();
    if (!email) return;
    out.push({
      linha: i + 2,
      usuario: {
        nome: v[0] ?? "",
        email,
        adicionadoPor: v[2] ?? "",
        adicionadoEm: v[3] ?? "",
        ativo: (v[4] ?? "SIM").trim().toUpperCase() !== "NAO",
      },
    });
  });
  return out;
}

export async function listarUsuarios(): Promise<Usuario[]> {
  const tk = await token();
  const linhas = await lerLinhas(tk);
  const fixos = getAllowedEmails();
  const daPlanilha = new Map(linhas.map((l) => [l.usuario.email, l.usuario]));
  const lista: Usuario[] = fixos.map((email) => ({
    nome: daPlanilha.get(email)?.nome ?? "",
    email,
    adicionadoPor: daPlanilha.get(email)?.adicionadoPor ?? "",
    adicionadoEm: daPlanilha.get(email)?.adicionadoEm ?? "",
    ativo: true,
    fixo: true,
  }));
  for (const l of linhas) {
    if (l.usuario.ativo && !fixos.includes(l.usuario.email)) lista.push({ ...l.usuario, fixo: false });
  }
  return lista;
}

export async function adicionarUsuario(nome: string, email: string, por: string): Promise<void> {
  const tk = await token();
  const linhas = await lerLinhas(tk);
  const existente = linhas.find((l) => l.usuario.email === email);
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  if (existente) {
    // reativa (ou atualiza o nome) em vez de duplicar a linha
    await sheetsFetch(
      tk,
      `/values/${encodeURIComponent(ABA)}!A${existente.linha}:E${existente.linha}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values: [[nome, email, por, agora, "SIM"]] }) },
    );
  } else {
    await sheetsFetch(
      tk,
      `/values/${encodeURIComponent(ABA)}!A:E:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: [[nome, email, por, agora, "SIM"]] }) },
    );
  }
  cache.clear();
}

export async function removerUsuario(email: string): Promise<void> {
  const tk = await token();
  const linhas = await lerLinhas(tk);
  const alvo = linhas.find((l) => l.usuario.email === email);
  if (!alvo) return;
  const u = alvo.usuario;
  await sheetsFetch(
    tk,
    `/values/${encodeURIComponent(ABA)}!A${alvo.linha}:E${alvo.linha}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: [[u.nome, u.email, u.adicionadoPor, u.adicionadoEm, "NAO"]] }) },
  );
  cache.clear();
}

// Checagem usada no login e a cada carregamento de página protegida. Cache
// curto pra não bater no Sheets toda hora; se o Sheets falhar, vale só a env
// (nunca derruba quem já está liberado por ela).
const cache = new Map<string, { ok: boolean; ate: number }>();
const TTL_MS = 60_000;

export async function emailLiberado(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  if (getAllowedEmails().includes(e)) return true;
  const hit = cache.get(e);
  if (hit && hit.ate > Date.now()) return hit.ok;
  try {
    const tk = await token();
    const ok = (await lerLinhas(tk)).some((l) => l.usuario.email === e && l.usuario.ativo);
    cache.set(e, { ok, ate: Date.now() + TTL_MS });
    return ok;
  } catch (err) {
    console.error("[usuarios] falha ao consultar a aba _usuarios:", err);
    return false;
  }
}
