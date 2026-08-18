import { prisma } from "@/db/client";

// Serviço de vínculo ativo↔alvo (T040): fonte da verdade para o estado de
// `ativo_mapeado` (data-model.md) — quem lista pendências/vínculos e quem
// aplica as três formas de resolução da tela de vínculos
// (contracts/server-actions.md, `vinculos.ts`). Camada de I/O: importa
// Prisma livremente; não é importado por src/core/**.
//
// `import-service.ts` (T036) é quem CRIA `ativo_mapeado` pendente para
// chaves novas — este módulo nunca cria pendências, apenas resolve
// (UPDATE/upsert) registros que já existem ou, no caso de uma chave nunca
// vista pelo import-service, cria o registro já resolvido diretamente
// (upsert defensivo: não deveria ocorrer no fluxo normal, mas evita um
// vínculo "impossível de registrar" caso a UI seja usada fora de ordem).
//
// Invariante inviolável (data-model.md, `ativo_mapeado`): `alvo_id`,
// `fora_da_carteira = true` e `reserva_emergencia = true` são mutuamente
// exclusivos entre si (e com `ignorar_no_import = true`, exceto que
// `ignorar_no_import` convive com `alvo_id` preenchido — ver comentários
// específicos abaixo). Toda escrita neste arquivo zera explicitamente os
// lados opostos antes de setar um dos estados.

export interface VinculoPendente {
  chaveExport: string;
  valorAtualCentavos: number;
}

export interface VinculoVinculado {
  chaveExport: string;
  alvoId: string;
  nomeAlvo: string;
  valorAtualCentavos: number;
}

export interface VinculoForaDaCarteira {
  chaveExport: string;
  valorAtualCentavos: number;
}

/**
 * Balde "reserva de emergência" (novo estado, mesmo shape de
 * `VinculoForaDaCarteira`): `chave_export` reconhecida do CSV que NÃO entra
 * em nenhum déficit/alocação por alvo, mas é um grupo ISOLADO próprio —
 * nunca misturado com `foraDaCarteira` nem com `pendentes`/`vinculados`.
 */
export interface VinculoReservaEmergencia {
  chaveExport: string;
  valorAtualCentavos: number;
}

/**
 * Balde "ignorados" (feature 002, FR-001): `chave_export` lida do CSV mas
 * excluída da consolidação porque foi substituída por uma `posicao_manual`.
 * `valorAtualCentavos` é o valor bruto do CSV, exibido só como referência —
 * o motor usa o `valor_atual` da posição manual, nunca este campo.
 * `posicaoManualPendente = true` quando não existe nenhuma `posicao_manual`
 * ativa com o mesmo `alvoId` — heurística de UX (sem FK direta entre
 * `ativo_mapeado` e `posicao_manual`; data-model.md da feature 002).
 */
export interface IgnoradoRow {
  chaveExport: string;
  alvoId: string;
  nomeAlvo: string;
  valorAtualCentavos: number;
  posicaoManualPendente: boolean;
}

export interface ListarVinculosOutput {
  pendentes: VinculoPendente[];
  vinculados: VinculoVinculado[];
  foraDaCarteira: VinculoForaDaCarteira[];
  /** Balde isolado "reserva de emergência" — ver `VinculoReservaEmergencia`. */
  reservaEmergencia: VinculoReservaEmergencia[];
  ignorados: IgnoradoRow[];
}

export type VincularAtivoInput =
  | { chaveExport: string; alvoId: string }
  | { chaveExport: string; foraDaCarteira: true }
  | { chaveExport: string; novoAlvo: { nome: string; percentualBps: number } }
  // NOVO (feature 002, FR-001) — "Ignorar (substituído por posição manual)".
  // Reaproveita os mesmos dois sub-modos de escolha de alvo já existentes
  // acima; não existe um modo "ignorar sem alvo" (contracts/server-actions.md).
  | { chaveExport: string; ignorarNoImport: true; alvoId: string }
  | { chaveExport: string; ignorarNoImport: true; novoAlvo: { nome: string; percentualBps: number } }
  // NOVO — "Reserva de emergência": mesmo padrão de `{chaveExport,
  // foraDaCarteira: true}`, um estado isolado próprio (não combina com
  // ignorarNoImport por decisão explícita, fora de escopo por ora).
  | { chaveExport: string; reservaEmergencia: true };

export interface VinculoAtualizado {
  chaveExport: string;
  alvoId: string | null;
  nomeAlvo: string | null;
  foraDaCarteira: boolean;
  /** Sempre presente, mesmo padrão de `foraDaCarteira` — `true` só na forma `{reservaEmergencia: true}`. */
  reservaEmergencia: boolean;
  /**
   * Presentes apenas quando a resolução foi feita com `ignorarNoImport: true`
   * (contracts/server-actions.md) — omitidos (`undefined`) nas demais formas
   * para não alterar o shape que a tela 6.3 já consome há mais tempo.
   */
  ignorarNoImport?: boolean;
  posicaoManualPendente?: boolean;
}

/**
 * Sessão VIGENTE mais recente (mesmo critério de
 * `dashboard-service.obterSessaoVigenteMaisRecente`/
 * `aporte-service.obterSessaoVigenteMaisRecente`). Cópia intencional da
 * mesma query — não importada dos outros módulos (funções privadas deles)
 * para não acoplar os serviços por uma função interna; os três locais devem
 * permanecer idênticos se a regra mudar (só duas linhas de query, baixo
 * risco de divergência silenciosa).
 */
async function obterSessaoVigenteMaisRecente() {
  return prisma.sessao_import.findFirst({
    where: { status: "VIGENTE" },
    orderBy: [{ data_export: "desc" }, { criado_em: "desc" }],
  });
}

/**
 * Valor consolidado (soma de `patrimonio_hoje_centavos`) por `chave_export`
 * na sessão VIGENTE mais recente — mesmo padrão de consolidação de
 * `dashboard-service.classificarPosicoesDaSessao` (uma chave pode aparecer
 * em instituições diferentes; consolida-se numa posição só). Se não houver
 * nenhuma sessão VIGENTE ainda (app recém-instalado), retorna um Map vazio
 * — chamador trata ausência como `0`, nunca lança erro.
 */
async function obterValorAtualPorChave(): Promise<Map<string, number>> {
  const sessao = await obterSessaoVigenteMaisRecente();
  const valorPorChave = new Map<string, number>();
  if (!sessao) return valorPorChave;

  const posicoesBrutas = await prisma.posicao.findMany({
    where: { sessao_import_id: sessao.id },
    select: { chave_export: true, patrimonio_hoje_centavos: true },
  });

  for (const p of posicoesBrutas) {
    valorPorChave.set(
      p.chave_export,
      (valorPorChave.get(p.chave_export) ?? 0) + p.patrimonio_hoje_centavos,
    );
  }

  return valorPorChave;
}

/**
 * `alvoId`s que têm ao menos uma `posicao_manual` ATIVA associada — usado
 * pela heurística de `posicaoManualPendente` (feature 002, FR-001; sem FK
 * direta entre `ativo_mapeado` e `posicao_manual`, data-model.md).
 */
async function obterAlvoIdsComPosicaoManualAtiva(): Promise<Set<string>> {
  const posicoesManuaisAtivas = await prisma.posicao_manual.findMany({
    where: { ativo: true },
    select: { alvo_id: true },
  });
  return new Set(posicoesManuaisAtivas.map((p) => p.alvo_id));
}

/**
 * Estado completo de `ativo_mapeado` (data-model.md, "Estados derivados"),
 * agrupado nos cinco baldes da tela 6.3 (`reservaEmergencia` é o mais
 * novo — balde isolado, nunca misturado com `foraDaCarteira`).
 * `vinculados` traz `nomeAlvo`
 * denormalizado para exibição direta (N-para-1: vários `chaveExport` podem
 * repetir o mesmo `alvoId`/`nomeAlvo` — agrupável no cliente por `alvoId`).
 *
 * Cada balde também traz `valorAtualCentavos`: o patrimônio consolidado da
 * `chave_export` na sessão VIGENTE mais recente (mesmo padrão de
 * `dashboard-service.classificarPosicoesDaSessao`). Uma `chave_export` sem
 * posição na sessão vigente (ativo zerado/vendido, ou nunca chegou a ter
 * posição na sessão atual) recebe `0` — nunca lança erro por ausência.
 *
 * `ignorados` (feature 002, FR-001): `chave_export` com `ignorar_no_import
 * = true` — checado ANTES de `fora_da_carteira`/`alvo_id`, já que a
 * invariante do data-model garante exclusão mútua com `fora_da_carteira` e
 * o `alvo_id` continua preenchido (não é o mesmo estado de "vinculado" —
 * some do balde `vinculados` e vira `ignorados`).
 */
export async function listarVinculos(): Promise<ListarVinculosOutput> {
  const [registros, valorPorChave, alvoIdsComPosicaoManualAtiva] = await Promise.all([
    prisma.ativo_mapeado.findMany({
      include: { alvo: true },
      orderBy: { chave_export: "asc" },
    }),
    obterValorAtualPorChave(),
    obterAlvoIdsComPosicaoManualAtiva(),
  ]);

  const pendentes: VinculoPendente[] = [];
  const vinculados: VinculoVinculado[] = [];
  const foraDaCarteira: VinculoForaDaCarteira[] = [];
  const reservaEmergencia: VinculoReservaEmergencia[] = [];
  const ignorados: IgnoradoRow[] = [];

  for (const registro of registros) {
    const valorAtualCentavos = valorPorChave.get(registro.chave_export) ?? 0;

    if (registro.ignorar_no_import) {
      const alvoId = registro.alvo_id ?? "";
      ignorados.push({
        chaveExport: registro.chave_export,
        alvoId,
        nomeAlvo: registro.alvo?.nome ?? alvoId,
        valorAtualCentavos,
        posicaoManualPendente: !alvoIdsComPosicaoManualAtiva.has(alvoId),
      });
    } else if (registro.fora_da_carteira) {
      // Estado "fora da carteira" — independente de alvo_id (que, pela
      // invariante, deve estar null aqui; ver nota em vincularAtivo).
      foraDaCarteira.push({ chaveExport: registro.chave_export, valorAtualCentavos });
    } else if (registro.reserva_emergencia) {
      // Estado "reserva de emergência" — balde ISOLADO próprio, nunca
      // misturado com foraDaCarteira nem com pendentes/vinculados (alvo_id
      // também deve estar null aqui, pela invariante).
      reservaEmergencia.push({ chaveExport: registro.chave_export, valorAtualCentavos });
    } else if (registro.alvo_id !== null) {
      vinculados.push({
        chaveExport: registro.chave_export,
        alvoId: registro.alvo_id,
        nomeAlvo: registro.alvo?.nome ?? registro.alvo_id,
        valorAtualCentavos,
      });
    } else {
      // Pendente: alvo_id = null AND fora_da_carteira = false AND
      // reserva_emergencia = false — bloqueia a calculadora (FR-015).
      // aporte-service.listarPendencias faz a mesma checagem hoje (duplicada
      // por decisão explícita da task: não alterar aporte-service nesta
      // task); este é o balde equivalente.
      pendentes.push({ chaveExport: registro.chave_export, valorAtualCentavos });
    }
  }

  return { pendentes, vinculados, foraDaCarteira, reservaEmergencia, ignorados };
}

/**
 * Quantidade de `ativo_mapeado` pendentes (alvo_id null AND fora_da_carteira
 * false AND reserva_emergencia false — reserva de emergência é um estado
 * RESOLVIDO, não conta como pendência).
 */
export async function contarPendencias(): Promise<number> {
  return prisma.ativo_mapeado.count({
    where: { alvo_id: null, fora_da_carteira: false, reserva_emergencia: false },
  });
}

/** Alvo vigente (vigencia_fim = null) por id, ou null se não existir/estiver fechado. */
async function obterAlvoVigentePorId(alvoId: string) {
  return prisma.alvo.findFirst({ where: { id: alvoId, vigencia_fim: null } });
}

/**
 * Resolve o vínculo de uma `chave_export` nas três formas do contrato
 * (contracts/server-actions.md, `vincularAtivo`). Em todos os casos o
 * registro de `ativo_mapeado` é criado (se ainda não existir) ou atualizado
 * (upsert) — nunca duplicado, já que `chave_export` é `@unique`.
 */
export async function vincularAtivo(input: VincularAtivoInput): Promise<VinculoAtualizado> {
  // `ignorarNoImport` é checado primeiro: as duas formas novas (feature 002)
  // reaproveitam os mesmos sub-modos `alvoId`/`novoAlvo` das formas
  // pré-existentes, então o discriminante precisa vir antes deles.
  if ("ignorarNoImport" in input && input.ignorarNoImport) {
    if ("novoAlvo" in input) {
      return vincularIgnorarNoImportComNovoAlvo(input.chaveExport, input.novoAlvo);
    }
    return vincularIgnorarNoImportComAlvoExistente(input.chaveExport, input.alvoId);
  }
  if ("novoAlvo" in input) {
    return vincularNovoAlvo(input.chaveExport, input.novoAlvo);
  }
  if ("reservaEmergencia" in input && input.reservaEmergencia) {
    return marcarReservaEmergencia(input.chaveExport);
  }
  // Após excluir `novoAlvo`/`reservaEmergencia`, resta `{alvoId}` |
  // `{foraDaCarteira: true}` — o discriminante `"alvoId" in input` narrowa
  // positivamente para o primeiro e, por eliminação, o `else` só pode ser o
  // segundo (narrowing negativo de `"in"` combinado com `&&` não é
  // confiável no TS, daí a ordem aqui).
  if ("alvoId" in input) {
    return vincularAlvoExistente(input.chaveExport, input.alvoId);
  }
  return marcarForaDaCarteira(input.chaveExport);
}

/** Forma `{chaveExport, alvoId}` — vincula a um alvo EXISTENTE da vigência aberta. */
async function vincularAlvoExistente(
  chaveExport: string,
  alvoId: string,
): Promise<VinculoAtualizado> {
  const alvo = await obterAlvoVigentePorId(alvoId);
  if (!alvo) {
    throw new Error(
      `vincularAtivo: alvo "${alvoId}" não encontrado na vigência aberta (vigencia_fim = null).`,
    );
  }

  // Exclusão mútua (data-model.md): vincular a um alvo sempre zera
  // fora_da_carteira e reserva_emergencia, independentemente do estado
  // anterior do registro.
  const mapeamento = await prisma.ativo_mapeado.upsert({
    where: { chave_export: chaveExport },
    create: {
      chave_export: chaveExport,
      alvo_id: alvo.id,
      fora_da_carteira: false,
      reserva_emergencia: false,
    },
    update: { alvo_id: alvo.id, fora_da_carteira: false, reserva_emergencia: false },
  });

  return {
    chaveExport: mapeamento.chave_export,
    alvoId: alvo.id,
    nomeAlvo: alvo.nome,
    foraDaCarteira: false,
    reservaEmergencia: false,
  };
}

/** Forma `{chaveExport, foraDaCarteira: true}` — marca fora-da-carteira, zerando alvo_id e reserva_emergencia. */
async function marcarForaDaCarteira(chaveExport: string): Promise<VinculoAtualizado> {
  // Exclusão mútua (data-model.md): marcar fora-da-carteira sempre zera
  // alvo_id e reserva_emergencia, independentemente do estado anterior do
  // registro.
  const mapeamento = await prisma.ativo_mapeado.upsert({
    where: { chave_export: chaveExport },
    create: { chave_export: chaveExport, alvo_id: null, fora_da_carteira: true, reserva_emergencia: false },
    update: { alvo_id: null, fora_da_carteira: true, reserva_emergencia: false },
  });

  return {
    chaveExport: mapeamento.chave_export,
    alvoId: null,
    nomeAlvo: null,
    foraDaCarteira: true,
    reservaEmergencia: false,
  };
}

/**
 * Forma `{chaveExport, reservaEmergencia: true}` — marca "reserva de
 * emergência", zerando alvo_id, fora_da_carteira e ignorar_no_import. Mesmo
 * padrão de `marcarForaDaCarteira`, mas para o balde isolado próprio de
 * reserva de emergência (não combina com ignorar_no_import por decisão
 * explícita, fora de escopo por ora).
 */
async function marcarReservaEmergencia(chaveExport: string): Promise<VinculoAtualizado> {
  const mapeamento = await prisma.ativo_mapeado.upsert({
    where: { chave_export: chaveExport },
    create: {
      chave_export: chaveExport,
      alvo_id: null,
      fora_da_carteira: false,
      ignorar_no_import: false,
      reserva_emergencia: true,
    },
    update: {
      alvo_id: null,
      fora_da_carteira: false,
      ignorar_no_import: false,
      reserva_emergencia: true,
    },
  });

  return {
    chaveExport: mapeamento.chave_export,
    alvoId: null,
    nomeAlvo: null,
    foraDaCarteira: false,
    reservaEmergencia: true,
  };
}

/**
 * Forma `{chaveExport, novoAlvo: {nome, percentualBps}}` — cria um alvo novo
 * na vigência aberta atual (vigencia_inicio = agora, vigencia_fim = null) e
 * vincula a chave a ele na MESMA transação (FR-012): nunca existe um estado
 * intermediário em que o alvo foi criado mas o vínculo não foi aplicado, nem
 * vice-versa.
 */
async function vincularNovoAlvo(
  chaveExport: string,
  novoAlvo: { nome: string; percentualBps: number },
): Promise<VinculoAtualizado> {
  return prisma.$transaction(async (tx) => {
    const alvo = await tx.alvo.create({
      data: {
        nome: novoAlvo.nome,
        percentual_alvo_bps: novoAlvo.percentualBps,
        vigencia_inicio: new Date(),
        vigencia_fim: null,
      },
    });

    const mapeamento = await tx.ativo_mapeado.upsert({
      where: { chave_export: chaveExport },
      create: {
        chave_export: chaveExport,
        alvo_id: alvo.id,
        fora_da_carteira: false,
        reserva_emergencia: false,
      },
      update: { alvo_id: alvo.id, fora_da_carteira: false, reserva_emergencia: false },
    });

    return {
      chaveExport: mapeamento.chave_export,
      alvoId: alvo.id,
      nomeAlvo: alvo.nome,
      foraDaCarteira: false,
      reservaEmergencia: false,
    };
  });
}

/**
 * Forma `{chaveExport, ignorarNoImport: true, alvoId}` (feature 002,
 * FR-001) — marca `ignorar_no_import = true` e preserva o `alvo_id`
 * escolhido (não é descartado: é o "mesmo alvo" que a `posicao_manual`
 * substituta deverá usar, contracts/server-actions.md). `fora_da_carteira`
 * permanece `false` — invariante de exclusão mútua do data-model.md.
 */
async function vincularIgnorarNoImportComAlvoExistente(
  chaveExport: string,
  alvoId: string,
): Promise<VinculoAtualizado> {
  const alvo = await obterAlvoVigentePorId(alvoId);
  if (!alvo) {
    throw new Error(
      `vincularAtivo: alvo "${alvoId}" não encontrado na vigência aberta (vigencia_fim = null).`,
    );
  }

  const mapeamento = await prisma.ativo_mapeado.upsert({
    where: { chave_export: chaveExport },
    create: {
      chave_export: chaveExport,
      alvo_id: alvo.id,
      fora_da_carteira: false,
      ignorar_no_import: true,
      reserva_emergencia: false,
    },
    update: {
      alvo_id: alvo.id,
      fora_da_carteira: false,
      ignorar_no_import: true,
      reserva_emergencia: false,
    },
  });

  const posicaoManualPendente = !(await obterAlvoIdsComPosicaoManualAtiva()).has(alvo.id);

  return {
    chaveExport: mapeamento.chave_export,
    alvoId: alvo.id,
    nomeAlvo: alvo.nome,
    foraDaCarteira: false,
    reservaEmergencia: false,
    ignorarNoImport: true,
    posicaoManualPendente,
  };
}

/**
 * Forma `{chaveExport, ignorarNoImport: true, novoAlvo}` (feature 002,
 * FR-001) — cria o alvo e já resolve o vínculo como "ignorado" na MESMA
 * transação, mesmo padrão de `vincularNovoAlvo`.
 */
async function vincularIgnorarNoImportComNovoAlvo(
  chaveExport: string,
  novoAlvo: { nome: string; percentualBps: number },
): Promise<VinculoAtualizado> {
  const resultado = await prisma.$transaction(async (tx) => {
    const alvo = await tx.alvo.create({
      data: {
        nome: novoAlvo.nome,
        percentual_alvo_bps: novoAlvo.percentualBps,
        vigencia_inicio: new Date(),
        vigencia_fim: null,
      },
    });

    const mapeamento = await tx.ativo_mapeado.upsert({
      where: { chave_export: chaveExport },
      create: {
        chave_export: chaveExport,
        alvo_id: alvo.id,
        fora_da_carteira: false,
        ignorar_no_import: true,
        reserva_emergencia: false,
      },
      update: {
        alvo_id: alvo.id,
        fora_da_carteira: false,
        ignorar_no_import: true,
        reserva_emergencia: false,
      },
    });

    return { mapeamento, alvo };
  });

  // Alvo recém-criado nunca tem posicao_manual ativa associada ainda —
  // sempre pendente. Calculado fora da transação (leitura simples), sem
  // custo relevante.
  return {
    chaveExport: resultado.mapeamento.chave_export,
    alvoId: resultado.alvo.id,
    nomeAlvo: resultado.alvo.nome,
    foraDaCarteira: false,
    reservaEmergencia: false,
    ignorarNoImport: true,
    posicaoManualPendente: true,
  };
}
