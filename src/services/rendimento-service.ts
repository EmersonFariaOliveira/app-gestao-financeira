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
 * contrato (contracts/server-actions.md), com `consolidado` (US1) e a
 * segmentação por bucket `reservaEmergencia`/`porTag`/`porAlvo`/
 * `foraDaCarteira` (US2, `calcularRendimentoPorBucket`). O campo `serie`
 * chega em task futura (US3), quando o shape completo for implementado.
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
  /** Rendimento de todas as chaves/posições manuais com `reserva_emergencia = true` (US2, FR-008). */
  reservaEmergencia: RendimentoPeriodo;
  /** Rendimento agrupado por `alvo.tag` (US2, FR-008) — só tags com pelo menos um alvo com chave elegível aparecem aqui. */
  porTag: RendimentoPorTag[];
  /** Rendimento de cada alvo individualmente (US2, FR-008/FR-009) — só alvos com pelo menos uma chave elegível aparecem aqui. */
  porAlvo: RendimentoPorAlvo[];
  /** Rendimento de CADA ativo/posição manual `fora_da_carteira = true`, um item por chave (US2, FR-009) — nunca agregado num único número. */
  foraDaCarteira: RendimentoAtivoForaDaCarteira[];
  /**
   * Rendimento de CADA ativo/posição manual pendente de vínculo (sem
   * `alvo_id`, `fora_da_carteira = false`, `reserva_emergencia = false`), um
   * item por chave — nunca agregado (FR-017: "exibidos à parte na análise de
   * rendimento, sem influenciar o rendimento de nenhum alvo/tag").
   *
   * Campo ausente do desenho original do contrato (`RendimentoOutput` não
   * previa "pendentes" nesta fatia) — adicionado durante a implementação
   * porque a metade "MUST ser exibidos à parte" de FR-017 e a soma exigida
   * por FR-014 (consolidado == reservaEmergencia + ΣporTag + Σ
   * foraDaCarteira + Σpendentes) não fecham sem ele: excluir pendentes de
   * TODOS os campos cumpre "sem influenciar alvo/tag" mas não "exibidos à
   * parte". Reaproveita o shape de `RendimentoAtivoForaDaCarteira`
   * (`{ chaveExport, rendimento }`) em vez de duplicar um tipo idêntico —
   * mesmo padrão "um item por chave, nunca agregado".
   */
  pendentes: RendimentoAtivoForaDaCarteira[];
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
 * Núcleo do algoritmo de matching por chave entre duas pontas de um período
 * (R5/R11) — usado tanto pelo consolidado (US1) quanto por CADA bucket (US2:
 * reserva de emergência, tag, alvo individual, ativo fora da carteira),
 * SEMPRE sobre um SUBCONJUNTO pré-filtrado de `chavesElegiveisDaSessao`
 * (nenhuma query de elegibilidade acontece aqui — só matching e resolução de
 * valor investido). Extraído de forma que "consolidado" e "por bucket"
 * nunca dupliquem esta lógica (mesma técnica, escopos de chave diferentes).
 *
 * Passos: (1) monta a UNIÃO das chaves dos dois mapas recebidos (uma chave
 * pode existir numa ponta e não na outra — ativo novo comprado ou vendido no
 * meio do período); (2) para cada chave da união, resolve
 * `valorInvestidoCentavos` em cada sessão onde ela está presente; (3) uma
 * chave só contribui para os totais de início E fim se tiver
 * `valorAtualCentavos` presente E `valorInvestidoCentavos` resolvível
 * (`resolverValorInvestido`) EM AMBAS as sessões — caso contrário, é
 * excluída dos DOIS totais, nunca só de um (nunca soma um total "cheio" de
 * um lado contra um "parcial" do outro).
 *
 * Se, depois do filtro, nenhuma chave sobrar com dado em ambas as pontas,
 * `valorInvestidoCentavos` de início/fim é `null` (não 0) — "sem histórico
 * suficiente" genuíno (FR-010), inclusive quando o subconjunto recebido já
 * vem vazio (bucket sem NENHUMA chave, ex.: nenhum ativo fora da carteira).
 */
async function consolidarSubconjunto(
  elegiveisInicio: Map<string, number>,
  elegiveisFim: Map<string, number>,
  sessaoInicioId: string,
  sessaoFimId: string,
): Promise<{
  inicio: { valorAtualCentavos: number; valorInvestidoCentavos: number | null };
  fim: { valorAtualCentavos: number; valorInvestidoCentavos: number | null };
}> {
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
 * Consolida `valorAtualCentavos`/`valorInvestidoCentavos` de início e fim
 * para o cálculo de rendimento de um PERÍODO (duas sessões), garantindo que
 * as duas pontas somem exatamente o MESMO conjunto de chaves — nunca dois
 * conjuntos diferentes (o que fabricaria ganho/prejuízo falso ao subtrair
 * `fim - início`). Resolve as chaves elegíveis de cada sessão via
 * `chavesElegiveisDaSessao` e delega o matching a `consolidarSubconjunto`
 * (sem nenhum filtro adicional — é o universo COMPLETO de chaves elegíveis,
 * usado pelo consolidado/patrimônio total, US1).
 *
 * IMPORTANTE — mudança de semântica em relação à antiga
 * `totalPatrimonioDaSessao`: os totais retornados NÃO são necessariamente o
 * patrimônio total absoluto de cada sessão. Quando alguma chave é excluída
 * por falta de dado numa das pontas, os totais refletem apenas o
 * SUBCONJUNTO de chaves rastreável nas DUAS pontas do período — é
 * intencional (única forma de uma subtração `fim - início` continuar
 * correta e não-enganosa quando o histórico é parcial, FR-010/FR-014).
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

  return consolidarSubconjunto(elegiveisInicio, elegiveisFim, sessaoInicioId, sessaoFimId);
}

/**
 * Monta um `RendimentoPeriodo` completo a partir de um SUBCONJUNTO de chaves
 * elegíveis de início/fim (`consolidarSubconjunto`), aplicando o mesmo
 * tratamento de "sessão única" já usado por `consolidado` (US1) a QUALQUER
 * bucket (US2): quando `sessaoInicioId === sessaoFimId`, não existe um
 * segundo ponto no tempo para subtrair — `calcularRendimentoPeriodo` sempre
 * daria delta `0` para dois pontos idênticos, um número incorreto e
 * enganoso (Princípio V). Nesse caso o resultado reflete o rendimento do
 * PONTO único (`calcularRendimentoPonto`), com `pontoInicio`/`pontoFim`
 * ambos iguais a ele — mesmo padrão de `dadosRendimento` (US1 Acceptance
 * Scenario 2), agora reutilizável por `reservaEmergencia`/`porTag`/`porAlvo`/
 * `foraDaCarteira` sem duplicar a lógica.
 */
async function calcularRendimentoPeriodoDeChaves(
  elegiveisInicio: Map<string, number>,
  elegiveisFim: Map<string, number>,
  sessaoInicioId: string,
  sessaoFimId: string,
): Promise<RendimentoPeriodo> {
  const { inicio, fim } = await consolidarSubconjunto(
    elegiveisInicio,
    elegiveisFim,
    sessaoInicioId,
    sessaoFimId,
  );

  if (sessaoInicioId === sessaoFimId) {
    const ponto = calcularRendimentoPonto(inicio);
    return {
      sessaoInicioId,
      sessaoFimId,
      rendimentoCentavos: ponto.rendimentoCentavos,
      rendimentoPct: ponto.rendimentoPct,
      pontoInicio: ponto,
      pontoFim: ponto,
    };
  }

  return calcularRendimentoPeriodo({
    sessaoInicioId,
    sessaoFimId,
    pontoInicio: inicio,
    pontoFim: fim,
  });
}

/**
 * `chave_export`/`chave_manual` -> bucket de classificação (US2), MESMA
 * ordem de prioridade já estabelecida por
 * `dashboard-service.classificarPosicoesDaSessao` (reaproveitada, não
 * reinventada): `fora_da_carteira` > `reserva_emergencia` > `alvo_id` >
 * pendente. `ignorar_no_import` NUNCA aparece aqui — já foi excluído
 * upstream por `chavesElegiveisDaSessao` (as chaves recebidas em `chaves`
 * já são só as elegíveis). Chaves sem NENHUM `ativo_mapeado`/`posicao_manual`
 * (defensivo, não deveria acontecer em dado consistente) caem em `pendente`.
 */
type ClassificacaoBucket =
  | { tipo: "fora" }
  | { tipo: "reserva" }
  | { tipo: "alvo"; alvoId: string }
  | { tipo: "pendente" };

async function classificarChavesPorBucket(chaves: string[]): Promise<Map<string, ClassificacaoBucket>> {
  const classificacao = new Map<string, ClassificacaoBucket>();
  if (chaves.length === 0) return classificacao;

  const mapeamentos = await prisma.ativo_mapeado.findMany({
    where: { chave_export: { in: chaves } },
    select: { chave_export: true, alvo_id: true, fora_da_carteira: true, reserva_emergencia: true },
  });
  for (const m of mapeamentos) {
    if (m.fora_da_carteira) classificacao.set(m.chave_export, { tipo: "fora" });
    else if (m.reserva_emergencia) classificacao.set(m.chave_export, { tipo: "reserva" });
    else if (m.alvo_id !== null) classificacao.set(m.chave_export, { tipo: "alvo", alvoId: m.alvo_id });
    else classificacao.set(m.chave_export, { tipo: "pendente" });
  }

  const posicoesManuais = await prisma.posicao_manual.findMany({
    where: { chave_manual: { in: chaves } },
    select: { chave_manual: true, alvo_id: true, fora_da_carteira: true, reserva_emergencia: true },
  });
  for (const p of posicoesManuais) {
    if (p.fora_da_carteira) classificacao.set(p.chave_manual, { tipo: "fora" });
    else if (p.reserva_emergencia) classificacao.set(p.chave_manual, { tipo: "reserva" });
    else if (p.alvo_id !== null) classificacao.set(p.chave_manual, { tipo: "alvo", alvoId: p.alvo_id });
    else classificacao.set(p.chave_manual, { tipo: "pendente" });
  }

  for (const chave of chaves) {
    if (!classificacao.has(chave)) classificacao.set(chave, { tipo: "pendente" });
  }

  return classificacao;
}

/** Filtra um `Map<chave, valorCentavos>` para as chaves presentes em `chaves`. */
function filtrarMapaPorChaves(mapa: Map<string, number>, chaves: Iterable<string>): Map<string, number> {
  const conjunto = chaves instanceof Set ? chaves : new Set(chaves);
  const resultado = new Map<string, number>();
  for (const [chave, valor] of mapa) {
    if (conjunto.has(chave)) resultado.set(chave, valor);
  }
  return resultado;
}

/** Rendimento por tag (agrupa todos os alvos com a mesma `alvo.tag`), contrato `server-actions.md`. */
export interface RendimentoPorTag {
  tag: string;
  rendimento: RendimentoPeriodo;
}

/** Rendimento por alvo individual, contrato `server-actions.md`. */
export interface RendimentoPorAlvo {
  alvoId: string;
  nomeAlvo: string;
  tag: string | null;
  rendimento: RendimentoPeriodo;
}

/** Rendimento de UM ativo fora da carteira (nunca agregado), contrato `server-actions.md`. */
export interface RendimentoAtivoForaDaCarteira {
  chaveExport: string;
  rendimento: RendimentoPeriodo;
}

/** Resultado de `calcularRendimentoPorBucket` — os 5 campos de segmentação de `RendimentoOutput` (US2 + pendentes FR-017/FR-014). */
export interface RendimentoPorBucket {
  reservaEmergencia: RendimentoPeriodo;
  porTag: RendimentoPorTag[];
  porAlvo: RendimentoPorAlvo[];
  foraDaCarteira: RendimentoAtivoForaDaCarteira[];
  /** Ver `RendimentoOutput.pendentes` — mesma semântica, um item por chave pendente, nunca agregado. */
  pendentes: RendimentoAtivoForaDaCarteira[];
}

/**
 * Segmentação do rendimento consolidado por bucket (US2, FR-008/FR-009):
 * reserva de emergência, cada tag, cada alvo individual dentro de uma tag, e
 * cada ativo marcado como fora da carteira. Reaproveita EXATAMENTE a mesma
 * técnica de matching por chave de `consolidadoDoPeriodo`
 * (`consolidarSubconjunto`/`calcularRendimentoPeriodoDeChaves`), aplicada a
 * um SUBCONJUNTO pré-filtrado de chaves elegíveis por bucket — nunca duplica
 * a lógica de "nunca somar total cheio de um lado contra parcial do outro".
 *
 * Ativos pendentes de vínculo (sem `alvo_id`/`fora_da_carteira`/
 * `reserva_emergencia`, FR-017) não entram em NENHUM bucket de
 * `reservaEmergencia`/`porTag`/`porAlvo`/`foraDaCarteira` (não influenciam o
 * rendimento de nenhum alvo/tag) — mas aparecem individualmente em
 * `pendentes`, um item por chave, nunca agregado (FR-017 "exibidos à parte";
 * FR-014 exige que a soma de todos os buckets, incluindo `pendentes`, bata
 * com o consolidado).
 *
 * Quando um bucket inteiro não tem NENHUMA chave (ex.: nenhum ativo fora da
 * carteira) ou nenhuma chave com dado completo nas duas pontas do período, o
 * `rendimento` daquele bucket vem com `rendimentoCentavos: null` (FR-010,
 * "sem histórico suficiente" — nunca 0).
 */
export async function calcularRendimentoPorBucket(
  sessaoInicioId: string,
  sessaoFimId: string,
): Promise<RendimentoPorBucket> {
  const [elegiveisInicio, elegiveisFim] = await Promise.all([
    chavesElegiveisDaSessao(sessaoInicioId),
    chavesElegiveisDaSessao(sessaoFimId),
  ]);

  const uniaoChaves = Array.from(new Set<string>([...elegiveisInicio.keys(), ...elegiveisFim.keys()]));
  const classificacao = await classificarChavesPorBucket(uniaoChaves);

  const chavesReserva = new Set<string>();
  const chavesFora: string[] = [];
  const chavesPendentes: string[] = [];
  const chavesPorAlvoId = new Map<string, Set<string>>();

  for (const chave of uniaoChaves) {
    const c = classificacao.get(chave);
    if (!c) continue;
    if (c.tipo === "reserva") {
      chavesReserva.add(chave);
    } else if (c.tipo === "fora") {
      chavesFora.push(chave);
    } else if (c.tipo === "alvo") {
      if (!chavesPorAlvoId.has(c.alvoId)) chavesPorAlvoId.set(c.alvoId, new Set());
      chavesPorAlvoId.get(c.alvoId)!.add(chave);
    } else {
      // "pendente" (FR-017): fora do escopo de reservaEmergencia/porTag/
      // porAlvo/foraDaCarteira — mas exposta individualmente em `pendentes`
      // (FR-017 "exibidos à parte", FR-014 soma dos buckets == consolidado).
      chavesPendentes.push(chave);
    }
  }

  const reservaEmergencia = await calcularRendimentoPeriodoDeChaves(
    filtrarMapaPorChaves(elegiveisInicio, chavesReserva),
    filtrarMapaPorChaves(elegiveisFim, chavesReserva),
    sessaoInicioId,
    sessaoFimId,
  );

  const foraDaCarteira: RendimentoAtivoForaDaCarteira[] = [];
  for (const chaveExport of chavesFora) {
    const rendimento = await calcularRendimentoPeriodoDeChaves(
      filtrarMapaPorChaves(elegiveisInicio, [chaveExport]),
      filtrarMapaPorChaves(elegiveisFim, [chaveExport]),
      sessaoInicioId,
      sessaoFimId,
    );
    foraDaCarteira.push({ chaveExport, rendimento });
  }

  const pendentes: RendimentoAtivoForaDaCarteira[] = [];
  for (const chaveExport of chavesPendentes) {
    const rendimento = await calcularRendimentoPeriodoDeChaves(
      filtrarMapaPorChaves(elegiveisInicio, [chaveExport]),
      filtrarMapaPorChaves(elegiveisFim, [chaveExport]),
      sessaoInicioId,
      sessaoFimId,
    );
    pendentes.push({ chaveExport, rendimento });
  }

  const alvoIds = Array.from(chavesPorAlvoId.keys());
  const alvos =
    alvoIds.length > 0
      ? await prisma.alvo.findMany({
          where: { id: { in: alvoIds } },
          select: { id: true, nome: true, tag: true },
        })
      : [];
  const alvoPorId = new Map(alvos.map((a) => [a.id, a]));

  const porAlvo: RendimentoPorAlvo[] = [];
  const chavesPorTag = new Map<string, Set<string>>();

  for (const alvoId of alvoIds) {
    const alvo = alvoPorId.get(alvoId);
    // Defensivo: alvo referenciado por ativo_mapeado/posicao_manual mas não
    // encontrado (não deveria acontecer em dado consistente) — mantém a
    // chave visível em vez de descartar o bucket silenciosamente.
    const nomeAlvo = alvo?.nome ?? alvoId;
    const tag = alvo?.tag ?? null;
    const chavesDoAlvo = chavesPorAlvoId.get(alvoId)!;

    const rendimento = await calcularRendimentoPeriodoDeChaves(
      filtrarMapaPorChaves(elegiveisInicio, chavesDoAlvo),
      filtrarMapaPorChaves(elegiveisFim, chavesDoAlvo),
      sessaoInicioId,
      sessaoFimId,
    );
    porAlvo.push({ alvoId, nomeAlvo, tag, rendimento });

    if (tag !== null) {
      if (!chavesPorTag.has(tag)) chavesPorTag.set(tag, new Set());
      for (const chave of chavesDoAlvo) chavesPorTag.get(tag)!.add(chave);
    }
  }

  const porTag: RendimentoPorTag[] = [];
  for (const [tag, chaves] of chavesPorTag) {
    const rendimento = await calcularRendimentoPeriodoDeChaves(
      filtrarMapaPorChaves(elegiveisInicio, chaves),
      filtrarMapaPorChaves(elegiveisFim, chaves),
      sessaoInicioId,
      sessaoFimId,
    );
    porTag.push({ tag, rendimento });
  }

  return { reservaEmergencia, porTag, porAlvo, foraDaCarteira, pendentes };
}

/** `RendimentoPeriodo` "vazio" (sem sessões concretas) — mesmo padrão de `PONTO_SEM_DADO`, reutilizado por `consolidado`/`reservaEmergencia` quando não há NENHUMA sessão VIGENTE. */
const RENDIMENTO_PERIODO_SEM_DADO: RendimentoPeriodo = {
  sessaoInicioId: "",
  sessaoFimId: "",
  rendimentoCentavos: null,
  rendimentoPct: null,
  pontoInicio: PONTO_SEM_DADO,
  pontoFim: PONTO_SEM_DADO,
};

/**
 * Dados da tela 6.10 (análise de rendimento): rendimento consolidado do
 * patrimônio total (US1, FR-001/FR-002/FR-005/FR-006) e a segmentação por
 * bucket — reserva de emergência, tag, alvo individual e ativos fora da
 * carteira (US2, FR-008/FR-009, `calcularRendimentoPorBucket`) — num período
 * selecionado. Nunca lança exceção por ausência de dados: sem NENHUMA sessão
 * VIGENTE, retorna `{vazio: true, ...}` (mesmo padrão de
 * `dashboard-service.dadosDashboard`); com sessões mas sem valor investido
 * rastreável em alguma delas (ou em algum bucket), o respectivo
 * `rendimentoCentavos` vem `null` (FR-010) — a UI decide como exibir "sem
 * histórico suficiente".
 *
 * Caso especial — apenas UMA sessão VIGENTE (`resolverPeriodo` resolve
 * `sessaoInicioId === sessaoFimId`): não há um segundo ponto no tempo para
 * calcular uma variação, em NENHUM dos campos (consolidado ou buckets) —
 * `calcularRendimentoPeriodoDeChaves` já trata esse caso genericamente
 * (calcula o rendimento do PONTO único em vez de um delta 0 enganoso,
 * Princípio V). `semPeriodoAnteriorParaComparacao: true` sinaliza esse caso
 * para a UI (spec.md US1 Acceptance Scenario 2).
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
      consolidado: RENDIMENTO_PERIODO_SEM_DADO,
      reservaEmergencia: RENDIMENTO_PERIODO_SEM_DADO,
      porTag: [],
      porAlvo: [],
      foraDaCarteira: [],
      pendentes: [],
      periodosDisponiveis,
      semPeriodoAnteriorParaComparacao: false,
    };
  }

  const [elegiveisInicio, elegiveisFim, buckets] = await Promise.all([
    chavesElegiveisDaSessao(periodo.sessaoInicioId),
    chavesElegiveisDaSessao(periodo.sessaoFimId),
    calcularRendimentoPorBucket(periodo.sessaoInicioId, periodo.sessaoFimId),
  ]);

  const consolidado = await calcularRendimentoPeriodoDeChaves(
    elegiveisInicio,
    elegiveisFim,
    periodo.sessaoInicioId,
    periodo.sessaoFimId,
  );

  return {
    vazio: false,
    periodo,
    consolidado,
    ...buckets,
    periodosDisponiveis,
    // Só uma sessão VIGENTE disponível (resolverPeriodo já resolveu início =
    // fim): sinaliza para a UI que não há período anterior de comparação
    // (spec.md US1 Acceptance Scenario 2).
    semPeriodoAnteriorParaComparacao: periodo.sessaoInicioId === periodo.sessaoFimId,
  };
}
