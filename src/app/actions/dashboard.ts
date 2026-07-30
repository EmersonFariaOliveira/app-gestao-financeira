"use server";

/**
 * src/app/actions/dashboard.ts — Server actions de leitura do Dashboard
 * (tela 6.1) e Histórico (tela 6.7), contracts/server-actions.md
 * "dashboard/histórico (telas 6.1 e 6.7)".
 *
 * Regra de camadas (CLAUDE.md / eslint.config.mjs): esta é a ÚNICA borda
 * entre a UI (src/app/**) e a camada de serviços. Aqui NÃO existe lógica de
 * negócio nem consolidação de posições — apenas tradução de exceções do
 * serviço em `{ ok: false, erro }` amigável. Toda a leitura/consolidação
 * vive em `src/services/dashboard-service.ts` — nunca duplicada aqui.
 *
 * Formato de retorno padrão (contracts/server-actions.md):
 * `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.
 */
import {
  dadosDashboard as dadosDashboardService,
  dadosHistorico as dadosHistoricoService,
  type DadosDashboardOutput,
  type DadosHistoricoOutput,
} from "@/services/dashboard-service";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; erro: string; detalhes?: unknown };

/** Mensagens de erro do serviço já são amigáveis (pt-BR) — apenas evita vazar stack trace de exceções não previstas. */
function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return "Erro inesperado ao processar a solicitação.";
}

/** Dados da tela 6.1 (dashboard/home): patrimônio consolidado, alocação atual vs. alvo, fora-da-carteira, pendências (FR-038..040). */
export async function dadosDashboard(): Promise<ActionResult<DadosDashboardOutput>> {
  try {
    const data = await dadosDashboardService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/** Dados da tela 6.7 (histórico): série mensal patrimonial, linha do tempo sugerido vs. executado, sessões substituídas para auditoria (FR-041/042). */
export async function dadosHistorico(): Promise<ActionResult<DadosHistoricoOutput>> {
  try {
    const data = await dadosHistoricoService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}
