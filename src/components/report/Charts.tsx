import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Demanda } from "@/lib/notion.functions";
import { normalizeForMatch, prioridadeList } from "@/lib/report-utils";

// Ordem igual ao PDF (Concluído, Em andamento, Não iniciado, Agendado,
// Aguardando); os demais status (vocabulário mais rico de outros condomínios,
// ex.: Vivendas Home Club) entram depois, na ordem declarada aqui.
const STATUS_COLORS: Record<string, string> = {
  Concluído: "#173F35",
  Feito: "#173F35",
  "Em andamento": "#2E5D7A",
  "Não iniciado": "#C66A2E",
  Agendado: "#7A2E3A",
  Aguardando: "#727272",
  Orçamento: "#8A6D3B",
  Orçando: "#8A6D3B",
  Reaberto: "#B08D57",
  Sempre: "#4A6B57",
  Assembleia: "#5B4B8A",
  Planejando: "#4A7A8C",
  Atrasado: "#B23A48",
  Parada: "#9A9A9A",
  Cancelado: "#3F3F3F",
};
const STATUS_ORDER = Object.keys(STATUS_COLORS);

// O Notion às vezes tem grafias divergentes pro mesmo status (ex.: "Nao
// iniciado" sem acento cadastrado à parte de "Não iniciado") — normaliza pro
// rótulo canônico conhecido antes de agrupar, pra não duplicar barra no
// gráfico. Fora daqui (tabelas, badges) o valor bruto continua sendo exibido.
const CANONICAL_STATUS = new Map(
  Object.keys(STATUS_COLORS).map((label) => [normalizeForMatch(label), label]),
);
function canonicalStatus(status: string): string {
  return CANONICAL_STATUS.get(normalizeForMatch(status)) ?? status;
}

const PRIORIDADE_ORDER = ["Urgente", "Grande Investimento", "Alta", "Média", "Baixa"] as const;
const PRIORIDADE_COLORS: Record<string, string> = {
  Urgente: "#7A2E3A",
  "Grande Investimento": "#5B4B8A",
  Alta: "#C66A2E",
  Média: "#173F35",
  Baixa: "#727272",
};

const SITUACAO_PRAZO_ORDER = [
  "Em dia",
  "Atrasada",
  "Concluída no Prazo",
  "Concluída com Atraso",
] as const;
const SITUACAO_PRAZO_COLORS: Record<string, string> = {
  "Em dia": "#173F35",
  Atrasada: "#7A2E3A",
  "Concluída no Prazo": "#2E5D7A",
  "Concluída com Atraso": "#C66A2E",
};
const CANONICAL_SITUACAO_PRAZO = new Map(
  SITUACAO_PRAZO_ORDER.map((label) => [normalizeForMatch(label), label]),
);
function canonicalSituacaoPrazo(situacao: string): string | null {
  return CANONICAL_SITUACAO_PRAZO.get(normalizeForMatch(situacao)) ?? null;
}

function MiniChart({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-brand-border bg-card rounded-xl border p-5 shadow-sm">
      <p className="text-muted-foreground text-center text-sm">{title}</p>
      <div className="mt-2 h-[240px] w-full">{children}</div>
    </div>
  );
}

export function Charts({ rows }: { rows: Demanda[] }) {
  const statusData = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((r) => {
      const status = canonicalStatus(r.status);
      map.set(status, (map.get(status) ?? 0) + 1);
    });
    return Array.from(map, ([name, total]) => ({ name, total })).sort((a, b) => {
      const ia = STATUS_ORDER.indexOf(a.name);
      const ib = STATUS_ORDER.indexOf(b.name);
      return (ia === -1 ? STATUS_ORDER.length : ia) - (ib === -1 ? STATUS_ORDER.length : ib);
    });
  }, [rows]);

  const prioridadeData = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((r) => {
      for (const p of prioridadeList(r.prioridade)) {
        if (!PRIORIDADE_ORDER.includes(p as (typeof PRIORIDADE_ORDER)[number])) continue;
        map.set(p, (map.get(p) ?? 0) + 1);
      }
    });
    return PRIORIDADE_ORDER.map((name) => ({ name, total: map.get(name) ?? 0 }));
  }, [rows]);

  const situacaoPrazoData = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((r) => {
      const situacao = canonicalSituacaoPrazo(r.situacaoPrazo ?? "");
      if (!situacao) return;
      map.set(situacao, (map.get(situacao) ?? 0) + 1);
    });
    return SITUACAO_PRAZO_ORDER.map((name) => ({ name, total: map.get(name) ?? 0 }));
  }, [rows]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-brand-green text-lg font-bold tracking-tight">
          Gráficos de acompanhamento
        </h2>
        <div className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <MiniChart title="Tarefas por status">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusData} margin={{ bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11 }}
                  angle={-25}
                  textAnchor="end"
                  height={60}
                />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                  {statusData.map((entry) => (
                    <Cell key={entry.name} fill={STATUS_COLORS[entry.name] ?? "#64748b"} />
                  ))}
                  <LabelList dataKey="total" position="top" fontSize={12} fontWeight={600} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </MiniChart>

          <MiniChart title="Tarefas por prioridade">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={prioridadeData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                  {prioridadeData.map((entry) => (
                    <Cell key={entry.name} fill={PRIORIDADE_COLORS[entry.name] ?? "#64748b"} />
                  ))}
                  <LabelList dataKey="total" position="top" fontSize={12} fontWeight={600} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </MiniChart>

          <MiniChart title="Tarefas por situação de prazo">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={situacaoPrazoData} margin={{ bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11 }}
                  angle={-25}
                  textAnchor="end"
                  height={60}
                />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                  {situacaoPrazoData.map((entry) => (
                    <Cell key={entry.name} fill={SITUACAO_PRAZO_COLORS[entry.name] ?? "#64748b"} />
                  ))}
                  <LabelList dataKey="total" position="top" fontSize={12} fontWeight={600} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </MiniChart>
        </div>
      </div>
    </div>
  );
}
