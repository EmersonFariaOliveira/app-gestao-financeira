import { prisma } from "@/db/client";
import { getConfig } from "@/services/config-service";
import { contarPendencias } from "@/services/mapeamento-service";

// Serviço de leitura do dashboard e histórico (T054, contracts/server-actions.md
// "dashboard/histórico (telas 6.1 e 6.7)"). Camada de LEITURA PURA: nenhuma
// escrita acontece neste arquivo — não é motor (não calcula déficit/fila/
// divisão; fica em src/services/, não em src/core/**) e não é a camada de
// orquestração da calculadora (aporte-service.ts, que É quem monta a entrada
// do motor e persiste `aporte`).
//
// Reaproveita o MESMO padrão de consolidação por `chave_export` que
// aporte-service.montarContextoEntradaMotor (data-model.md: "Consolidação: em
// leitura, nunca materializada"), mas com uma query mais simples: dashboard
// não precisa de `tipo_grupo`/quantidades/cotações (isso é exclusivo do
// motor), só do valor consolidado por chave e do estado de vínculo
// (vinculado / fora-da-carteira / pendente).
//
// ## Decisões de design documentadas (pedidas explicitamente pela task)
//
// 1. **"Patrimônio na carteira" vs. "fora da carteira" vs. "pendente"**:
//    - `patrimonioTotalCentavos` = soma de TODAS as posições consolidadas da
//      sessão vigente, não importa o estado de vínculo (é o número "quanto eu
//      tenho, no total, ponto final" do topo do dashboard).
//    - `patrimonioNaCarteiraCentavos` = soma apenas das posições VINCULADAS a
//      um alvo (`alvo_id != null`) e não fora-da-carteira. Esta é
//      exatamente a mesma base que `src/core/motor/deficit.ts` usa como
//      `patrimonioBaseCentavos` (condição espelhada: motor pula quando
//      `foraDaCarteira || alvoId === null`) — é o denominador de
//      `percentualAtualBps` por alvo, para que o desvio exibido bata com o
//      que o motor usaria se calculasse um aporte agora. Isso inclui,
//      propositalmente, valor de qualquer `alvo_id` "zumbi" (alvo removido/
//      de vigência fechada) que ainda tenha vínculos apontando para ele —
//      mesmo comportamento documentado em `alvo-service.removerAlvo`; esse
//      valor entra na base mas não aparece em nenhuma linha de `alocacao`
//      (só alvos vigentes são listados), o que é a réplica fiel do que o
//      motor já faz hoje, não um bug novo.
//    - `patrimonioForaDaCarteiraCentavos` = soma das posições marcadas
//      `fora_da_carteira = true` — excluídas da base, exibidas à parte
//      (`foraDaCarteira: {chaveExport, valorCentavos}[]`), nunca misturadas
//      na alocação por alvo.
//    - `patrimonioPendenteCentavos` = soma das posições sem vínculo resolvido
//      (`alvo_id = null AND fora_da_carteira = false`, incluindo — defensivamente,
//      igual a `aporte-service.listarPendenciasDaSessao` — chaves sem NENHUM
//      registro de `ativo_mapeado`). Não é "fora da carteira" (decisão do
//      usuário) nem "na carteira" (ainda sem alvo) — listado à parte em
//      `pendentes`, como contraparte financeira do alerta de contagem
//      (`contarPendencias()`, que só conta, não soma valor).
//    - Invariante: `patrimonioTotalCentavos === patrimonioNaCarteiraCentavos +
//      patrimonioForaDaCarteiraCentavos + patrimonioPendenteCentavos`.
//
// 2. **Data usada para ordenar a linha do tempo sugerido vs. executado**:
//    usa-se o `mes_referencia` da SESSÃO à qual o `aporte` está amarrado
//    (`aporte.sessao_import_id` → `sessao_import.mes_referencia`), não
//    `aporte.criado_em`. Razões: (a) é o mês ao qual o aporte
//    conceitualmente pertence — o usuário calcula sobre as posições recém
//    importadas de um mês; (b) `criado_em` é só o timestamp de quando o
//    registro foi salvo, podendo ficar defasado (aporte registrado dias
//    depois, ou com o import do mês seguinte já confirmado) e não deveria
//    mover o ponto na linha do tempo para o mês "errado"; (c) coerente com a
//    regra de imutabilidade (data-model.md): o `aporte` fica amarrado
//    PERMANENTEMENTE à sessão do cálculo mesmo que ela seja substituída
//    depois — o `mes_referencia` daquela sessão continua sendo o rótulo
//    correto do mês, independentemente do `status` atual dela. `criado_em`
//    é usado apenas como critério de desempate (ordem estável) entre
//    múltiplos aportes do mesmo `mes_referencia`.

/** Ativo (por `chave_export`) com o valor consolidado da sessão, fora da alocação por alvo. */
export interface AtivoComValor {
  chaveExport: string;
  valorCentavos: number;
}

/** Alocação atual vs. alvo de um alvo vigente, em bps (research.md/data-model.md). */
export interface AlocacaoPorAlvo {
  alvoId: string;
  nomeAlvo: string;
  percentualAlvoBps: number;
  valorAtualCentavos: number;
  /** Percentual do alvo sobre `patrimonioNaCarteiraCentavos` (mesma base do motor), truncado. */
  percentualAtualBps: number;
  /** `percentualAtualBps - percentualAlvoBps`. Negativo = alvo abaixo do alvo (déficit). */
  desvioBps: number;
  /** `Math.abs(desvioBps) <= bandaToleranciaBps` — regra 8: só visual, não afeta nenhum cálculo. */
  dentroDaBanda: boolean;
}

/** Estado "app vazio" — nenhuma sessão de import foi confirmada ainda. */
export interface DashboardVazio {
  vazio: true;
  bandaToleranciaBps: number;
  qtdPendencias: number;
}

/** Estado normal do dashboard, com a sessão VIGENTE mais recente já resolvida. */
export interface DashboardComDados {
  vazio: false;
  sessaoImportId: string;
  dataExport: Date;
  mesReferencia: string;
  patrimonioTotalCentavos: number;
  patrimonioNaCarteiraCentavos: number;
  patrimonioForaDaCarteiraCentavos: number;
  patrimonioPendenteCentavos: number;
  alocacao: AlocacaoPorAlvo[];
  foraDaCarteira: AtivoComValor[];
  pendentes: AtivoComValor[];
  qtdPendencias: number;
  bandaToleranciaBps: number;
}

export type DadosDashboardOutput = DashboardVazio | DashboardComDados;

export interface PontoSerieMensal {
  sessaoImportId: string;
  mesReferencia: string;
  dataExport: Date;
  patrimonioTotalCentavos: number;
}

export interface PontoAporteHistorico {
  aporteId: string;
  /** `mes_referencia` da sessão à qual o aporte está amarrado — ver nota de design acima. */
  mesReferencia: string;
  criadoEm: Date;
  /** Soma de `valor_centavos` das linhas de `aporte.sugestao` (JSON). */
  sugeridoCentavos: number;
  /** Soma de `valor_centavos` das linhas de `aporte.executado` (JSON). */
  executadoCentavos: number;
  valorTotalCentavos: number;
  trocoCentavos: number;
}

/** Sessão SUBSTITUIDA, para a visão de auditoria (nunca aparece na `serieMensal`). */
export interface SessaoSubstituidaAuditoria {
  sessaoImportId: string;
  mesReferencia: string;
  dataExport: Date;
  criadoEm: Date;
  instituicoes: string[];
  patrimonioTotalCentavos: number;
}

export interface DadosHistoricoOutput {
  /** 1 ponto por mês, só sessões VIGENTES, ordenado por `mes_referencia` asc. */
  serieMensal: PontoSerieMensal[];
  /** 1 ponto por `aporte` registrado, ordenado por `mesReferencia` (ver nota de design) e `criadoEm` como desempate. */
  linhaDoTempoAportes: PontoAporteHistorico[];
  /** Sessões SUBSTITUIDAS, mais recentes primeiro — consulta de auditoria, fora da série principal. */
  sessoesSubstituidas: SessaoSubstituidaAuditoria[];
}

/**
 * Sessão VIGENTE mais recente (uma por `mes_referencia`, mas o dashboard
 * sempre mostra a mais recente entre todos os meses). Cópia intencional da
 * mesma query usada em `aporte-service.obterSessaoVigenteMaisRecente` — não
 * importada de lá (função privada daquele módulo) para não acoplar os dois
 * serviços por uma função interna; ambos os locais devem permanecer
 * idênticos se a regra mudar (só duas linhas de query, baixo risco de
 * divergência silenciosa).
 */
async function obterSessaoVigenteMaisRecente() {
  return prisma.sessao_import.findFirst({
    where: { status: "VIGENTE" },
    orderBy: [{ data_export: "desc" }, { criado_em: "desc" }],
  });
}

interface ClassificacaoPosicoes {
  patrimonioTotalCentavos: number;
  patrimonioNaCarteiraCentavos: number;
  patrimonioForaDaCarteiraCentavos: number;
  patrimonioPendenteCentavos: number;
  valorPorAlvoId: Map<string, number>;
  foraDaCarteira: AtivoComValor[];
  pendentes: AtivoComValor[];
}

/**
 * Consolida as posições de uma sessão por `chave_export` (mesma chave em
 * instituições diferentes = uma posição só, somando patrimônio — data-model.md)
 * e classifica cada uma em vinculada / fora-da-carteira / pendente, espelhando
 * EXATAMENTE a condição de exclusão de `src/core/motor/deficit.ts`
 * (`foraDaCarteira || alvoId === null` ⇒ fora da base) para que
 * `patrimonioNaCarteiraCentavos` seja idêntico ao `patrimonioBaseCentavos`
 * que o motor usaria hoje.
 */
async function classificarPosicoesDaSessao(sessaoId: string): Promise<ClassificacaoPosicoes> {
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
  const mapeamentos =
    chaves.length > 0
      ? await prisma.ativo_mapeado.findMany({ where: { chave_export: { in: chaves } } })
      : [];
  const mapaPorChave = new Map(mapeamentos.map((m) => [m.chave_export, m]));

  let patrimonioTotalCentavos = 0;
  let patrimonioNaCarteiraCentavos = 0;
  let patrimonioForaDaCarteiraCentavos = 0;
  let patrimonioPendenteCentavos = 0;
  const valorPorAlvoId = new Map<string, number>();
  const foraDaCarteira: AtivoComValor[] = [];
  const pendentes: AtivoComValor[] = [];

  for (const [chaveExport, valorCentavos] of valorPorChave) {
    patrimonioTotalCentavos += valorCentavos;
    const mapeamento = mapaPorChave.get(chaveExport);
    const alvoId = mapeamento?.alvo_id ?? null;
    const foraDaCarteiraFlag = mapeamento?.fora_da_carteira ?? false;

    if (foraDaCarteiraFlag) {
      patrimonioForaDaCarteiraCentavos += valorCentavos;
      foraDaCarteira.push({ chaveExport, valorCentavos });
    } else if (alvoId !== null) {
      patrimonioNaCarteiraCentavos += valorCentavos;
      valorPorAlvoId.set(alvoId, (valorPorAlvoId.get(alvoId) ?? 0) + valorCentavos);
    } else {
      // Pendente (ou chave sem NENHUM ativo_mapeado — mesmo tratamento
      // defensivo de aporte-service.listarPendenciasDaSessao): fica de fora
      // da base do motor e do bucket fora-da-carteira; listado à parte.
      patrimonioPendenteCentavos += valorCentavos;
      pendentes.push({ chaveExport, valorCentavos });
    }
  }

  return {
    patrimonioTotalCentavos,
    patrimonioNaCarteiraCentavos,
    patrimonioForaDaCarteiraCentavos,
    patrimonioPendenteCentavos,
    valorPorAlvoId,
    foraDaCarteira,
    pendentes,
  };
}

/**
 * Dados da tela 6.1 (dashboard/home): patrimônio consolidado + data das
 * posições, alocação atual vs. alvo por alvo com desvio e banda de
 * tolerância (regra 8 — visual, não afeta nenhum cálculo do motor),
 * fora-da-carteira à parte e alerta de pendências (FR-038..040).
 *
 * Nunca lança exceção por ausência de dados: se não houver NENHUMA sessão
 * VIGENTE (app recém-instalado, nunca importou nada), retorna
 * `{vazio: true, ...}` em vez do padrão de erro usado por
 * `aporte-service.montarContextoEntradaMotor` — o dashboard é a TELA INICIAL
 * do app e precisa ser sempre renderizável.
 */
export async function dadosDashboard(): Promise<DadosDashboardOutput> {
  const [sessao, bandaToleranciaBps, qtdPendencias] = await Promise.all([
    obterSessaoVigenteMaisRecente(),
    getConfig("banda_tolerancia_bps"),
    contarPendencias(),
  ]);

  if (!sessao) {
    return { vazio: true, bandaToleranciaBps, qtdPendencias };
  }

  const [classificacao, alvosVigentes] = await Promise.all([
    classificarPosicoesDaSessao(sessao.id),
    prisma.alvo.findMany({
      where: { vigencia_fim: null, ativo: true },
      orderBy: { criado_em: "asc" },
    }),
  ]);

  const alocacao: AlocacaoPorAlvo[] = alvosVigentes.map((alvo) => {
    const valorAtualCentavos = classificacao.valorPorAlvoId.get(alvo.id) ?? 0;
    const percentualAtualBps =
      classificacao.patrimonioNaCarteiraCentavos > 0
        ? Math.trunc((valorAtualCentavos * 10000) / classificacao.patrimonioNaCarteiraCentavos)
        : 0;
    const desvioBps = percentualAtualBps - alvo.percentual_alvo_bps;

    return {
      alvoId: alvo.id,
      nomeAlvo: alvo.nome,
      percentualAlvoBps: alvo.percentual_alvo_bps,
      valorAtualCentavos,
      percentualAtualBps,
      desvioBps,
      dentroDaBanda: Math.abs(desvioBps) <= bandaToleranciaBps,
    };
  });

  return {
    vazio: false,
    sessaoImportId: sessao.id,
    dataExport: sessao.data_export,
    mesReferencia: sessao.mes_referencia,
    patrimonioTotalCentavos: classificacao.patrimonioTotalCentavos,
    patrimonioNaCarteiraCentavos: classificacao.patrimonioNaCarteiraCentavos,
    patrimonioForaDaCarteiraCentavos: classificacao.patrimonioForaDaCarteiraCentavos,
    patrimonioPendenteCentavos: classificacao.patrimonioPendenteCentavos,
    alocacao,
    foraDaCarteira: classificacao.foraDaCarteira,
    pendentes: classificacao.pendentes,
    qtdPendencias,
    bandaToleranciaBps,
  };
}

/** Soma `valor_centavos` das linhas de um JSON `LinhaAporte[]` (aporte.sugestao/executado). */
function somarLinhasAporte(json: string): number {
  try {
    const linhas = JSON.parse(json) as Array<{ valor_centavos?: number }>;
    return linhas.reduce((acc, linha) => acc + (linha.valor_centavos ?? 0), 0);
  } catch {
    // JSON corrompido/inesperado nunca deveria ocorrer (só este módulo e
    // aporte-service.registrarAporte escrevem esses campos) — falha
    // silenciosamente para 0 em vez de quebrar a tela inteira de histórico
    // por causa de um único registro.
    return 0;
  }
}

/**
 * Dados da tela 6.7 (histórico): série mensal patrimonial (só sessões
 * VIGENTES — nunca as SUBSTITUIDAS, que ficam à parte na auditoria), linha
 * do tempo sugerido vs. executado por aporte registrado, e acesso de
 * auditoria às sessões SUBSTITUIDAS (FR-041/042).
 */
export async function dadosHistorico(): Promise<DadosHistoricoOutput> {
  const [sessoesVigentes, sessoesSubstituidasBrutas, aportesBrutos] = await Promise.all([
    prisma.sessao_import.findMany({
      where: { status: "VIGENTE" },
      orderBy: { mes_referencia: "asc" },
      include: { posicoes: { select: { patrimonio_hoje_centavos: true } } },
    }),
    prisma.sessao_import.findMany({
      where: { status: "SUBSTITUIDO" },
      orderBy: [{ mes_referencia: "desc" }, { criado_em: "desc" }],
      include: { posicoes: { select: { patrimonio_hoje_centavos: true } } },
    }),
    prisma.aporte.findMany({
      include: { sessao_import: { select: { mes_referencia: true } } },
    }),
  ]);

  const serieMensal: PontoSerieMensal[] = sessoesVigentes.map((sessao) => ({
    sessaoImportId: sessao.id,
    mesReferencia: sessao.mes_referencia,
    dataExport: sessao.data_export,
    patrimonioTotalCentavos: sessao.posicoes.reduce(
      (acc, p) => acc + p.patrimonio_hoje_centavos,
      0,
    ),
  }));

  const linhaDoTempoAportes: PontoAporteHistorico[] = aportesBrutos
    .map((aporte) => ({
      aporteId: aporte.id,
      mesReferencia: aporte.sessao_import.mes_referencia,
      criadoEm: aporte.criado_em,
      sugeridoCentavos: somarLinhasAporte(aporte.sugestao),
      executadoCentavos: somarLinhasAporte(aporte.executado),
      valorTotalCentavos: aporte.valor_total_centavos,
      trocoCentavos: aporte.troco_centavos,
    }))
    .sort(
      (a, b) =>
        a.mesReferencia.localeCompare(b.mesReferencia) || a.criadoEm.getTime() - b.criadoEm.getTime(),
    );

  const sessoesSubstituidas: SessaoSubstituidaAuditoria[] = sessoesSubstituidasBrutas.map(
    (sessao) => ({
      sessaoImportId: sessao.id,
      mesReferencia: sessao.mes_referencia,
      dataExport: sessao.data_export,
      criadoEm: sessao.criado_em,
      instituicoes: JSON.parse(sessao.instituicoes) as string[],
      patrimonioTotalCentavos: sessao.posicoes.reduce(
        (acc, p) => acc + p.patrimonio_hoje_centavos,
        0,
      ),
    }),
  );

  return { serieMensal, linhaDoTempoAportes, sessoesSubstituidas };
}
