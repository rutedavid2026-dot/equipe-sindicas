import { defineTool } from "@lovable.dev/mcp-js";
import { fetchDemandas } from "../notion";

// "Cancelada" (não só "Cancelado") existe de verdade em bases de
// condomínios diferentes — ver src/lib/report-utils.ts.
const STATUS_FECHADO = ["Concluído", "Feito", "Cancelado", "Cancelada"];

function normalizeStatus(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

function isFechado(status: string): boolean {
  const alvo = normalizeStatus(status);
  return STATUS_FECHADO.some((s) => normalizeStatus(s) === alvo);
}

function temPrioridade(p: string, alvo: string): boolean {
  return p
    .split(",")
    .map((s) => s.trim())
    .includes(alvo);
}

export default defineTool({
  name: "get_priority_demandas",
  title: "High-priority open demands",
  description:
    "List only the demands classified as 'Alta', 'Urgente' or 'Grande Investimento' that are not yet completed or cancelled, across every registered condominium.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async () => {
    const { data, error } = await fetchDemandas();
    if (error) {
      return { content: [{ type: "text", text: `Error: ${error}` }], isError: true };
    }
    const rows = data
      .filter(
        (r) =>
          (temPrioridade(r.prioridade, "Alta") ||
            temPrioridade(r.prioridade, "Urgente") ||
            temPrioridade(r.prioridade, "Grande Investimento")) &&
          !isFechado(r.status),
      )
      .sort((a) => (temPrioridade(a.prioridade, "Urgente") ? -1 : 1));
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { count: rows.length, rows },
    };
  },
});
