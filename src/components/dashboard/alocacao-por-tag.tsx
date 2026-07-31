"use client";

/**
 * src/components/dashboard/alocacao-por-tag.tsx — bloco "alocação atual vs.
 * alvo por carteira/tag" do dashboard (tela 6.1). Complementa
 * `alocacao-atual-vs-alvo.tsx` (que agrupa por alvo individual) com uma
 * visão agrupada pela categorização livre do usuário (`tag`, ex.: A-AÇÕES,
 * R-REAL ESTATE/FIIs, C-CAIXA — ver tela 6.4/`alvo-service.ts`), respondendo
 * "quanto do patrimônio está em cada carteira/grupo".
 *
 * Deliberadamente MUITO parecido com `AlocacaoAtualVsAlvo` (mesma barra CSS,
 * mesmo badge dentro/fora da banda, mesmas abas Barras/Tabela) — a
 * generalização dos dois num único componente parametrizado foi cogitada,
 * mas a diferença de shape dos dados (`AlocacaoPorAlvo` tem `alvoId`/
 * `nomeAlvo`; `AlocacaoPorTag` tem `tag`/`qtdAlvos`, sem id estável de
 * "linha", já que a chave de agrupamento É o dado) tornaria a generalização
 * mais complexa de ler do que os dois componentes irmãos lado a lado.
 * Nenhum cálculo acontece aqui — `AlocacaoPorTag` já chega pronta de
 * `dashboard-service.ts` (`dadosDashboard().alocacaoPorTag`).
 */
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { CHART_COLORS } from "@/components/charts/chart-colors";
import {
  SortableTableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBps, formatCentavosParaReais } from "@/core/money";
import { useSortableRows } from "@/hooks/use-sortable-rows";
import type { AlocacaoPorTag as AlocacaoPorTagDto } from "@/services/dashboard-service";

/** bps (1/100 p.p., 10000 = 100%) -> percentual visual 0-100 para `width`/`left` do CSS, sem afetar o número exibido (que continua vindo de `formatBps`). */
function bpsParaPercentualVisual(bps: number): number {
  return Math.max(0, Math.min(100, bps / 100));
}

function StatusBadge({ dentroDaBanda }: { dentroDaBanda: boolean }) {
  const cor = dentroDaBanda ? CHART_COLORS.statusGood : CHART_COLORS.statusCritical;
  const Icon = dentroDaBanda ? CheckCircle2 : AlertTriangle;
  return (
    <span className="inline-flex items-center gap-1 text-sm font-medium" style={{ color: cor }}>
      <Icon className="size-4" />
      {dentroDaBanda ? "Dentro da banda" : "Fora da banda"}
    </span>
  );
}

function LinhaBarra({ item }: { item: AlocacaoPorTagDto }) {
  const atualPct = bpsParaPercentualVisual(item.percentualAtualBps);
  const alvoPct = bpsParaPercentualVisual(item.percentualAlvoBps);
  const cor = item.dentroDaBanda ? CHART_COLORS.statusGood : CHART_COLORS.statusCritical;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {item.tag}{" "}
          <span className="font-normal text-muted-foreground">
            ({item.qtdAlvos} alvo(s))
          </span>
        </span>
        <StatusBadge dentroDaBanda={item.dentroDaBanda} />
      </div>
      <div
        className="relative h-3 w-full rounded-full"
        style={{ background: CHART_COLORS.gridline }}
      >
        <div
          className="h-3 rounded-full"
          style={{ width: `${atualPct}%`, background: cor }}
        />
        <div
          className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${alvoPct}%`, background: CHART_COLORS.baseline }}
          aria-hidden
          title={`Alvo: ${formatBps(item.percentualAlvoBps)}`}
        />
      </div>
      <div
        className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs"
        style={{ color: CHART_COLORS.textSecondary }}
      >
        <span>
          Atual:{" "}
          <strong style={{ color: CHART_COLORS.textPrimary }}>
            {formatBps(item.percentualAtualBps)}
          </strong>{" "}
          ({formatCentavosParaReais(item.valorAtualCentavos)})
        </span>
        <span>Alvo: {formatBps(item.percentualAlvoBps)}</span>
        <span>Desvio: {formatBps(item.desvioBps)}</span>
      </div>
    </div>
  );
}

export function AlocacaoPorTag({ alocacaoPorTag }: { alocacaoPorTag: AlocacaoPorTagDto[] }) {
  // Hook chamado incondicionalmente (regra dos hooks), antes do early return
  // abaixo — aceita array vazio sem problema.
  const alocacaoOrdenada = useSortableRows(alocacaoPorTag, {
    tag: (i) => i.tag,
    qtdAlvos: (i) => i.qtdAlvos,
    percentualAtualBps: (i) => i.percentualAtualBps,
    percentualAlvoBps: (i) => i.percentualAlvoBps,
    desvioBps: (i) => i.desvioBps,
  });

  if (alocacaoPorTag.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nenhum alvo vigente cadastrado — cadastre a carteira alvo em{" "}
        <a href="/alvos" className="underline">
          /alvos
        </a>
        .
      </p>
    );
  }

  return (
    <Tabs defaultValue="barras">
      <TabsList>
        <TabsTrigger value="barras">Barras</TabsTrigger>
        <TabsTrigger value="tabela">Tabela</TabsTrigger>
      </TabsList>
      <TabsContent value="barras" className="flex flex-col gap-4 pt-4">
        {alocacaoPorTag.map((item) => (
          <LinhaBarra key={item.tag} item={item} />
        ))}
      </TabsContent>
      <TabsContent value="tabela" className="pt-4">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead
                sortDirection={alocacaoOrdenada.sortDirectionFor("tag")}
                onSort={() => alocacaoOrdenada.toggleSort("tag")}
              >
                Tag
              </SortableTableHead>
              <SortableTableHead
                sortDirection={alocacaoOrdenada.sortDirectionFor("qtdAlvos")}
                onSort={() => alocacaoOrdenada.toggleSort("qtdAlvos")}
              >
                Qtd. de alvos
              </SortableTableHead>
              <SortableTableHead
                sortDirection={alocacaoOrdenada.sortDirectionFor("percentualAtualBps")}
                onSort={() => alocacaoOrdenada.toggleSort("percentualAtualBps")}
              >
                % atual
              </SortableTableHead>
              <SortableTableHead
                sortDirection={alocacaoOrdenada.sortDirectionFor("percentualAlvoBps")}
                onSort={() => alocacaoOrdenada.toggleSort("percentualAlvoBps")}
              >
                % alvo
              </SortableTableHead>
              <SortableTableHead
                sortDirection={alocacaoOrdenada.sortDirectionFor("desvioBps")}
                onSort={() => alocacaoOrdenada.toggleSort("desvioBps")}
              >
                Desvio
              </SortableTableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {alocacaoOrdenada.sortedRows.map((item) => (
              <TableRow key={item.tag}>
                <TableCell>{item.tag}</TableCell>
                <TableCell>{item.qtdAlvos}</TableCell>
                <TableCell>{formatBps(item.percentualAtualBps)}</TableCell>
                <TableCell>{formatBps(item.percentualAlvoBps)}</TableCell>
                <TableCell>{formatBps(item.desvioBps)}</TableCell>
                <TableCell>
                  <StatusBadge dentroDaBanda={item.dentroDaBanda} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TabsContent>
    </Tabs>
  );
}
