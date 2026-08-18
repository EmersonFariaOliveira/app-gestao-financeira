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
 * Nota de escopo (T011): `criarPosicaoManual`/`editarPosicaoManual`/
 * `encerrarPosicaoManual` (User Story 1). `criarOuAtualizarAjuste` e
 * `listarAjustesAtivos` (User Story 2, T016) foram adicionadas nesta task.
 * `listarPosicoesManuaisEAjustes` (User Story 3, T019, com carry-forward de
 * revisão de import) NÃO faz parte desta task — fica para a fase 5.
 */
import {
  atualizarValoresPosicaoManual as atualizarValoresPosicaoManualService,
  criarOuAtualizarAjuste as criarOuAtualizarAjusteService,
  criarPosicaoManual as criarPosicaoManualService,
  editarPosicaoManual as editarPosicaoManualService,
  encerrarPosicaoManual as encerrarPosicaoManualService,
  listarAjustesAtivos as listarAjustesAtivosService,
  listarPosicoesManuaisAtivas as listarPosicoesManuaisAtivasService,
  listarPosicoesManuaisParaVinculo as listarPosicoesManuaisParaVinculoService,
  vincularPosicaoManual as vincularPosicaoManualService,
  type AjusteAtivoListItem,
  type AjusteValorInvestidoOutput,
  type AtualizarValoresPosicaoManualInput,
  type CriarOuAtualizarAjusteInput,
  type CriarPosicaoManualInput,
  type EditarPosicaoManualInput,
  type EncerrarPosicaoManualInput,
  type ListarPosicoesManuaisParaVinculoOutput,
  type PosicaoManualListItem,
  type PosicaoManualOutput,
  type PosicaoManualValorOutput,
  type VincularPosicaoManualInput,
  type VinculoPosicaoManualAtualizado,
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
  if (input.alvoId !== undefined && (typeof input.alvoId !== "string" || !input.alvoId.trim())) {
    return { ok: false, erro: "alvoId, se informado, não pode ser vazio." };
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

/**
 * Cria/atualiza (upsert) o ajuste de valor investido de um `chaveExport`
 * (T016, User Story 2, FR-005). Action fina: valida o shape do input e
 * delega a `posicaoManualService.criarOuAtualizarAjuste` (T015) — nenhuma
 * regra de sessão-vigente/upsert é reimplementada aqui.
 */
export async function criarOuAtualizarAjuste(
  input: CriarOuAtualizarAjusteInput,
): Promise<ActionResult<AjusteValorInvestidoOutput>> {
  if (!input || typeof input.chaveExport !== "string" || !input.chaveExport.trim()) {
    return { ok: false, erro: "chaveExport é obrigatório." };
  }
  if (!ehCentavosValido(input.valorInvestidoCentavosCorrigido)) {
    return { ok: false, erro: "valorInvestidoCentavosCorrigido deve ser um inteiro em centavos ≥ 0." };
  }

  try {
    const data = await criarOuAtualizarAjusteService({
      chaveExport: input.chaveExport.trim(),
      valorInvestidoCentavosCorrigido: input.valorInvestidoCentavosCorrigido,
    });
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * Leitura para a seção "Ajustes de fundos" da tela 6.9 (T017, fora do fluxo
 * de import) — mesma nota de escopo de `listarPosicoesManuaisAtivas`: não é
 * `listarPosicoesManuaisEAjustes` (T019/User Story 3, com carry-forward).
 */
export async function listarAjustesAtivos(): Promise<ActionResult<AjusteAtivoListItem[]>> {
  try {
    const data = await listarAjustesAtivosService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * Leitura dos quatro baldes (pendentes/vinculadas/foraDaCarteira/
 * reservaEmergencia) de posições manuais, para a tela /vinculos unificar
 * com `listarVinculos` (mesmo layout, mesma máquina de estados de
 * `ativo_mapeado` — ver relatório do desenvolvedor-ui desta task).
 */
export async function listarPosicoesManuaisParaVinculo(): Promise<
  ActionResult<ListarPosicoesManuaisParaVinculoOutput>
> {
  try {
    const data = await listarPosicoesManuaisParaVinculoService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * Resolve o vínculo de uma `posicao_manual` (mesmo contrato de union
 * discriminada de `vincularAtivo`/`vinculos.ts`, mas com 4 formas — sem
 * "ignorar", que é conceito exclusivo de `ativo_mapeado`/CSV e não se aplica
 * a uma posição manual).
 */
export async function vincularPosicaoManual(
  input: VincularPosicaoManualInput,
): Promise<ActionResult<VinculoPosicaoManualAtualizado>> {
  if (!input || typeof input.posicaoManualId !== "string" || !input.posicaoManualId.trim()) {
    return { ok: false, erro: "posicaoManualId é obrigatório." };
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
  } else if ("foraDaCarteira" in input) {
    if (input.foraDaCarteira !== true) {
      return { ok: false, erro: "Input inválido: informe alvoId, novoAlvo, foraDaCarteira ou reservaEmergencia." };
    }
  } else if (!("reservaEmergencia" in input) || input.reservaEmergencia !== true) {
    return { ok: false, erro: "Input inválido: informe alvoId, novoAlvo, foraDaCarteira ou reservaEmergencia." };
  }

  try {
    const data = await vincularPosicaoManualService(input);
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * Atualiza os valores (investido/atual) de uma `posicao_manual` na sessão
 * VIGENTE mais recente — usado pelo diálogo "Editar" da tela /posicoes-manuais.
 */
export async function atualizarValoresPosicaoManual(
  input: AtualizarValoresPosicaoManualInput,
): Promise<ActionResult<PosicaoManualValorOutput>> {
  if (!input || typeof input.posicaoManualId !== "string" || !input.posicaoManualId.trim()) {
    return { ok: false, erro: "posicaoManualId é obrigatório." };
  }
  if (!ehCentavosValido(input.valorInvestidoCentavos)) {
    return { ok: false, erro: "valorInvestidoCentavos deve ser um inteiro em centavos ≥ 0." };
  }
  if (!ehCentavosValido(input.valorAtualCentavos)) {
    return { ok: false, erro: "valorAtualCentavos deve ser um inteiro em centavos ≥ 0." };
  }

  try {
    const data = await atualizarValoresPosicaoManualService(input);
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}
