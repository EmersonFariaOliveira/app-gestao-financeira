"use server";

/**
 * src/app/actions/posicoes-manuais.ts — Server actions da tela de Posições
 * manuais (tela 6.9, contracts/server-actions.md "posicoes-manuais.ts",
 * feature 002-posicoes-manuais-ajustes).
 *
 * Regra de camadas (CLAUDE.md / eslint.config.mjs): esta é a ÚNICA borda
 * entre a UI (src/app/**) e a camada de serviços. Aqui NÃO existe lógica de
 * negócio — apenas validação de shape do input vindo do formulário e
 * tradução de exceções do serviço em `{ ok: false, erro }` amigável. Toda a
 * regra de CRUD/imutabilidade/sessão-vigente vive em
 * `src/services/posicao-manual-service.ts` (T007) — nunca duplicada aqui.
 *
 * Formato de retorno padrão (contracts/server-actions.md):
 * `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.
 *
 * Nota de escopo (T011): apenas `criarPosicaoManual`/`editarPosicaoManual`/
 * `encerrarPosicaoManual` (User Story 1). `criarOuAtualizarAjuste` (User
 * Story 2, T016) e `listarPosicoesManuaisEAjustes` (User Story 3, T019) NÃO
 * fazem parte desta task — ficam para as fases 4/5, quando os serviços
 * correspondentes existirem.
 */
import {
  criarPosicaoManual as criarPosicaoManualService,
  editarPosicaoManual as editarPosicaoManualService,
  encerrarPosicaoManual as encerrarPosicaoManualService,
  listarPosicoesManuaisAtivas as listarPosicoesManuaisAtivasService,
  type CriarPosicaoManualInput,
  type EditarPosicaoManualInput,
  type EncerrarPosicaoManualInput,
  type PosicaoManualListItem,
  type PosicaoManualOutput,
} from "@/services/posicao-manual-service";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; erro: string; detalhes?: unknown };

/** Mensagens de erro do serviço já são amigáveis (pt-BR) — apenas evita vazar stack trace de exceções não previstas. */
function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return "Erro inesperado ao processar a solicitação.";
}

function ehCentavosValido(valor: unknown): valor is number {
  return typeof valor === "number" && Number.isInteger(valor) && valor >= 0;
}

/**
 * Input do formulário de criação (contracts/server-actions.md,
 * `posicoes-manuais.ts`). Mesmo shape de `CriarPosicaoManualInput` do
 * serviço, exceto por `chaveExportOrigem`, que o contrato desta feature não
 * expõe como campo de entrada da action (fica de fora até uma decisão
 * explícita de produto — ver relatório de T009-T012).
 */
export type CriarPosicaoManualActionInput = Pick<
  CriarPosicaoManualInput,
  "chaveManual" | "instituicao" | "descricao" | "alvoId" | "valorInvestidoCentavos" | "valorAtualCentavos"
>;

export async function criarPosicaoManual(
  input: CriarPosicaoManualActionInput,
): Promise<ActionResult<PosicaoManualOutput>> {
  if (!input || typeof input.chaveManual !== "string" || !input.chaveManual.trim()) {
    return { ok: false, erro: "chaveManual é obrigatória." };
  }
  if (typeof input.instituicao !== "string" || !input.instituicao.trim()) {
    return { ok: false, erro: "instituicao é obrigatória." };
  }
  if (typeof input.descricao !== "string" || !input.descricao.trim()) {
    return { ok: false, erro: "descricao é obrigatória." };
  }
  if (typeof input.alvoId !== "string" || !input.alvoId.trim()) {
    return { ok: false, erro: "alvoId é obrigatório." };
  }
  if (!ehCentavosValido(input.valorInvestidoCentavos)) {
    return { ok: false, erro: "valorInvestidoCentavos deve ser um inteiro em centavos ≥ 0." };
  }
  if (!ehCentavosValido(input.valorAtualCentavos)) {
    return { ok: false, erro: "valorAtualCentavos deve ser um inteiro em centavos ≥ 0." };
  }

  try {
    const data = await criarPosicaoManualService({
      chaveManual: input.chaveManual.trim(),
      instituicao: input.instituicao.trim(),
      descricao: input.descricao.trim(),
      alvoId: input.alvoId,
      valorInvestidoCentavos: input.valorInvestidoCentavos,
      valorAtualCentavos: input.valorAtualCentavos,
    });
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

export async function editarPosicaoManual(
  input: EditarPosicaoManualInput,
): Promise<ActionResult<PosicaoManualOutput>> {
  if (!input || typeof input.posicaoManualId !== "string" || !input.posicaoManualId.trim()) {
    return { ok: false, erro: "posicaoManualId é obrigatório." };
  }
  if (input.instituicao !== undefined && (typeof input.instituicao !== "string" || !input.instituicao.trim())) {
    return { ok: false, erro: "instituicao, se informada, não pode ser vazia." };
  }
  if (input.descricao !== undefined && (typeof input.descricao !== "string" || !input.descricao.trim())) {
    return { ok: false, erro: "descricao, se informada, não pode ser vazia." };
  }
  if (input.alvoId !== undefined && (typeof input.alvoId !== "string" || !input.alvoId.trim())) {
    return { ok: false, erro: "alvoId, se informado, não pode ser vazio." };
  }

  try {
    const data = await editarPosicaoManualService(input);
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

export async function encerrarPosicaoManual(
  input: EncerrarPosicaoManualInput,
): Promise<ActionResult<PosicaoManualOutput>> {
  if (!input || typeof input.posicaoManualId !== "string" || !input.posicaoManualId.trim()) {
    return { ok: false, erro: "posicaoManualId é obrigatório." };
  }

  try {
    const data = await encerrarPosicaoManualService(input);
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * Leitura para a listagem da tela 6.9 (fora do fluxo de import). Não faz
 * parte do contrato `posicoes-manuais.ts` (que define
 * `listarPosicoesManuaisEAjustes`, T019/Fase 5, com carry-forward de
 * revisão de import) — esta é uma leitura mínima equivalente, restrita ao
 * necessário para a listagem + "Encerrar" desta task (T012). Ver relatório
 * de T009-T012 para a nota de escopo.
 */
export async function listarPosicoesManuaisAtivas(): Promise<
  ActionResult<PosicaoManualListItem[]>
> {
  try {
    const data = await listarPosicoesManuaisAtivasService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}
