"use server";

/**
 * src/app/actions/vinculos.ts — Server actions do Vínculo de ativos (tela
 * 6.3, contracts/server-actions.md "vinculos.ts").
 *
 * Regra de camadas (CLAUDE.md / eslint.config.mjs): esta é a ÚNICA borda
 * entre a UI (src/app/**) e a camada de serviços. Aqui NÃO existe lógica de
 * negócio — apenas checagem de shape do input vindo do formulário e
 * tradução de exceções do serviço em `{ ok: false, erro }` amigável. Toda a
 * regra de vínculo/pendência/exclusão-mútua vive em
 * `src/services/mapeamento-service.ts` — nunca duplicada aqui.
 *
 * Formato de retorno padrão (contracts/server-actions.md):
 * `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.
 *
 * `listarAlvosParaDropdown`: fina camada sobre `listarAlvos` de
 * `src/app/actions/alvos.ts` (tela 6.4, já existente) — reaproveitada aqui
 * em vez de chamar `alvo-service` diretamente, para não duplicar a borda de
 * leitura de alvos. Apenas reduz o shape (que já traz `vigenciaInicio`,
 * `qtdAtivosMapeados` etc.) ao mínimo necessário para popular o dropdown de
 * "vincular a alvo existente" da tela 6.3.
 */
import {
  contarPendencias as contarPendenciasService,
  listarVinculos as listarVinculosService,
  vincularAtivo as vincularAtivoService,
  type ListarVinculosOutput,
  type VinculoAtualizado,
  type VincularAtivoInput,
} from "@/services/mapeamento-service";
import { listarAlvos as listarAlvosAction } from "@/app/actions/alvos";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; erro: string; detalhes?: unknown };

/** Mensagens de erro do serviço já são amigáveis (pt-BR) — apenas evita vazar stack trace de exceções não previstas. */
function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return "Erro inesperado ao processar a solicitação.";
}

export async function listarVinculos(): Promise<ActionResult<ListarVinculosOutput>> {
  try {
    const data = await listarVinculosService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

export async function contarPendencias(): Promise<ActionResult<number>> {
  try {
    const data = await contarPendenciasService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/** Opção simplificada de alvo vigente, para popular o dropdown de vínculo (tela 6.3). */
export interface AlvoParaDropdown {
  id: string;
  nome: string;
  percentualAlvoBps: number;
}

export async function listarAlvosParaDropdown(): Promise<ActionResult<AlvoParaDropdown[]>> {
  const resp = await listarAlvosAction();
  if (!resp.ok) return resp;
  return {
    ok: true,
    data: resp.data.alvos.map((a) => ({
      id: a.id,
      nome: a.nome,
      percentualAlvoBps: a.percentualAlvoBps,
    })),
  };
}

/**
 * Input aceito do formulário — mesmo shape de `VincularAtivoInput`
 * (contracts/server-actions.md), com checagem mínima antes de delegar.
 */
export async function vincularAtivo(
  input: VincularAtivoInput,
): Promise<ActionResult<VinculoAtualizado>> {
  if (!input || typeof input.chaveExport !== "string" || !input.chaveExport.trim()) {
    return { ok: false, erro: "chaveExport é obrigatória." };
  }

  if ("novoAlvo" in input) {
    if (!input.novoAlvo || typeof input.novoAlvo.nome !== "string" || !input.novoAlvo.nome.trim()) {
      return { ok: false, erro: "Informe o nome do novo alvo." };
    }
    if (
      !Number.isInteger(input.novoAlvo.percentualBps) ||
      !(input.novoAlvo.percentualBps > 0)
    ) {
      return { ok: false, erro: "Percentual do novo alvo deve ser um inteiro positivo (bps)." };
    }
  } else if ("alvoId" in input) {
    if (typeof input.alvoId !== "string" || !input.alvoId.trim()) {
      return { ok: false, erro: "alvoId é obrigatório para vincular a um alvo existente." };
    }
  } else if (input.foraDaCarteira !== true) {
    return { ok: false, erro: "Input inválido: informe alvoId, novoAlvo ou foraDaCarteira." };
  }

  try {
    const data = await vincularAtivoService(input);
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}
