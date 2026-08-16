import { prisma } from "@/db/client";

// Serviço de posições manuais (T007, feature 002-posicoes-manuais-ajustes):
// fonte da verdade para CRUD-sem-D de `posicao_manual` e criação do
// `posicao_manual_valor` inicial. Camada de I/O: importa Prisma livremente,
// não é importada por src/core/**.
//
// Regras de imutabilidade (data-model.md desta feature, "Regras de
// integridade transversais" #1/#2):
// - `posicao_manual_valor` nunca é deletado/atualizado após criado — cada
//   sessão gera um snapshot novo (fora do escopo desta task: carry-forward
//   fica para T018/T019).
// - `posicao_manual.chave_manual` é imutável após criação — trocar a chave é
//   cadastrar uma posição manual nova; `editarPosicaoManual` nunca a toca.
// - `posicao_manual.ativo` só transiciona `true -> false` (encerramento,
//   FR-004), nunca o inverso — não existe `ativarPosicaoManual`.
//
// Pré-condição de sessão vigente (research.md R7; contracts/motor-integracao.md
// §2.3): cadastrar uma posição manual fora do fluxo de import precisa anexar
// o `posicao_manual_valor` inicial à sessão VIGENTE mais recente — sem isso a
// posição não apareceria no cálculo até o próximo import (contradiz o
// Independent Test da User Story 1). Sem sessão vigente, falha alto com a
// MESMA mensagem já usada por `aporte-service.montarContextoEntradaMotor`.
const MENSAGEM_SEM_SESSAO_VIGENTE =
  "Nenhuma sessão de import VIGENTE encontrada — realize um import antes de calcular o aporte.";

export interface CriarPosicaoManualInput {
  chaveManual: string;
  instituicao: string;
  descricao: string;
  alvoId: string;
  valorInvestidoCentavos: number;
  valorAtualCentavos: number;
  /** Opcional (data-model.md): registra qual `chave_export` ignorada esta posição substitui. */
  chaveExportOrigem?: string;
}

export interface PosicaoManualOutput {
  id: string;
  chaveManual: string;
  instituicao: string;
  descricao: string;
  alvoId: string;
  tipoGrupo: string;
  ativo: boolean;
}

export interface EditarPosicaoManualInput {
  posicaoManualId: string;
  instituicao?: string;
  descricao?: string;
  alvoId?: string;
}

export interface EncerrarPosicaoManualInput {
  posicaoManualId: string;
}

/**
 * Sessão VIGENTE mais recente (mesmo critério de
 * `aporte-service.obterSessaoVigenteMaisRecente`/
 * `mapeamento-service.obterSessaoVigenteMaisRecente`). Cópia intencional da
 * mesma query — não importada dos outros módulos por serem funções privadas
 * deles; os três locais devem permanecer idênticos se a regra mudar.
 */
async function obterSessaoVigenteMaisRecente() {
  return prisma.sessao_import.findFirst({
    where: { status: "VIGENTE" },
    orderBy: [{ data_export: "desc" }, { criado_em: "desc" }],
  });
}

function paraOutput(posicaoManual: {
  id: string;
  chave_manual: string;
  instituicao: string;
  descricao: string;
  alvo_id: string;
  tipo_grupo: string;
  ativo: boolean;
}): PosicaoManualOutput {
  return {
    id: posicaoManual.id,
    chaveManual: posicaoManual.chave_manual,
    instituicao: posicaoManual.instituicao,
    descricao: posicaoManual.descricao,
    alvoId: posicaoManual.alvo_id,
    tipoGrupo: posicaoManual.tipo_grupo,
    ativo: posicaoManual.ativo,
  };
}

/**
 * Cria uma `posicao_manual` e o `posicao_manual_valor` inicial na MESMA
 * transação, anexado à sessão VIGENTE mais recente (research.md R7). Falha
 * alto (fail loud) — nenhum registro parcial — se não houver sessão VIGENTE.
 */
export async function criarPosicaoManual(
  input: CriarPosicaoManualInput,
): Promise<PosicaoManualOutput> {
  const sessao = await obterSessaoVigenteMaisRecente();
  if (!sessao) {
    throw new Error(MENSAGEM_SEM_SESSAO_VIGENTE);
  }

  const posicaoManual = await prisma.$transaction(async (tx) => {
    const criada = await tx.posicao_manual.create({
      data: {
        chave_manual: input.chaveManual,
        instituicao: input.instituicao,
        descricao: input.descricao,
        alvo_id: input.alvoId,
        chave_export_origem: input.chaveExportOrigem ?? null,
      },
    });

    await tx.posicao_manual_valor.create({
      data: {
        posicao_manual_id: criada.id,
        sessao_import_id: sessao.id,
        valor_investido_centavos: input.valorInvestidoCentavos,
        valor_atual_centavos: input.valorAtualCentavos,
      },
    });

    return criada;
  });

  return paraOutput(posicaoManual);
}

/**
 * Atualiza somente campos cadastrais (`instituicao`, `descricao`, `alvo_id`)
 * — nunca cria/altera `posicao_manual_valor` e nunca toca `chave_manual`
 * (imutável após criação, data-model.md #2). Parcial: campos não informados
 * permanecem como estavam.
 */
export async function editarPosicaoManual(
  input: EditarPosicaoManualInput,
): Promise<PosicaoManualOutput> {
  const data: { instituicao?: string; descricao?: string; alvo_id?: string } = {};
  if (input.instituicao !== undefined) data.instituicao = input.instituicao;
  if (input.descricao !== undefined) data.descricao = input.descricao;
  if (input.alvoId !== undefined) data.alvo_id = input.alvoId;

  const atualizada = await prisma.posicao_manual.update({
    where: { id: input.posicaoManualId },
    data,
  });

  return paraOutput(atualizada);
}

/**
 * Encerra a posição manual (`ativo: true -> false`, FR-004). Irreversível —
 * não existe `ativarPosicaoManual`; uma segunda chamada é um no-op seguro
 * (idempotente), nunca reativa. Histórico (`posicao_manual_valor`) nunca é
 * apagado.
 */
export async function encerrarPosicaoManual(
  input: EncerrarPosicaoManualInput,
): Promise<PosicaoManualOutput> {
  const atualizada = await prisma.posicao_manual.update({
    where: { id: input.posicaoManualId },
    data: { ativo: false },
  });

  return paraOutput(atualizada);
}

export interface PosicaoManualListItem extends PosicaoManualOutput {
  nomeAlvo: string;
  /** Último snapshot conhecido (qualquer sessão) — `null` se a posição nunca teve `posicao_manual_valor` (sem sessão VIGENTE no cadastro). */
  valorInvestidoCentavos: number | null;
  valorAtualCentavos: number | null;
}

/**
 * Lista de posições manuais ATIVAS para a tela dedicada (6.9, FR-014),
 * fora do fluxo de import. Leitura simples do último snapshot conhecido de
 * cada posição — NÃO é o mesmo que `listarPosicoesManuaisEAjustes` (T019,
 * User Story 3), que monta carry-forward/incrementos pendentes para a
 * revisão dentro do import; aqui é só "o que existe agora", para exibição e
 * ação de encerrar.
 */
export async function listarPosicoesManuaisAtivas(): Promise<PosicaoManualListItem[]> {
  const posicoes = await prisma.posicao_manual.findMany({
    where: { ativo: true },
    include: { alvo: true },
    orderBy: { criado_em: "desc" },
  });

  if (posicoes.length === 0) return [];

  const snapshots = await prisma.posicao_manual_valor.findMany({
    where: { posicao_manual_id: { in: posicoes.map((p) => p.id) } },
    orderBy: { criado_em: "desc" },
  });

  const ultimoSnapshotPorPosicao = new Map<
    string,
    { valor_investido_centavos: number; valor_atual_centavos: number }
  >();
  for (const snapshot of snapshots) {
    if (!ultimoSnapshotPorPosicao.has(snapshot.posicao_manual_id)) {
      ultimoSnapshotPorPosicao.set(snapshot.posicao_manual_id, snapshot);
    }
  }

  return posicoes.map((posicaoManual) => {
    const snapshot = ultimoSnapshotPorPosicao.get(posicaoManual.id);
    return {
      ...paraOutput(posicaoManual),
      nomeAlvo: posicaoManual.alvo?.nome ?? posicaoManual.alvo_id,
      valorInvestidoCentavos: snapshot?.valor_investido_centavos ?? null,
      valorAtualCentavos: snapshot?.valor_atual_centavos ?? null,
    };
  });
}
