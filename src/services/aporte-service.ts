import { prisma } from "@/db/client";
import { getConfig, setConfig } from "@/services/config-service";
import { totalDisponivelCentavos as totalDividendosDisponivelCentavos } from "@/services/dividendo-service";
import { calcularAporte } from "@/core/motor";
import type {
  AjusteUsuario,
  AlvoVigente,
  CotacaoB3,
  EntradaMotor,
  LinhaDivisao,
  OrigemLinhaDivisao,
  PosicaoConsolidada,
  ResultadoMotor,
} from "@/core/motor";

// Serviço de orquestração da calculadora de aporte (T026). Camada de I/O:
// pode importar Prisma livremente, mas NUNCA é importado por src/core/**
// (o motor é lógica pura — ver eslint.config.mjs). Este módulo é responsável
// por resolver a sessão de import vigente em EntradaMotor, aplicar a regra
// de bloqueio por pendência de vínculo (FR-015) e persistir o registro do
// aporte sem jamais escrever em `posicao` (regra 9, inviolável).

/**
 * Grupos B3 (regra 7 — arredondamento por lote): quantidade sempre inteira,
 * preço derivado por cota. Ações, FIIs/Fiagros e ETFs.
 */
const GRUPOS_B3 = new Set(["ACOES", "FII_FIAGRO", "ETF"]);

/**
 * Heurística de `rendaFixa` (contracts/motor.md não lista os `tipo_grupo`
 * exaustivamente — decisão documentada aqui, conforme instrução da tarefa):
 * qualquer `tipo_grupo` que NÃO seja B3 (ações/FIIs/ETFs) nem EXTERIOR conta
 * como renda fixa (TESOURO_DIRETO, FUNDOS_INVESTIMENTO, OUTROS_FUNDOS, e
 * quaisquer outros valores opacos futuros). Um alvo é `rendaFixa` quando
 * TODAS as posições atualmente vinculadas a ele são desse tipo — um alvo
 * misto (ex.: ações + fundo no mesmo alvo) não é tratado como destino de
 * troco fracionário, já que ele próprio teria ativos sujeitos a lote.
 * Um alvo sem nenhuma posição hoje (déficit "do zero") não tem como ser
 * classificado por este método e assume `rendaFixa = false` por padrão.
 */
const GRUPOS_NAO_RENDA_FIXA = new Set([...GRUPOS_B3, "EXTERIOR"]);

/** Shape persistido em `aporte.sugestao` / `aporte.executado` (data-model.md). */
export interface LinhaAporte {
  alvo_id: string;
  nome_alvo: string;
  valor_centavos: number;
  origem: OrigemLinhaDivisao;
  cotas?: number;
  preco_centavos?: number;
}

export interface PrepararCalculadoraOutput {
  bloqueada: boolean;
  pendencias: string[];
  dividendosDisponiveisCentavos: number;
  trocoAnteriorCentavos: number;
  aporteMinimoCentavos: number;
}

export interface CalcularInput {
  valorCentavos: number;
  incluirDividendos: boolean;
  incluirTroco: boolean;
  aporteMinimoCentavos: number;
  ajustesUsuario?: AjusteUsuario[];
}

export interface CalcularOutput {
  resultado: ResultadoMotor;
  sessaoImportId: string;
  valorTotalCentavos: number;
  valorDividendosCentavos: number;
  dividendosIncluidosIds: string[];
  trocoAnteriorIncluidoCentavos: number;
  /** `resultado.divisao` já convertido para o shape persistido, com nome do alvo denormalizado. */
  sugestao: LinhaAporte[];
  /**
   * Nome de TODO alvo vigente (`contexto.alvos`, não só os presentes em
   * `sugestao`/`resultado.divisao`), indexado por `alvoId`. Necessário porque
   * `resultado.fila` (research.md / motor.md) inclui todos os alvos vigentes,
   * inclusive os que não recebem fatia (déficit <= 0) — a UI precisa resolver
   * o nome desses também, não só dos que aparecem em `divisao`. Objeto plano
   * (não `Map`) porque este valor atravessa a borda server action → client
   * component via JSON (contracts/server-actions.md), onde `Map` não
   * serializa.
   */
  nomesPorAlvoId: Record<string, string>;
}

export interface RegistrarAporteInput {
  /** Sessão vigente NO MOMENTO do cálculo (vem de `CalcularOutput.sessaoImportId`) — nunca re-derivada aqui. */
  sessaoImportId: string;
  sugestao: LinhaAporte[];
  executado: LinhaAporte[];
  valorTotalCentavos: number;
  valorDividendosCentavos: number;
  /** `resultado.trocoCentavos` do motor (research.md R10). */
  trocoCentavos: number;
  /** IDs de `dividendo` (aporte_id ainda null) a marcar como utilizados nesta transação. */
  dividendosIncluidosIds?: string[];
}

/**
 * Sessão de import VIGENTE mais recente (uma por `mes_referencia`, mas o
 * cálculo sempre parte da mais recente entre todos os meses).
 */
async function obterSessaoVigenteMaisRecente() {
  return prisma.sessao_import.findFirst({
    where: { status: "VIGENTE" },
    orderBy: [{ data_export: "desc" }, { criado_em: "desc" }],
  });
}

/**
 * Cruza as `chave_export` das posições de uma sessão com `ativo_mapeado` e
 * retorna as que estão pendentes (data-model.md: `alvo_id = null AND
 * fora_da_carteira = false`), incluindo — defensivamente — chaves sem
 * NENHUM registro de `ativo_mapeado` (estado equivalente a pendente, ainda
 * que fora do fluxo normal em que o import já cria o pendente).
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
    return !mapeamento || (mapeamento.alvo_id === null && !mapeamento.fora_da_carteira);
  });
}

/**
 * Pendências da sessão vigente mais recente. Sem sessão vigente nenhuma,
 * retorna `[]` (não há o que bloquear por vínculo — `montarContextoEntradaMotor`
 * falha por outro motivo, "sem sessão", nesse caso).
 */
export async function listarPendencias(): Promise<string[]> {
  const sessao = await obterSessaoVigenteMaisRecente();
  if (!sessao) return [];
  return listarPendenciasDaSessao(sessao.id);
}

/** Soma quantidades decimais (string) B3; retorna `null` se o total não for inteiro (não deveria ocorrer em B3 — research.md R6). */
function somarQuantidadesInteiras(quantidades: string[]): number | null {
  let total = 0;
  for (const quantidade of quantidades) {
    const numero = Number(quantidade);
    if (!Number.isFinite(numero)) return null;
    total += numero;
  }
  return Number.isInteger(total) ? total : null;
}

interface ContextoEntradaMotor {
  sessaoId: string;
  alvos: AlvoVigente[];
  posicoes: PosicaoConsolidada[];
  cotacoes: CotacaoB3[];
}

/**
 * Monta o contexto completo (alvos, posições consolidadas e cotações B3) a
 * partir da sessão VIGENTE mais recente. Lança erro se não houver sessão ou
 * se houver qualquer pendência de vínculo — a calculadora nunca deve
 * calcular sobre uma base incompleta (FR-015).
 */
async function montarContextoEntradaMotor(): Promise<ContextoEntradaMotor> {
  const sessao = await obterSessaoVigenteMaisRecente();
  if (!sessao) {
    throw new Error(
      "Nenhuma sessão de import VIGENTE encontrada — realize um import antes de calcular o aporte.",
    );
  }

  const pendencias = await listarPendenciasDaSessao(sessao.id);
  if (pendencias.length > 0) {
    throw new Error(
      `Calculadora bloqueada: ${pendencias.length} ativo(s) pendente(s) de vínculo (${pendencias.join(", ")}). Resolva em /vinculos antes de calcular.`,
    );
  }

  const posicoesBrutas = await prisma.posicao.findMany({
    where: { sessao_import_id: sessao.id },
  });

  const chaves = Array.from(new Set(posicoesBrutas.map((p) => p.chave_export)));
  const mapeamentos = await prisma.ativo_mapeado.findMany({
    where: { chave_export: { in: chaves } },
  });
  const mapaPorChave = new Map(mapeamentos.map((m) => [m.chave_export, m]));

  // Consolidação por chave_export (data-model.md: "em leitura, nunca
  // materializada") — mesma chave em instituições diferentes vira uma só
  // posição, somando patrimônio e acumulando as quantidades para a
  // derivação de preço por cota (B3).
  interface Consolidado {
    valorCentavos: number;
    tipoGrupo: string;
    quantidades: string[];
  }
  const consolidadoPorChave = new Map<string, Consolidado>();
  for (const p of posicoesBrutas) {
    const existente = consolidadoPorChave.get(p.chave_export);
    if (existente) {
      existente.valorCentavos += p.patrimonio_hoje_centavos;
      existente.quantidades.push(p.quantidade);
    } else {
      consolidadoPorChave.set(p.chave_export, {
        valorCentavos: p.patrimonio_hoje_centavos,
        tipoGrupo: p.tipo_grupo,
        quantidades: [p.quantidade],
      });
    }
  }

  const posicoes: PosicaoConsolidada[] = [];
  const tiposGrupoPorAlvoId = new Map<string, Set<string>>();
  const candidatosCotacaoPorAlvo = new Map<string, number[]>();

  for (const [chaveExport, dados] of consolidadoPorChave) {
    const mapeamento = mapaPorChave.get(chaveExport);
    const alvoId = mapeamento?.alvo_id ?? null;
    const foraDaCarteira = mapeamento?.fora_da_carteira ?? false;

    posicoes.push({
      chaveExport,
      alvoId,
      foraDaCarteira,
      valorCentavos: dados.valorCentavos,
      tipoGrupo: dados.tipoGrupo,
    });

    if (!alvoId || foraDaCarteira) continue;

    const tipos = tiposGrupoPorAlvoId.get(alvoId) ?? new Set<string>();
    tipos.add(dados.tipoGrupo);
    tiposGrupoPorAlvoId.set(alvoId, tipos);

    // Regra 7 / research.md R6: cotação só para B3 (ações/FIIs/ETFs);
    // EXTERIOR e renda fixa nunca entram em `cotacoes`.
    if (GRUPOS_B3.has(dados.tipoGrupo)) {
      const quantidadeTotal = somarQuantidadesInteiras(dados.quantidades);
      if (quantidadeTotal !== null && quantidadeTotal > 0) {
        const precoCentavos = Math.round(dados.valorCentavos / quantidadeTotal);
        const lista = candidatosCotacaoPorAlvo.get(alvoId) ?? [];
        lista.push(precoCentavos);
        candidatosCotacaoPorAlvo.set(alvoId, lista);
      }
    }
  }

  const alvosDb = await prisma.alvo.findMany({
    where: { vigencia_fim: null, ativo: true },
  });
  const alvos: AlvoVigente[] = alvosDb.map((a) => {
    const tipos = tiposGrupoPorAlvoId.get(a.id);
    const rendaFixa =
      tipos !== undefined &&
      tipos.size > 0 &&
      [...tipos].every((tipo) => !GRUPOS_NAO_RENDA_FIXA.has(tipo));
    return {
      alvoId: a.id,
      nome: a.nome,
      percentualBps: a.percentual_alvo_bps,
      rendaFixa,
    };
  });

  const cotacoes: CotacaoB3[] = [];
  for (const [alvoId, precos] of candidatosCotacaoPorAlvo) {
    // Limitação documentada: o contrato do motor modela cotação por ALVO
    // (não por chave_export). Se o alvo consolidar mais de um ticket B3
    // distinto (config incomum — cada alvo normalmente corresponde a 1
    // ticket), não existe um único "preço por cota" válido; nesse caso
    // omitimos a cotação para o alvo em vez de escolher um preço arbitrário
    // — ele simplesmente fica de fora do arredondamento por lote.
    if (precos.length === 1) {
      cotacoes.push({ alvoId, precoCentavos: precos[0] });
    }
  }

  return { sessaoId: sessao.id, alvos, posicoes, cotacoes };
}

/** Troco do arredondamento por lote do último aporte registrado (research.md R10). */
async function obterTrocoAnterior(): Promise<number> {
  const ultimoAporte = await prisma.aporte.findFirst({
    orderBy: { criado_em: "desc" },
  });
  return ultimoAporte?.troco_centavos ?? 0;
}

/**
 * Dividendos ainda não utilizados (`aporte_id = null`), com os registros
 * completos (não só a soma) porque `calcular()` precisa dos `id`s para
 * marcá-los como utilizados em `registrarAporte` (`dividendosIncluidosIds`).
 * Mantido aqui — em vez de expor uma listagem completa em
 * `dividendo-service.ts` só para isso — porque é uma query trivial e o
 * shape (`{id, valor_centavos}` do Prisma) é interno a este módulo; a SOMA
 * usada em `prepararCalculadora` (T049/T050) já delega para
 * `dividendo-service.totalDisponivelCentavos()` logo abaixo, evitando a
 * duplicação de regra de negócio que antes existia aqui.
 */
async function listarDividendosDisponiveis() {
  return prisma.dividendo.findMany({ where: { aporte_id: null } });
}

/**
 * Dados de abertura da calculadora (contracts/server-actions.md,
 * `aporte.ts`): estado de bloqueio por pendência (FR-015), oferta de
 * dividendos não utilizados (FR-030) e troco do mês anterior (R10).
 */
export async function prepararCalculadora(): Promise<PrepararCalculadoraOutput> {
  const [pendencias, dividendosDisponiveisCentavos, trocoAnteriorCentavos, aporteMinimoCentavos] =
    await Promise.all([
      listarPendencias(),
      // Delegado a dividendo-service (T049) em vez de duplicar a query de
      // soma — este módulo continua responsável apenas por buscar os
      // registros completos quando precisa dos `id`s (`listarDividendosDisponiveis`,
      // usado só por `calcular`).
      totalDividendosDisponivelCentavos(),
      obterTrocoAnterior(),
      getConfig("aporte_minimo_centavos"),
    ]);

  return {
    bloqueada: pendencias.length > 0,
    pendencias,
    dividendosDisponiveisCentavos,
    trocoAnteriorCentavos,
    aporteMinimoCentavos,
  };
}

/** Converte uma `LinhaDivisao` do motor no shape persistido (`nome_alvo` denormalizado). */
function paraLinhaAporte(linha: LinhaDivisao, nomePorAlvoId: Map<string, string>): LinhaAporte {
  const base: LinhaAporte = {
    alvo_id: linha.alvoId,
    nome_alvo: nomePorAlvoId.get(linha.alvoId) ?? linha.alvoId,
    valor_centavos: linha.valorCentavos,
    origem: linha.origem,
  };
  if (linha.cotas !== undefined) base.cotas = linha.cotas;
  if (linha.precoCentavos !== undefined) base.preco_centavos = linha.precoCentavos;
  return base;
}

/**
 * Monta a `EntradaMotor` a partir da sessão vigente (bloqueando por
 * pendência), soma dividendos/troco quando solicitado e delega ao motor
 * puro `calcularAporte`. Atualiza `aporte_minimo_centavos` na config
 * ("lembrado da última vez", data-model.md). Lança erro se a calculadora
 * estiver bloqueada — nunca calcula silenciosamente sobre base incompleta.
 */
export async function calcular(input: CalcularInput): Promise<CalcularOutput> {
  const contexto = await montarContextoEntradaMotor();

  let valorDividendosCentavos = 0;
  let dividendosIncluidosIds: string[] = [];
  if (input.incluirDividendos) {
    const disponiveis = await listarDividendosDisponiveis();
    valorDividendosCentavos = disponiveis.reduce((acc, d) => acc + d.valor_centavos, 0);
    dividendosIncluidosIds = disponiveis.map((d) => d.id);
  }

  let trocoAnteriorIncluidoCentavos = 0;
  if (input.incluirTroco) {
    trocoAnteriorIncluidoCentavos = await obterTrocoAnterior();
  }

  const valorTotalCentavos =
    input.valorCentavos + valorDividendosCentavos + trocoAnteriorIncluidoCentavos;

  const entradaMotor: EntradaMotor = {
    alvos: contexto.alvos,
    posicoes: contexto.posicoes,
    valorAporteCentavos: valorTotalCentavos,
    aporteMinimoCentavos: input.aporteMinimoCentavos,
    ajustesUsuario: input.ajustesUsuario,
    cotacoes: contexto.cotacoes.length > 0 ? contexto.cotacoes : undefined,
  };

  const resultado = calcularAporte(entradaMotor);

  // "Lembrado da última vez" (data-model.md, tabela de config).
  await setConfig("aporte_minimo_centavos", input.aporteMinimoCentavos);

  const nomePorAlvoId = new Map(contexto.alvos.map((a) => [a.alvoId, a.nome]));
  const sugestao = resultado.divisao.map((linha) => paraLinhaAporte(linha, nomePorAlvoId));
  const nomesPorAlvoId = Object.fromEntries(nomePorAlvoId);

  return {
    resultado,
    sessaoImportId: contexto.sessaoId,
    valorTotalCentavos,
    valorDividendosCentavos,
    dividendosIncluidosIds,
    trocoAnteriorIncluidoCentavos,
    sugestao,
    nomesPorAlvoId,
  };
}

/**
 * Registra o cálculo + execução declarada em transação: cria `aporte`
 * amarrado à sessão informada (permanente — NUNCA re-derivada/re-vinculada
 * aqui, mesmo que ela já não seja mais a vigente no momento do registro) e
 * marca os dividendos incluídos como utilizados.
 *
 * REGRA 9 (inviolável, data-model.md): esta função NUNCA escreve em
 * `posicao` — nenhuma linha de código abaixo faz update/create/delete em
 * `posicao`, sob nenhuma circunstância. Não "corrigir" isso.
 */
export async function registrarAporte(
  input: RegistrarAporteInput,
): Promise<{ aporteId: string }> {
  if (input.valorTotalCentavos <= 0) {
    throw new Error("registrarAporte: valorTotalCentavos deve ser > 0.");
  }

  const aporteId = await prisma.$transaction(async (tx) => {
    // Falhar alto, nunca em silêncio: antes de criar o `aporte`, confirma que
    // TODOS os `dividendosIncluidosIds` ainda estão disponíveis
    // (`aporte_id: null`). Sem essa checagem, o `updateMany` abaixo aceitaria
    // silenciosamente ids já usados por outro aporte (guarda `WHERE
    // aporte_id: null` some sem erro) — o `aporte` seria criado com
    // `valor_dividendos_centavos` divergente do que de fato foi marcado como
    // utilizado. Cenário de concorrência teórico (app single-user local),
    // mas a validação garante que a transação inteira reverte em vez de
    // persistir um registro divergente.
    if (input.dividendosIncluidosIds && input.dividendosIncluidosIds.length > 0) {
      const disponiveis = await tx.dividendo.count({
        where: { id: { in: input.dividendosIncluidosIds }, aporte_id: null },
      });
      if (disponiveis !== input.dividendosIncluidosIds.length) {
        throw new Error(
          "Um ou mais dividendos incluídos já foram utilizados em outro aporte — recalcule antes de registrar.",
        );
      }
    }

    const aporte = await tx.aporte.create({
      data: {
        sessao_import_id: input.sessaoImportId,
        valor_total_centavos: input.valorTotalCentavos,
        valor_dividendos_centavos: input.valorDividendosCentavos,
        sugestao: JSON.stringify(input.sugestao),
        executado: JSON.stringify(input.executado),
        troco_centavos: input.trocoCentavos,
      },
    });

    if (input.dividendosIncluidosIds && input.dividendosIncluidosIds.length > 0) {
      await tx.dividendo.updateMany({
        where: { id: { in: input.dividendosIncluidosIds }, aporte_id: null },
        data: { aporte_id: aporte.id },
      });
    }

    return aporte.id;
  });

  return { aporteId };
}
