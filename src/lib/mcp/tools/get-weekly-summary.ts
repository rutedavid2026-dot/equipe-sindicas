import { defineTool } from "@lovable.dev/mcp-js";
import { fetchDemandas } from "../notion";
import type { Demanda } from "../notion";

const STATUS_CONCLUIDO = ["Concluído", "Feito"];
// "Cancelada" (não só "Cancelado") existe de verdade em bases de
// condomínios diferentes — troca de gênero, não coberta por
// normalizeStatus (só acento/maiúscula). Ver src/lib/report-utils.ts.
const STATUS_CANCELADO = ["Cancelado", "Cancelada"];
const STATUS_ANDAMENTO = ["Em andamento", "Agendado", "Orçamento", "Orçando", "Reaberto", "Sempre"];

// Normaliza maiúsculas/acentos antes de comparar: o mesmo status aparece com
// grafias diferentes entre condomínios (ex.: "cancelado", "orcamento" sem
// cedilha, minúsculo, em vez da forma capitalizada/acentuada).
function normalizeStatus(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

function statusIn(lista: string[], valor: string): boolean {
  const alvo = normalizeStatus(valor);
  return lista.some((item) => normalizeStatus(item) === alvo);
}

function bucket(r: Demanda) {
  if (statusIn(STATUS_CONCLUIDO, r.status)) return "concluidas";
  if (statusIn(STATUS_CANCELADO, r.status)) return "canceladas";
  if (statusIn(STATUS_ANDAMENTO, r.status)) return "em_andamento";
  return "pendentes";
}

function temPrioridade(p: string, alvo: string): boolean {
  return p
    .split(",")
    .map((s) => s.trim())
    .includes(alvo);
}

export default defineTool({
  name: "get_weekly_summary",
  title: "Weekly summary of demands",
  description:
    "Return an executive summary with KPIs (total, completed, cancelled, in progress, pending, urgent), plus counts by responsible, status and category, across every condominium registered in the index sheet.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async () => {
    const { data, error } = await fetchDemandas();
    if (error) {
      return { content: [{ type: "text", text: `Error: ${error}` }], isError: true };
    }

    const kpis = {
      total: data.length,
      concluidas: 0,
      canceladas: 0,
      em_andamento: 0,
      pendentes: 0,
      urgentes: 0,
    };
    const porResponsavel: Record<string, number> = {};
    const porStatus: Record<string, number> = {};
    const porCategoria: Record<string, number> = {};
    const porCondominio: Record<string, number> = {};

    for (const r of data) {
      const b = bucket(r);
      if (b === "concluidas") kpis.concluidas += 1;
      else if (b === "canceladas") kpis.canceladas += 1;
      else if (b === "em_andamento") kpis.em_andamento += 1;
      else kpis.pendentes += 1;
      if (temPrioridade(r.prioridade, "Urgente") && b !== "concluidas" && b !== "canceladas") {
        kpis.urgentes += 1;
      }
      porResponsavel[r.responsavel] = (porResponsavel[r.responsavel] ?? 0) + 1;
      porStatus[r.status] = (porStatus[r.status] ?? 0) + 1;
      porCategoria[r.area] = (porCategoria[r.area] ?? 0) + 1;
      porCondominio[r.condominio] = (porCondominio[r.condominio] ?? 0) + 1;
    }

    const summary = { kpis, porResponsavel, porStatus, porCategoria, porCondominio };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
});
