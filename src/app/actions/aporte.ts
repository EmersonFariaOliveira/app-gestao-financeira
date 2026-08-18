"use server";

/**
 * src/app/actions/aporte.ts — Server actions da Calculadora de aporte (tela
 * 6.5, contracts/server-actions.md "aporte.ts").
 *
 * Regra de camadas (CLAUDE.md / eslint.config.mjs): esta é a ÚNICA borda
 * entre a UI (src/app/**) e a camada de serviços. Aqui NÃO existe lógica de
 * negócio — apenas validação de input vindo do formulário (conversão de
 * string decimal para centavos via src/core/money, checagem de shape) e
 * tradução de exceções do serviço em `{ ok: false, erro }` amigável. Toda a
 * regra de déficit/fila/divisão/transbordo/mínimo/arredondamento vive no
 * Motor de Aporte (src/core/motor) e é orquestrada por
 * src/services/aporte-service.ts — nunca duplicada aqui.
 *
 * Formato de retorno padrão (contracts/server-actions.md):
 * `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.
 */
import { parseDecimalParaCentavos } from "@/core/money";
import type { AjusteUsuario } from "@/core/motor";
import {
  calcular as calcularService,
  prepararCalculadora as prepararCalculadoraService,
  registrarAporte as registrarAporteService,
  type CalcularOutput,
  type PrepararCalculadoraOutput,
  type RegistrarAporteInput,
} from "@/services/aporte-service";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; erro: string; detalhes?: unknown };

/** Mensagens de erro de serviços/motor já são amigáveis (pt-BR) — apenas evita vazar stack trace de exceções não previstas. */
function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return "Erro inesperado ao processar a solicitação.";
}

/**
 * Estado de abertura da calculadora (FR-015): bloqueio por pendência de
 * vínculo, oferta de dividendos não utilizados (FR-030) e troco do mês
 * anterior (R10). A UI decide, com base em `bloqueada`, se mostra a
 * calculadora ou a lista de pendências com link para /vinculos.
 */
export async function prepararCalculadora(): Promise<
  ActionResult<PrepararCalculadoraOutput>
> {
  try {
    const data = await prepararCalculadoraService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * Input do formulário de cálculo (contracts/server-actions.md, `aporte.ts`).
 * `valorCentavos` aceita tanto a string decimal digitada pelo usuário (ex.:
 * "2000,00", convertida aqui via `parseDecimalParaCentavos`) quanto um
 * número inteiro em centavos já resolvido pelo cliente — nunca um float
 * livre.
 */
export interface CalcularActionInput {
  valorCentavos: string | number;
  incluirDividendos: boolean;
  incluirTroco: boolean;
  aporteMinimoCentavos: number;
  ajustesUsuario?: AjusteUsuario[];
}

export async function calcular(
  input: CalcularActionInput,
): Promise<ActionResult<CalcularOutput>> {
  let valorCentavos: number;
  try {
    valorCentavos =
      typeof input.valorCentavos === "number"
        ? input.valorCentavos
        : parseDecimalParaCentavos(input.valorCentavos);
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }

  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) {
    return { ok: false, erro: "Informe um valor de aporte maior que zero." };
  }
  if (
    !Number.isInteger(input.aporteMinimoCentavos) ||
    input.aporteMinimoCentavos < 0
  ) {
    return { ok: false, erro: "Aporte mínimo por transação inválido." };
  }

  try {
    const data = await calcularService({
      valorCentavos,
      incluirDividendos: input.incluirDividendos,
      incluirTroco: input.incluirTroco,
      aporteMinimoCentavos: input.aporteMinimoCentavos,
      ajustesUsuario: input.ajustesUsuario,
    });
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * Input do registro (sugerido + executado, editável pelo usuário antes de
 * confirmar — a cotação do export pode estar defasada em relação à ordem
 * real, regra 7). `sessaoImportId`, `trocoCentavos` etc. vêm de
 * `CalcularOutput`/`ResultadoMotor` sem re-derivação nesta camada — o shape
 * é exatamente `RegistrarAporteInput` do serviço (nenhum mapeamento extra
 * necessário na borda).
 */
export type RegistrarAporteActionInput = RegistrarAporteInput;

export async function registrarAporte(
  input: RegistrarAporteActionInput,
): Promise<ActionResult<{ aporteId: string }>> {
  if (!input.sessaoImportId) {
    return { ok: false, erro: "Sessão de import não informada." };
  }
  if (!Array.isArray(input.executado) || input.executado.length === 0) {
    return {
      ok: false,
      erro: "Informe ao menos uma linha de execução antes de registrar.",
    };
  }
  if (!Number.isInteger(input.valorTotalCentavos) || input.valorTotalCentavos <= 0) {
    return { ok: false, erro: "Valor total do aporte inválido." };
  }

  try {
    const data = await registrarAporteService(input);
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}
