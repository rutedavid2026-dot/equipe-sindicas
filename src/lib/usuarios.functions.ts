import { createServerFn } from "@tanstack/react-start";
import { getSession } from "@tanstack/react-start/server";
import { getSessionConfig, type AuthSessionData } from "./auth";
import { adicionarUsuario, listarUsuarios, removerUsuario, renomearUsuario, type Usuario } from "./usuarios";

export type ResultadoUsuarios = { data: Usuario[]; error: string | null };
export type ResultadoAcao = { ok: boolean; error: string | null };

async function emailLogado(): Promise<string | null> {
  const session = await getSession<AuthSessionData>(getSessionConfig());
  return session.data.email ?? null;
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export const getUsuarios = createServerFn({ method: "GET" }).handler(
  async (): Promise<ResultadoUsuarios> => {
    if (!(await emailLogado())) return { data: [], error: "Não autenticado." };
    try {
      return { data: await listarUsuarios(), error: null };
    } catch (err) {
      return { data: [], error: err instanceof Error ? err.message : String(err) };
    }
  },
);

export const addUsuario = createServerFn({ method: "POST" })
  .inputValidator((d: { nome: string; email: string }) => d)
  .handler(async ({ data }): Promise<ResultadoAcao> => {
    const por = await emailLogado();
    if (!por) return { ok: false, error: "Não autenticado." };
    const nome = data.nome.trim();
    const email = data.email.trim().toLowerCase();
    if (!nome) return { ok: false, error: "Informe o nome." };
    if (!EMAIL_RE.test(email)) return { ok: false, error: "E-mail inválido." };
    try {
      await adicionarUsuario(nome, email, por);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

export const removeUsuario = createServerFn({ method: "POST" })
  .inputValidator((d: { email: string }) => d)
  .handler(async ({ data }): Promise<ResultadoAcao> => {
    const por = await emailLogado();
    if (!por) return { ok: false, error: "Não autenticado." };
    const email = data.email.trim().toLowerCase();
    if (email === por.toLowerCase()) return { ok: false, error: "Você não pode remover a si mesmo." };
    try {
      await removerUsuario(email);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

export const editUsuarioNome = createServerFn({ method: "POST" })
  .inputValidator((d: { email: string; nome: string }) => d)
  .handler(async ({ data }): Promise<ResultadoAcao> => {
    const por = await emailLogado();
    if (!por) return { ok: false, error: "Não autenticado." };
    const nome = data.nome.trim();
    if (!nome) return { ok: false, error: "Informe o nome." };
    try {
      await renomearUsuario(data.email.trim().toLowerCase(), nome, por);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
