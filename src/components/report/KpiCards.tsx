type Kpi = {
  label: string;
  value: number;
  destaque?: boolean;
};

type Props = {
  total: number;
  concluidas: number;
  canceladas: number;
  andamento: number;
  pendentes: number;
  urgentes: number;
  atrasadas: number;
  variant?: "default" | "gerencial";
};

export function KpiCards({
  total,
  concluidas,
  canceladas,
  andamento,
  pendentes,
  urgentes,
  atrasadas,
  variant = "default",
}: Props) {
  // Visão gerencial: o número de destaque são as tarefas em aberto; andamento,
  // pendentes, urgentes e atrasadas são recortes dentro delas. Concluídas e
  // canceladas ficam fora dos cards (concluídas têm seção própria na página).
  const kpis: Kpi[] =
    variant === "gerencial"
      ? [
          { label: "Tarefas em aberto", value: andamento + pendentes },
          { label: "Em andamento", value: andamento },
          { label: "Pendentes de ação", value: pendentes },
          { label: "Urgentes", value: urgentes },
          { label: "Atrasadas", value: atrasadas, destaque: atrasadas > 0 },
        ]
      : [
          { label: "Total de tarefas", value: total },
          { label: "Concluídas", value: concluidas },
          { label: "Em andamento", value: andamento },
          { label: "Pendentes", value: pendentes },
          { label: "Urgentes", value: urgentes },
          { label: "Atrasadas", value: atrasadas, destaque: atrasadas > 0 },
          ...(canceladas > 0 ? [{ label: "Canceladas", value: canceladas }] : []),
        ];

  return (
    <div
      className={`grid grid-cols-2 gap-3 md:grid-cols-3 ${kpis.length > 6 ? "lg:grid-cols-7" : kpis.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-6"}`}
    >
      {kpis.map((k) =>
        variant === "gerencial" ? (
          <div
            key={k.label}
            className="bg-card relative overflow-hidden rounded-lg border p-4 text-left shadow-sm"
          >
            <div
              className={`absolute inset-x-0 top-0 h-1 ${k.destaque ? "bg-destructive" : "bg-brand-green"}`}
            />
            <div
              className={`text-3xl font-bold tabular-nums ${k.destaque ? "text-destructive" : "text-foreground"}`}
            >
              {k.value}
            </div>
            <div
              className={`mt-1 text-xs font-semibold tracking-wide uppercase ${k.destaque ? "text-destructive" : "text-muted-foreground"}`}
            >
              {k.label}
            </div>
          </div>
        ) : (
          <div
            key={k.label}
            className={
              k.destaque
                ? "bg-destructive/10 border-destructive/40 rounded-xl border p-4 text-center"
                : "bg-brand-cream border-brand-border rounded-xl border p-4 text-center"
            }
          >
            <div
              className={
                k.destaque
                  ? "text-destructive text-3xl font-bold"
                  : "text-brand-green text-3xl font-bold"
              }
            >
              {k.value}
            </div>
            <div
              className={
                k.destaque
                  ? "text-destructive mt-1 text-xs font-semibold"
                  : "text-muted-foreground mt-1 text-xs font-medium"
              }
            >
              {k.label}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
