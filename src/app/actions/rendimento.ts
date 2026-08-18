"use server";

/**
 * src/app/actions/rendimento.ts — Server action de leitura da Análise de
 * Rendimento (tela 6.10, specs/003-dashboard-analise-rendimento/contracts/
 * server-actions.md "rendimento.ts").
 *
 * Regra de camadas (CLAUDE.md / eslint.config.mjs): esta é a ÚNICA borda
 * entre a UI (src/app/**) e a camada de serviços. Aqui NÃO existe lógica de
 * negócio nem consolidação de posições — apenas validação de shape do input
 * (`PeriodoInput`) e tradução de exceções do serviço em `{ ok: false, erro }`
 * amigável. Toda a resolução de período/fórmula de rendimento vive em
 * `src/services/rendimento-service.ts` — nunca duplicada aqui.
 *
 * Fatia atual (US1/P1, MVP): só o campo `consolidado` de `RendimentoOutput`
 * — `reservaEmergencia`/`porTag`/`porAlvo`/`foraDaCarteira`/`serie` do
 * contrato completo chegam em tasks futuras (US2/US3), quando o shape do
 * serviço for estendido.
 *
 * Formato de retorno padrão (contracts/server-actions.md):
 * `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.
 */
import {
  dadosRendimento as dadosRendimentoService,
  type PeriodoInput,
  type RendimentoOutput,
} from "@/services/rendimento-service";

export type { PeriodoInput, RendimentoOutput };

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; erro: string; detalhes?: unknown };

const PRESETS_VALIDOS = new Set(["1M", "3M", "6M", "12M", "DESDE_INICIO"]);

/** Mensagens de erro do serviço já são amigáveis (pt-BR) — apenas evita vazar stack trace de exceções não previstas. */
function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return "Erro inesperado ao processar a solicitação.";
}

/** Checagem de shape do input vindo do seletor de período (tela 6.10) — nenhuma regra de negócio, só validação estrutural. */
function validarInput(input: PeriodoInput): string | null {
  if (!input || typeof input !== "object" || typeof input.tipo !== "string") {
    return "Período inválido.";
  }
  if (input.tipo === "CUSTOMIZADO") {
    if (!input.sessaoInicioId || !input.sessaoFimId) {
      return "Selecione as duas sessões do período customizado.";
    }
    return null;
  }
  if (!PRESETS_VALIDOS.has(input.tipo)) {
    return "Período inválido.";
  }
  return null;
}

/**
 * Dados da tela 6.10 (análise de rendimento): rendimento consolidado do
 * patrimônio total (R$ e %) no período selecionado, mais as sessões
 * disponíveis para montar o seletor de período customizado (FR-001/FR-002/
 * FR-005/FR-006/FR-020 — nunca rotular o percentual como "rentabilidade").
 */
export async function dadosRendimento(input: PeriodoInput): Promise<ActionResult<RendimentoOutput>> {
  const erroValidacao = validarInput(input);
  if (erroValidacao) {
    return { ok: false, erro: erroValidacao };
  }

  try {
    const data = await dadosRendimentoService(input);
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}
