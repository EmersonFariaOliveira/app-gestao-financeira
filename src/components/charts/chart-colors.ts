/**
 * src/components/charts/chart-colors.ts — nomes das CSS custom properties
 * definidas em `src/app/globals.css` (paleta validada para
 * daltonismo/contraste) para uso em `stroke`/`fill`/`color` dos gráficos do
 * dashboard (6.1) e histórico (6.7). Nenhum valor de cor é hardcoded aqui
 * nem em nenhum componente de gráfico — sempre `var(--chart-*)`, para que
 * trocar o tema (claro/escuro) baste editar o CSS, sem tocar em código.
 *
 * Regras de uso (documentadas na task, não decisão arbitrária):
 * - Cor de status (`statusGood`/`statusCritical`) NUNCA é a única pista —
 *   sempre acompanhada de ícone + rótulo textual explícito.
 * - Séries categóricas (não-status) usam `series1Blue`/`series2Orange`,
 *   NESSA ordem fixa (1ª série sempre azul, 2ª sempre laranja).
 * - Nunca dual-axis; nunca cor de série carregando texto/eixo (texto usa
 *   sempre `textPrimary`/`textSecondary`/`textMuted`).
 */
export const CHART_COLORS = {
  surface1: "var(--chart-surface-1)",
  textPrimary: "var(--chart-text-primary)",
  textSecondary: "var(--chart-text-secondary)",
  textMuted: "var(--chart-text-muted)",
  gridline: "var(--chart-gridline)",
  baseline: "var(--chart-baseline)",
  statusGood: "var(--chart-status-good)",
  statusCritical: "var(--chart-status-critical)",
  series1Blue: "var(--chart-series-1-blue)",
  series2Orange: "var(--chart-series-2-orange)",
} as const;
