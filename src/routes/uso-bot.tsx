import { useMemo } from "react";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { getUsoBot, type UsoBotEntry } from "@/lib/uso-bot.functions";
import { dataLocalIso, formatDatePt, hojeLocalIso } from "@/lib/report-utils";
import { pageMeta } from "@/lib/page-meta";
import { requireAuth } from "@/lib/auth.functions";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Masthead } from "@/components/report/Masthead";

const usoBotQueryOptions = queryOptions({
  queryKey: ["telegram", "uso-bot"],
  queryFn: () => getUsoBot(),
  staleTime: 60_000,
});

export const Route = createFileRoute("/uso-bot")({
  beforeLoad: requireAuth,
  head: () => ({
    meta: pageMeta(
      "Equipe Síndicas — Uso do Bot",
      "Monitor de uso do bot do Telegram: quem mandou mensagem, quando e quantas vezes.",
    ),
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(usoBotQueryOptions),
  component: UsoBotPage,
});

function isoParaDiaBr(iso: string): string {
  const [y, m, d] = dataLocalIso(iso).split("-");
  return `${d}/${m}/${y}`;
}

function diasAtras(dias: number): string {
  const d = new Date(`${hojeLocalIso()}T12:00:00`);
  d.setUTCDate(d.getUTCDate() - dias);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}

function UsoBotPage() {
  const { user } = Route.useRouteContext();
  const { data: result } = useSuspenseQuery(usoBotQueryOptions);

  const hoje = hojeLocalIso();
  const seteDiasAtras = diasAtras(6); // hoje + 6 dias anteriores = janela de 7 dias

  const porDia = useMemo(() => {
    const mapa = new Map<
      string,
      { pessoas: Set<string>; total: number; entradas: UsoBotEntry[] }
    >();
    for (const e of result.data) {
      const dia = dataLocalIso(e.data);
      if (!mapa.has(dia)) mapa.set(dia, { pessoas: new Set(), total: 0, entradas: [] });
      const bucket = mapa.get(dia)!;
      bucket.pessoas.add(e.pessoa);
      bucket.total += 1;
      bucket.entradas.push(e);
    }
    return [...mapa.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [result.data]);

  const kpis = useMemo(() => {
    const doDia = porDia.find(([dia]) => dia === hoje);
    const ultimos7 = result.data.filter((e) => dataLocalIso(e.data) >= seteDiasAtras);
    const pessoas7 = new Set(ultimos7.map((e) => e.pessoa));
    const pessoasTotal = new Set(result.data.map((e) => e.pessoa));
    return {
      mensagensHoje: doDia?.[1].total ?? 0,
      usuariosHoje: doDia?.[1].pessoas.size ?? 0,
      mensagens7: ultimos7.length,
      usuarios7: pessoas7.size,
      usuariosTotal: pessoasTotal.size,
    };
  }, [porDia, result.data, hoje, seteDiasAtras]);

  const recentes = result.data.slice(0, 200);

  return (
    <main className="bg-background min-h-screen">
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 md:px-8 md:py-10">
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

        <Masthead condominio="" />

        <div>
          <h1 className="text-brand-green text-lg font-bold tracking-tight">
            Uso do bot do Telegram
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Quem mandou mensagem pro bot, quando e quantas vezes — 1 linha por interação, gravada
            automaticamente.
          </p>
        </div>

        {result.error && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-xl border p-4 text-sm">
            {result.error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            { label: "Mensagens hoje", value: kpis.mensagensHoje },
            { label: "Usuários hoje", value: kpis.usuariosHoje },
            { label: "Mensagens (7 dias)", value: kpis.mensagens7 },
            { label: "Usuários únicos (7 dias)", value: kpis.usuarios7 },
            { label: "Usuários únicos (total)", value: kpis.usuariosTotal },
          ].map((k) => (
            <div
              key={k.label}
              className="bg-card relative overflow-hidden rounded-lg border p-4 text-left shadow-sm"
            >
              <div className="bg-brand-green absolute inset-x-0 top-0 h-1" />
              <div className="text-foreground text-3xl font-bold tabular-nums">{k.value}</div>
              <div className="text-muted-foreground mt-1 text-xs font-semibold tracking-wide uppercase">
                {k.label}
              </div>
            </div>
          ))}
        </div>

        <div className="bg-card rounded-xl border p-6 shadow-sm">
          <h2 className="text-foreground mb-3 text-sm font-semibold">Por dia</h2>
          {porDia.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nenhuma interação registrada ainda.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dia</TableHead>
                  <TableHead>Usuários</TableHead>
                  <TableHead className="text-right">Mensagens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {porDia.map(([dia, bucket]) => (
                  <TableRow key={dia}>
                    <TableCell className="text-foreground font-medium">
                      {formatDatePt(dia)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {[...bucket.pessoas].sort().join(", ")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{bucket.total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="bg-card rounded-xl border p-6 shadow-sm">
          <h2 className="text-foreground mb-3 text-sm font-semibold">
            Log recente (últimas {recentes.length} interações)
          </h2>
          {recentes.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nenhuma interação registrada ainda.</p>
          ) : (
            <div className="max-h-[600px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Pessoa</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Resumo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentes.map((e, i) => (
                    <TableRow key={`${e.chatId}-${e.data}-${i}`}>
                      <TableCell className="text-muted-foreground whitespace-nowrap">
                        {isoParaDiaBr(e.data)}{" "}
                        {new Date(e.data).toLocaleTimeString("pt-BR", {
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZone: "America/Sao_Paulo",
                        })}
                      </TableCell>
                      <TableCell className="text-foreground font-medium">{e.pessoa}</TableCell>
                      <TableCell className="text-muted-foreground">{e.tipo}</TableCell>
                      <TableCell className="text-muted-foreground max-w-xs truncate">
                        {e.resumo || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
