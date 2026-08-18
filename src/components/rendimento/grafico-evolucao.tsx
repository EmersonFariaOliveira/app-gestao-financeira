"use client";

/**
 * src/components/rendimento/grafico-evolucao.tsx — gráfico interativo de
 * evolução do rendimento (tela 6.10, US3, `docs/app-gestao-aportes.md`
 * seção 6.10 / `specs/003-dashboard-analise-rendimento`).
 *
 * TRÊS séries temporais (`valorInvestidoCentavos`/`valorAtualCentavos`/
 * `rendimentoCentavos`), um ponto por sessão VIGENTE da `SerieRendimento` já
 * montada por `montarSerieRendimento` (`src/services/rendimento-service.ts`)
 * — este componente NUNCA recalcula nada, só formata/exibe. Ordem categórica
 * fixa: valor investido (`series1Blue`), valor atual (`series2Orange`),
 * rendimento (`series3Green`) — legenda obrigatória (3 séries simultâneas,
 * guia de design já usado por `sugerido-vs-executado-chart.tsx`).
 *
 * `valorInvestidoCentavos`/`rendimentoCentavos` podem ser `null` num ponto
 * específico (FR-010, "sem histórico suficiente" naquela sessão) — passado
 * como `null` direto para o `dataKey` do Recharts, que trata `null` como gap
 * na linha (comportamento nativo, não é tratado como erro nem como 0).
 *
 * Tooltip customizado (não o `formatter` genérico) porque precisa mostrar o
 * percentual de rendimento junto com os R$ — dado que só existe por ponto na
 * série (`rendimentoPct`), não é uma série própria do gráfico.
 *
 * FR-020 (inviolável): a série/label de rendimento nunca é chamada de
 * "rentabilidade" — sempre "rendimento" (variação em R$) e "ganho sobre
 * capital investido" para o percentual, mesmo vocabulário do resto da tela.
 */
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { CHART_COLORS } from "@/components/charts/chart-colors";
import { formatCentavosParaReais } from "@/core/money";
import type { PontoSerieRendimento, SerieRendimento } from "@/services/rendimento-service";

/** `number` (percentual já dividido, ex.: 12.5) -> "12,50%" — mesma convenção pt-BR de `page.tsx`. */
function formatPercentual(pct: number): string {
  const negativo = pct < 0;
  const abs = Math.abs(pct);
  const formatado = abs.toFixed(2).replace(".", ",");
  return `${negativo ? "-" : ""}${formatado}%`;
}

interface PontoGrafico {
  mesReferencia: string;
  valorInvestidoCentavos: number | null;
  valorAtualCentavos: number;
  rendimentoCentavos: number | null;
  rendimentoPct: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TooltipEvolucao(props: any) {
  const { active, payload } = props as {
    active?: boolean;
    payload?: Array<{ payload: PontoGrafico }>;
  };
  if (!active || !payload || payload.length === 0) return null;

  const ponto = payload[0]?.payload;
  if (!ponto) return null;

  return (
    <div
      className="flex flex-col gap-1 rounded-md border px-3 py-2 text-sm"
      style={{
        background: CHART_COLORS.surface1,
        borderColor: CHART_COLORS.gridline,
        color: CHART_COLORS.textPrimary,
      }}
    >
      <span className="font-medium" style={{ color: CHART_COLORS.textSecondary }}>
        Mês: {ponto.mesReferencia}
      </span>
      <span>
        Valor investido:{" "}
        {ponto.valorInvestidoCentavos === null
          ? "sem histórico suficiente"
          : formatCentavosParaReais(ponto.valorInvestidoCentavos)}
      </span>
      <span>Valor atual: {formatCentavosParaReais(ponto.valorAtualCentavos)}</span>
      <span>
        Rendimento:{" "}
        {ponto.rendimentoCentavos === null
          ? "sem histórico suficiente"
          : formatCentavosParaReais(ponto.rendimentoCentavos)}
        {ponto.rendimentoPct !== null && ` (${formatPercentual(ponto.rendimentoPct)})`}
      </span>
    </div>
  );
}

export function GraficoEvolucaoRendimento({ serie }: { serie: SerieRendimento }) {
  const dados: PontoGrafico[] = serie.map((p: PontoSerieRendimento) => ({
    mesReferencia: p.mesReferencia,
    valorInvestidoCentavos: p.valorInvestidoCentavos,
    valorAtualCentavos: p.valorAtualCentavos,
    rendimentoCentavos: p.rendimentoCentavos,
    rendimentoPct: p.rendimentoPct,
  }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={dados} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid stroke={CHART_COLORS.gridline} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="mesReferencia"
          stroke={CHART_COLORS.textMuted}
          tick={{ fill: CHART_COLORS.textMuted, fontSize: 12 }}
          tickLine={false}
        />
        <YAxis
          stroke={CHART_COLORS.textMuted}
          tick={{ fill: CHART_COLORS.textMuted, fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={96}
          tickFormatter={(valor: number) => formatCentavosParaReais(Math.trunc(valor))}
        />
        <Tooltip content={TooltipEvolucao} />
        <Legend
          formatter={(value) => (
            <span style={{ color: CHART_COLORS.textSecondary }}>{value}</span>
          )}
        />
        <Line
          type="monotone"
          dataKey="valorInvestidoCentavos"
          name="Valor investido"
          stroke={CHART_COLORS.series1Blue}
          strokeWidth={2}
          dot={{ r: 4, fill: CHART_COLORS.series1Blue, strokeWidth: 0 }}
          activeDot={{ r: 5 }}
          connectNulls={false}
        />
        <Line
          type="monotone"
          dataKey="valorAtualCentavos"
          name="Valor atual"
          stroke={CHART_COLORS.series2Orange}
          strokeWidth={2}
          dot={{ r: 4, fill: CHART_COLORS.series2Orange, strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
        <Line
          type="monotone"
          dataKey="rendimentoCentavos"
          name="Rendimento"
          stroke={CHART_COLORS.series3Green}
          strokeWidth={2}
          dot={{ r: 4, fill: CHART_COLORS.series3Green, strokeWidth: 0 }}
          activeDot={{ r: 5 }}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
