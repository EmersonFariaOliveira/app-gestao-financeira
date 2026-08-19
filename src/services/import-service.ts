import { prisma } from "@/db/client";
import { parseArquivoMyCapital } from "@/parser/mycapital";
import type { ArquivoImport, ArquivoParseado, ErroParse } from "@/parser/types";
import { executarBackupComRetencao } from "@/services/backup-service";
import {
  marcarPendenciasComoAplicadas,
  montarIncrementosAmbiguosPendentes,
  montarRevisaoImport,
  type AjusteRevisaoItem,
  type IncrementoAmbiguoPendenteItem,
  type PosicaoManualRevisaoItem,
} from "@/services/posicao-manual-service";
import {
  calcularMovimentacaoNaoExplicada,
  contarAtivosComValorInvestidoRastreavel,
  type MovimentacaoNaoExplicada,
} from "@/services/rendimento-service";

// Serviço de import mensal (T036): orquestra o parse em memória (preview,
// sem persistir nada) e a confirmação (backup + transação Prisma) de uma
// sessão de import (data-model.md `sessao_import`/`posicao`). Camada de
// I/O — pode importar Prisma/parser livremente; não é importada por
// src/core/** (ver eslint.config.mjs).
//
// Regra inviolável (data-model.md, seção "Regras de integridade
// transversais" e docs/app-gestao-aportes.md seção 4): nenhuma sessão ou
// posição anterior é deletada ou tem UPDATE de conteúdo — só a transição de
// `status` de VIGENTE para SUBSTITUIDO. Erro de parse em qualquer arquivo
// (preview ou confirmação) invalida a operação inteira: nada persiste.

/** Resumo por instituição exibido no preview (contracts/server-actions.md). */
export interface PreviewInstituicaoResumo {
  instituicao: string;
  totalCentavos: number;
  qtdAtivos: number;
  dataMaisRecente: string | null;
}

export interface AvisoSubstituicao {
  /** `mes_referencia` proposto/informado para este import. */
  mes: string;
  /** `data_export` (ISO) da sessão VIGENTE que será substituída. */
  dataAnterior: string;
}

export interface VariacaoGrande {
  chaveExport: string;
  valorAnteriorCentavos: number;
  valorNovoCentavos: number;
  /** Sinalizada: positiva = aumentou, negativa = diminuiu. */
  variacaoPercentual: number;
}

/**
 * Diff de posições consolidadas por `chave_export` desta sessão contra uma
 * sessão de referência (decisão de design, ver `resolverSessaoParaDiff`).
 */
export interface DiffPosicoes {
  /** Chaves que não existiam na sessão de referência. */
  novos: string[];
  /** Chaves que existiam na sessão de referência e não vieram neste import. */
  sumiram: string[];
  variacoesGrandes: VariacaoGrande[];
}

/**
 * Incrementos ambíguos por alvo (T026) — alias do tipo produzido por
 * `posicao-manual-service.montarIncrementosAmbiguosPendentes`. Mantido como
 * um tipo próprio deste módulo (em vez de reexportar o tipo importado
 * diretamente) para preservar o nome já usado por `PreviewImportResultado`
 * desde a fase anterior (placeholder), sem quebrar quem já depende dele.
 */
export type IncrementoAmbiguoPendente = IncrementoAmbiguoPendenteItem;

/**
 * Item de avaliação "ao vivo" de movimentação não explicada (ver
 * `PreviewImportResultado.avaliacoesMovimentacaoAoVivo`) — dados brutos
 * suficientes para o client (`import/page.tsx`) recalcular
 * `avaliarMovimentacaoNaoExplicada` a cada edição dos campos de ajuste, sem
 * round-trip ao servidor.
 */
export interface AvaliacaoMovimentacaoAoVivo {
  alvoId: string;
  nomeAlvo: string;
  granularidade: "ativo" | "alvo";
  chaveExport?: string;
  posicaoManualId?: string;
  valorInvestidoEsperadoCentavos: number;
  houveBaseComparacao: boolean;
  /** Soma de `consolidadoPorChave` para as chaves do alvo SEM ajuste pendente (parte fixa do valor real). */
  valorRealBaseCentavos: number;
  /** Uma entrada por chave do alvo COM ajuste pendente — `valorCsvCentavos` é o fallback bruto do CSV quando o campo de ajuste ficar vazio. */
  ajustesDoAlvo: { chaveExport: string; valorCsvCentavos: number | null }[];
}

export type PreviewImportResultado =
  | {
      ok: true;
      arquivos: PreviewInstituicaoResumo[];
      mesReferenciaProposto: string;
      dataExport: string;
      avisoSubstituicao?: AvisoSubstituicao;
      instituicoesFaltantes?: string[];
      diff?: DiffPosicoes;
      /** Carry-forward de posições manuais para a revisão dentro do import (contracts/server-actions.md §import.ts, US3). */
      posicoesManuaisRevisao: PosicaoManualRevisaoItem[];
      /** Carry-forward de ajustes de valor investido para a revisão dentro do import (idem). */
      ajustesRevisao: AjusteRevisaoItem[];
      /** Pendências ambíguas de alvo agregadas (T026, motor-integracao.md §4.2). */
      incrementosAmbiguosPendentes: IncrementoAmbiguoPendente[];
      /**
       * NOVO (feature 003, US4, FR-011/FR-011a/FR-018). Comparação, POR ALVO,
       * entre o valor investido esperado (sessão VIGENTE anterior + aportes
       * registrados no app desde então, research.md R7) e o valor investido
       * REAL que este preview traria — só para diferenças que excedem FR-018
       * (5% E R$20,00 simultaneamente, research.md R8). Array vazio = nada a
       * sinalizar. Puramente informativo (research.md R13) — NUNCA bloqueia
       * `previewImport` nem `confirmarImport`.
       */
      movimentacoesNaoExplicadas: MovimentacaoNaoExplicada[];
      /**
       * NOVO (correção do falso positivo de fundos com ajuste manual
       * recorrente): alvos cuja avaliação de "movimentação não explicada"
       * NÃO pode ser resolvida estaticamente aqui porque ao menos uma das
       * chaves elegíveis do alvo tem edição pendente em `ajustesRevisao`
       * nesta revisão do import — o valor real depende do que o usuário
       * ainda vai digitar no campo de ajuste. O client recalcula a MESMA
       * regra (`avaliarMovimentacaoNaoExplicada`,
       * `src/core/rendimento/movimentacao-nao-explicada.ts`) reativamente,
       * combinando `valorRealBaseCentavos` com o texto atual dos campos de
       * ajuste (`ajustesDoAlvo`). Alvos sem nenhum ajuste pendente continuam
       * cobertos por `movimentacoesNaoExplicadas` (cálculo estático, como
       * antes).
       */
      avaliacoesMovimentacaoAoVivo: AvaliacaoMovimentacaoAoVivo[];
    }
  | { ok: false; erros: ErroParse[] };

export interface ConfirmarImportInput {
  arquivos: ArquivoImport[];
  /** `mes_referencia` (`YYYY-MM`) — respeita edição manual feita no preview (research.md R9). */
  mesReferencia: string;
  /** Exigido explicitamente (`=== true`) quando há instituição faltante vs. a sessão anterior (seção 6.2). */
  confirmouInstituicoesFaltantes?: boolean;
  /**
   * Snapshots de posição manual confirmados na revisão (US3, contracts/server-actions.md
   * §import.ts). Opcional — ausente/vazio é compatível com imports sem nenhuma posição
   * manual cadastrada ainda (cenário comum, sem quebra).
   */
  posicoesManuaisConfirmadas?: {
    posicaoManualId: string;
    valorInvestidoCentavos: number;
    valorAtualCentavos: number;
  }[];
  /**
   * Ajustes de valor investido confirmados na revisão (US3, idem). Uma chave ausente aqui =
   * usuário deixou vazio — nenhum `ajuste_valor_investido` é criado para ela nesta sessão
   * (aviso, não bloqueio — FR-009).
   */
  ajustesConfirmados?: {
    chaveExport: string;
    valorInvestidoCentavosCorrigido: number;
  }[];
}

export type ConfirmarImportResultado =
  | {
      ok: true;
      sessaoId: string;
      pendenciasVinculo: string[];
      /**
       * Sempre `0` — server-actions.md §import.ts documenta este campo como
       * "cosmético", calculado no CLIENT a partir de
       * `distribuicoesIncrementosAmbiguos` vs. `incrementosAmbiguosPendentes`
       * do preview (não persiste, não afeta a confirmação). O servidor não
       * tem como calcular esse resíduo — `distribuicoesIncrementosAmbiguos`
       * é só uma anotação da UI, não uma fonte de verdade de alocação
       * (research.md R5).
       */
      incrementosAmbiguosNaoAlocadosCentavos: number;
    }
  | { ok: false; erro: string; erros?: ErroParse[]; instituicoesFaltantes?: string[] };

/**
 * Limiar de "variação grande" no diff (regra intencionalmente deixada em
 * aberto pela spec — "ex. 20%"): variação relativa >= 20% em módulo, para
 * chaves presentes em ambas as sessões. Documentado aqui como a única fonte
 * da verdade deste número; se um dia virar configurável, este é o ponto de
 * extensão.
 */
const LIMIAR_VARIACAO_GRANDE_PCT = 20;

/** Formato exato do parser: ISO date/datetime — comparável lexicograficamente. */
function derivarDataExportISO(arquivos: ArquivoParseado[]): string {
  let maxData: string | null = null;
  for (const arquivo of arquivos) {
    if (arquivo.dataMaisRecente === null) continue;
    if (maxData === null || arquivo.dataMaisRecente > maxData) {
      maxData = arquivo.dataMaisRecente;
    }
  }
  // Nenhuma linha de nenhum arquivo trouxe dataUltimaCotacao (ex.: import só
  // com EXTERIOR/Avenue, onde a data vem "null" literal em todas as linhas):
  // não há como derivar a data das posições a partir do CSV. Decisão de
  // design: cair para "agora" (o usuário ainda pode editar mesReferencia no
  // preview antes de confirmar — R9). Alternativa rejeitada: lançar erro,
  // que bloquearia um cenário legítimo (import só de instituição EXTERIOR).
  return maxData ?? new Date().toISOString();
}

function derivarMesReferencia(dataExportISO: string): string {
  return dataExportISO.slice(0, 7);
}

/** Soma `patrimonioHojeCentavos`/`patrimonio_hoje_centavos` por `chave_export` (consolidação em leitura — data-model.md). */
function consolidarPorChave(
  linhas: { chaveExport: string; valorCentavos: number }[],
): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const linha of linhas) {
    mapa.set(linha.chaveExport, (mapa.get(linha.chaveExport) ?? 0) + linha.valorCentavos);
  }
  return mapa;
}

function calcularDiff(
  novoConsolidado: Map<string, number>,
  anteriorConsolidado: Map<string, number>,
): DiffPosicoes {
  const novos: string[] = [];
  const sumiram: string[] = [];
  const variacoesGrandes: VariacaoGrande[] = [];

  for (const chave of novoConsolidado.keys()) {
    if (!anteriorConsolidado.has(chave)) novos.push(chave);
  }
  for (const chave of anteriorConsolidado.keys()) {
    if (!novoConsolidado.has(chave)) sumiram.push(chave);
  }
  for (const [chave, valorNovoCentavos] of novoConsolidado) {
    const valorAnteriorCentavos = anteriorConsolidado.get(chave);
    // Ausente em um dos lados já virou novos/sumiram acima; valor anterior
    // zero tornaria a variação percentual indefinida/infinita — sem sinal
    // útil, então não entra em variacoesGrandes (não é um "sumiu" nem um
    // "novo", mas também não há base para medir variação relativa).
    if (valorAnteriorCentavos === undefined || valorAnteriorCentavos === 0) continue;

    const variacaoPercentual =
      ((valorNovoCentavos - valorAnteriorCentavos) / valorAnteriorCentavos) * 100;
    if (Math.abs(variacaoPercentual) >= LIMIAR_VARIACAO_GRANDE_PCT) {
      variacoesGrandes.push({
        chaveExport: chave,
        valorAnteriorCentavos,
        valorNovoCentavos,
        variacaoPercentual,
      });
    }
  }

  return { novos, sumiram, variacoesGrandes };
}

/** Parseia todos os arquivos; falha alto: qualquer erro em qualquer arquivo invalida a operação inteira. */
function parseTodos(
  arquivos: ArquivoImport[],
): { ok: true; arquivos: ArquivoParseado[] } | { ok: false; erros: ErroParse[] } {
  const resultados = arquivos.map((arquivo) => parseArquivoMyCapital(arquivo));
  const erros: ErroParse[] = [];
  for (const resultado of resultados) {
    if (!resultado.ok) erros.push(...resultado.erros);
  }
  if (erros.length > 0) return { ok: false, erros };

  const arquivosParseados = resultados.map((r) => (r as { ok: true; arquivo: ArquivoParseado }).arquivo);
  return { ok: true, arquivos: arquivosParseados };
}

/** Sessão VIGENTE mais recente entre TODOS os meses (mesma noção usada em aporte-service). */
async function obterSessaoVigenteMaisRecente() {
  return prisma.sessao_import.findFirst({
    where: { status: "VIGENTE" },
    orderBy: [{ data_export: "desc" }, { criado_em: "desc" }],
  });
}

/** Sessão VIGENTE do `mes_referencia` informado, se houver (no máximo uma — invariante de aplicação). */
async function obterSessaoVigenteDoMes(mesReferencia: string) {
  return prisma.sessao_import.findFirst({
    where: { mes_referencia: mesReferencia, status: "VIGENTE" },
  });
}

/** Instituições ausentes neste import em relação a uma sessão de referência (JSON `instituicoes`). */
function calcularInstituicoesFaltantes(
  instituicoesAtuais: string[],
  sessaoReferencia: { instituicoes: string } | null,
): string[] {
  if (!sessaoReferencia) return [];
  const instituicoesAnteriores: string[] = JSON.parse(sessaoReferencia.instituicoes);
  return instituicoesAnteriores.filter((i) => !instituicoesAtuais.includes(i));
}

/**
 * Chaves pendentes de vínculo (data-model.md: `alvo_id = null AND
 * fora_da_carteira = false AND reserva_emergencia = false AND
 * ignorar_no_import = false`, ou sem registro algum). `reserva_emergencia =
 * true` e `ignorar_no_import = true` são estados RESOLVIDOS — não contam
 * como pendência nem bloqueiam a calculadora (`ignorar_no_import` é checado
 * com a MESMA prioridade de `mapeamento-service.listarVinculos`, antes de
 * fora_da_carteira/reserva_emergencia/alvo_id; cópia intencional de
 * aporte-service.listarPendenciasDaSessao — ver nota lá sobre manter os dois
 * locais idênticos).
 */
async function listarPendenciasDaSessao(sessaoId: string): Promise<string[]> {
  const posicoes = await prisma.posicao.findMany({
    where: { sessao_import_id: sessaoId },
    select: { chave_export: true },
    distinct: ["chave_export"],
  });
  const chaves = posicoes.map((p) => p.chave_export);
  if (chaves.length === 0) return [];

  const mapeamentos = await prisma.ativo_mapeado.findMany({
    where: { chave_export: { in: chaves } },
  });
  const mapaPorChave = new Map(mapeamentos.map((m) => [m.chave_export, m]));

  return chaves.filter((chave) => {
    const mapeamento = mapaPorChave.get(chave);
    return (
      !mapeamento ||
      (!mapeamento.ignorar_no_import &&
        mapeamento.alvo_id === null &&
        !mapeamento.fora_da_carteira &&
        !mapeamento.reserva_emergencia)
    );
  });
}

/**
 * Consolida `patrimonioAplicadoCentavos` por `chave_export`, entre todos os
 * arquivos deste preview — mesma técnica de `consolidarPorChave`
 * (`patrimonio_hoje_centavos`), mas preservando `null` quando QUALQUER linha
 * daquela chave não trouxe valor (coluna ausente/inválida naquela linha,
 * research.md R2 da feature 003) — nunca soma parcial disfarçada de
 * completa (mesma regra já usada por `resolverValorInvestido`, feature 003
 * US1).
 */
function consolidarPatrimonioAplicadoPorChave(
  arquivosParseados: ArquivoParseado[],
): Map<string, number | null> {
  const mapa = new Map<string, number | null>();
  for (const arquivo of arquivosParseados) {
    for (const linha of arquivo.linhas) {
      const atual = mapa.get(linha.chaveExport);
      if (atual === null) continue; // já marcada como sem dado por outra linha da mesma chave
      if (linha.patrimonioAplicadoCentavos === null) {
        mapa.set(linha.chaveExport, null);
      } else {
        mapa.set(linha.chaveExport, (atual ?? 0) + linha.patrimonioAplicadoCentavos);
      }
    }
  }
  return mapa;
}

/**
 * Calcula, a partir dos dados parseados em memória (ANTES de qualquer
 * persistência) e da sessão VIGENTE mais recente (mesma referência de
 * "sessão anterior" já usada por `instituicoesFaltantes`/`diff`), a divisão
 * entre:
 * - `movimentacoesNaoExplicadas` (US4, FR-011/FR-011a/FR-018, research.md
 *   R6/R7/R13): avaliação ESTÁTICA, resolvida por completo aqui no
 *   servidor, para alvos cujas chaves elegíveis NÃO têm nenhuma edição
 *   pendente em `ajustesRevisao` nesta revisão do import.
 * - `avaliacoesMovimentacaoAoVivo`: alvos com ao menos uma chave elegível em
 *   `chavesComAjustePendente` — o valor real depende do que o usuário ainda
 *   vai digitar no campo de ajuste (que só é persistido na confirmação), e
 *   por isso a decisão de exceder tolerância é adiada para o client
 *   recalcular reativamente (correção do falso positivo de fundos com
 *   ajuste manual recorrente: o valor bruto do CSV usado aqui no preview
 *   estático não reflete a correção que o usuário sempre aplica).
 *
 * Escopo desta fatia (decisão documentada em tasks.md): só valida alvos
 * cuja elegibilidade COMPLETA (`contarAtivosComValorInvestidoRastreavel`,
 * R6) é formada exclusivamente por `chave_export` presentes NESTE import com
 * valor real disponível. Um alvo com QUALQUER `posicao_manual` elegível, ou
 * com um `chave_export` elegível ausente/sem valor neste import específico,
 * é pulado (nunca um falso alarme construído sobre dado incompleto) — o
 * valor investido de posição manual só é conhecido depois da revisão da
 * tela de import (ainda não confirmada neste momento do preview).
 */
async function calcularMovimentacoesNaoExplicadasDoPreview(
  arquivosParseados: ArquivoParseado[],
  sessaoAnteriorId: string | null,
  chavesComAjustePendente: Set<string>,
): Promise<{
  movimentacoesNaoExplicadas: MovimentacaoNaoExplicada[];
  avaliacoesMovimentacaoAoVivo: AvaliacaoMovimentacaoAoVivo[];
}> {
  if (!sessaoAnteriorId) return { movimentacoesNaoExplicadas: [], avaliacoesMovimentacaoAoVivo: [] };

  const consolidadoPorChave = consolidarPatrimonioAplicadoPorChave(arquivosParseados);
  const chaves = Array.from(consolidadoPorChave.keys());
  if (chaves.length === 0) return { movimentacoesNaoExplicadas: [], avaliacoesMovimentacaoAoVivo: [] };

  const mapeamentos = await prisma.ativo_mapeado.findMany({
    where: {
      chave_export: { in: chaves },
      alvo_id: { not: null },
      fora_da_carteira: false,
      ignorar_no_import: false,
    },
    select: { chave_export: true, alvo_id: true },
  });
  if (mapeamentos.length === 0) return { movimentacoesNaoExplicadas: [], avaliacoesMovimentacaoAoVivo: [] };

  const chavesPorAlvoId = new Map<string, string[]>();
  for (const m of mapeamentos) {
    const alvoId = m.alvo_id as string;
    if (!chavesPorAlvoId.has(alvoId)) chavesPorAlvoId.set(alvoId, []);
    chavesPorAlvoId.get(alvoId)!.push(m.chave_export);
  }

  const alvos = await prisma.alvo.findMany({
    where: { id: { in: Array.from(chavesPorAlvoId.keys()) } },
    select: { id: true, nome: true },
  });
  const nomePorAlvoId = new Map(alvos.map((a) => [a.id, a.nome]));

  const resultado: MovimentacaoNaoExplicada[] = [];
  const avaliacoesAoVivo: AvaliacaoMovimentacaoAoVivo[] = [];
  for (const [alvoId, chavesDoAlvo] of chavesPorAlvoId) {
    const elegibilidade = await contarAtivosComValorInvestidoRastreavel(alvoId);
    const somenteChaveExport = elegibilidade.elegiveis.every((e) => e.chaveExport !== undefined);
    if (!somenteChaveExport) continue;

    const chavesElegiveisEsperadas = new Set(elegibilidade.elegiveis.map((e) => e.chaveExport as string));
    const chavesDoAlvoSet = new Set(chavesDoAlvo);
    const cobreTodasElegiveis =
      chavesElegiveisEsperadas.size === chavesDoAlvoSet.size &&
      Array.from(chavesElegiveisEsperadas).every((c) => chavesDoAlvoSet.has(c));
    if (!cobreTodasElegiveis) continue;

    let valorRealCentavos: number | null = 0;
    for (const chave of chavesDoAlvo) {
      const valor = consolidadoPorChave.get(chave);
      if (valor === null || valor === undefined) {
        valorRealCentavos = null;
        break;
      }
      valorRealCentavos += valor;
    }
    if (valorRealCentavos === null) continue;

    const nomeAlvo = nomePorAlvoId.get(alvoId) ?? alvoId;
    const temAjustePendente = chavesDoAlvo.some((c) => chavesComAjustePendente.has(c));

    if (temAjustePendente) {
      // Valor real "base" (fixo): soma só das chaves SEM ajuste pendente —
      // mesma regra "nunca número parcial disfarçado de completo" já usada
      // acima (se alguma delas não tiver dado, pula o alvo inteiro).
      let valorRealBaseCentavos: number | null = 0;
      for (const chave of chavesDoAlvo) {
        if (chavesComAjustePendente.has(chave)) continue;
        const valor = consolidadoPorChave.get(chave);
        if (valor === null || valor === undefined) {
          valorRealBaseCentavos = null;
          break;
        }
        valorRealBaseCentavos += valor;
      }
      if (valorRealBaseCentavos === null) continue;

      const movimentacao = await calcularMovimentacaoNaoExplicada(
        { alvoId, nomeAlvo, valorInvestidoRealCentavos: valorRealCentavos },
        sessaoAnteriorId,
      );
      if (!movimentacao) continue;

      const ajustesDoAlvo = chavesDoAlvo
        .filter((c) => chavesComAjustePendente.has(c))
        .map((chaveExport) => ({
          chaveExport,
          valorCsvCentavos: consolidadoPorChave.get(chaveExport) ?? null,
        }));

      avaliacoesAoVivo.push({
        alvoId,
        nomeAlvo,
        granularidade: movimentacao.granularidade,
        chaveExport: movimentacao.chaveExport,
        posicaoManualId: movimentacao.posicaoManualId,
        valorInvestidoEsperadoCentavos: movimentacao.valorInvestidoEsperadoCentavos,
        houveBaseComparacao: movimentacao.houveBaseComparacao,
        valorRealBaseCentavos,
        ajustesDoAlvo,
      });
      continue;
    }

    const movimentacao = await calcularMovimentacaoNaoExplicada(
      { alvoId, nomeAlvo, valorInvestidoRealCentavos: valorRealCentavos },
      sessaoAnteriorId,
    );
    if (movimentacao && movimentacao.excedeTolerancia) {
      resultado.push(movimentacao);
    }
  }

  return { movimentacoesNaoExplicadas: resultado, avaliacoesMovimentacaoAoVivo: avaliacoesAoVivo };
}

/**
 * Preview de um import multi-arquivo: parse 100% EM MEMÓRIA — nada persiste,
 * inclusive quando há erro de parse (retorna `ok: false` com todos os erros
 * de todos os arquivos, nunca resultado parcial).
 *
 * Decisões de design documentadas aqui (spec deixava espaço):
 * - `instituicoesFaltantes` compara contra a sessão VIGENTE mais recente de
 *   QUALQUER mês (não necessariamente do mesmo mês do import) — é a leitura
 *   mais direta de "a sessão anterior" quando ainda não existe sessão do mês
 *   corrente (primeiro import de um mês novo).
 * - `avisoSubstituicao` compara contra a sessão VIGENTE do MESMO
 *   `mes_referencia` proposto — é especificamente o aviso de substituição.
 * - `diff` usa a sessão VIGENTE do mesmo mês quando existe (caso comum:
 *   reimport do mês corrente); na ausência dela, cai para a sessão VIGENTE
 *   mais recente de qualquer mês (fallback razoável: comparar com "como a
 *   carteira estava da última vez que sabíamos"). Sem nenhuma sessão
 *   VIGENTE anterior (primeiro import do app), `diff` é omitido.
 */
export async function previewImport(arquivos: ArquivoImport[]): Promise<PreviewImportResultado> {
  const parse = parseTodos(arquivos);
  if (!parse.ok) return { ok: false, erros: parse.erros };

  const arquivosParseados = parse.arquivos;

  const resumoPorInstituicao: PreviewInstituicaoResumo[] = arquivosParseados.map((a) => ({
    instituicao: a.instituicao,
    totalCentavos: a.totalCentavos,
    qtdAtivos: a.linhas.length,
    dataMaisRecente: a.dataMaisRecente,
  }));

  const dataExport = derivarDataExportISO(arquivosParseados);
  const mesReferenciaProposto = derivarMesReferencia(dataExport);
  const instituicoesAtuais = arquivosParseados.map((a) => a.instituicao);

  const [sessaoMesmoMes, sessaoMaisRecenteQualquerMes] = await Promise.all([
    obterSessaoVigenteDoMes(mesReferenciaProposto),
    obterSessaoVigenteMaisRecente(),
  ]);

  const avisoSubstituicao: AvisoSubstituicao | undefined = sessaoMesmoMes
    ? { mes: mesReferenciaProposto, dataAnterior: sessaoMesmoMes.data_export.toISOString() }
    : undefined;

  const faltantes = calcularInstituicoesFaltantes(instituicoesAtuais, sessaoMaisRecenteQualquerMes);
  const instituicoesFaltantes = faltantes.length > 0 ? faltantes : undefined;

  const sessaoParaDiff = sessaoMesmoMes ?? sessaoMaisRecenteQualquerMes;
  let diff: DiffPosicoes | undefined;
  if (sessaoParaDiff) {
    const posicoesAnteriores = await prisma.posicao.findMany({
      where: { sessao_import_id: sessaoParaDiff.id },
    });
    const anteriorConsolidado = consolidarPorChave(
      posicoesAnteriores.map((p) => ({
        chaveExport: p.chave_export,
        valorCentavos: p.patrimonio_hoje_centavos,
      })),
    );
    const novoConsolidado = consolidarPorChave(
      arquivosParseados.flatMap((a) =>
        a.linhas.map((linha) => ({
          chaveExport: linha.chaveExport,
          valorCentavos: linha.patrimonioHojeCentavos,
        })),
      ),
    );
    diff = calcularDiff(novoConsolidado, anteriorConsolidado);
  }

  // Carry-forward de posições manuais/ajustes (US3, data-model.md "Fluxo
  // técnico" passos 1-2) e agregação de pendências ambíguas por alvo (T026,
  // US4, motor-integracao.md §4.2) — leitura pura, resolvida a partir do
  // estado ATUAL do banco (a sessão deste import ainda não existe).
  const [{ posicoesManuaisRevisao, ajustesRevisao }, incrementosAmbiguosPendentes] = await Promise.all([
    montarRevisaoImport(),
    montarIncrementosAmbiguosPendentes(),
  ]);

  // US4 (FR-011/FR-011a/FR-018, research.md R13): puramente informativo,
  // calculado ANTES de qualquer persistência — mesma referência de "sessão
  // anterior" já usada acima para instituicoesFaltantes/diff. Nunca lançado
  // como erro: qualquer alvo sem dado suficiente é simplesmente omitido
  // (calcularMovimentacoesNaoExplicadasDoPreview já trata isso).
  const chavesComAjustePendente = new Set(ajustesRevisao.map((a) => a.chaveExport));
  const { movimentacoesNaoExplicadas, avaliacoesMovimentacaoAoVivo } =
    await calcularMovimentacoesNaoExplicadasDoPreview(
      arquivosParseados,
      sessaoMaisRecenteQualquerMes?.id ?? null,
      chavesComAjustePendente,
    );

  return {
    ok: true,
    arquivos: resumoPorInstituicao,
    mesReferenciaProposto,
    dataExport,
    avisoSubstituicao,
    instituicoesFaltantes,
    diff,
    posicoesManuaisRevisao,
    ajustesRevisao,
    incrementosAmbiguosPendentes,
    movimentacoesNaoExplicadas,
    avaliacoesMovimentacaoAoVivo,
  };
}

/**
 * Confirma um import: cria a sessão VIGENTE + posições + pendências de
 * vínculo em transação, precedida do backup datado (research.md R8) e do
 * bloqueio explícito de instituição faltante sem confirmação.
 *
 * Estratégia de reuso do preview (decisão de design documentada): esta
 * função RE-PARSEIA os arquivos recebidos em vez de aceitar um token de
 * cache do preview. Justificativa: `import-service` é uma camada de
 * serviço stateless (sem sessão HTTP própria); introduzir um cache
 * in-memory ou persistido só para evitar um re-parse (operação barata, em
 * memória, sem I/O) trocaria simplicidade e correção por uma otimização
 * sem necessidade demonstrada — e evita invalidação de cache (arquivo
 * mudou entre preview e confirmação?). Se a camada de UI (T038) quiser
 * evitar reenviar os arquivos, ela pode manter os `File`/bytes no cliente
 * e reenviar no `confirmarImport`; a responsabilidade de "token" fica na
 * borda (server action), não neste serviço.
 */
export async function confirmarImport(
  input: ConfirmarImportInput,
): Promise<ConfirmarImportResultado> {
  const parse = parseTodos(input.arquivos);
  if (!parse.ok) {
    return {
      ok: false,
      erro: "Erro de parse em um ou mais arquivos — nada foi persistido.",
      erros: parse.erros,
    };
  }
  const arquivosParseados = parse.arquivos;

  if (!/^\d{4}-\d{2}$/.test(input.mesReferencia)) {
    return {
      ok: false,
      erro: `mesReferencia inválido: "${input.mesReferencia}" (esperado "YYYY-MM").`,
    };
  }

  const instituicoesAtuais = arquivosParseados.map((a) => a.instituicao);

  // Checagem de completude (seção 6.2): contra a sessão VIGENTE mais recente
  // de QUALQUER mês — mesma referência usada no preview (ver comentário de
  // `previewImport`), para que o aviso mostrado ao usuário e a checagem
  // exigida na confirmação sejam sempre a mesma comparação.
  const sessaoMaisRecenteQualquerMes = await obterSessaoVigenteMaisRecente();
  const instituicoesFaltantes = calcularInstituicoesFaltantes(
    instituicoesAtuais,
    sessaoMaisRecenteQualquerMes,
  );
  if (instituicoesFaltantes.length > 0 && input.confirmouInstituicoesFaltantes !== true) {
    return {
      ok: false,
      erro: `Instituições presentes no import anterior e ausentes deste import: ${instituicoesFaltantes.join(", ")}. Confirme explicitamente (confirmouInstituicoesFaltantes: true) para prosseguir.`,
      instituicoesFaltantes,
    };
  }

  const dataExportISO = derivarDataExportISO(arquivosParseados);
  const dataExport = new Date(dataExportISO);
  const instituicoesJson = JSON.stringify(instituicoesAtuais);

  const todasLinhas = arquivosParseados.flatMap((arquivo) =>
    arquivo.linhas.map((linha) => ({ ...linha, instituicao: arquivo.instituicao })),
  );

  // Backup ANTES de qualquer escrita (research.md R8) — fora da transação,
  // e só depois de toda validação acima (parse + completude), para nunca
  // criar um backup datado às vésperas de uma operação que será recusada.
  await executarBackupComRetencao();

  const sessaoId = await prisma.$transaction(async (tx) => {
    const sessaoAnteriorMesmoMes = await tx.sessao_import.findFirst({
      where: { mes_referencia: input.mesReferencia, status: "VIGENTE" },
    });

    const novaSessao = await tx.sessao_import.create({
      data: {
        mes_referencia: input.mesReferencia,
        data_export: dataExport,
        status: "VIGENTE",
        instituicoes: instituicoesJson,
      },
    });

    if (todasLinhas.length > 0) {
      await tx.posicao.createMany({
        data: todasLinhas.map((linha) => ({
          sessao_import_id: novaSessao.id,
          chave_export: linha.chaveExport,
          instituicao: linha.instituicao,
          quantidade: linha.quantidade,
          patrimonio_hoje_centavos: linha.patrimonioHojeCentavos,
          patrimonio_investido_centavos: linha.patrimonioAplicadoCentavos,
          tipo_grupo: linha.tipoGrupo,
          tipo_ativo_internacional: linha.tipoAtivoInternacional,
          data_ultima_cotacao: linha.dataUltimaCotacao ? new Date(linha.dataUltimaCotacao) : null,
        })),
      });
    }

    // Vínculo memorizado (seção 4): só cria `ativo_mapeado` pendente para
    // chaves que NUNCA tiveram registro — uma chave já mapeada (vinculada
    // ou fora-da-carteira) em um import anterior nunca vira pendência de
    // novo, mesmo que a sessão que a criou já tenha sido substituída.
    const chavesUnicas = Array.from(new Set(todasLinhas.map((l) => l.chaveExport)));
    if (chavesUnicas.length > 0) {
      const existentes = await tx.ativo_mapeado.findMany({
        where: { chave_export: { in: chavesUnicas } },
        select: { chave_export: true },
      });
      const chavesExistentes = new Set(existentes.map((e) => e.chave_export));
      const chavesNovas = chavesUnicas.filter((c) => !chavesExistentes.has(c));

      if (chavesNovas.length > 0) {
        await tx.ativo_mapeado.createMany({
          data: chavesNovas.map((chave) => ({
            chave_export: chave,
            alvo_id: null,
            fora_da_carteira: false,
          })),
        });
      }
    }

    // Persistência da revisão de posições manuais/ajustes (US3,
    // data-model.md "Fluxo técnico" passo 4) — dentro da MESMA transação,
    // vinculada à NOVA sessão. Ambos os campos são opcionais: ausência não
    // quebra nada (compatibilidade com imports sem nenhuma posição
    // manual/ajuste cadastrado ainda). Nenhuma linha de sessão anterior é
    // tocada — só CREATE de linhas novas nesta sessão.
    //
    // Validação defensiva (bug real encontrado em revisão pós-implementação):
    // um item com `posicaoManualId`/`chaveExport` vazio ou só espaços não
    // corresponde a nenhum registro real, e persisti-lo faria o Prisma
    // lançar um `PrismaClientKnownRequestError` de violação de FK — erro
    // técnico cru, não uma mensagem amigável (viola "falhar alto, nunca em
    // silêncio" da forma errada: falha baixo/opaco). Em vez disso, tratamos
    // como "usuário deixou vazio": o item é simplesmente ignorado, mesmo
    // padrão de "aviso, não bloqueio" (FR-009) já usado para uma chave
    // ausente do array inteiro.
    const posicoesManuaisPreenchidas = (input.posicoesManuaisConfirmadas ?? []).filter(
      (item) => typeof item.posicaoManualId === "string" && item.posicaoManualId.trim().length > 0,
    );
    if (posicoesManuaisPreenchidas.length > 0) {
      await tx.posicao_manual_valor.createMany({
        data: posicoesManuaisPreenchidas.map((item) => ({
          posicao_manual_id: item.posicaoManualId,
          sessao_import_id: novaSessao.id,
          valor_investido_centavos: item.valorInvestidoCentavos,
          valor_atual_centavos: item.valorAtualCentavos,
        })),
      });
    }

    const ajustesPreenchidos = (input.ajustesConfirmados ?? []).filter(
      (item) => typeof item.chaveExport === "string" && item.chaveExport.trim().length > 0,
    );
    if (ajustesPreenchidos.length > 0) {
      // `create` simples (não upsert): a sessão é sempre nova, então o
      // `@@unique([chave_export, sessao_import_id])` nunca pode colidir
      // aqui (data-model.md).
      await tx.ajuste_valor_investido.createMany({
        data: ajustesPreenchidos.map((item) => ({
          chave_export: item.chaveExport.trim(),
          sessao_import_id: novaSessao.id,
          valor_investido_corrigido_centavos: item.valorInvestidoCentavosCorrigido,
        })),
      });
    }

    // Consumo das pendências (T026, motor-integracao.md §4.3/§4.4, FR-013,
    // MESMA transação): marca `aplicado = true` em TODA pendência
    // `incremento_valor_investido_pendente` ainda não aplicada que foi
    // "exibida nesta revisão" — na prática, o mesmo conjunto que
    // `montarRevisaoImport`/`montarIncrementosAmbiguosPendentes` (chamadas
    // por `previewImport` imediatamente antes desta confirmação, sobre o
    // MESMO estado do banco) somam:
    //   (a) TODAS as pendências exclusivas (posicao_manual_id/chave_export)
    //       de cada posição/ajuste efetivamente persistido nesta sessão
    //       (posicoesManuaisPreenchidas/ajustesPreenchidos acima) — mesmo
    //       critério "TODAS, não só a mais recente" usado na soma exibida
    //       (§4.1);
    //   (b) TODAS as pendências ambíguas de alvo ainda não aplicadas
    //       (chave_export IS NULL AND posicao_manual_id IS NULL) — research.md
    //       R5: marcadas integralmente na confirmação, mesmo com
    //       distribuição parcial pelo usuário; `incrementosAmbiguosPendentes`
    //       não restringe por alvo tocado nesta sessão (todo alvo com
    //       pendência ambígua aparece na revisão, então toda confirmação as
    //       consome — mesma leitura "sem filtro adicional" usada no preview).
    const posicaoManualIdsTocados = posicoesManuaisPreenchidas.map((item) => item.posicaoManualId);
    const chavesExportTocadas = ajustesPreenchidos.map((item) => item.chaveExport.trim());

    const pendenciasParaMarcar = await tx.incremento_valor_investido_pendente.findMany({
      where: {
        aplicado: false,
        OR: [
          { chave_export: null, posicao_manual_id: null },
          ...(posicaoManualIdsTocados.length > 0
            ? [{ posicao_manual_id: { in: posicaoManualIdsTocados } }]
            : []),
          ...(chavesExportTocadas.length > 0
            ? [{ chave_export: { in: chavesExportTocadas } }]
            : []),
        ],
      },
      select: { id: true },
    });
    if (pendenciasParaMarcar.length > 0) {
      await marcarPendenciasComoAplicadas(
        {
          pendenciaIds: pendenciasParaMarcar.map((p) => p.id),
          sessaoAplicacaoId: novaSessao.id,
        },
        tx,
      );
    }

    // Transição de estado (data-model.md): a sessão VIGENTE anterior do
    // MESMO mes_referencia (se houver) vira SUBSTITUIDO — nunca DELETE,
    // nunca UPDATE de conteúdo além do campo `status`.
    if (sessaoAnteriorMesmoMes) {
      await tx.sessao_import.update({
        where: { id: sessaoAnteriorMesmoMes.id },
        data: { status: "SUBSTITUIDO" },
      });
    }

    return novaSessao.id;
  });

  const pendenciasVinculo = await listarPendenciasDaSessao(sessaoId);

  return {
    ok: true,
    sessaoId,
    pendenciasVinculo,
    incrementosAmbiguosNaoAlocadosCentavos: 0,
  };
}
