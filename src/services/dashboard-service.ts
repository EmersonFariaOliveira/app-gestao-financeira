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
//    - `patrimonioTotalCentavos` = soma das posições consolidadas da sessão
//      vigente EXCETO as marcadas `ignorar_no_import = true` (é o número
//      "quanto eu tenho, no total, ponto final" do topo do dashboard — ver
//      nota sobre `patrimonioIgnoradoCentavos` abaixo para o porquê da
//      exclusão).
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
//    - `patrimonioReservaEmergenciaCentavos` = soma das posições marcadas
//      `reserva_emergencia = true` — excluídas da base (mesmo tratamento de
//      exclusão que `fora_da_carteira`), mas exibidas em um balde ISOLADO
//      próprio (`reservaEmergencia: {chaveExport, valorCentavos}[]`), nunca
//      misturado com `foraDaCarteira` nem com `pendentes`/alocação por alvo.
//    - `patrimonioPendenteCentavos` = soma das posições sem vínculo resolvido
//      (`alvo_id = null AND fora_da_carteira = false AND reserva_emergencia
//      = false AND ignorar_no_import = false`, incluindo — defensivamente,
//      igual a `aporte-service.listarPendenciasDaSessao` — chaves sem
//      NENHUM registro de `ativo_mapeado`). Não é "fora da carteira" nem
//      "reserva de emergência" nem "ignorado" (decisões do usuário) nem "na
//      carteira" (ainda sem alvo) — listado à parte em `pendentes`, como
//      contraparte financeira do alerta de contagem (`contarPendencias()`,
//      que só conta, não soma valor).
//    - `patrimonioIgnoradoCentavos` = soma das posições marcadas
//      `ignorar_no_import = true` — estado RESOLVIDO (o usuário decidiu
//      explicitamente ignorar essa chave do CSV porque será substituída por
//      uma `posicao_manual`), checado com a MESMA prioridade de
//      `mapeamento-service.listarVinculos` (`ignorar_no_import` vem ANTES
//      de fora_da_carteira/reserva_emergencia/alvo_id). Excluída da base do
//      motor e de TODOS os outros baldes — nunca infla
//      `patrimonioPendenteCentavos`, `patrimonioNaCarteiraCentavos` NEM
//      `patrimonioTotalCentavos` ("quanto eu tenho" nunca deveria contar uma
//      posição que o usuário já declarou substituída por uma
//      `posicao_manual`; somá-la infla o número do topo do dashboard).
//      `posicao_manual` não tem campo equivalente (ela É a substituta, não a
//      ignorada), então este balde só existe do lado de `ativo_mapeado` e é
//      retornado à parte (`patrimonioIgnoradoCentavos`) só para quem
//      precisar auditar o valor ignorado — hoje nenhuma tela o exibe.
//    - Invariante: `patrimonioTotalCentavos === patrimonioNaCarteiraCentavos +
//      patrimonioForaDaCarteiraCentavos + patrimonioReservaEmergenciaCentavos +
//      patrimonioPendenteCentavos` (SEM somar `patrimonioIgnoradoCentavos`).
//    - `posicao_manual` (feature 002-posicoes-manuais-ajustes) participa dos
//      quatro totais acima com a MESMA máquina de estados e a MESMA
//      prioridade de classificação de `ativo_mapeado` (foraDaCarteira →
//      reservaEmergencia → alvo_id → pendente) — ver
//      `classificarPosicoesDaSessao` abaixo. Diferença central: uma posição
//      manual só entra no cálculo de UM mês específico se tiver um
//      `posicao_manual_valor` cujo `sessao_import_id` seja EXATAMENTE a
//      sessão vigente resolvida por `dadosDashboard` (nunca "último snapshot
//      conhecido de qualquer sessão"); sem esse snapshot, a posição é
//      omitida silenciosamente deste dashboard (mesmo comportamento de
//      `aporte-service.montarContextoEntradaMotor`, §2.2/§2.3). E usa SEMPRE
//      `valor_atual_centavos` — nunca `valor_investido_centavos` (FR-006/
//      SC-004, inviolável). `qtdPendencias` soma `contarPendencias()` (CSV)
//      + posições manuais pendentes (independente de sessão, mesma decisão
//      de `aporte-service.listarPendencias`).
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

/**
 * Alocação atual vs. alvo agrupada por `tag` (categorização livre do
 * usuário — ex.: A-AÇÕES, R-REAL ESTATE, C-CAIXA). Alvos sem `tag` entram no
 * grupo "Sem tag". Mesma segunda passada sobre os dados já buscados por
 * `dadosDashboard` para montar `alocacao`; nenhuma query nova. Segue
 * EXATAMENTE a mesma fórmula de `percentualAtualBps`/`desvioBps`/
 * `dentroDaBanda` já usada por alvo (ver `AlocacaoPorAlvo`), só que somando
 * `percentual_alvo_bps`/`valorAtualCentavos` de todos os alvos do grupo antes
 * de aplicar a fórmula.
 */
export interface AlocacaoPorTag {
  /** Nome livre da tag, ou `"Sem tag"` para alvos sem `tag` definida. */
  tag: string;
  qtdAlvos: number;
  /** Soma de `percentual_alvo_bps` dos alvos do grupo. */
  percentualAlvoBps: number;
  /** Soma de `valorAtualCentavos` dos alvos do grupo. */
  valorAtualCentavos: number;
  /** `valorAtualCentavos` do grupo / `patrimonioNaCarteiraCentavos` * 10000, truncado — mesma fórmula usada por alvo. */
  percentualAtualBps: number;
  /** `percentualAtualBps - percentualAlvoBps` do grupo. */
  desvioBps: number;
  /** `Math.abs(desvioBps) <= bandaToleranciaBps` — mesma regra usada por alvo. */
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
  /** Soma das posições marcadas `reserva_emergencia = true` — balde isolado, ver nota de design acima. */
  patrimonioReservaEmergenciaCentavos: number;
  patrimonioPendenteCentavos: number;
  /** Soma das posições marcadas `ignorar_no_import = true` — estado RESOLVIDO, ver nota de design acima. */
  patrimonioIgnoradoCentavos: number;
  alocacao: AlocacaoPorAlvo[];
  /** Mesma alocação de `alocacao`, agrupada por `tag` — ver `AlocacaoPorTag`. */
  alocacaoPorTag: AlocacaoPorTag[];
  foraDaCarteira: AtivoComValor[];
  /** Balde isolado "reserva de emergência" — nunca misturado com `foraDaCarteira`/`pendentes`. */
  reservaEmergencia: AtivoComValor[];
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

/**
 * Quantidade de `posicao_manual` pendentes (mesmo critério de pendência de
 * `ativo_mapeado`: `alvo_id = null AND fora_da_carteira = false AND
 * reserva_emergencia = false`), independente de sessão (`posicao_manual` não
 * é filha de `sessao_import` — mesma decisão de
 * `aporte-service.listarPendenciasPosicoesManuais`). Query de contagem
 * direta (não `posicao-manual-service.listarPosicoesManuaisParaVinculo`, que
 * monta os 4 baldes com snapshot incluído) porque só o número é necessário
 * aqui — evitaria uma query extra de `posicao_manual_valor` sem uso.
 */
async function contarPendenciasPosicoesManuais(): Promise<number> {
  return prisma.posicao_manual.count({
    where: { ativo: true, alvo_id: null, fora_da_carteira: false, reserva_emergencia: false },
  });
}

interface ClassificacaoPosicoes {
  patrimonioTotalCentavos: number;
  patrimonioNaCarteiraCentavos: number;
  patrimonioForaDaCarteiraCentavos: number;
  patrimonioReservaEmergenciaCentavos: number;
  patrimonioPendenteCentavos: number;
  patrimonioIgnoradoCentavos: number;
  valorPorAlvoId: Map<string, number>;
  foraDaCarteira: AtivoComValor[];
  reservaEmergencia: AtivoComValor[];
  pendentes: AtivoComValor[];
}

/**
 * Consolida as posições de uma sessão por `chave_export` (mesma chave em
 * instituições diferentes = uma posição só, somando patrimônio — data-model.md)
 * e classifica cada uma em vinculada / fora-da-carteira / reserva-de-emergência /
 * pendente, espelhando EXATAMENTE a condição de exclusão de
 * `src/core/motor/deficit.ts` (`foraDaCarteira || alvoId === null` ⇒ fora da
 * base) para que `patrimonioNaCarteiraCentavos` seja idêntico ao
 * `patrimonioBaseCentavos` que o motor usaria hoje. `reserva_emergencia`
 * também tem `alvo_id = null` (invariante da aplicação), então já cairia na
 * mesma exclusão do motor — aqui ela é classificada num branch próprio, ANTES
 * do branch de "pendente", para ser exibida em um balde isolado em vez de
 * cair em `pendentes`. `ignorar_no_import` (também `alvo_id = null`) tem
 * PRIORIDADE MÁXIMA na classificação — checado ANTES de fora_da_carteira/
 * reserva_emergencia/alvo_id, mesma ordem de `mapeamento-service.
 * listarVinculos` — porque é um estado RESOLVIDO (substituído por
 * `posicao_manual`), não uma pendência.
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
  let patrimonioReservaEmergenciaCentavos = 0;
  let patrimonioPendenteCentavos = 0;
  let patrimonioIgnoradoCentavos = 0;
  const valorPorAlvoId = new Map<string, number>();
  const foraDaCarteira: AtivoComValor[] = [];
  const reservaEmergencia: AtivoComValor[] = [];
  const pendentes: AtivoComValor[] = [];

  for (const [chaveExport, valorCentavos] of valorPorChave) {
    const mapeamento = mapaPorChave.get(chaveExport);
    const alvoId = mapeamento?.alvo_id ?? null;
    const ignorarNoImportFlag = mapeamento?.ignorar_no_import ?? false;
    const foraDaCarteiraFlag = mapeamento?.fora_da_carteira ?? false;
    const reservaEmergenciaFlag = mapeamento?.reserva_emergencia ?? false;

    if (ignorarNoImportFlag) {
      // Estado RESOLVIDO com PRIORIDADE MÁXIMA (mesma ordem de
      // mapeamento-service.listarVinculos) — excluído de todos os outros
      // baldes/base do motor; nunca infla patrimonioPendenteCentavos nem
      // patrimonioNaCarteiraCentavos.
      patrimonioIgnoradoCentavos += valorCentavos;
    } else if (foraDaCarteiraFlag) {
      patrimonioForaDaCarteiraCentavos += valorCentavos;
      foraDaCarteira.push({ chaveExport, valorCentavos });
    } else if (reservaEmergenciaFlag) {
      // Balde isolado próprio — nunca misturado com foraDaCarteira nem com
      // a alocação por alvo (mesmo tratamento de exclusão da base, mas
      // exibição separada).
      patrimonioReservaEmergenciaCentavos += valorCentavos;
      reservaEmergencia.push({ chaveExport, valorCentavos });
    } else if (alvoId !== null) {
      patrimonioNaCarteiraCentavos += valorCentavos;
      valorPorAlvoId.set(alvoId, (valorPorAlvoId.get(alvoId) ?? 0) + valorCentavos);
    } else {
      // Pendente (ou chave sem NENHUM ativo_mapeado — mesmo tratamento
      // defensivo de aporte-service.listarPendenciasDaSessao): fica de fora
      // da base do motor e dos buckets fora-da-carteira/reserva-de-emergência;
      // listado à parte.
      patrimonioPendenteCentavos += valorCentavos;
      pendentes.push({ chaveExport, valorCentavos });
    }
  }

  // posicao_manual (feature 002-posicoes-manuais-ajustes): mesma máquina de
  // estados de ativo_mapeado, mas nunca é filha de sessao_import — para
  // entrar no cálculo/exibição de UM mês específico, precisa ter um
  // posicao_manual_valor cujo `sessao_import_id` seja EXATAMENTE a sessão
  // vigente resolvida por `dadosDashboard` (nunca "último snapshot conhecido
  // de qualquer sessão" — isso seria inconsistente com o tratamento de
  // `posicao` acima, que também está sempre escopado à sessão específica).
  // Uma posição manual ativa SEM snapshot nesta sessão é omitida
  // silenciosamente (mesmo comportamento de
  // aporte-service.montarContextoEntradaMotor, §2.2/§2.3): ainda não existe
  // dado suficiente para ela entrar este mês, e isso não é um erro.
  const posicoesManuaisAtivas = await prisma.posicao_manual.findMany({
    where: { ativo: true },
  });
  if (posicoesManuaisAtivas.length > 0) {
    const snapshots = await prisma.posicao_manual_valor.findMany({
      where: {
        sessao_import_id: sessaoId,
        posicao_manual_id: { in: posicoesManuaisAtivas.map((p) => p.id) },
      },
    });
    const snapshotPorPosicaoManualId = new Map(snapshots.map((s) => [s.posicao_manual_id, s]));

    for (const posicaoManual of posicoesManuaisAtivas) {
      const snapshot = snapshotPorPosicaoManualId.get(posicaoManual.id);
      if (!snapshot) continue;

      // FR-006/SC-004 (inviolável): patrimônio SEMPRE usa
      // valor_atual_centavos — valor_investido_centavos nunca entra em
      // nenhum cálculo/exibição de patrimônio.
      const valorCentavos = snapshot.valor_atual_centavos;
      const chaveExport = posicaoManual.chave_manual;

      if (posicaoManual.fora_da_carteira) {
        patrimonioForaDaCarteiraCentavos += valorCentavos;
        foraDaCarteira.push({ chaveExport, valorCentavos });
      } else if (posicaoManual.reserva_emergencia) {
        patrimonioReservaEmergenciaCentavos += valorCentavos;
        reservaEmergencia.push({ chaveExport, valorCentavos });
      } else if (posicaoManual.alvo_id !== null) {
        patrimonioNaCarteiraCentavos += valorCentavos;
        valorPorAlvoId.set(
          posicaoManual.alvo_id,
          (valorPorAlvoId.get(posicaoManual.alvo_id) ?? 0) + valorCentavos,
        );
      } else {
        patrimonioPendenteCentavos += valorCentavos;
        pendentes.push({ chaveExport, valorCentavos });
      }
    }
  }

  // patrimonioTotalCentavos = soma dos baldes que NÃO excluem a posição da
  // exibição (na carteira + fora da carteira + reserva de emergência +
  // pendente) — NUNCA soma patrimonioIgnoradoCentavos, que é um estado
  // RESOLVIDO excluído de TODAS as somas do sistema (ver nota de design no
  // topo do arquivo e aporte-service.montarContextoEntradaMotor, que já
  // exclui `ignorar_no_import` "INTEIRAMENTE da consolidação do CSV").
  patrimonioTotalCentavos =
    patrimonioNaCarteiraCentavos +
    patrimonioForaDaCarteiraCentavos +
    patrimonioReservaEmergenciaCentavos +
    patrimonioPendenteCentavos;

  return {
    patrimonioTotalCentavos,
    patrimonioNaCarteiraCentavos,
    patrimonioForaDaCarteiraCentavos,
    patrimonioReservaEmergenciaCentavos,
    patrimonioPendenteCentavos,
    patrimonioIgnoradoCentavos,
    valorPorAlvoId,
    foraDaCarteira,
    reservaEmergencia,
    pendentes,
  };
}

/** Rótulo do grupo de alvos sem `tag` definida — sempre por último na ordenação de `alocacaoPorTag`. */
const SEM_TAG = "Sem tag";

/**
 * Agrupa os alvos vigentes por `tag` e soma `percentual_alvo_bps`/
 * `valorAtualCentavos` (via `valorPorAlvoId`, já calculado por
 * `classificarPosicoesDaSessao`) dentro de cada grupo, aplicando por grupo a
 * MESMA fórmula de `percentualAtualBps`/`desvioBps`/`dentroDaBanda` já usada
 * por alvo em `dadosDashboard` (nenhuma query nova — segunda passada sobre
 * dados já buscados). Alvos sem `tag` entram em `SEM_TAG`. Ordenado
 * alfabeticamente por `tag`, com `SEM_TAG` sempre por último.
 */
function agruparAlocacaoPorTag(
  alvosVigentes: Array<{ id: string; tag: string | null; percentual_alvo_bps: number }>,
  valorPorAlvoId: Map<string, number>,
  patrimonioNaCarteiraCentavos: number,
  bandaToleranciaBps: number,
): AlocacaoPorTag[] {
  interface Acumulador {
    qtdAlvos: number;
    percentualAlvoBps: number;
    valorAtualCentavos: number;
  }
  const grupos = new Map<string, Acumulador>();

  for (const alvo of alvosVigentes) {
    const tag = alvo.tag ?? SEM_TAG;
    const valorAtualCentavos = valorPorAlvoId.get(alvo.id) ?? 0;
    const acc = grupos.get(tag) ?? { qtdAlvos: 0, percentualAlvoBps: 0, valorAtualCentavos: 0 };
    acc.qtdAlvos += 1;
    acc.percentualAlvoBps += alvo.percentual_alvo_bps;
    acc.valorAtualCentavos += valorAtualCentavos;
    grupos.set(tag, acc);
  }

  const resultado: AlocacaoPorTag[] = Array.from(grupos.entries()).map(([tag, acc]) => {
    const percentualAtualBps =
      patrimonioNaCarteiraCentavos > 0
        ? Math.trunc((acc.valorAtualCentavos * 10000) / patrimonioNaCarteiraCentavos)
        : 0;
    const desvioBps = percentualAtualBps - acc.percentualAlvoBps;

    return {
      tag,
      qtdAlvos: acc.qtdAlvos,
      percentualAlvoBps: acc.percentualAlvoBps,
      valorAtualCentavos: acc.valorAtualCentavos,
      percentualAtualBps,
      desvioBps,
      dentroDaBanda: Math.abs(desvioBps) <= bandaToleranciaBps,
    };
  });

  return resultado.sort((a, b) => {
    if (a.tag === SEM_TAG) return b.tag === SEM_TAG ? 0 : 1;
    if (b.tag === SEM_TAG) return -1;
    return a.tag.localeCompare(b.tag);
  });
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
  const [sessao, bandaToleranciaBps, qtdPendenciasCsv, qtdPendenciasManuais] = await Promise.all([
    obterSessaoVigenteMaisRecente(),
    getConfig("banda_tolerancia_bps"),
    contarPendencias(),
    // posicao_manual não é filha de sessao_import — pendência manual conta
    // mesmo no branch "vazio" (sem sessão vigente nenhuma), mesma decisão já
    // tomada em aporte-service.listarPendencias.
    contarPendenciasPosicoesManuais(),
  ]);
  const qtdPendencias = qtdPendenciasCsv + qtdPendenciasManuais;

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

  const alocacaoPorTag = agruparAlocacaoPorTag(
    alvosVigentes,
    classificacao.valorPorAlvoId,
    classificacao.patrimonioNaCarteiraCentavos,
    bandaToleranciaBps,
  );

  return {
    vazio: false,
    sessaoImportId: sessao.id,
    dataExport: sessao.data_export,
    mesReferencia: sessao.mes_referencia,
    patrimonioTotalCentavos: classificacao.patrimonioTotalCentavos,
    patrimonioNaCarteiraCentavos: classificacao.patrimonioNaCarteiraCentavos,
    patrimonioForaDaCarteiraCentavos: classificacao.patrimonioForaDaCarteiraCentavos,
    patrimonioReservaEmergenciaCentavos: classificacao.patrimonioReservaEmergenciaCentavos,
    patrimonioPendenteCentavos: classificacao.patrimonioPendenteCentavos,
    patrimonioIgnoradoCentavos: classificacao.patrimonioIgnoradoCentavos,
    alocacao,
    alocacaoPorTag,
    foraDaCarteira: classificacao.foraDaCarteira,
    reservaEmergencia: classificacao.reservaEmergencia,
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
 * Soma `patrimonio_hoje_centavos` das posições de uma sessão, EXCLUINDO as
 * marcadas `ignorar_no_import = true` em `ativo_mapeado` — mesma exclusão de
 * `classificarPosicoesDaSessao` (estado RESOLVIDO, substituído por
 * `posicao_manual`, nunca deveria inflar nenhuma soma de patrimônio do
 * sistema, nem aqui na série histórica/auditoria de sessões substituídas).
 * Cópia deliberada do padrão de consulta a `ativo_mapeado` por
 * `chave_export` já usado em `classificarPosicoesDaSessao` — não extraída
 * numa função 100% compartilhada porque as duas já são cópias intencionais
 * (ver nota da linha ~221-228 sobre duplicação deliberada entre este arquivo
 * e `aporte-service`); manter o mesmo padrão aqui evita acoplar as duas
 * funções por uma dependência nova só para uma soma simples.
 */
async function somarPatrimonioSemIgnorados(
  posicoes: Array<{ chave_export: string; patrimonio_hoje_centavos: number }>,
): Promise<number> {
  if (posicoes.length === 0) return 0;

  const chaves = Array.from(new Set(posicoes.map((p) => p.chave_export)));
  const mapeamentos = await prisma.ativo_mapeado.findMany({
    where: { chave_export: { in: chaves }, ignorar_no_import: true },
    select: { chave_export: true },
  });
  const chavesIgnoradas = new Set(mapeamentos.map((m) => m.chave_export));

  return posicoes.reduce(
    (acc, p) => (chavesIgnoradas.has(p.chave_export) ? acc : acc + p.patrimonio_hoje_centavos),
    0,
  );
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
      include: { posicoes: { select: { chave_export: true, patrimonio_hoje_centavos: true } } },
    }),
    prisma.sessao_import.findMany({
      where: { status: "SUBSTITUIDO" },
      orderBy: [{ mes_referencia: "desc" }, { criado_em: "desc" }],
      include: { posicoes: { select: { chave_export: true, patrimonio_hoje_centavos: true } } },
    }),
    prisma.aporte.findMany({
      include: { sessao_import: { select: { mes_referencia: true } } },
    }),
  ]);

  const serieMensal: PontoSerieMensal[] = await Promise.all(
    sessoesVigentes.map(async (sessao) => ({
      sessaoImportId: sessao.id,
      mesReferencia: sessao.mes_referencia,
      dataExport: sessao.data_export,
      patrimonioTotalCentavos: await somarPatrimonioSemIgnorados(sessao.posicoes),
    })),
  );

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

  const sessoesSubstituidas: SessaoSubstituidaAuditoria[] = await Promise.all(
    sessoesSubstituidasBrutas.map(async (sessao) => ({
      sessaoImportId: sessao.id,
      mesReferencia: sessao.mes_referencia,
      dataExport: sessao.data_export,
      criadoEm: sessao.criado_em,
      instituicoes: JSON.parse(sessao.instituicoes) as string[],
      patrimonioTotalCentavos: await somarPatrimonioSemIgnorados(sessao.posicoes),
    })),
  );

  return { serieMensal, linhaDoTempoAportes, sessoesSubstituidas };
}
