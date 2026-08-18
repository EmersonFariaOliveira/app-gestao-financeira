"use client";

/**
 * src/components/historico/sugerido-vs-executado-chart.tsx — "linha do
 * tempo de aportes: sugerido vs. executado por mês" (tela 6.7).
 *
 * DUAS séries por mês -> legenda obrigatória (guia de design da task).
 * Ordem categórica FIXA: sugerido (`--chart-series-1-blue`) sempre
 * primeiro, executado (`--chart-series-2-orange`) sempre segundo — nunca
 * invertida. Nenhuma soma/agregação de negócio acontece aqui: cada barra
 * já representa um `aporte` registrado (`PontoAporteHistorico`), calculado
 * inteiramente por `dashboard-service.dadosHistorico`.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { CHART_COLORS } from "@/components/charts/chart-colors";
import { formatCentavosParaReais } from "@/core/money";
import type { PontoAporteHistorico } from "@/services/dashboard-service";

export function SugeridoVsExecutadoChart({
  linhaDoTempoAportes,
}: {
  linhaDoTempoAportes: PontoAporteHistorico[];
}) {
  const dados = linhaDoTempoAportes.map((p) => ({
    mes: p.mesReferencia,
    sugeridoCentavos: p.sugeridoCentavos,
    executadoCentavos: p.executadoCentavos,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={dados} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid stroke={CHART_COLORS.gridline} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="mes"
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
        <Tooltip
          formatter={(valor, nome) => [
            formatCentavosParaReais(Math.trunc(Number(valor))),
            nome,
          ]}
          labelFormatter={(mes) => `Mês: ${mes}`}
          contentStyle={{
            background: CHART_COLORS.surface1,
            border: `1px solid ${CHART_COLORS.gridline}`,
            color: CHART_COLORS.textPrimary,
          }}
          labelStyle={{ color: CHART_COLORS.textSecondary }}
        />
        <Legend
          formatter={(value) => (
            <span style={{ color: CHART_COLORS.textSecondary }}>{value}</span>
          )}
        />
        <Bar
          dataKey="sugeridoCentavos"
          name="Sugerido"
          fill={CHART_COLORS.series1Blue}
          radius={[3, 3, 0, 0]}
        />
        <Bar
          dataKey="executadoCentavos"
          name="Executado"
          fill={CHART_COLORS.series2Orange}
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
