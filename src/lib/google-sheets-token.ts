// Token de acesso do Google (Service Account) usando só Web Crypto — roda no
// edge e no Node 22. Mesmo código de webhooks/notion.ts e
// scripts/capturar-historico-sheets.mjs, duplicado de propósito (runtimes
// diferentes, cada um isolado do resto); este é o usado por
// scripts/sincronizar-responsaveis.mjs.

type ServiceAccount = { client_email: string; private_key: string };

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  arr.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemParaBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function obterTokenSheets(chaveJson: string): Promise<string> {
  const conta = JSON.parse(chaveJson) as ServiceAccount;
  const agora = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const naoAssinado = `${base64Url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${base64Url(
    enc.encode(
      JSON.stringify({
        iss: conta.client_email,
        scope: "https://www.googleapis.com/auth/spreadsheets",
        aud: "https://oauth2.googleapis.com/token",
        iat: agora,
        exp: agora + 3600,
      }),
    ),
  )}`;
  const chave = await crypto.subtle.importKey(
    "pkcs8",
    pemParaBuffer(conta.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assinatura = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, enc.encode(naoAssinado));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${naoAssinado}.${base64Url(assinatura)}`,
    }),
  });
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Falha ao obter access token do Google");
  return json.access_token;
}
