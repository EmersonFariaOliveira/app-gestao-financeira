import { prisma } from "@/db/client";

// Serviço de leitura da análise de rendimento (T010, specs/003-dashboard-
// analise-rendimento/data-model.md e research.md R4/R5/R11). Camada de
// LEITURA PURA no mesmo padrão de `dashboard-service.ts`: nenhuma escrita
// acontece neste arquivo, nunca importado por `src/core/motor/**`
// (invariante estrutural — `patrimonio_investido_centavos` nunca alimenta
// `PosicaoConsolidada`/`EntradaMotor`, FR-019/R1).
//
// Escopo desta primeira fatia (US1, P1): resolução de fonte de valor
// investido (R4), fórmulas de rendimento de ponto/período (R5) e resolução
// de período pré-definido/customizado. Segmentação por bucket (US2),
// gráfico (US3) e "movimentação não explicada" (US4) ficam para tasks
// futuras — as interfaces abaixo já preparam o terreno (nomes/shapes
// exatamente conforme data-model.md).

/** Resultado da resolução de prioridade R4, para um `chave_export` numa sessão. */
export interface ValorInvestidoResolvido {
  chaveExport: string;
  /** null = sem dado suficiente (FR-010) — nem ajuste preenchido, nem CSV. */
  valorInvestidoCentavos: number | null;
  fonte: "ajuste" | "csv" | "indisponivel";
}

/** Rendimento de um ativo/alvo/tag/bucket numa única sessão (fórmula R5, ponto no tempo). */
export interface RendimentoPonto {
  /** null = FR-010 (sem valor investido rastreável nessa sessão). */
  rendimentoCentavos: number | null;
  /** null quando rendimentoCentavos é null OU valorInvestidoCentavos = 0. */
  rendimentoPct: number | null;
  valorAtualCentavos: number;
  /** null = sem dado (não confundir com 0). */
  valorInvestidoCentavos: number | null;
}

/** Rendimento entre duas sessões (fórmula R5, variação de período) — o que US1/US3 exibem. */
export interface RendimentoPeriodo {
  sessaoInicioId: string;
  sessaoFimId: string;
  /** Sempre calculável quando ambos os pontos têm dado — diferença exata em centavos. */
  rendimentoCentavos: number | null;
  /** Base = valorInvestidoCentavos do ponto de início (Clarifications, spec.md). */
  rendimentoPct: number | null;
  pontoInicio: RendimentoPonto;
  pontoFim: RendimentoPonto;
}

type PeriodoPredefinido = "1M" | "3M" | "6M" | "12M" | "DESDE_INICIO";

/** Intervalo selecionado pelo usuário (FR-005/FR-006), resolvido para duas `sessao_import` VIGENTE. */
export interface PeriodoAnalise {
  tipo: PeriodoPredefinido | "CUSTOMIZADO";
  /** null = nenhuma sessão vigente no intervalo (edge case do spec). */
  sessaoInicioId: string | null;
  sessaoFimId: string | null;
}

/** Meses subtraídos de cada preset pré-definido (R5/FR-006). */
const MESES_POR_PRESET: Record<Exclude<PeriodoPredefinido, "DESDE_INICIO">, number> = {
  "1M": 1,
  "3M": 3,
  "6M": 6,
  "12M": 12,
};

// Constantes de aplicação (R8) — tolerância de "movimentação não explicada"
// (FR-018), consumidas por tasks futuras (US4). Não persistidas em `config`
// nesta versão (mudança aditiva de baixo risco caso vire configurável).
export const TOLERANCIA_MOVIMENTACAO_PCT = 5;
export const TOLERANCIA_MOVIMENTACAO_PISO_CENTAVOS = 2000; // R$ 20,00

/**
 * Resolve o valor investido de um `chave_export` numa sessão, aplicando a
 * prioridade R4:
 * 1. `ajuste_valor_investido.valor_investido_corrigido_centavos` da sessão,
 *    se existir uma linha **e** o campo não for `null`.
 * 2. Senão, a SOMA de `posicao.patrimonio_investido_centavos` de TODAS as
 *    linhas `posicao` daquela `chave_export` nessa sessão — cobre tanto
 *    posições vindas do CSV (o "Patrimônio Aplicado") quanto, sem nenhuma
 *    mudança de fluxo, o snapshot de `posicao_manual_valor.
 *    valor_investido_centavos` (feature 002, inalterado — FR-004): a chave
 *    de uma posição manual é `posicao_manual.chave_manual`, que nunca tem
 *    linha em `posicao`, então a consulta cai direto na tabela de posições
 *    manuais.
 *
 *    IMPORTANTE — uma `chave_export` pode ter VÁRIAS linhas `posicao` na
 *    mesma sessão quando o mesmo ativo está espalhado por instituições
 *    diferentes (ex.: mesmo ticker na Itaú e na Nubank; ver
 *    `prisma/seed.ts`). Essa soma precisa ser feita aqui pela mesma razão
 *    que `chavesElegiveisDaSessao` soma `patrimonio_hoje_centavos` entre
 *    instituições: início e fim de um `RendimentoPonto` têm que usar a MESMA
 *    unidade consolidada (FR-002), nunca uma única linha arbitrária. Regra
 *    de "nunca um número parcial disfarçado de completo" (Princípio V): se
 *    QUALQUER linha `posicao` daquela chave/sessão tiver
 *    `patrimonio_investido_centavos: null`, a chave INTEIRA é tratada como
 *    sem dado CSV disponível nesta camada (cai para o passo 3, nunca soma
 *    só as linhas que têm valor e ignora silenciosamente as que não têm).
 *    Só quando TODAS as linhas da chave têm valor não-nulo é que a soma é
 *    usada.
 * 3. Se nenhuma linha `posicao` existir para a chave (posição manual) ou a
 *    soma do passo 2 não for aplicável (alguma linha nula), tenta o
 *    snapshot `posicao_manual_valor.valor_investido_centavos`.
 * 4. Se nada disso resolver → "sem histórico suficiente" (FR-010).
 */
export async function resolverValorInvestido(
  chaveExport: string,
  sessaoId: string,
): Promise<ValorInvestidoResolvido> {
  const ajuste = await prisma.ajuste_valor_investido.findUnique({
    where: { chave_export_sessao_import_id: { chave_export: chaveExport, sessao_import_id: sessaoId } },
  });
  if (ajuste && ajuste.valor_investido_corrigido_centavos !== null) {
    return {
      chaveExport,
      valorInvestidoCentavos: ajuste.valor_investido_corrigido_centavos,
      fonte: "ajuste",
    };
  }

  const posicoes = await prisma.posicao.findMany({
    where: { chave_export: chaveExport, sessao_import_id: sessaoId },
    select: { patrimonio_investido_centavos: true },
  });
  if (posicoes.length > 0) {
    const todasComValor = posicoes.every((p) => p.patrimonio_investido_centavos !== null);
    if (todasComValor) {
      const somaCentavos = posicoes.reduce(
        (acc, p) => acc + (p.patrimonio_investido_centavos as number),
        0,
      );
      return { chaveExport, valorInvestidoCentavos: somaCentavos, fonte: "csv" };
    }
  }

  // Nenhuma linha `posicao` para essa chave nesta sessão, OU pelo menos uma
  // linha tinha `patrimonio_investido_centavos: null` (dado CSV incompleto,
  // não usável) — tenta posicao_manual (FR-004, feature 002 inalterada:
  // sempre posicao_manual_valor.valor_investido_centavos).
  const posicaoManual = await prisma.posicao_manual.findUnique({
    where: { chave_manual: chaveExport },
    select: { id: true },
  });
  if (posicaoManual) {
    const snapshot = await prisma.posicao_manual_valor.findUnique({
      where: {
        posicao_manual_id_sessao_import_id: {
          posicao_manual_id: posicaoManual.id,
          sessao_import_id: sessaoId,
        },
      },
      select: { valor_investido_centavos: true },
    });
    if (snapshot) {
      return { chaveExport, valorInvestidoCentavos: snapshot.valor_investido_centavos, fonte: "csv" };
    }
  }

  return { chaveExport, valorInvestidoCentavos: null, fonte: "indisponivel" };
}

/**
 * Fórmula R5 de uma sessão única (ponto no tempo):
 * `rendimentoCentavos = valorAtualCentavos - valorInvestidoCentavos`,
 * `rendimentoPct = valorInvestidoCentavos > 0 ? rendimentoCentavos /
 * valorInvestidoCentavos * 100 : null` — guarda de divisão por zero, nunca
 * `Infinity`/`NaN`/0 enganoso (Princípio V). Quando `valorInvestidoCentavos`
 * é `null` (FR-010), tanto `rendimentoCentavos` quanto `rendimentoPct`
 * também são `null` — sem base nenhuma para calcular a diferença.
 */
export function calcularRendimentoPonto(dados: {
  valorAtualCentavos: number;
  valorInvestidoCentavos: number | null;
}): RendimentoPonto {
  const { valorAtualCentavos, valorInvestidoCentavos } = dados;

  if (valorInvestidoCentavos === null) {
    return { rendimentoCentavos: null, rendimentoPct: null, valorAtualCentavos, valorInvestidoCentavos: null };
  }

  const rendimentoCentavos = valorAtualCentavos - valorInvestidoCentavos;
  const rendimentoPct =
    valorInvestidoCentavos > 0 ? (rendimentoCentavos / valorInvestidoCentavos) * 100 : null;

  return { rendimentoCentavos, rendimentoPct, valorAtualCentavos, valorInvestidoCentavos };
}

/**
 * Fórmula R5 de variação entre duas sessões:
 * `deltaRendimentoCentavos = rendimentoCentavos(fim) - rendimentoCentavos(início)`,
 * `rendimentoPctPeriodo` usa `valorInvestidoCentavos(início)` como base
 * SEMPRE (Clarifications, spec.md — nunca o fim, para não diluir o
 * percentual quando há aporte novo no meio do período). Ambos `null` quando
 * qualquer um dos dois pontos não tem valor investido rastreável (FR-010).
 */
export function calcularRendimentoPeriodo(dados: {
  sessaoInicioId: string;
  sessaoFimId: string;
  pontoInicio: { valorAtualCentavos: number; valorInvestidoCentavos: number | null };
  pontoFim: { valorAtualCentavos: number; valorInvestidoCentavos: number | null };
}): RendimentoPeriodo {
  const pontoInicio = calcularRendimentoPonto(dados.pontoInicio);
  const pontoFim = calcularRendimentoPonto(dados.pontoFim);

  const rendimentoCentavos =
    pontoInicio.rendimentoCentavos === null || pontoFim.rendimentoCentavos === null
      ? null
      : pontoFim.rendimentoCentavos - pontoInicio.rendimentoCentavos;

  const rendimentoPct =
    rendimentoCentavos === null || pontoInicio.valorInvestidoCentavos === null
      ? null
      : pontoInicio.valorInvestidoCentavos > 0
        ? (rendimentoCentavos / pontoInicio.valorInvestidoCentavos) * 100
        : null;

  return {
    sessaoInicioId: dados.sessaoInicioId,
    sessaoFimId: dados.sessaoFimId,
    rendimentoCentavos,
    rendimentoPct,
    pontoInicio,
    pontoFim,
  };
}

/** Todas as sessões VIGENTE, ordenadas por `mes_referencia` asc (FR-013: SUBSTITUIDO nunca entra). */
async function listarSessoesVigentesOrdenadas() {
  return prisma.sessao_import.findMany({
    where: { status: "VIGENTE" },
    orderBy: { mes_referencia: "asc" },
    select: { id: true, mes_referencia: true },
  });
}

/** `"2026-08"` -> `{ ano: 2026, mes: 8 }` (mes_referencia é sempre `AAAA-MM`, data-model.md). */
function parseMesReferencia(mesReferencia: string): { ano: number; mes: number } {
  const [ano, mes] = mesReferencia.split("-").map(Number);
  return { ano, mes };
}

/** `mesReferencia` menos `n` meses, no mesmo formato `"AAAA-MM"`. */
function subtrairMeses(mesReferencia: string, n: number): string {
  const { ano, mes } = parseMesReferencia(mesReferencia);
  const totalMeses = ano * 12 + (mes - 1) - n;
  const anoAlvo = Math.floor(totalMeses / 12);
  const mesAlvo = (totalMeses % 12) + 1;
  return `${anoAlvo}-${String(mesAlvo).padStart(2, "0")}`;
}

/**
 * Resolve um `PeriodoAnalise` (presets 1M/3M/6M/12M/DESDE_INICIO ou
 * customizado) para duas `sessao_import` VIGENTE concretas.
 *
 * Presets: fim = sessão VIGENTE mais recente por `mes_referencia`; início =
 * a sessão VIGENTE mais próxima (nunca interpolada) do mês alvo (fim menos N
 * meses) — se não houver sessão exatamente naquele mês, usa a mais antiga
 * disponível que ainda seja `<=` o mês alvo mais recente possível, isto é,
 * a sessão vigente cujo `mes_referencia` mais se aproxima do alvo sem
 * "inventar" um ponto que não existe (nunca interpola entre dois meses
 * reais). `DESDE_INICIO`: início = primeira sessão VIGENTE, fim = mais
 * recente.
 *
 * Customizado: usa `sessaoInicioId`/`sessaoFimId` explícitos, sem nenhuma
 * consulta adicional (o chamador já resolveu as sessões).
 *
 * Nunca lança exceção: sem NENHUMA sessão VIGENTE, retorna
 * `{sessaoInicioId: null, sessaoFimId: null}`.
 */
export async function resolverPeriodo(
  entrada:
    | { tipo: PeriodoPredefinido }
    | { tipo: "CUSTOMIZADO"; sessaoInicioId: string; sessaoFimId: string },
): Promise<PeriodoAnalise> {
  if (entrada.tipo === "CUSTOMIZADO") {
    return { tipo: "CUSTOMIZADO", sessaoInicioId: entrada.sessaoInicioId, sessaoFimId: entrada.sessaoFimId };
  }

  const sessoes = await listarSessoesVigentesOrdenadas();
  if (sessoes.length === 0) {
    return { tipo: entrada.tipo, sessaoInicioId: null, sessaoFimId: null };
  }

  const sessaoFim = sessoes[sessoes.length - 1];

  if (entrada.tipo === "DESDE_INICIO") {
    return { tipo: entrada.tipo, sessaoInicioId: sessoes[0].id, sessaoFimId: sessaoFim.id };
  }

  const mesAlvo = subtrairMeses(sessaoFim.mes_referencia, MESES_POR_PRESET[entrada.tipo]);

  // Sessão VIGENTE mais próxima do mês alvo, nunca interpolada: entre as
  // candidatas com `mes_referencia <= mesAlvo`, pega a mais recente (a mais
  // próxima "por baixo"); se não houver nenhuma, cai para a mais antiga
  // disponível (histórico mais curto que o preset pedido).
  const candidatasAntesOuNoAlvo = sessoes.filter((s) => s.mes_referencia <= mesAlvo);
  const sessaoInicio =
    candidatasAntesOuNoAlvo.length > 0
      ? candidatasAntesOuNoAlvo[candidatasAntesOuNoAlvo.length - 1]
      : sessoes[0];

  return { tipo: entrada.tipo, sessaoInicioId: sessaoInicio.id, sessaoFimId: sessaoFim.id };
}

// ---------------------------------------------------------------------------
// US1 (P1, MVP) — rendimento consolidado do patrimônio total num período
// (contracts/server-actions.md "rendimento.ts", tela 6.10). Único slice
// implementado nesta fatia: `porTag`/`porAlvo`/`foraDaCarteira`/`reserva
// Emergencia`/`serie` do contrato completo ficam para tasks futuras (US2/US3)
// — a interface abaixo é deliberadamente um subconjunto de
// `RendimentoOutput` do contrato, não o shape final.
// ---------------------------------------------------------------------------

/** Input de `dadosRendimento` — mesmo shape aceito por `resolverPeriodo`. */
export type PeriodoInput =
  | { tipo: PeriodoPredefinido }
  | { tipo: "CUSTOMIZADO"; sessaoInicioId: string; sessaoFimId: string };

/** Sessão VIGENTE resumida, para popular o seletor de período customizado (tela 6.10). */
export interface PeriodoDisponivel {
  sessaoImportId: string;
  mesReferencia: string;
  dataExport: string;
}

/**
 * Resultado de `dadosRendimento` — subconjunto do `RendimentoOutput` do
 * contrato (contracts/server-actions.md), só com `consolidado` (US1). Os
 * campos `reservaEmergencia`/`porTag`/`porAlvo`/`foraDaCarteira`/`serie`
 * chegam em tasks futuras (US2/US3), quando o shape completo for
 * implementado.
 */
export interface RendimentoOutput {
  /** true = nenhuma sessão VIGENTE existe ainda (mesmo padrão de `DashboardVazio`) — nunca "sem dado de valor investido", isso é tratado por `rendimentoCentavos: null` dentro de `consolidado`. */
  vazio: boolean;
  periodo: PeriodoAnalise;
  /**
   * Rendimento do patrimônio TOTAL (todas as posições/posições manuais
   * elegíveis, exceto `ignorar_no_import` — FR-012/FR-014) no período
   * resolvido por `periodo`.
   *
   * Quando `periodo.sessaoInicioId !== periodo.sessaoFimId`, é a variação
   * ENTRE as duas sessões (`calcularRendimentoPeriodo`, fim - início).
   *
   * Quando só existe UMA sessão VIGENTE (`periodo.sessaoInicioId ===
   * periodo.sessaoFimId`), NÃO existe um segundo ponto para subtrair — um
   * delta entre dois pontos idênticos sempre daria `0`, um número incorreto
   * exibido silenciosamente (Princípio V, spec.md US1 Acceptance Scenario
   * 2). Nesse caso `consolidado` reflete o rendimento DAQUELA sessão isolada
   * (`calcularRendimentoPonto`: `rendimentoCentavos = valorAtual -
   * valorInvestido` da própria sessão), com `pontoInicio`/`pontoFim` ambos
   * iguais a esse único ponto. Ver `semPeriodoAnteriorParaComparacao`.
   */
  consolidado: RendimentoPeriodo;
  periodosDisponiveis: PeriodoDisponivel[];
  /**
   * `true` quando o período resolvido tem só UMA sessão VIGENTE disponível
   * (`periodo.sessaoInicioId === periodo.sessaoFimId`) — não há período
   * anterior para comparar, então `consolidado` é o rendimento de um ÚNICO
   * ponto no tempo, não uma variação (spec.md US1 Acceptance Scenario 2). A
   * UI deve sinalizar isso ao usuário em vez de exibir um "0" enganoso.
   *
   * `false` no caso normal (duas sessões VIGENTE distintas) e também quando
   * `vazio: true` (nenhuma sessão VIGENTE — o campo não tem sentido nesse
   * cenário, valor neutro).
   */
  semPeriodoAnteriorParaComparacao: boolean;
}

/** `RendimentoPonto` "vazio" usado quando não há NENHUMA sessão VIGENTE (edge case do spec, `sessaoInicioId`/`sessaoFimId: null`). */
const PONTO_SEM_DADO: RendimentoPonto = {
  rendimentoCentavos: null,
  rendimentoPct: null,
  valorAtualCentavos: 0,
  valorInvestidoCentavos: null,
};

/**
 * `chave_export`/`chave_manual` elegíveis de UMA sessão, com o respectivo
 * `valorAtualCentavos` ("somar antes de dividir", mesma técnica de
 * `dashboard-service.classificarPosicoesDaSessao`/`agruparAlocacaoPorTag`,
 * R5 de research.md).
 *
 * Elegibilidade: TODAS as posições consolidadas por `chave_export` da sessão
 * (soma entre instituições) e TODAS as `posicao_manual` ativas com snapshot
 * nesta sessão, EXCETO as marcadas `ignorar_no_import = true` em
 * `ativo_mapeado` — mesma exclusão do "patrimônio total" do dashboard
 * (FR-012, FR-014: consolidado = soma de todos os buckets exibidos hoje,
 * incluindo pendentes com dado disponível; só `ignorar_no_import` fica de
 * fora). `posicao_manual` não tem campo equivalente a `ignorar_no_import`
 * (ela É a substituta, nunca a ignorada).
 *
 * Extraída de forma que `consolidadoDoPeriodo` possa montar a UNIÃO das
 * chaves elegíveis de início e fim sem duplicar esta lógica.
 */
async function chavesElegiveisDaSessao(sessaoId: string): Promise<Map<string, number>> {
  const posicoesBrutas = await prisma.posicao.findMany({
    where: { sessao_import_id: sessaoId },
    select: { chave_export: true, patrimonio_hoje_centavos: true },
  });

  const valorPorChave = new Map<string, number>();
  for (const p of posicoesBrutas) {
    valorPorChave.set(
      p.chave_export,
      (valorPorChave.get(p.chave_export) ?? 0) + p.patrimonio_hoje_centavos,
    );
  }

  const chaves = Array.from(valorPorChave.keys());
  const mapeamentosIgnorados =
    chaves.length > 0
      ? await prisma.ativo_mapeado.findMany({
          where: { chave_export: { in: chaves }, ignorar_no_import: true },
          select: { chave_export: true },
        })
      : [];
  const chavesIgnoradas = new Set(mapeamentosIgnorados.map((m) => m.chave_export));

  const elegiveis = new Map<string, number>();
  for (const [chaveExport, valorCentavos] of valorPorChave) {
    if (chavesIgnoradas.has(chaveExport)) continue;
    elegiveis.set(chaveExport, valorCentavos);
  }

  // posicao_manual ativas com snapshot NESTA sessão específica (mesmo
  // tratamento de dashboard-service.classificarPosicoesDaSessao — sem
  // snapshot na sessão, a posição manual é omitida silenciosamente, não é
  // erro). Usa SEMPRE valor_atual_centavos (FR-006/SC-004 inviolável).
  const posicoesManuaisAtivas = await prisma.posicao_manual.findMany({ where: { ativo: true } });
  if (posicoesManuaisAtivas.length > 0) {
    const snapshots = await prisma.posicao_manual_valor.findMany({
      where: {
        sessao_import_id: sessaoId,
        posicao_manual_id: { in: posicoesManuaisAtivas.map((p) => p.id) },
      },
      select: { posicao_manual_id: true, valor_atual_centavos: true },
    });
    const posicaoManualPorId = new Map(posicoesManuaisAtivas.map((p) => [p.id, p]));
    for (const snapshot of snapshots) {
      const posicaoManual = posicaoManualPorId.get(snapshot.posicao_manual_id);
      if (!posicaoManual) continue;
      elegiveis.set(posicaoManual.chave_manual, snapshot.valor_atual_centavos);
    }
  }

  return elegiveis;
}

/**
 * Consolida `valorAtualCentavos`/`valorInvestidoCentavos` de início e fim
 * para o cálculo de rendimento de um PERÍODO (duas sessões), garantindo que
 * as duas pontas somem exatamente o MESMO conjunto de chaves — nunca dois
 * conjuntos diferentes (o que fabricaria ganho/prejuízo falso ao subtrair
 * `fim - início`).
 *
 * Passos: (1) resolve as chaves elegíveis de cada sessão separadamente via
 * `chavesElegiveisDaSessao`; (2) monta a UNIÃO dessas chaves (uma chave pode
 * existir numa sessão e não na outra — ativo novo comprado ou vendido no
 * meio do período); (3) para cada chave da união, resolve
 * `valorInvestidoCentavos` em cada sessão onde ela está presente; (4) uma
 * chave só contribui para os totais de início E fim se tiver
 * `valorAtualCentavos` presente E `valorInvestidoCentavos` resolvível
 * (`resolverValorInvestido`) EM AMBAS as sessões — caso contrário, é
 * excluída dos DOIS totais, nunca só de um.
 *
 * IMPORTANTE — mudança de semântica em relação à antiga
 * `totalPatrimonioDaSessao`: os totais retornados NÃO são necessariamente o
 * patrimônio total absoluto de cada sessão. Quando alguma chave é excluída
 * por falta de dado numa das pontas, os totais refletem apenas o
 * SUBCONJUNTO de chaves rastreável nas DUAS pontas do período — é
 * intencional (única forma de uma subtração `fim - início` continuar
 * correta e não-enganosa quando o histórico é parcial, FR-010/FR-014).
 *
 * Se, depois do filtro, nenhuma chave sobrar com dado em ambas as pontas,
 * `valorInvestidoCentavos` de início/fim é `null` (não 0) — "sem histórico
 * suficiente" genuíno, mesmo padrão do resto do serviço.
 */
async function consolidadoDoPeriodo(
  sessaoInicioId: string,
  sessaoFimId: string,
): Promise<{
  inicio: { valorAtualCentavos: number; valorInvestidoCentavos: number | null };
  fim: { valorAtualCentavos: number; valorInvestidoCentavos: number | null };
}> {
  const [elegiveisInicio, elegiveisFim] = await Promise.all([
    chavesElegiveisDaSessao(sessaoInicioId),
    chavesElegiveisDaSessao(sessaoFimId),
  ]);

  const uniaoChaves = new Set<string>([...elegiveisInicio.keys(), ...elegiveisFim.keys()]);

  let valorAtualInicio = 0;
  let valorAtualFim = 0;
  let valorInvestidoInicio: number | null = 0;
  let valorInvestidoFim: number | null = 0;
  let algumaChaveContribuiu = false;

  for (const chaveExport of uniaoChaves) {
    const atualInicio = elegiveisInicio.get(chaveExport);
    const atualFim = elegiveisFim.get(chaveExport);

    // Presente em apenas uma ponta (ou ausente de ambas, impossível dado que
    // veio da união) — sem dado completo nas duas pontas, exclui dos DOIS
    // totais.
    if (atualInicio === undefined || atualFim === undefined) continue;

    const [resolvidoInicio, resolvidoFim] = await Promise.all([
      resolverValorInvestido(chaveExport, sessaoInicioId),
      resolverValorInvestido(chaveExport, sessaoFimId),
    ]);

    if (resolvidoInicio.valorInvestidoCentavos === null || resolvidoFim.valorInvestidoCentavos === null) {
      continue;
    }

    algumaChaveContribuiu = true;
    valorAtualInicio += atualInicio;
    valorAtualFim += atualFim;
    valorInvestidoInicio = (valorInvestidoInicio ?? 0) + resolvidoInicio.valorInvestidoCentavos;
    valorInvestidoFim = (valorInvestidoFim ?? 0) + resolvidoFim.valorInvestidoCentavos;
  }

  if (!algumaChaveContribuiu) {
    valorInvestidoInicio = null;
    valorInvestidoFim = null;
  }

  return {
    inicio: { valorAtualCentavos: valorAtualInicio, valorInvestidoCentavos: valorInvestidoInicio },
    fim: { valorAtualCentavos: valorAtualFim, valorInvestidoCentavos: valorInvestidoFim },
  };
}

/**
 * Dados da tela 6.10 (análise de rendimento) — nesta fatia (US1/P1), só o
 * rendimento consolidado do patrimônio total num período selecionado
 * (FR-001/FR-002/FR-005/FR-006). Nunca lança exceção por ausência de dados:
 * sem NENHUMA sessão VIGENTE, retorna `{vazio: true, ...}` (mesmo padrão de
 * `dashboard-service.dadosDashboard`); com sessões mas sem valor investido
 * rastreável em alguma delas, `consolidado.rendimentoCentavos` vem `null`
 * (FR-010) — a UI decide como exibir "sem histórico suficiente".
 *
 * Caso especial — apenas UMA sessão VIGENTE (`resolverPeriodo` resolve
 * `sessaoInicioId === sessaoFimId`): não há um segundo ponto no tempo para
 * calcular uma variação. `consolidado` é montado com `calcularRendimentoPonto`
 * dessa sessão isolada (não `calcularRendimentoPeriodo`, que sempre daria
 * delta 0 para dois pontos idênticos — um número incorreto e enganoso).
 * `semPeriodoAnteriorParaComparacao: true` sinaliza esse caso para a UI
 * (spec.md US1 Acceptance Scenario 2).
 */
export async function dadosRendimento(input: PeriodoInput): Promise<RendimentoOutput> {
  const [periodo, sessoesVigentes] = await Promise.all([
    resolverPeriodo(input),
    prisma.sessao_import.findMany({
      where: { status: "VIGENTE" },
      orderBy: { mes_referencia: "asc" },
      select: { id: true, mes_referencia: true, data_export: true },
    }),
  ]);

  const periodosDisponiveis: PeriodoDisponivel[] = sessoesVigentes.map((s) => ({
    sessaoImportId: s.id,
    mesReferencia: s.mes_referencia,
    dataExport: s.data_export.toISOString(),
  }));

  if (periodo.sessaoInicioId === null || periodo.sessaoFimId === null) {
    return {
      vazio: true,
      periodo,
      consolidado: {
        sessaoInicioId: "",
        sessaoFimId: "",
        rendimentoCentavos: null,
        rendimentoPct: null,
        pontoInicio: PONTO_SEM_DADO,
        pontoFim: PONTO_SEM_DADO,
      },
      periodosDisponiveis,
      semPeriodoAnteriorParaComparacao: false,
    };
  }

  // Só uma sessão VIGENTE disponível (`resolverPeriodo` já resolveu início =
  // fim): não existe segundo ponto para comparar. `calcularRendimentoPeriodo`
  // com início e fim idênticos sempre daria delta 0, mascarando o rendimento
  // real (positivo/negativo/indisponível) daquela sessão isolada — em vez
  // disso, calcula o rendimento do PONTO único e monta um `RendimentoPeriodo`
  // com pontoInicio/pontoFim ambos iguais a ele (spec.md US1 Acceptance
  // Scenario 2, Princípio V).
  if (periodo.sessaoInicioId === periodo.sessaoFimId) {
    const { inicio: dadosSessaoUnica } = await consolidadoDoPeriodo(
      periodo.sessaoInicioId,
      periodo.sessaoFimId,
    );

    const ponto = calcularRendimentoPonto(dadosSessaoUnica);

    const consolidado: RendimentoPeriodo = {
      sessaoInicioId: periodo.sessaoInicioId,
      sessaoFimId: periodo.sessaoFimId,
      rendimentoCentavos: ponto.rendimentoCentavos,
      rendimentoPct: ponto.rendimentoPct,
      pontoInicio: ponto,
      pontoFim: ponto,
    };

    return { vazio: false, periodo, consolidado, periodosDisponiveis, semPeriodoAnteriorParaComparacao: true };
  }

  const { inicio: dadosInicio, fim: dadosFim } = await consolidadoDoPeriodo(
    periodo.sessaoInicioId,
    periodo.sessaoFimId,
  );

  const consolidado = calcularRendimentoPeriodo({
    sessaoInicioId: periodo.sessaoInicioId,
    sessaoFimId: periodo.sessaoFimId,
    pontoInicio: dadosInicio,
    pontoFim: dadosFim,
  });

  return { vazio: false, periodo, consolidado, periodosDisponiveis, semPeriodoAnteriorParaComparacao: false };
}
