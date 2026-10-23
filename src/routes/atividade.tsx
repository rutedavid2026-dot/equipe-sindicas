import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { getAtividade } from "@/lib/atividade.functions";
import { pageMeta } from "@/lib/page-meta";
import { requireAuth } from "@/lib/auth.functions";
import { Masthead } from "@/components/report/Masthead";

export const Route = createFileRoute("/atividade")({
  beforeLoad: requireAuth,
  head: () => ({
    meta: pageMeta(
      "Equipe Síndicas — Atividade",
      "O que foi criado ou alterado em cada condomínio nos últimos dias.",
    ),
  }),
  // Link filtrado: /atividade?periodo=hoje|ontem|7dias|30dias[&condominio=<id>]
  // ("ontem" = ontem e hoje; "condominio" = id da planilha índice, ex.: mobby).
  validateSearch: (s: Record<string, unknown>): { periodo?: Periodo; condominio?: string } => ({
    periodo: PERIODOS.some((p) => p.chave === s.periodo) ? (s.periodo as Periodo) : undefined,
    condominio:
      typeof s.condominio === "string" && s.condominio.trim()
        ? s.condominio.trim().toLowerCase()
        : undefined,
  }),
  component: AtividadePage,
});

type Periodo = "hoje" | "ontem" | "7dias" | "30dias";
const PERIODOS: { chave: Periodo; dias: number; rotulo: string }[] = [
  { chave: "hoje", dias: 1, rotulo: "Hoje" },
  { chave: "ontem", dias: 2, rotulo: "Ontem e hoje" },
  { chave: "7dias", dias: 7, rotulo: "7 dias" },
  { chave: "30dias", dias: 30, rotulo: "30 dias" },
];

function quando(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AtividadePage() {
  const { user } = Route.useRouteContext();
  const { periodo = "ontem", condominio: filtro } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const dias = PERIODOS.find((p) => p.chave === periodo)!.dias;
  const { data: result, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["atividade", dias],
    queryFn: () => getAtividade({ data: { dias } }),
    staleTime: 60_000,
  });

  const todos = result?.data ?? [];
  const condos = filtro ? todos.filter((c) => c.id.toLowerCase() === filtro) : todos;
  const comAtividade = condos
    .filter((c) => c.itens.length > 0)
    .sort((a, b) => b.itens[0].quando.localeCompare(a.itens[0].quando));
  const semAtividade = condos.filter((c) => c.itens.length === 0 && !c.erro);
  const comErro = condos.filter((c) => c.erro);
  const novas = comAtividade.reduce((n, c) => n + c.itens.filter((i) => i.tipo === "nova").length, 0);
  const editadas = comAtividade.reduce(
    (n, c) => n + c.itens.filter((i) => i.tipo === "editada").length,
    0,
  );

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

        <div className="flex flex-wrap items-center gap-2">
          {PERIODOS.map((p) => (
            <button
              key={p.dias}
              onClick={() => navigate({ search: (prev) => ({ ...prev, periodo: p.chave }) })}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                p.chave === periodo
                  ? "bg-brand-green border-transparent text-white"
                  : "bg-card hover:border-brand-green"
              }`}
            >
              {p.rotulo}
            </button>
          ))}
          {filtro && (
            <button
              onClick={() => navigate({ search: (prev) => ({ ...prev, condominio: undefined }) })}
              className="bg-card hover:border-brand-green rounded-full border px-3 py-1 text-xs"
            >
              {condos[0]?.condominio ?? filtro} ✕ ver todos
            </button>
          )}
          <button
            onClick={() => refetch()}
            className="text-muted-foreground hover:text-brand-green ml-auto text-xs"
          >
            {isFetching ? "Atualizando…" : "Atualizar"}
          </button>
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Consultando o Notion…</p>
        ) : result?.error ? (
          <p className="text-sm text-red-700">{result.error}</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {[
                { n: comAtividade.length, r: `de ${condos.length} condomínios com atividade` },
                { n: novas, r: "tarefas novas" },
                { n: editadas, r: "tarefas editadas" },
              ].map((k) => (
                <div key={k.r} className="bg-card rounded-xl border p-4 shadow-sm">
                  <p className="text-brand-green text-2xl font-bold">{k.n}</p>
                  <p className="text-muted-foreground text-xs">{k.r}</p>
                </div>
              ))}
            </div>

            {comAtividade.length === 0 && (
              <p className="text-muted-foreground text-sm">Nenhuma atividade no período.</p>
            )}

            {comAtividade.map((c) => (
              <section key={c.id} className="bg-card rounded-xl border shadow-sm">
                <h2 className="text-brand-green border-b px-5 py-3 text-sm font-bold">
                  <button
                    onClick={() => navigate({ search: (prev) => ({ ...prev, condominio: c.id }) })}
                    className="hover:underline"
                  >
                    {c.condominio}
                  </button>
                  <span className="text-muted-foreground ml-2 text-xs font-normal">
                    {c.itens.filter((i) => i.tipo === "nova").length} novas ·{" "}
                    {c.itens.filter((i) => i.tipo === "editada").length} editadas
                  </span>
                </h2>
                <ul className="divide-y">
                  {c.itens.map((i) => (
                    <li key={i.url} className="flex items-start gap-3 px-5 py-2.5 text-sm">
                      <span
                        className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                          i.tipo === "nova"
                            ? "bg-brand-green text-white"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {i.tipo}
                      </span>
                      <div className="min-w-0 flex-1">
                        <a href={i.url} target="_blank" rel="noreferrer" className="hover:underline">
                          {i.tarefa}
                        </a>
                        <p className="text-muted-foreground text-xs">
                          {[i.status, i.responsavel].filter(Boolean).join(" · ") || "—"}
                        </p>
                      </div>
                      <span className="text-muted-foreground shrink-0 text-xs">{quando(i.quando)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            {comErro.length > 0 && (
              <section className="rounded-xl border border-red-300 p-4 text-sm">
                <p className="font-semibold text-red-700">Não consegui ler:</p>
                <ul className="text-xs text-red-700">
                  {comErro.map((c) => (
                    <li key={c.id}>
                      {c.condominio}: {c.erro}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {semAtividade.length > 0 && (
              <section className="bg-card rounded-xl border p-5 shadow-sm">
                <h2 className="text-muted-foreground mb-2 text-xs font-bold uppercase">
                  Sem atividade ({semAtividade.length})
                </h2>
                <p className="text-sm">{semAtividade.map((c) => c.condominio).join(" · ")}</p>
              </section>
            )}

            <p className="text-muted-foreground text-xs">
              "Editada" = a tarefa foi alterada no Notion no período (o Notion não informa qual
              campo mudou). Gerado em {quando(result!.geradoEm)}.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
