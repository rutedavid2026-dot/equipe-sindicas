import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, User } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Demanda } from "@/lib/notion.functions";
import { brDateSortKey, formatDatePt, isAtrasada, situacaoPrazoClass } from "@/lib/report-utils";

type Props = {
  title: string;
  description: string;
  rows: Demanda[];
  showCondominio?: boolean;
};

type SortKey =
  | "demanda"
  | "condominio"
  | "responsavel"
  | "criadaEm"
  | "status"
  | "situacaoPrazo"
  | "dataPrevista"
  | "concluidoEm"
  | "ultimaAtualizacao";

type SortState = { key: SortKey; dir: "asc" | "desc" } | null;

function sortValue(r: Demanda, key: SortKey): string {
  switch (key) {
    case "demanda":
      return r.demanda;
    case "condominio":
      return r.condominio;
    case "responsavel":
      return r.responsavel;
    case "criadaEm":
      return r.criadaEm ?? "";
    case "status":
      return r.status;
    case "situacaoPrazo":
      return r.situacaoPrazo ?? "";
    case "dataPrevista":
      return brDateSortKey(r.dataPrevista);
    case "concluidoEm":
      return r.concluidoEm ?? "";
    case "ultimaAtualizacao":
      return r.ultimaAtualizacao || r.historico || "";
  }
}

function rowHighlightClass(r: Demanda, i: number): string {
  if (isAtrasada(r.situacaoPrazo)) return "bg-destructive/10";
  return i % 2 === 1 ? "bg-brand-cream/40" : "bg-card";
}

export function DemandaSectionTable({ title, description, rows, showCondominio }: Props) {
  const [sort, setSort] = useState<SortState>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const { key, dir } = sort;
    const factor = dir === "asc" ? 1 : -1;
    return [...rows].sort(
      (a, b) => sortValue(a, key).localeCompare(sortValue(b, key), "pt-BR") * factor,
    );
  }, [rows, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  };

  return (
    <div className="bg-card overflow-hidden rounded-xl border shadow-sm">
      <div className="border-b p-5">
        <h3 className="text-brand-green text-lg font-bold tracking-tight">{title}</h3>
        <p className="text-muted-foreground mt-1 text-xs">{description}</p>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground py-10 text-center text-sm">
          Nenhuma tarefa encontrada para os filtros atuais.
        </p>
      ) : (
        <>
          <ul className="sm:hidden">
            {sortedRows.map((r, i) => (
              <li
                key={r.id}
                className={rowHighlightClass(r, i)}
                style={{ borderBottom: "0.5px solid var(--brand-border)" }}
              >
                <div className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:underline"
                    >
                      {r.demanda || "—"}
                    </a>
                    <div className="text-muted-foreground mt-1 flex items-center gap-1 text-sm">
                      <User className="size-3.5 shrink-0" />
                      <span className="truncate">{r.responsavel || "—"}</span>
                    </div>
                    {showCondominio && (
                      <p className="text-muted-foreground/80 mt-1 text-xs font-medium">
                        {r.condominio}
                      </p>
                    )}
                    <div className="text-muted-foreground/80 mt-1 text-xs">
                      {formatDatePt(r.criadaEm)}
                      {r.ultimaAtualizacao ? (
                        <span> · {r.ultimaAtualizacao}</span>
                      ) : r.historico ? (
                        <span> · Histórico: {r.historico}</span>
                      ) : null}
                    </div>
                    {(r.dataPrevista || r.concluidoEm) && (
                      <div className="text-muted-foreground/80 mt-1 text-xs">
                        {r.dataPrevista && <span>Previsto: {r.dataPrevista}</span>}
                        {r.dataPrevista && r.concluidoEm && <span> · </span>}
                        {r.concluidoEm && <span>Concluído: {formatDatePt(r.concluidoEm)}</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="border-brand-border bg-brand-cream text-brand-green rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap">
                      {r.status}
                    </span>
                    {r.situacaoPrazo && (
                      <span
                        className={`text-xs font-medium whitespace-nowrap ${situacaoPrazoClass(r.situacaoPrazo)}`}
                      >
                        {r.situacaoPrazo}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden sm:block">
            <Table className="table-fixed">
              <colgroup>
                <col className={showCondominio ? "w-[17%]" : "w-[20%]"} />
                {showCondominio && <col className="w-[10%]" />}
                <col className={showCondominio ? "w-[10%]" : "w-[12%]"} />
                <col className={showCondominio ? "w-[8%]" : "w-[9%]"} />
                <col className={showCondominio ? "w-[8%]" : "w-[9%]"} />
                <col className={showCondominio ? "w-[9%]" : "w-[10%]"} />
                <col className={showCondominio ? "w-[11%]" : "w-[12%]"} />
                <col className={showCondominio ? "w-[9%]" : "w-[10%]"} />
                <col className="w-[18%]" />
              </colgroup>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <SortableHead sortKey="demanda" sort={sort} onSort={toggleSort}>
                    Tarefa
                  </SortableHead>
                  {showCondominio && (
                    <SortableHead sortKey="condominio" sort={sort} onSort={toggleSort}>
                      Condomínio
                    </SortableHead>
                  )}
                  <SortableHead sortKey="responsavel" sort={sort} onSort={toggleSort}>
                    Responsável
                  </SortableHead>
                  <SortableHead sortKey="criadaEm" sort={sort} onSort={toggleSort}>
                    Data de Início
                  </SortableHead>
                  <SortableHead sortKey="status" sort={sort} onSort={toggleSort}>
                    Status
                  </SortableHead>
                  <SortableHead sortKey="situacaoPrazo" sort={sort} onSort={toggleSort}>
                    Situação de Prazo
                  </SortableHead>
                  <SortableHead sortKey="dataPrevista" sort={sort} onSort={toggleSort}>
                    Data Prevista de Conclusão
                  </SortableHead>
                  <SortableHead sortKey="concluidoEm" sort={sort} onSort={toggleSort}>
                    Data de Conclusão
                  </SortableHead>
                  <SortableHead sortKey="ultimaAtualizacao" sort={sort} onSort={toggleSort}>
                    Última Atualização
                  </SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRows.map((r, i) => (
                  <TableRow key={r.id} className={`${rowHighlightClass(r, i)} hover:bg-muted/50`}>
                    <TableCell className="p-1.5 align-top text-xs break-words">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium hover:underline"
                      >
                        {r.demanda || "—"}
                      </a>
                    </TableCell>
                    {showCondominio && (
                      <TableCell className="text-muted-foreground p-1.5 text-center align-top text-xs break-words">
                        {r.condominio}
                      </TableCell>
                    )}
                    <TableCell className="text-muted-foreground p-1.5 text-center align-top text-xs break-words">
                      {r.responsavel || "—"}
                    </TableCell>
                    <TableCell className="p-1.5 text-center align-top text-xs">
                      {formatDatePt(r.criadaEm)}
                    </TableCell>
                    <TableCell className="p-1.5 text-center align-top text-xs break-words">
                      {r.status}
                    </TableCell>
                    <TableCell
                      className={`p-1.5 text-center align-top text-xs font-medium ${situacaoPrazoClass(r.situacaoPrazo)}`}
                    >
                      {r.situacaoPrazo || "—"}
                    </TableCell>
                    <TableCell className="p-1.5 text-center align-top text-xs">
                      {r.dataPrevista || "—"}
                    </TableCell>
                    <TableCell className="p-1.5 text-center align-top text-xs">
                      {formatDatePt(r.concluidoEm)}
                    </TableCell>
                    <TableCell className="text-muted-foreground p-1.5 align-top text-xs break-words">
                      {r.ultimaAtualizacao || "—"}
                      {!r.ultimaAtualizacao && r.historico && (
                        <div className="text-muted-foreground/70 mt-0.5 italic">
                          Histórico: {r.historico}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

function SortableHead({
  sortKey,
  sort,
  onSort,
  children,
}: {
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  children: React.ReactNode;
}) {
  const active = sort?.key === sortKey;
  const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead
      className="bg-brand-green h-auto cursor-pointer p-1.5 text-center text-xs font-semibold text-white select-none"
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center justify-center gap-1 leading-tight">
        {children}
        <Icon className={`size-3 shrink-0 ${active ? "opacity-100" : "opacity-50"}`} />
      </span>
    </TableHead>
  );
}
