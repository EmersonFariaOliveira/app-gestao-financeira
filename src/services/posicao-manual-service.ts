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

export interface CriarOuAtualizarAjusteInput {
  chaveExport: string;
  valorInvestidoCentavosCorrigido: number;
}

export interface AjusteValorInvestidoOutput {
  chaveExport: string;
  valorInvestidoCentavosCorrigido: number | null;
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

/**
 * Cria ou atualiza (upsert) o `ajuste_valor_investido` de um `chave_export`
 * — correção pontual do valor investido de um ativo que continua vindo do
 * CSV, associado à sessão VIGENTE mais recente (FR-005, mesmo racional de
 * "efeito imediato" de `criarPosicaoManual`, research.md R7). Fail loud (mesma
 * mensagem já usada nas outras funções deste arquivo) sem sessão VIGENTE.
 *
 * NUNCA toca `posicao.patrimonio_hoje_centavos` (FR-006) — o valor atual
 * continua vindo exclusivamente do import; este ajuste é só o
 * "valor investido corrigido" usado fora do cálculo de déficit.
 *
 * Upsert por `(chave_export, sessao_import_id)` (`@@unique` no schema):
 * chamadas repetidas na MESMA sessão vigente atualizam a linha existente —
 * nunca duplicam.
 */
export async function criarOuAtualizarAjuste(
  input: CriarOuAtualizarAjusteInput,
): Promise<AjusteValorInvestidoOutput> {
  const sessao = await obterSessaoVigenteMaisRecente();
  if (!sessao) {
    throw new Error(MENSAGEM_SEM_SESSAO_VIGENTE);
  }

  const ajuste = await prisma.ajuste_valor_investido.upsert({
    where: {
      chave_export_sessao_import_id: {
        chave_export: input.chaveExport,
        sessao_import_id: sessao.id,
      },
    },
    create: {
      chave_export: input.chaveExport,
      sessao_import_id: sessao.id,
      valor_investido_corrigido_centavos: input.valorInvestidoCentavosCorrigido,
    },
    update: {
      valor_investido_corrigido_centavos: input.valorInvestidoCentavosCorrigido,
    },
  });

  return {
    chaveExport: ajuste.chave_export,
    valorInvestidoCentavosCorrigido: ajuste.valor_investido_corrigido_centavos,
  };
}

export interface AjusteAtivoListItem {
  chaveExport: string;
  alvoId: string | null;
  nomeAlvo: string | null;
  /** Valor corrigido mais recente conhecido — `null` = "primeira vez" (FR-009), ainda não preenchido. */
  valorInvestidoCentavosCorrigido: number | null;
}

/**
 * Lista de `chave_export` "sob ajuste" para a tela dedicada (6.9, T017/User
 * Story 2), fora do fluxo de import. "Sob ajuste" aqui é a mesma condição
 * derivada de data-model.md ("Identidade de 'ativo sob ajuste'"): existe ao
 * menos um `ajuste_valor_investido` histórico para o `chave_export` E o
 * `ativo_mapeado` correspondente ainda está vinculado a um alvo ativo
 * (`alvo_id IS NOT NULL`, `fora_da_carteira = false`, `ignorar_no_import =
 * false`). Retorna o valor corrigido mais recente conhecido (qualquer
 * sessão) — NÃO é o mesmo que `listarPosicoesManuaisEAjustes` (T019, User
 * Story 3), que monta carry-forward/incrementos pendentes para a revisão
 * dentro do import; aqui é só "o que existe agora", para exibição e
 * criação/edição do valor corrigido.
 */
export async function listarAjustesAtivos(): Promise<AjusteAtivoListItem[]> {
  const ajustes = await prisma.ajuste_valor_investido.findMany({
    orderBy: { criado_em: "desc" },
  });
  if (ajustes.length === 0) return [];

  const chavesComAjuste = [...new Set(ajustes.map((a) => a.chave_export))];
  const ativosMapeados = await prisma.ativo_mapeado.findMany({
    where: {
      chave_export: { in: chavesComAjuste },
      alvo_id: { not: null },
      fora_da_carteira: false,
      ignorar_no_import: false,
    },
    include: { alvo: true },
  });

  const ultimoAjustePorChave = new Map<string, (typeof ajustes)[number]>();
  for (const ajuste of ajustes) {
    if (!ultimoAjustePorChave.has(ajuste.chave_export)) {
      ultimoAjustePorChave.set(ajuste.chave_export, ajuste);
    }
  }

  return ativosMapeados.map((ativoMapeado) => {
    const ultimo = ultimoAjustePorChave.get(ativoMapeado.chave_export);
    return {
      chaveExport: ativoMapeado.chave_export,
      alvoId: ativoMapeado.alvo_id,
      nomeAlvo: ativoMapeado.alvo?.nome ?? ativoMapeado.alvo_id,
      valorInvestidoCentavosCorrigido: ultimo?.valor_investido_corrigido_centavos ?? null,
    };
  });
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

export interface PosicaoManualRevisaoItem {
  posicaoManualId: string;
  chaveManual: string;
  instituicao: string;
  descricao: string;
  alvoId: string;
  nomeAlvo: string;
  /** 0 se não houver `posicao_manual_valor` anterior conhecido (posição nova, sem carry-forward). */
  valorInvestidoCentavosAnterior: number;
  /** Sempre 0 nesta fase — US4 (T023-T026) passa a somar `incremento_valor_investido_pendente` aqui. */
  incrementoPendenteCentavos: number;
  /** = valorInvestidoCentavosAnterior + incrementoPendenteCentavos (= Anterior, por ora). */
  valorInvestidoCentavosSugerido: number;
  /** = valor_atual do snapshot anterior; 0 se não houver snapshot anterior. */
  valorAtualCentavosSugerido: number;
}

export interface AjusteRevisaoItem {
  chaveExport: string;
  alvoId: string | null;
  nomeAlvo: string | null;
  /** true = nenhum valor preenchido ainda (FR-009) — ajuste_valor_investido mais recente tem valor null. */
  primeiraVez: boolean;
  valorInvestidoCentavosAnterior: number | null;
  /** Sempre 0 nesta fase — mesmo racional de PosicaoManualRevisaoItem. */
  incrementoPendenteCentavos: number;
  valorInvestidoCentavosSugerido: number | null;
}

export interface RevisaoImportOutput {
  posicoesManuaisRevisao: PosicaoManualRevisaoItem[];
  ajustesRevisao: AjusteRevisaoItem[];
}

/**
 * Monta o carry-forward de posições manuais/ajustes para a revisão dentro do
 * import (tela 6.9-dentro-do-import, data-model.md "Fluxo técnico" passos
 * 1-2; contracts/server-actions.md §import.ts `posicoesManuaisRevisao`/
 * `ajustesRevisao`). Função PURAMENTE de leitura — nenhuma escrita, nenhum
 * argumento: a sessão de referência (VIGENTE mais recente) é resolvida
 * internamente a cada chamada, porque a sessão do import em andamento ainda
 * não existe no banco no momento em que a revisão é montada (mesmo padrão de
 * `previewImport` da feature 001, tudo em memória até `confirmarImport`).
 *
 * Carry-forward é por ENTIDADE, não estritamente pela sessão VIGENTE mais
 * recente em si: usa o snapshot/ajuste mais recente conhecido (por
 * `criado_em`) de cada `posicao_manual`/`chave_export`, mesmo que essa sessão
 * de origem não seja a VIGENTE mais recente (cenário de "mês pulado", em que
 * a posição/ajuste não foi tocado num import intermediário) — mesmo critério
 * já usado por `listarPosicoesManuaisAtivas`/`listarAjustesAtivos` acima.
 *
 * `incrementoPendenteCentavos` sempre 0 nesta fase (US4/T023-T026, fora do
 * escopo desta task) — mantido no shape só para não quebrar o contrato
 * quando a soma de `incremento_valor_investido_pendente` for implementada.
 */
export async function montarRevisaoImport(): Promise<RevisaoImportOutput> {
  const posicoesManuaisAtivas = await prisma.posicao_manual.findMany({
    where: { ativo: true },
    include: { alvo: true },
    orderBy: { criado_em: "desc" },
  });

  const snapshotsMaisRecentes =
    posicoesManuaisAtivas.length === 0
      ? []
      : await prisma.posicao_manual_valor.findMany({
          where: { posicao_manual_id: { in: posicoesManuaisAtivas.map((p) => p.id) } },
          orderBy: { criado_em: "desc" },
        });

  const ultimoSnapshotPorPosicao = new Map<
    string,
    { valor_investido_centavos: number; valor_atual_centavos: number }
  >();
  for (const snapshot of snapshotsMaisRecentes) {
    if (!ultimoSnapshotPorPosicao.has(snapshot.posicao_manual_id)) {
      ultimoSnapshotPorPosicao.set(snapshot.posicao_manual_id, snapshot);
    }
  }

  const posicoesManuaisRevisao: PosicaoManualRevisaoItem[] = posicoesManuaisAtivas.map(
    (posicaoManual) => {
      const snapshot = ultimoSnapshotPorPosicao.get(posicaoManual.id);
      const valorInvestidoCentavosAnterior = snapshot?.valor_investido_centavos ?? 0;
      const valorAtualCentavosSugerido = snapshot?.valor_atual_centavos ?? 0;
      return {
        posicaoManualId: posicaoManual.id,
        chaveManual: posicaoManual.chave_manual,
        instituicao: posicaoManual.instituicao,
        descricao: posicaoManual.descricao,
        alvoId: posicaoManual.alvo_id,
        nomeAlvo: posicaoManual.alvo?.nome ?? posicaoManual.alvo_id,
        valorInvestidoCentavosAnterior,
        incrementoPendenteCentavos: 0,
        valorInvestidoCentavosSugerido: valorInvestidoCentavosAnterior,
        valorAtualCentavosSugerido,
      };
    },
  );

  const ajustesTodos = await prisma.ajuste_valor_investido.findMany({
    orderBy: { criado_em: "desc" },
  });

  let ajustesRevisao: AjusteRevisaoItem[] = [];
  if (ajustesTodos.length > 0) {
    const chavesComAjuste = [...new Set(ajustesTodos.map((a) => a.chave_export))];
    const ativosMapeadosElegiveis = await prisma.ativo_mapeado.findMany({
      where: {
        chave_export: { in: chavesComAjuste },
        alvo_id: { not: null },
        fora_da_carteira: false,
        ignorar_no_import: false,
      },
      include: { alvo: true },
    });

    const ultimoAjustePorChave = new Map<string, (typeof ajustesTodos)[number]>();
    for (const ajuste of ajustesTodos) {
      if (!ultimoAjustePorChave.has(ajuste.chave_export)) {
        ultimoAjustePorChave.set(ajuste.chave_export, ajuste);
      }
    }

    ajustesRevisao = ativosMapeadosElegiveis.map((ativoMapeado) => {
      const ultimo = ultimoAjustePorChave.get(ativoMapeado.chave_export);
      const valorAnterior = ultimo?.valor_investido_corrigido_centavos ?? null;
      const primeiraVez = valorAnterior === null;
      return {
        chaveExport: ativoMapeado.chave_export,
        alvoId: ativoMapeado.alvo_id,
        nomeAlvo: ativoMapeado.alvo?.nome ?? ativoMapeado.alvo_id,
        primeiraVez,
        valorInvestidoCentavosAnterior: valorAnterior,
        incrementoPendenteCentavos: 0,
        valorInvestidoCentavosSugerido: valorAnterior,
      };
    });
  }

  return { posicoesManuaisRevisao, ajustesRevisao };
}

export interface PosicaoManualEAjustesOutput {
  posicoesManuais: Omit<PosicaoManualRevisaoItem, "incrementoPendenteCentavos">[];
  ajustes: Omit<AjusteRevisaoItem, "incrementoPendenteCentavos">[];
}

/**
 * Leitura de posições manuais ativas + ajustes ativos para a tela dedicada
 * (6.9, FR-014), fora do fluxo de import — contracts/server-actions.md
 * §posicoes-manuais.ts `listarPosicoesManuaisEAjustes`. Reaproveita o mesmo
 * carry-forward de `montarRevisaoImport` (mesma regra de "snapshot/ajuste
 * mais recente conhecido"), só que sem o campo `incrementoPendenteCentavos`
 * (sempre 0 nesta fase, e conceitualmente não faz sentido fora do contexto
 * de uma revisão de import em andamento).
 *
 * Nota (T019): `listarPosicoesManuaisAtivas`/`listarAjustesAtivos` (US1/US2)
 * permanecem inalteradas neste arquivo — ainda usadas por
 * `src/app/actions/posicoes-manuais.ts`/`src/app/posicoes-manuais/page.tsx`.
 * Substituí-las por esta função é uma decisão de UI (arquivos fora da camada
 * de dados) deixada para uma task futura (T021/T022) — ver relatório desta
 * task.
 */
export async function listarPosicoesManuaisEAjustes(): Promise<PosicaoManualEAjustesOutput> {
  const { posicoesManuaisRevisao, ajustesRevisao } = await montarRevisaoImport();
  return {
    posicoesManuais: posicoesManuaisRevisao.map(
      ({ incrementoPendenteCentavos: _incrementoPendenteCentavos, ...resto }) => resto,
    ),
    ajustes: ajustesRevisao.map(
      ({ incrementoPendenteCentavos: _incrementoPendenteCentavos, ...resto }) => resto,
    ),
  };
}
