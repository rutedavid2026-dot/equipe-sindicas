import { createFileRoute } from "@tanstack/react-router";

// Recebe eventos do webhook de integração do Notion (qualquer mudança em
// qualquer database/página compartilhada com a integração "relatorio-semanal"
// / NOTION_API_KEY_2 — hoje cobre todos os 29 condomínios, ver memória do
// projeto). Ao chegar um evento real, dispara o workflow do GitHub Actions
// que já faz a captura completa (scripts/capturar-historico-sheets.mjs),
// pra não duplicar a lógica de sincronização aqui.
//
// Por que grava o verification_token na planilha em vez de guardar em
// memória: rodando em edge/serverless (Cloudflare via Nitro), cada
// requisição pode cair numa instância/isolate diferente — confirmado na
// prática em 2026-08-24, o GET logo depois do POST de verificação não via o
// token guardado em memória. A aba "_webhook" (célula A1) vira a fonte de
// verdade, com o mesmo Service Account já usado por
// scripts/capturar-historico-sheets.mjs.
//
// Não existe debounce aqui — todo evento dispara na hora. Coalescer edições
// em rajada é responsabilidade da `concurrency` do workflow do GitHub
// Actions (ver .github/workflows/capturar-historico-sheets.yml): uma
// captura nova do mesmo condomínio cancela a anterior ainda em andamento
// (2026-08-30, depois de um debounce por timestamp ter descartado edições
// de verdade em vez de só coalescer rajadas).
//
// Setup (ver instruções passadas no chat):
//   1. notion.so/my-integrations -> sua integração -> aba "Webhooks" ->
//      "+ Create a subscription" -> URL: https://SEU_DOMINIO/webhooks/notion
//   2. A Notion manda um POST único com { verification_token }. Esta rota
//      grava esse token na planilha — acesse a mesma URL via GET (a qualquer
//      momento depois, sem pressa) pra ver o token e colar de volta na UI da
//      Notion, no botão "Verify".
//   3. Depois de verificado, a Notion te dá um "signing_secret" — configure
//      como variável de ambiente NOTION_WEBHOOK_SECRET pra habilitar a
//      validação de assinatura (sem ela, a rota aceita eventos sem checar
//      origem — funciona, mas fica aberta a chamadas forjadas).
//   4. Configure também GOOGLE_SERVICE_ACCOUNT_KEY (o mesmo JSON da Service
//      Account usado no GitHub Actions), GH_WORKFLOW_TOKEN (Personal Access
//      Token do GitHub com permissão "Actions: Read and write") e,
//      opcionalmente, GH_REPO (formato "dono/repo"; default já aponta pro
//      repo atual).

const GH_REPO_DEFAULT = "rutedavid2026-dot/equipe-sindicas";
const GH_WORKFLOW_FILE = "capturar-historico-sheets.yml";
const SPREADSHEET_ID_DEFAULT = "1fEkPgTf6oGYknWEP6zzi8eyBTpoDDQR0goJg1D_Wed0";
// Plano de Ação Vivendas não vive na planilha de configuração (não é um
// condomínio "normal") — tratado como um pseudo-condomínio com esse slug,
// reconhecido pelo database_id fixo (mesmo ID de
// apps-script/OutrosFollowUps.gs e scripts/capturar-historico-sheets.mjs).
const PLANO_ACAO_VIVENDAS_DB_ID = "3c2e69ba114f80cb9c62f1a0843dcf73";
const PLANO_ACAO_VIVENDAS_ID = "vivendas-plano-de-acao";
// Aba própria em vez de colunas extras em '_configuracao' — essa aba tem
// grid fixo de 4 colunas (A-D) usado pelo Apps Script; escrever fora disso
// (ex.: coluna F) dá erro "exceeds grid limits" da Sheets API (confirmado em
// 2026-08-24: a escrita falhava silenciosamente, o handler não checava o
// erro da resposta).
const WEBHOOK_SHEET_NAME = "_webhook";
const CELULA_VERIFICATION_TOKEN = `'${WEBHOOK_SHEET_NAME}'!A1`;

// Versão da API do Notion que suporta o objeto "data_source" (modelo mais
// novo de databases com múltiplas fontes de dados) — diferente da versão
// 2022-06-28 usada no resto do projeto (notion.functions.ts,
// apps-script/CapturaSemanal.gs), que não conhece esse objeto. Só usada
// nesta função isolada de resolução de entidade do evento.
const NOTION_VERSION_DATA_SOURCE = "2026-03-11";

// ---------- Google Sheets API (Service Account, Web Crypto — precisa rodar
// em edge runtime, por isso RSASSA-PKCS1-v1_5 via crypto.subtle em vez de
// node:crypto, diferente de scripts/capturar-historico-sheets.mjs) ----------

function base64UrlFromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  arr.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemParaArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function assinarJwt(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const naoAssinado = `${base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(header)))}.${base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(claim)))}`;
  const chave = await crypto.subtle.importKey(
    "pkcs8",
    pemParaArrayBuffer(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assinatura = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(naoAssinado));
  return `${naoAssinado}.${base64UrlFromBytes(assinatura)}`;
}

async function getAccessToken(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await assinarJwt(serviceAccount),
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error("Falha ao obter access token do Google: " + JSON.stringify(json));
  return json.access_token;
}

function getServiceAccount(): { client_email: string; private_key: string } | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;
  return JSON.parse(raw);
}

async function lerCelula(token: string, spreadsheetId: string, celula: string): Promise<string | null> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(celula)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null; // aba ainda não existe (primeira vez) — trata como "sem valor"
  const json = (await res.json()) as { values?: string[][] };
  return json.values?.[0]?.[0] ?? null;
}

// Cria a aba "_webhook" se ainda não existir — idempotente (a API retorna
// erro se o nome já existir, e a gente simplesmente ignora esse erro).
async function garantirAbaWebhook(token: string, spreadsheetId: string): Promise<void> {
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: WEBHOOK_SHEET_NAME } } }] }),
  });
  // Sem checar o resultado de propósito: se a aba já existe, a API retorna
  // 400 ("already exists") — é o caso normal em toda chamada depois da
  // primeira, não é uma falha real.
}

// Log de diagnóstico (append-only, 1 linha por evento recebido) — criado
// pra investigar uma resolução errada observada em 2026-08-30 (edição no
// Thai Beach resultou em captura do Absoluto). Diferente do diagnóstico
// anterior (célula única, sobrescrita a cada evento — só dava pra ver o
// último), este acumula histórico pra correlacionar rajadas de eventos.
const DIAGNOSTICO_SHEET_NAME = "_webhook_log";

async function garantirAbaDiagnostico(token: string, spreadsheetId: string): Promise<void> {
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: DIAGNOSTICO_SHEET_NAME } } }] }),
  });
  // Erro "already exists" é o caso normal depois da primeira chamada —
  // mesmo padrão de garantirAbaWebhook, sem checar de propósito.
}

async function registrarDiagnostico(token: string, spreadsheetId: string, linha: (string | number)[]): Promise<void> {
  await garantirAbaDiagnostico(token, spreadsheetId);
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${DIAGNOSTICO_SHEET_NAME}'!A1:H`)}:append?valueInputOption=RAW`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [linha] }),
    },
  );
}

async function escreverCelula(token: string, spreadsheetId: string, celula: string, valor: string): Promise<void> {
  await garantirAbaWebhook(token, spreadsheetId);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(celula)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[valor]] }),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Sheets API (escreverCelula ${celula}): ${res.status} ${detail}`);
  }
}

// ---------- Resolução do condomínio a partir do evento da Notion ----------

function getNotionTokens(): string[] {
  return [process.env.NOTION_API_KEY, process.env.NOTION_API_KEY_2, process.env.NOTION_API_KEY_3].filter(
    (t): t is string => !!t,
  );
}

// O evento traz `entity: { id, type }`, onde type é "page"/"database"/
// "data_source"/etc. Só sabemos resolver os dois últimos pra um database_id
// (que é o que a planilha de configuração guarda, extraído da URL). Pra
// "data_source" (modelo novo, uma database pode ter várias fontes de dados),
// precisa buscar o database_id pai via API — usando uma versão mais nova do
// Notion-Version só nessa chamada isolada.
async function resolverDatabaseId(entity: { id?: string; type?: string } | undefined): Promise<string | null> {
  if (!entity?.id) return null;
  if (entity.type === "database") return entity.id;
  if (entity.type !== "data_source") return null;

  for (const token of getNotionTokens()) {
    try {
      const res = await fetch(`https://api.notion.com/v1/data_sources/${entity.id}`, {
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION_DATA_SOURCE },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { parent?: { type?: string; database_id?: string } };
      if (json.parent?.type === "database_id" && json.parent.database_id) {
        return json.parent.database_id;
      }
    } catch {
      // tenta o próximo token (workspaces diferentes, mesmo padrão de
      // buscarDemandasComTokens em apps-script/CapturaSemanal.gs)
    }
  }
  return null;
}

// Duplicado de STATUS_CONCLUIDO/STATUS_CANCELADO (src/lib/report-utils.ts) —
// mesma nota de "duplicada de propósito" do resto deste arquivo: essa rota
// roda isolada, sem importar módulos "de UI" do resto do app.
const STATUS_FECHADO = ["Concluído", "Feito", "Concluída", "Cancelado", "Cancelada"];

function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

// A Notion não guarda (nem expõe por webhook ou API) o histórico de quando
// uma propriedade mudou — só o valor atual. Sem isso, a fórmula "Situação do
// Prazo" (AjustarTarefasInternas.gs / PadronizarDatabase.gs) não tem como
// saber que uma tarefa terminou quando ninguém preenche "Data de Conclusão"
// à mão — ela caía como "Atrasada" (bug corrigido em 2026-09-22, ver
// conversa) e agora cai como "Sem data de conclusão", o que ainda exige
// alguém lembrar de voltar lá e preencher a data.
//
// Em vez de depender disso, todo evento de edição de uma PÁGINA (= uma linha
// de tarefa) passa por aqui: se o Status virou concluído/cancelado e "Data
// de Conclusão" ainda está vazia, preenche com a data de hoje na hora — o
// mais próximo que dá de capturar "quando a tarefa foi concluída" sem ter
// histórico de verdade (é a data em que a mudança de Status chegou aqui via
// webhook, não necessariamente a data "real" que a síndica tinha em mente).
// Best-effort: qualquer falha aqui não deve derrubar a captura normal do
// evento (chamada dentro de try/catch por quem chama).
async function preencherDataConclusaoSeNecessario(pageId: string): Promise<void> {
  for (const token of getNotionTokens()) {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
    });
    if (!res.ok) continue; // tenta o próximo token (mesmo padrão do resto deste arquivo)

    const page = (await res.json()) as {
      properties?: Record<
        string,
        { type: string; status?: { name?: string } | null; date?: { start?: string } | null }
      >;
    };
    const status = page.properties?.["Status"];
    const dataConclusao = page.properties?.["Data de Conclusão"];
    if (!status || status.type !== "status") return;
    if (!dataConclusao || dataConclusao.type !== "date") return;

    const nomeStatus = status.status?.name ?? "";
    const fechado = STATUS_FECHADO.some((s) => normalizeForMatch(s) === normalizeForMatch(nomeStatus));
    if (!fechado || dataConclusao.date) return; // ainda aberta, ou já tem data — nada a fazer

    const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD
    const patch = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties: { "Data de Conclusão": { date: { start: hoje } } } }),
    });
    if (patch.ok) {
      console.log(
        `Notion webhook: preencheu "Data de Conclusão" (${hoje}) da página ${pageId} (Status: "${nomeStatus}").`,
      );
    } else {
      console.warn(`Notion webhook: falha ao preencher "Data de Conclusão" da página ${pageId}: HTTP ${patch.status}`);
    }
    return;
  }
}

function extrairDatabaseId(url: string): string | null {
  const m = url.match(/[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/);
  return m ? m[0].replace(/-/g, "") : null;
}

async function encontrarSlugPorDatabaseId(
  sheetsToken: string,
  spreadsheetId: string,
  databaseId: string,
): Promise<string | null> {
  const alvo = databaseId.replace(/-/g, "").toLowerCase();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent("'_configuracao'!A2:D")}`,
    { headers: { Authorization: `Bearer ${sheetsToken}` } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { values?: string[][] };
  for (const row of json.values ?? []) {
    const url = String(row[1] || "");
    const id = String(row[3] || "").trim();
    const dbId = extrairDatabaseId(url);
    if (dbId && id && dbId.toLowerCase() === alvo) return id;
  }
  return null;
}

// ---------- Assinatura do Notion (HMAC-SHA256, header x-notion-signature) ----------

async function verificarAssinatura(rawBody: string, assinaturaRecebida: string | null, segredo: string) {
  if (!assinaturaRecebida) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const esperada = `sha256=${hex}`;
  if (esperada.length !== assinaturaRecebida.length) return false;
  // Comparação em tempo constante (evita timing attack) — XOR byte a byte.
  let diff = 0;
  for (let i = 0; i < esperada.length; i++) {
    diff |= esperada.charCodeAt(i) ^ assinaturaRecebida.charCodeAt(i);
  }
  return diff === 0;
}

// Dispara sempre, sem debounce que descarta — a fila de verdade é a
// `concurrency` do workflow do GitHub Actions (ver
// .github/workflows/capturar-historico-sheets.yml): uma edição nova no MESMO
// condomínio cancela a captura anterior ainda em andamento e assume o lugar,
// em vez de simplesmente ignorar o evento por estar "muito recente". Isso
// garante que toda edição real eventualmente resulta numa atualização, sem
// depender de uma edição seguinte pra "destravar" (era o problema do
// debounce anterior, que descartava eventos dentro de uma janela fixa).
async function dispararCaptura(condominioSlug: string | null): Promise<{ disparado: boolean; motivo: string }> {
  const token = process.env.GH_WORKFLOW_TOKEN;
  if (!token) {
    return { disparado: false, motivo: "GH_WORKFLOW_TOKEN não configurado" };
  }
  const repo = process.env.GH_REPO || GH_REPO_DEFAULT;
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${GH_WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        // Obrigatório pela API do GitHub — sem isso, todo request leva 403
        // "forbidden by administrative rules" (confirmado em 2026-08-25).
        "User-Agent": "gestao-em-movimento-webhook",
      },
      body: JSON.stringify({ ref: "main", inputs: condominioSlug ? { condominio: condominioSlug } : {} }),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    return { disparado: false, motivo: `GitHub API: ${res.status} ${detail}` };
  }
  return {
    disparado: true,
    motivo: condominioSlug
      ? `workflow_dispatch enviado (condomínio: ${condominioSlug})`
      : "workflow_dispatch enviado (todos os condomínios)",
  };
}

export const Route = createFileRoute("/webhooks/notion")({
  server: {
    handlers: {
      GET: async () => {
        const serviceAccount = getServiceAccount();
        if (!serviceAccount) {
          return new Response("GOOGLE_SERVICE_ACCOUNT_KEY não configurado nesta implantação.", { status: 500 });
        }
        const spreadsheetId = process.env.REGISTRY_SPREADSHEET_ID || SPREADSHEET_ID_DEFAULT;
        const sheetsToken = await getAccessToken(serviceAccount);
        const valor = await lerCelula(sheetsToken, spreadsheetId, CELULA_VERIFICATION_TOKEN);
        return new Response(
          valor
            ? `verification_token: ${valor}`
            : "Nenhum verification_token registrado ainda (cria uma assinatura na Notion e confira aqui de novo).",
          { headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      },
      POST: async ({ request }) => {
        const rawBody = await request.text();
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(rawBody);
        } catch {
          return new Response("JSON inválido", { status: 400 });
        }

        const serviceAccount = getServiceAccount();
        const spreadsheetId = process.env.REGISTRY_SPREADSHEET_ID || SPREADSHEET_ID_DEFAULT;

        // Handshake de verificação (passo único, feito na hora de criar a
        // assinatura na UI da Notion) — não tem assinatura ainda nesse ponto.
        if (typeof json.verification_token === "string") {
          console.log("Notion webhook verification_token:", json.verification_token);
          if (!serviceAccount) {
            return new Response("ok (aviso: GOOGLE_SERVICE_ACCOUNT_KEY não configurado, token não gravado)", {
              status: 200,
            });
          }
          try {
            const sheetsToken = await getAccessToken(serviceAccount);
            await escreverCelula(sheetsToken, spreadsheetId, CELULA_VERIFICATION_TOKEN, json.verification_token);
          } catch (err) {
            console.error("Notion webhook: falha ao gravar verification_token na planilha:", err);
            return new Response(`ok (aviso: falha ao gravar na planilha — ${(err as Error).message})`, {
              status: 200,
            });
          }
          return new Response("ok", { status: 200 });
        }

        const segredo = process.env.NOTION_WEBHOOK_SECRET;
        if (segredo) {
          const assinatura = request.headers.get("x-notion-signature");
          const valido = await verificarAssinatura(rawBody, assinatura, segredo);
          if (!valido) {
            console.warn("Notion webhook: assinatura inválida, ignorando evento.");
            return new Response("assinatura inválida", { status: 401 });
          }
        } else {
          console.warn("Notion webhook: NOTION_WEBHOOK_SECRET não configurado — aceitando evento sem validar origem.");
        }

        // Preenche "Data de Conclusão" automaticamente quando o evento é a
        // edição de uma linha (page) — independente de sheetsToken/planilha,
        // então roda mesmo se a captura completa abaixo falhar. Best-effort:
        // não deixa a resposta do webhook (nem a captura) esperar por um erro
        // aqui.
        const entityRaiz = json.entity as { id?: string; type?: string } | undefined;
        if (entityRaiz?.type === "page" && entityRaiz.id) {
          try {
            await preencherDataConclusaoSeNecessario(entityRaiz.id);
          } catch (err) {
            console.warn("Notion webhook: falha ao tentar preencher Data de Conclusão automaticamente:", err);
          }
        }

        const sheetsToken = serviceAccount ? await getAccessToken(serviceAccount) : null;

        // Resolve qual condomínio mudou, pra reprocessar só ele em vez dos 29
        // — best-effort: qualquer falha aqui (evento de tipo não mapeado,
        // Notion API fora do ar, condomínio não encontrado na planilha) cai
        // pra captura completa, nunca perde o evento por causa da otimização.
        let condominioSlug: string | null = null;
        if (sheetsToken) {
          try {
            const entity = json.entity as { id?: string; type?: string } | undefined;
            const data = json.data as { parent?: { id?: string; type?: string } } | undefined;

            // Edição de uma LINHA (a Notion trata cada linha de database como
            // uma "page") já traz o database_id direto em data.parent.id —
            // confirmado inspecionando um evento real de page.created em
            // 2026-08-30 (o database_id não vinha no `entity`, só em
            // `data.parent`, por isso toda edição de linha caía pra captura
            // completa antes desta correção). Só cai pra resolverDatabaseId
            // (que faz uma chamada extra à API do Notion) quando o evento é
            // sobre a própria database/fonte de dados, não uma linha dela.
            const databaseId =
              entity?.type === "page" && data?.parent?.type === "database" && data.parent.id
                ? data.parent.id
                : await resolverDatabaseId(entity);

            if (databaseId) {
              condominioSlug =
                databaseId.replace(/-/g, "").toLowerCase() === PLANO_ACAO_VIVENDAS_DB_ID.toLowerCase()
                  ? PLANO_ACAO_VIVENDAS_ID
                  : await encontrarSlugPorDatabaseId(sheetsToken, spreadsheetId, databaseId);
            }
            if (entity && !condominioSlug) {
              console.log(`Notion webhook: não resolveu condomínio pra entity ${JSON.stringify(entity)} — captura completa.`);
            }

            // Diagnóstico temporário (2026-08-30) — 1 linha por evento, pra
            // correlacionar rajadas e conferir se o database_id resolvido
            // bate com o condomínio esperado. Remover depois de confirmar.
            try {
              await registrarDiagnostico(sheetsToken, spreadsheetId, [
                new Date().toISOString(),
                String(json.type ?? ""),
                entity?.type ?? "",
                entity?.id ?? "",
                data?.parent?.type ?? "",
                data?.parent?.id ?? "",
                databaseId ?? "",
                condominioSlug ?? "",
              ]);
            } catch {
              // não deixa o diagnóstico quebrar o fluxo principal
            }
          } catch (err) {
            console.warn("Notion webhook: falha ao resolver condomínio do evento, seguindo com captura completa:", err);
          }
        }

        const resultado = await dispararCaptura(condominioSlug);
        console.log("Notion webhook: evento recebido —", resultado.motivo);
        return new Response(JSON.stringify(resultado), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
