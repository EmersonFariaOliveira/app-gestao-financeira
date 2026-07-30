"use client";

/**
 * src/components/historico/evolucao-patrimonial-chart.tsx — "evolução
 * patrimonial mês a mês" (tela 6.7, docs/app-gestao-aportes.md seção 6.7).
 *
 * Série TEMPORAL única (uma hue, `--chart-series-1-blue`) — sem legenda: o
 * título do card já nomeia a série (legenda só é obrigatória com 2+
 * séries, guia de design da task). Linha de 2px, marcadores de 8px (r=4),
 * grid discreto, eixos em `--chart-text-muted`. Só sessões VIGENTES (nunca
 * SUBSTITUIDAS) — já filtrado por `dashboard-service.dadosHistorico`, nada
 * refeito aqui.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { CHART_COLORS } from "@/components/charts/chart-colors";
import { formatCentavosParaReais } from "@/core/money";
import type { PontoSerieMensal } from "@/services/dashboard-service";

export function EvolucaoPatrimonialChart({
  serieMensal,
}: {
  serieMensal: PontoSerieMensal[];
}) {
  const dados = serieMensal.map((p) => ({
    mes: p.mesReferencia,
    valorCentavos: p.patrimonioTotalCentavos,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={dados} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
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
          formatter={(valor) => [
            formatCentavosParaReais(Math.trunc(Number(valor))),
            "Patrimônio",
          ]}
          labelFormatter={(mes) => `Mês: ${mes}`}
          contentStyle={{
            background: CHART_COLORS.surface1,
            border: `1px solid ${CHART_COLORS.gridline}`,
            color: CHART_COLORS.textPrimary,
          }}
          labelStyle={{ color: CHART_COLORS.textSecondary }}
        />
        <Line
          type="monotone"
          dataKey="valorCentavos"
          stroke={CHART_COLORS.series1Blue}
          strokeWidth={2}
          dot={{ r: 4, fill: CHART_COLORS.series1Blue, strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
