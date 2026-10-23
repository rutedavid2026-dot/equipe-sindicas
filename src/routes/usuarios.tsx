import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { addUsuario, getUsuarios, removeUsuario } from "@/lib/usuarios.functions";
import { pageMeta } from "@/lib/page-meta";
import { requireAuthComPreview } from "@/lib/auth.functions";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Masthead } from "@/components/report/Masthead";

export const Route = createFileRoute("/usuarios")({
  beforeLoad: requireAuthComPreview,
  head: () => ({
    meta: pageMeta(
      "Equipe Síndicas — Usuários",
      "Quem pode entrar no sistema com o login Google.",
    ),
  }),
  component: UsuariosPage,
});

const QUERY_KEY = ["usuarios"];

function UsuariosPage() {
  const { user } = Route.useRouteContext();
  const qc = useQueryClient();
  const { data: result, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => getUsuarios(),
  });
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  async function adicionar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setSalvando(true);
    const r = await addUsuario({ data: { nome, email } });
    setSalvando(false);
    if (!r.ok) return setErro(r.error);
    setNome("");
    setEmail("");
    await qc.invalidateQueries({ queryKey: QUERY_KEY });
  }

  async function remover(alvo: string) {
    if (!window.confirm(`Remover o acesso de ${alvo}?`)) return;
    setErro(null);
    const r = await removeUsuario({ data: { email: alvo } });
    if (!r.ok) return setErro(r.error);
    await qc.invalidateQueries({ queryKey: QUERY_KEY });
  }

  const usuarios = result?.data ?? [];

  return (
    <main className="bg-background min-h-screen">
      <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 md:px-8 md:py-10">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <Link to="/admin" className="hover:text-brand-green transition-colors">
            ← Voltar
          </Link>
          <span>Conectado como {user.email}</span>
        </div>

        <Masthead condominio="" />

        <section className="bg-card space-y-3 rounded-xl border p-5 shadow-sm">
          <h2 className="text-brand-green text-base font-bold tracking-tight">Adicionar usuário</h2>
          <p className="text-muted-foreground text-xs">
            O e-mail precisa ser uma conta Google. Vale na hora — a pessoa já pode entrar com o
            botão "Entrar com Google".
          </p>
          <form onSubmit={adicionar} className="flex flex-col gap-2 sm:flex-row">
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Nome"
              required
              className="bg-background flex-1 rounded-md border px-3 py-2 text-sm"
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="E-mail (Google)"
              type="email"
              required
              className="bg-background flex-1 rounded-md border px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={salvando}
              className="bg-brand-green rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {salvando ? "Salvando…" : "Salvar"}
            </button>
          </form>
          {erro && <p className="text-sm text-red-700">{erro}</p>}
        </section>

        <section className="bg-card rounded-xl border shadow-sm">
          {isLoading ? (
            <p className="text-muted-foreground p-5 text-sm">Carregando…</p>
          ) : result?.error ? (
            <p className="p-5 text-sm text-red-700">{result.error}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Adicionado em</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {usuarios.map((u) => (
                  <TableRow key={u.email}>
                    <TableCell>{u.nome || "—"}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {u.fixo ? "Liberado na configuração" : u.adicionadoEm}
                    </TableCell>
                    <TableCell className="text-right">
                      {!u.fixo && u.email !== user.email.toLowerCase() && (
                        <button
                          onClick={() => remover(u.email)}
                          className="text-xs text-red-700 hover:underline"
                        >
                          Remover
                        </button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </main>
  );
}
