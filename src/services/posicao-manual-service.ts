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
 * `ativo_mapeado` correspondente não está ignorado (`ignorar_no_import =
 * false`) E (está vinculado a um alvo ativo (`alvo_id IS NOT NULL`) OU está
 * marcado `fora_da_carteira = true`). Ativos "pendentes" (sem alvo e não
 * fora-da-carteira) ficam de fora. Para uma chave `fora_da_carteira = true`
 * sem alvo, `alvoId`/`nomeAlvo` retornam `null` (não força um nome de alvo
 * fictício). Esta identidade é distinta da elegibilidade de "incremento
 * pendente" (que continua exigindo `alvo_id` — um aporte é sempre feito NUM
 * alvo; ver `montarIncrementosAmbiguosPendentes` abaixo e
 * `aporte-service.gerarIncrementosPendentes`). Retorna o valor corrigido
 * mais recente conhecido (qualquer sessão) — NÃO é o mesmo que
 * `listarPosicoesManuaisEAjustes` (T019, User Story 3), que monta
 * carry-forward/incrementos pendentes para a revisão dentro do import; aqui
 * é só "o que existe agora", para exibição e criação/edição do valor
 * corrigido.
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
      ignorar_no_import: false,
      OR: [{ alvo_id: { not: null } }, { fora_da_carteira: true }],
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
      nomeAlvo: ativoMapeado.alvo?.nome ?? null,
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
  /**
   * Soma de TODAS as linhas `incremento_valor_investido_pendente` ainda não
   * aplicadas (`aplicado = false`) vinculadas a esta `posicao_manual_id`
   * (T026, motor-integracao.md §4.1) — nunca só a mais recente; se dois
   * aportes foram registrados antes deste import, ambos se acumulam aqui.
   * 0 se não houver nenhuma pendência aplicável.
   */
  incrementoPendenteCentavos: number;
  /** = valorInvestidoCentavosAnterior + incrementoPendenteCentavos. */
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
  /**
   * Soma de TODAS as linhas `incremento_valor_investido_pendente` ainda não
   * aplicadas (`aplicado = false`) vinculadas a este `chave_export` (T026,
   * motor-integracao.md §4.1) — mesmo racional de `PosicaoManualRevisaoItem`.
   * 0 se não houver nenhuma pendência aplicável.
   */
  incrementoPendenteCentavos: number;
  /**
   * `valorInvestidoCentavosAnterior + incrementoPendenteCentavos` quando
   * `valorInvestidoCentavosAnterior` não é null. Quando `primeiraVez` (anterior
   * null) e existe incremento pendente > 0, o campo é pré-preenchido com o
   * próprio incremento (o "anterior" implícito de um ajuste nunca preenchido
   * é 0) — decisão de leitura de spec (motor-integracao.md §4.1 não cobre
   * este cruzamento explicitamente); continua null só quando não há
   * NENHUMA pendência aplicável, preservando o aviso visual de "vazio"
   * (FR-009) nesse caso.
   */
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
 * `incrementoPendenteCentavos` (T026, motor-integracao.md §4.1) soma TODAS
 * as linhas `incremento_valor_investido_pendente` com `aplicado = false`
 * vinculadas à `posicao_manual_id`/`chave_export` correspondente — nunca só
 * a mais recente. A marcação `aplicado = true` (consumo) NÃO acontece aqui
 * (função puramente de leitura) — é responsabilidade de
 * `marcarPendenciasComoAplicadas`, chamada por `confirmarImport` na mesma
 * transação que persiste a revisão (motor-integracao.md §4.3/§4.4).
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

  // T026 (motor-integracao.md §4.1): soma de TODAS as pendências não
  // aplicadas por posicao_manual_id — nunca só a mais recente.
  const idsPosicoesManuais = posicoesManuaisAtivas.map((p) => p.id);
  const pendentesPosicoesManuais =
    idsPosicoesManuais.length === 0
      ? []
      : await prisma.incremento_valor_investido_pendente.findMany({
          where: { aplicado: false, posicao_manual_id: { in: idsPosicoesManuais } },
        });
  const incrementoPorPosicaoManualId = new Map<string, number>();
  for (const pendente of pendentesPosicoesManuais) {
    const chave = pendente.posicao_manual_id as string;
    incrementoPorPosicaoManualId.set(
      chave,
      (incrementoPorPosicaoManualId.get(chave) ?? 0) + pendente.valor_incremento_centavos,
    );
  }

  const posicoesManuaisRevisao: PosicaoManualRevisaoItem[] = posicoesManuaisAtivas.map(
    (posicaoManual) => {
      const snapshot = ultimoSnapshotPorPosicao.get(posicaoManual.id);
      const valorInvestidoCentavosAnterior = snapshot?.valor_investido_centavos ?? 0;
      const valorAtualCentavosSugerido = snapshot?.valor_atual_centavos ?? 0;
      const incrementoPendenteCentavos = incrementoPorPosicaoManualId.get(posicaoManual.id) ?? 0;
      return {
        posicaoManualId: posicaoManual.id,
        chaveManual: posicaoManual.chave_manual,
        instituicao: posicaoManual.instituicao,
        descricao: posicaoManual.descricao,
        alvoId: posicaoManual.alvo_id,
        nomeAlvo: posicaoManual.alvo?.nome ?? posicaoManual.alvo_id,
        valorInvestidoCentavosAnterior,
        incrementoPendenteCentavos,
        valorInvestidoCentavosSugerido: valorInvestidoCentavosAnterior + incrementoPendenteCentavos,
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
    // Mesma identidade de "ativo sob ajuste" de `listarAjustesAtivos` acima
    // (data-model.md, "Identidade de 'ativo sob ajuste'"): não ignorado E
    // (vinculado a um alvo OU fora-da-carteira). Para chaves fora-da-carteira
    // sem alvo, `incrementoPendenteCentavos` abaixo naturalmente resolve
    // para 0 (nunca existe `incremento_valor_investido_pendente` para uma
    // chave sem alvo — regra de elegibilidade de incremento continua
    // exigindo `alvo_id`, propositalmente inalterada).
    const ativosMapeadosElegiveis = await prisma.ativo_mapeado.findMany({
      where: {
        chave_export: { in: chavesComAjuste },
        ignorar_no_import: false,
        OR: [{ alvo_id: { not: null } }, { fora_da_carteira: true }],
      },
      include: { alvo: true },
    });

    const ultimoAjustePorChave = new Map<string, (typeof ajustesTodos)[number]>();
    for (const ajuste of ajustesTodos) {
      if (!ultimoAjustePorChave.has(ajuste.chave_export)) {
        ultimoAjustePorChave.set(ajuste.chave_export, ajuste);
      }
    }

    // T026 (motor-integracao.md §4.1): soma de TODAS as pendências não
    // aplicadas por chave_export — nunca só a mais recente.
    const chavesElegiveis = ativosMapeadosElegiveis.map((a) => a.chave_export);
    const pendentesAjustes =
      chavesElegiveis.length === 0
        ? []
        : await prisma.incremento_valor_investido_pendente.findMany({
            where: { aplicado: false, chave_export: { in: chavesElegiveis } },
          });
    const incrementoPorChaveExport = new Map<string, number>();
    for (const pendente of pendentesAjustes) {
      const chave = pendente.chave_export as string;
      incrementoPorChaveExport.set(
        chave,
        (incrementoPorChaveExport.get(chave) ?? 0) + pendente.valor_incremento_centavos,
      );
    }

    ajustesRevisao = ativosMapeadosElegiveis.map((ativoMapeado) => {
      const ultimo = ultimoAjustePorChave.get(ativoMapeado.chave_export);
      const valorAnterior = ultimo?.valor_investido_corrigido_centavos ?? null;
      const primeiraVez = valorAnterior === null;
      const incrementoPendenteCentavos =
        incrementoPorChaveExport.get(ativoMapeado.chave_export) ?? 0;
      const valorInvestidoCentavosSugerido =
        valorAnterior !== null
          ? valorAnterior + incrementoPendenteCentavos
          : incrementoPendenteCentavos > 0
            ? incrementoPendenteCentavos
            : null;
      return {
        chaveExport: ativoMapeado.chave_export,
        alvoId: ativoMapeado.alvo_id,
        nomeAlvo: ativoMapeado.alvo?.nome ?? null,
        primeiraVez,
        valorInvestidoCentavosAnterior: valorAnterior,
        incrementoPendenteCentavos,
        valorInvestidoCentavosSugerido,
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
 * (não faz sentido fora do contexto de uma revisão de import em andamento —
 * essa listagem é "o que existe agora", não uma pré-visualização de import).
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
    posicoesManuais: posicoesManuaisRevisao.map((item) => ({
      posicaoManualId: item.posicaoManualId,
      chaveManual: item.chaveManual,
      instituicao: item.instituicao,
      descricao: item.descricao,
      alvoId: item.alvoId,
      nomeAlvo: item.nomeAlvo,
      valorInvestidoCentavosAnterior: item.valorInvestidoCentavosAnterior,
      valorInvestidoCentavosSugerido: item.valorInvestidoCentavosSugerido,
      valorAtualCentavosSugerido: item.valorAtualCentavosSugerido,
    })),
    ajustes: ajustesRevisao.map((item) => ({
      chaveExport: item.chaveExport,
      alvoId: item.alvoId,
      nomeAlvo: item.nomeAlvo,
      primeiraVez: item.primeiraVez,
      valorInvestidoCentavosAnterior: item.valorInvestidoCentavosAnterior,
      valorInvestidoCentavosSugerido: item.valorInvestidoCentavosSugerido,
    })),
  };
}

export interface IncrementoAmbiguoPendenteItem {
  alvoId: string;
  nomeAlvo: string;
  /** Soma de TODAS as pendências ambíguas não aplicadas deste alvo (motor-integracao.md §4.2). */
  valorPendenteCentavos: number;
  /** Destinos possíveis de distribuição manual pela UI (contracts/server-actions.md, campo `elegiveis`). */
  elegiveis: { tipo: "posicaoManual" | "ajuste"; id: string; rotulo: string }[];
}

/**
 * Agregação de `incremento_valor_investido_pendente` AMBÍGUOS (`chave_export
 * IS NULL AND posicao_manual_id IS NULL`, `aplicado = false`) por `alvo_id`,
 * para a seção "destaque de pendência ambígua" da revisão de import (T026,
 * motor-integracao.md §4.2, contracts/server-actions.md §import.ts campo
 * `incrementosAmbiguosPendentes`). Função de leitura pura, sem argumentos —
 * mesmo padrão de `montarRevisaoImport`.
 *
 * `elegiveis` reaproveita a MESMA definição de "ativo elegível" de
 * `src/services/aporte-service.ts` (`gerarIncrementosPendentes`, §3.1 do
 * contrato): (a) `posicao_manual` ativas vinculadas ao alvo; (b)
 * `chave_export` vinculado ao alvo (não fora-da-carteira, não ignorado) com
 * ao menos um `ajuste_valor_investido` histórico. A QUERY é duplicada aqui
 * (não importada de `aporte-service.ts`) porque são camadas de leitura
 * distintas — `aporte-service.ts` calcula elegibilidade DENTRO da transação
 * de `registrarAporte` (usa o client `tx`, roda para 1 alvo por vez, no
 * momento em que o incremento é GERADO); esta função é leitura pura fora de
 * qualquer transação (usa o client `prisma` global, roda para TODOS os
 * alvos com pendência ambígua de uma vez, no momento em que o incremento é
 * CONSUMIDO/exibido). Extrair uma função compartilhada exigiria um client
 * genérico (`tx | typeof prisma`) atravessando as duas camadas de serviço
 * para uma query pequena (2 `findMany` + 1 `distinct`) — mais complexidade
 * de acoplamento entre os dois serviços do que a duplicação em si. Se a
 * regra de elegibilidade mudar no futuro, os dois lugares precisam ser
 * atualizados juntos (documentado aqui como o custo aceito desta decisão).
 */
export async function montarIncrementosAmbiguosPendentes(): Promise<IncrementoAmbiguoPendenteItem[]> {
  const pendentesAmbiguos = await prisma.incremento_valor_investido_pendente.findMany({
    where: { aplicado: false, chave_export: null, posicao_manual_id: null },
  });
  if (pendentesAmbiguos.length === 0) return [];

  const valorPendentePorAlvoId = new Map<string, number>();
  for (const pendente of pendentesAmbiguos) {
    valorPendentePorAlvoId.set(
      pendente.alvo_id,
      (valorPendentePorAlvoId.get(pendente.alvo_id) ?? 0) + pendente.valor_incremento_centavos,
    );
  }
  const alvoIds = [...valorPendentePorAlvoId.keys()];

  const [alvos, posicoesManuaisElegiveis, ativosMapeadosDoAlvo] = await Promise.all([
    prisma.alvo.findMany({ where: { id: { in: alvoIds } } }),
    prisma.posicao_manual.findMany({
      where: { alvo_id: { in: alvoIds }, ativo: true },
    }),
    prisma.ativo_mapeado.findMany({
      where: { alvo_id: { in: alvoIds }, fora_da_carteira: false, ignorar_no_import: false },
    }),
  ]);
  const nomePorAlvoId = new Map(alvos.map((a) => [a.id, a.nome]));

  // "Ajuste ativo" (mesma decisão de §3.1-b/§5.1 do contrato): exige EXISTS
  // de ao menos 1 ajuste_valor_investido histórico para a chave.
  let chavesComHistorico = new Set<string>();
  if (ativosMapeadosDoAlvo.length > 0) {
    const chavesComHistoricoRows = await prisma.ajuste_valor_investido.findMany({
      where: { chave_export: { in: ativosMapeadosDoAlvo.map((a) => a.chave_export) } },
      select: { chave_export: true },
      distinct: ["chave_export"],
    });
    chavesComHistorico = new Set(chavesComHistoricoRows.map((r) => r.chave_export));
  }

  const posicoesManuaisPorAlvoId = new Map<string, typeof posicoesManuaisElegiveis>();
  for (const posicaoManual of posicoesManuaisElegiveis) {
    const lista = posicoesManuaisPorAlvoId.get(posicaoManual.alvo_id) ?? [];
    lista.push(posicaoManual);
    posicoesManuaisPorAlvoId.set(posicaoManual.alvo_id, lista);
  }
  const ajustesElegiveisPorAlvoId = new Map<string, typeof ativosMapeadosDoAlvo>();
  for (const ativoMapeado of ativosMapeadosDoAlvo) {
    if (!ativoMapeado.alvo_id || !chavesComHistorico.has(ativoMapeado.chave_export)) continue;
    const lista = ajustesElegiveisPorAlvoId.get(ativoMapeado.alvo_id) ?? [];
    lista.push(ativoMapeado);
    ajustesElegiveisPorAlvoId.set(ativoMapeado.alvo_id, lista);
  }

  return alvoIds.map((alvoId) => {
    const posicoesManuaisDoAlvo = posicoesManuaisPorAlvoId.get(alvoId) ?? [];
    const ajustesDoAlvo = ajustesElegiveisPorAlvoId.get(alvoId) ?? [];
    const elegiveis: IncrementoAmbiguoPendenteItem["elegiveis"] = [
      ...posicoesManuaisDoAlvo.map((posicaoManual) => ({
        tipo: "posicaoManual" as const,
        id: posicaoManual.id,
        rotulo: `${posicaoManual.descricao} (${posicaoManual.instituicao})`,
      })),
      ...ajustesDoAlvo.map((ativoMapeado) => ({
        tipo: "ajuste" as const,
        id: ativoMapeado.chave_export,
        rotulo: ativoMapeado.chave_export,
      })),
    ];
    return {
      alvoId,
      nomeAlvo: nomePorAlvoId.get(alvoId) ?? alvoId,
      valorPendenteCentavos: valorPendentePorAlvoId.get(alvoId) ?? 0,
      elegiveis,
    };
  });
}

/** Tipo mínimo do client (global `prisma` OU `tx` de transação) exigido por `marcarPendenciasComoAplicadas`. */
type ClientePendencias = Pick<typeof prisma, "incremento_valor_investido_pendente">;

export interface MarcarPendenciasComoAplicadasInput {
  pendenciaIds: string[];
  sessaoAplicacaoId: string;
}

/**
 * Marca `aplicado = true` + grava `sessao_aplicacao_id` em lote para os ids
 * informados (T026, motor-integracao.md §4.3/§5.3, FR-013). Função
 * utilitária pura de escrita — não recalcula elegibilidade nem valida FKs
 * mutuamente exclusivos (exclusiva vs. ambígua); recebe a lista JÁ RESOLVIDA
 * de ids a marcar (o chamador — `confirmarImport` — decide quais).
 *
 * Aceita um segundo parâmetro OPCIONAL `cliente` (default: o `prisma`
 * global deste módulo) tipado estruturalmente como
 * `Pick<typeof prisma, "incremento_valor_investido_pendente">` — o `tx` de
 * `prisma.$transaction(async (tx) => ...)` satisfaz esse tipo (mesmo
 * delegate `incremento_valor_investido_pendente`, gerado do mesmo schema).
 * Isso permite `confirmarImport` (import-service.ts) chamar esta função
 * PASSANDO `tx`, garantindo que a marcação ocorra na MESMA transação que
 * persiste `posicao_manual_valor`/`ajuste_valor_investido` da nova sessão
 * (requisito de atomicidade do contrato) — e permite que os testes deste
 * arquivo chamem a função sem segundo argumento, contra o client global.
 * Duas variantes de função (uma "core" + um wrapper) foram consideradas e
 * rejeitadas: um único parâmetro opcional com default é mais simples e não
 * duplica a assinatura pública.
 */
export async function marcarPendenciasComoAplicadas(
  input: MarcarPendenciasComoAplicadasInput,
  cliente: ClientePendencias = prisma,
): Promise<{ quantidadeAtualizada: number }> {
  if (input.pendenciaIds.length === 0) return { quantidadeAtualizada: 0 };

  const resultado = await cliente.incremento_valor_investido_pendente.updateMany({
    where: { id: { in: input.pendenciaIds } },
    data: { aplicado: true, sessao_aplicacao_id: input.sessaoAplicacaoId },
  });

  return { quantidadeAtualizada: resultado.count };
}
