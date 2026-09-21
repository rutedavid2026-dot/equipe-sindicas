import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { z } from "zod";
import { getAllDemandas } from "@/lib/notion.functions";
import { requireAuth } from "@/lib/auth.functions";
import {
  getCondominiosRegistry,
  getHistoricoSemana,
  getSemanasDisponiveis,
} from "@/lib/sheets.functions";
import {
  applyFilters,
  brToIso,
  currentWeekNumber,
  isAtrasada,
  isFechada,
  splitLista,
  statusBucket,
  temPrioridade,
  temResponsavel,
  uniqueSorted,
  weekRange,
  SEMANA_TODAS,
  type Filters,
} from "@/lib/report-utils";
import { Masthead } from "@/components/report/Masthead";
import { ReportHeader } from "@/components/report/ReportHeader";
import { KpiCards } from "@/components/report/KpiCards";
import { Charts } from "@/components/report/Charts";
import { ResumoExecutivo } from "@/components/report/ResumoExecutivo";
import { DemandaSectionTable } from "@/components/report/DemandaSectionTable";
import { ConsolidadoFilters } from "@/components/report/ConsolidadoFilters";
import { pageMeta } from "@/lib/page-meta";

const registryQueryOptions = queryOptions({
  queryKey: ["sheets", "registry"],
  queryFn: () => getCondominiosRegistry(),
  staleTime: 60_000,
});

const allDemandasQueryOptions = queryOptions({
  queryKey: ["notion", "demandas", "todas"],
  queryFn: () => getAllDemandas(),
  staleTime: 60_000,
});

const historicoQueryOptions = (slugsKey: string, slugs: string[], semanaInicio: string) =>
  queryOptions({
    queryKey: ["sheets", "historico-multi", slugsKey, semanaInicio],
    queryFn: () => getHistoricoSemana({ data: { semanaInicio, condominioSlugs: slugs } }),
    staleTime: 60_000,
  });

const semanasQueryOptions = (slugsKey: string, slugs: string[]) =>
  queryOptions({
    queryKey: ["sheets", "semanas-multi", slugsKey],
    queryFn: () => getSemanasDisponiveis({ data: { condominioSlugs: slugs } }),
    staleTime: 60_000,
  });

// Mesmo motivo do $condominio.tsx: fica cru (dd-mm-aaaa, "todas" ou "") no
// estado de busca — conversão pra ISO só no ponto de uso, via `brToIso`.
const dateBrOrTodas = z
  .string()
  .optional()
  .default("")
  .refine(
    (v) => v === "" || v === SEMANA_TODAS || /^\d{2}-\d{2}-\d{4}$/.test(v),
    "formato esperado dd-mm-aaaa",
  );

const searchSchema = z.object({
  semanainicio: dateBrOrTodas,
  semanafim: dateBrOrTodas,
  // ids (slugs) dos condomínios selecionados, separados por vírgula — vazio
  // significa "Todos os condomínios cadastrados".
  condominios: z.string().optional().default(""),
  responsavel: z.string().optional().default(""),
  status: z.string().optional().default(""),
  situacaoPrazo: z.string().optional().default(""),
});

export const Route = createFileRoute("/relatorio-geral")({
  validateSearch: (s) => searchSchema.parse(s),
  beforeLoad: requireAuth,
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(registryQueryOptions),
      context.queryClient.ensureQueryData(allDemandasQueryOptions),
    ]);
  },
  head: () => ({
    meta: pageMeta(
      "Dashboard Gerencial — Equipe Síndicas",
      "Dashboard gerencial de acompanhamento de tarefas de múltiplos condomínios, com KPIs, gráficos e detalhamento em tempo real via Notion.",
    ),
  }),
  component: RelatorioGeralPage,
});

function RelatorioGeralPage() {
  const { user } = Route.useRouteContext();
  const search = Route.useSearch();
  const { data: registryResult } = useSuspenseQuery(registryQueryOptions);
  const { data: allResult } = useSuspenseQuery(allDemandasQueryOptions);

  const registry = registryResult.data;
  const condominioOptions = useMemo(
    () => registry.map((r) => ({ id: r.id, condominio: r.condominio })),
    [registry],
  );

  const selecionadosIds = splitLista(search.condominios);
  const isTodosCondominios = selecionadosIds.length === 0;
  const selectedSlugs = useMemo(
    () => (isTodosCondominios ? registry.map((r) => r.id) : selecionadosIds),
    [isTodosCondominios, registry, selecionadosIds],
  );
  const slugsKey = useMemo(() => [...selectedSlugs].sort().join(","), [selectedSlugs]);

  const selectedNames = useMemo(() => {
    if (isTodosCondominios) return null; // null = não filtra por nome, aceita tudo
    return new Set(registry.filter((r) => selecionadosIds.includes(r.id)).map((r) => r.condominio));
  }, [isTodosCondominios, registry, selecionadosIds]);

  const allRows = useMemo(
    () =>
      selectedNames
        ? allResult.data.filter((r) => selectedNames.has(r.condominio))
        : allResult.data,
    [allResult.data, selectedNames],
  );

  const condominioLabel = isTodosCondominios
    ? "Todos os condomínios"
    : selecionadosIds.length === 1
      ? (registry.find((r) => r.id === selecionadosIds[0])?.condominio ?? selecionadosIds[0])
      : `${selecionadosIds.length} condomínios selecionados`;

  const filters: Filters = useMemo(
    () => ({
      responsavel: splitLista(search.responsavel),
      status: search.status,
      situacaoPrazo: search.situacaoPrazo,
    }),
    [search.responsavel, search.status, search.situacaoPrazo],
  );

  const isTodasSemanas = search.semanainicio === SEMANA_TODAS;
  const currentWeekN = useMemo(() => currentWeekNumber(), []);
  const currentRange = useMemo(() => weekRange(currentWeekN), [currentWeekN]);
  const resolvedStart = isTodasSemanas
    ? null
    : search.semanainicio
      ? brToIso(search.semanainicio)
      : currentRange.start;
  const resolvedEnd = isTodasSemanas
    ? null
    : search.semanafim
      ? brToIso(search.semanafim)
      : currentRange.end;

  const historicoQuery = useQuery({
    ...historicoQueryOptions(slugsKey, selectedSlugs, resolvedStart ?? ""),
    enabled: !!resolvedStart,
  });

  const semanasQuery = useQuery(semanasQueryOptions(slugsKey, selectedSlugs));

  const weekOptions = useMemo(() => {
    const list = semanasQuery.data ?? [];
    if (list.some((w) => w.n === currentWeekN)) return list;
    return [...list, { n: currentWeekN, ...currentRange }].sort((a, b) => a.n - b.n);
  }, [semanasQuery.data, currentWeekN, currentRange]);

  const isLoadingFoto = historicoQuery.isLoading;
  const usaFotografia = !isTodasSemanas && (historicoQuery.data?.data.length ?? 0) > 0;
  const baseRows = useMemo(
    () => (isLoadingFoto ? [] : usaFotografia ? historicoQuery.data!.data : allRows),
    [isLoadingFoto, usaFotografia, historicoQuery.data, allRows],
  );

  const responsaveis = useMemo(
    () => uniqueSorted(allRows.flatMap((r) => splitLista(r.responsavel))),
    [allRows],
  );
  const statuses = useMemo(() => uniqueSorted(allRows.map((r) => r.status)), [allRows]);
  const situacoesPrazo = useMemo(
    () => uniqueSorted(allRows.map((r) => r.situacaoPrazo ?? "")),
    [allRows],
  );

  const filtered = useMemo(() => applyFilters(baseRows, filters), [baseRows, filters]);

  const kpis = useMemo(() => {
    let concluidas = 0;
    let canceladas = 0;
    let andamento = 0;
    let pendentes = 0;
    let urgentes = 0;
    let atrasadas = 0;
    filtered.forEach((r) => {
      const b = statusBucket(r.status);
      if (b === "concluido") concluidas += 1;
      else if (b === "cancelado") canceladas += 1;
      else if (b === "andamento") andamento += 1;
      else pendentes += 1;
      if (temPrioridade(r.prioridade, "Urgente") && !isFechada(r.status)) urgentes += 1;
      if (isAtrasada(r.situacaoPrazo) && !isFechada(r.status)) atrasadas += 1;
    });
    return {
      total: filtered.length,
      concluidas,
      canceladas,
      andamento,
      pendentes,
      urgentes,
      atrasadas,
    };
  }, [filtered]);

  const altas = useMemo(
    () =>
      filtered.filter((r) => temPrioridade(r.prioridade, "Alta") && !isFechada(r.status)).length,
    [filtered],
  );

  const abertas = useMemo(() => filtered.filter((r) => !isFechada(r.status)), [filtered]);
  const prioritarias = useMemo(
    () =>
      abertas.filter(
        (r) => temPrioridade(r.prioridade, "Urgente") || temPrioridade(r.prioridade, "Alta"),
      ),
    [abertas],
  );
  const operacionais = useMemo(
    () =>
      abertas.filter(
        (r) => !temPrioridade(r.prioridade, "Urgente") && !temPrioridade(r.prioridade, "Alta"),
      ),
    [abertas],
  );
  const concluidasRows = useMemo(() => filtered.filter((r) => isFechada(r.status)), [filtered]);
  const construtora = useMemo(
    () => filtered.filter((r) => temResponsavel(r.responsavel, "Construtora")),
    [filtered],
  );

  const dataUltimaEdicaoLive = useMemo(() => {
    if (allRows.length === 0) return null;
    return allRows.reduce(
      (max, r) => (r.dataUltimaEdicao > max ? r.dataUltimaEdicao : max),
      allRows[0].dataUltimaEdicao,
    );
  }, [allRows]);

  const referencia = usaFotografia
    ? (historicoQuery.data?.capturadoEm ?? null)
    : dataUltimaEdicaoLive;

  const descricao = `Este dashboard gerencial apresenta o acompanhamento consolidado das tarefas de ${isTodosCondominios ? "todos os condomínios" : condominioLabel}, com foco em tarefa, data de criação, status e última atualização registrada. Há ${kpis.andamento + kpis.pendentes} tarefa${kpis.andamento + kpis.pendentes === 1 ? "" : "s"} em aberto (${kpis.concluidas} já concluída${kpis.concluidas === 1 ? "" : "s"}); o detalhamento abaixo organiza as tarefas em aberto por prioridade, com as concluídas numa seção própria.`;

  const mostraCondominioNasTabelas = isTodosCondominios || selecionadosIds.length > 1;

  return (
    <main className="bg-muted/40 min-h-screen">
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 md:px-8 md:py-10">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <Link to="/admin" className="hover:text-brand-green transition-colors">
            ← Voltar ao menu
          </Link>
          <span className="flex items-center gap-3">
            Conectado como {user.email}
            <a href="/auth/logout" className="hover:text-brand-green transition-colors">
              Sair
            </a>
          </span>
        </div>

        {allResult.errors.length > 0 && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-3 rounded-xl border p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium">Não foi possível carregar todos os condomínios.</p>
              <ul className="mt-1 list-inside list-disc text-xs opacity-80">
                {allResult.errors.map((e) => (
                  <li key={e.condominio}>
                    {e.condominio}: {e.error}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <Masthead condominio={condominioLabel} />

        <ReportHeader
          condominio={condominioLabel}
          semanaInicio={resolvedStart}
          semanaFim={resolvedEnd}
          referencia={referencia}
          descricao={descricao}
          congelado={usaFotografia}
          titulo="Dashboard Gerencial de Acompanhamento"
          variant="gerencial"
        />

        <ConsolidadoFilters
          search={search}
          weekOptions={weekOptions}
          condominioOptions={condominioOptions}
          responsaveis={responsaveis}
          statuses={statuses}
          situacoesPrazo={situacoesPrazo}
        />

        {isLoadingFoto ? (
          <div className="bg-card text-muted-foreground flex flex-col items-center justify-center gap-3 rounded-xl border py-16">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Carregando fotografia da semana selecionada…</p>
          </div>
        ) : (
          <>
            <KpiCards {...kpis} variant="gerencial" />

            <Charts rows={filtered} />

            <ResumoExecutivo
              emMovimento={kpis.andamento + kpis.pendentes}
              urgentes={kpis.urgentes}
              altas={altas}
              atrasadas={kpis.atrasadas}
            />

            <DemandaSectionTable
              title="Tarefas em Aberto - Prioridade Urgente e Alta"
              description="Detalhamento das tarefas que exigem acompanhamento mais próximo. As tarefas concluídas não foram detalhadas nesta seção."
              rows={prioritarias}
              showCondominio={mostraCondominioNasTabelas}
            />

            <DemandaSectionTable
              title="Tarefas em Aberto - Acompanhamento Operacional"
              description="Demais tarefas em andamento, não iniciadas, agendadas ou aguardando providências."
              rows={operacionais}
              showCondominio={mostraCondominioNasTabelas}
            />

            <DemandaSectionTable
              title="Tarefas Concluídas"
              description="Tarefas já concluídas ou canceladas, de todas as prioridades."
              rows={concluidasRows}
              showCondominio={mostraCondominioNasTabelas}
            />

            {construtora.length > 0 && (
              <DemandaSectionTable
                title="Tarefas da Construtora"
                description="Tarefas cuja responsabilidade é da Construtora."
                rows={construtora}
                showCondominio={mostraCondominioNasTabelas}
              />
            )}
          </>
        )}

        <footer className="border-brand-border flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs">
          <span className="text-muted-foreground">
            Equipe Síndicas Profissionais | Dashboard Gerencial
          </span>
          <span className="text-muted-foreground">
            {usaFotografia
              ? "Dados congelados na fotografia semanal (Google Sheets)."
              : "Dados consumidos em tempo real via Notion API."}
          </span>
        </footer>
      </div>
    </main>
  );
}
