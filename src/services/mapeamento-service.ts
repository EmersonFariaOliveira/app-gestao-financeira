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
// `fora_da_carteira = true`, `reserva_emergencia = true` e
// `ignorar_no_import = true` são mutuamente exclusivos entre si — quando
// qualquer um dos três booleans é setado, `alvo_id` é sempre zerado (`null`).
// Não há exceção: `ignorar_no_import` NÃO carrega mais `alvo_id` (revertido
// — ver nota histórica abaixo). Toda escrita neste arquivo zera
// explicitamente os lados opostos antes de setar um dos estados.
//
// Nota histórica: `ignorar_no_import` chegou a preservar `alvo_id` (feature
// 002 inicial) para alimentar a heurística de `posicaoManualPendente` por
// alvo. Essa exceção causava vínculos incorretos na UI (obrigava escolher um
// alvo só para "Ignorar", mesmo quando a `posicao_manual` substituta ainda
// nem existia) e foi revertida: `posicaoManualPendente`/`IgnoradoRow.alvoId`
// agora derivam de um match EXATO via `posicao_manual.chave_export_origem`
// (ver `existePosicaoManualSubstituta` abaixo), não mais de `ativo_mapeado.alvo_id`.

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
 * excluída da consolidação porque foi (ou será) substituída por uma
 * `posicao_manual`. `valorAtualCentavos` é o valor bruto do CSV, exibido só
 * como referência — o motor usa o `valor_atual` da posição manual, nunca
 * este campo.
 *
 * `ativo_mapeado.alvo_id` é sempre `null` neste estado (invariante — ver
 * comentário no topo do arquivo), então `alvoId`/`nomeAlvo` aqui NÃO vêm do
 * `ativo_mapeado`: são derivados por match EXATO via
 * `posicao_manual.chave_export_origem = chaveExport` (campo desenhado
 * exatamente para isso — data-model.md da feature 002, `posicao_manual`).
 * `alvoId`/`nomeAlvo` são `null` quando ainda não existe nenhuma
 * `posicao_manual` ativa com esse `chave_export_origem` — o mesmo momento em
 * que `posicaoManualPendente` é `true`. Os dois campos são redundantes por
 * construção (`alvoId === null <=> posicaoManualPendente === true`);
 * `posicaoManualPendente` é mantido como campo próprio (em vez de inferido
 * pelo consumidor) porque a UI (`src/app/vinculos/page.tsx`) já depende
 * desse nome para decidir o CTA "cadastrar posição manual" vs. exibir o
 * alvo — remover o campo obrigaria a UI a reimplementar essa checagem.
 */
export interface IgnoradoRow {
  chaveExport: string;
  alvoId: string | null;
  nomeAlvo: string | null;
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
  // "Ignorar (substituído por posição manual)" (feature 002, FR-001) — ação
  // de um clique, sem sub-modo de escolha de alvo: mesmo padrão de
  // `{chaveExport, foraDaCarteira: true}`/`{chaveExport, reservaEmergencia:
  // true}` (revertido de uma versão anterior que exigia `alvoId`/`novoAlvo`
  // — ver nota histórica no topo do arquivo).
  | { chaveExport: string; ignorarNoImport: true }
  // "Reserva de emergência": mesmo padrão de `{chaveExport, foraDaCarteira:
  // true}`, um estado isolado próprio (não combina com ignorarNoImport por
  // decisão explícita, fora de escopo por ora).
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

/** Alvo (id/nome) da `posicao_manual` substituta de uma `chave_export`, ou `null` se ainda não existir. */
export interface PosicaoManualSubstituta {
  alvoId: string | null;
  nomeAlvo: string | null;
}

/**
 * Match EXATO via `posicao_manual.chave_export_origem` (data-model.md da
 * feature 002 — campo desenhado precisamente para isto): existe uma
 * `posicao_manual` ATIVA que substitui esta `chave_export` do CSV? Substitui
 * a heurística anterior por-alvo (`obterAlvoIdsComPosicaoManualAtiva`), que
 * dependia de `ativo_mapeado.alvo_id` continuar preenchido em
 * `ignorar_no_import = true` — invariante revertida (ver nota no topo do
 * arquivo). `alvoId`/`nomeAlvo` no retorno vêm da própria `posicao_manual`
 * e podem ser `null` se ela existir mas ainda estiver pendente de vínculo
 * (`posicao_manual.alvo_id = null`) — caso raro, tratado como "ainda sem
 * alvo para mostrar", não como "sem substituta".
 */
async function existePosicaoManualSubstituta(
  chaveExport: string,
): Promise<PosicaoManualSubstituta | null> {
  const substituta = await prisma.posicao_manual.findFirst({
    where: { chave_export_origem: chaveExport, ativo: true },
    include: { alvo: true },
  });
  if (!substituta) return null;
  return { alvoId: substituta.alvo_id, nomeAlvo: substituta.alvo?.nome ?? null };
}

/**
 * Versão em lote de `existePosicaoManualSubstituta`, usada por
 * `listarVinculos` para evitar N+1 queries (uma por `chave_export`
 * ignorada). Mesma semântica: chave = `chave_export_origem`, valor = alvo da
 * `posicao_manual` substituta ATIVA (ou ausente do Map quando não há
 * substituta cadastrada).
 */
async function obterPosicoesManuaisSubstitutasPorChaveOrigem(): Promise<
  Map<string, PosicaoManualSubstituta>
> {
  const substitutas = await prisma.posicao_manual.findMany({
    where: { chave_export_origem: { not: null }, ativo: true },
    include: { alvo: true },
  });

  const mapa = new Map<string, PosicaoManualSubstituta>();
  for (const p of substitutas) {
    // `chave_export_origem` é filtrado `{ not: null }` acima, então sempre
    // string aqui; TS não estreita automaticamente através do Prisma.
    if (p.chave_export_origem) {
      mapa.set(p.chave_export_origem, { alvoId: p.alvo_id, nomeAlvo: p.alvo?.nome ?? null });
    }
  }
  return mapa;
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
 * `alvo_id = null` (não é o mesmo estado de "vinculado" — some do balde
 * `vinculados` e vira `ignorados`). `alvoId`/`nomeAlvo` do balde `ignorados`
 * vêm da `posicao_manual` substituta (match exato via
 * `chave_export_origem`, ver `obterPosicoesManuaisSubstitutasPorChaveOrigem`),
 * não de `ativo_mapeado.alvo_id`.
 */
export async function listarVinculos(): Promise<ListarVinculosOutput> {
  const [registros, valorPorChave, substitutasPorChaveOrigem] = await Promise.all([
    prisma.ativo_mapeado.findMany({
      include: { alvo: true },
      orderBy: { chave_export: "asc" },
    }),
    obterValorAtualPorChave(),
    obterPosicoesManuaisSubstitutasPorChaveOrigem(),
  ]);

  const pendentes: VinculoPendente[] = [];
  const vinculados: VinculoVinculado[] = [];
  const foraDaCarteira: VinculoForaDaCarteira[] = [];
  const reservaEmergencia: VinculoReservaEmergencia[] = [];
  const ignorados: IgnoradoRow[] = [];

  for (const registro of registros) {
    const valorAtualCentavos = valorPorChave.get(registro.chave_export) ?? 0;

    if (registro.ignorar_no_import) {
      const substituta = substitutasPorChaveOrigem.get(registro.chave_export) ?? null;
      ignorados.push({
        chaveExport: registro.chave_export,
        alvoId: substituta?.alvoId ?? null,
        nomeAlvo: substituta?.nomeAlvo ?? null,
        valorAtualCentavos,
        posicaoManualPendente: substituta === null,
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
 * false AND reserva_emergencia false AND ignorar_no_import false —
 * reserva de emergência e ignorar_no_import são estados RESOLVIDOS, não
 * contam como pendência; ver prioridade de classificação em
 * `listarVinculos` acima, onde `ignorar_no_import` é checado primeiro).
 */
export async function contarPendencias(): Promise<number> {
  return prisma.ativo_mapeado.count({
    where: {
      alvo_id: null,
      fora_da_carteira: false,
      reserva_emergencia: false,
      ignorar_no_import: false,
    },
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
  // `ignorarNoImport` é checado primeiro: é uma forma "sem alvo" própria
  // (mesmo padrão de `foraDaCarteira`/`reservaEmergencia`), então o
  // discriminante precisa vir antes de `novoAlvo`/`alvoId`.
  if ("ignorarNoImport" in input && input.ignorarNoImport) {
    return marcarIgnoradoNoImport(input.chaveExport);
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
 * Forma `{chaveExport, ignorarNoImport: true}` (feature 002, FR-001,
 * revertido para o design original de `data-model.md:21`) — marca
 * `ignorar_no_import = true` e ZERA `alvo_id`, mesmo padrão exato de
 * `marcarForaDaCarteira`/`marcarReservaEmergencia`. Não recebe alvo: "Ignorar"
 * é uma ação de um clique, sem sub-modo de escolha de alvo — não há valor do
 * CSV a atribuir a um alvo neste estado (a `posicao_manual` substituta, essa
 * sim, tem o seu próprio `alvo_id`).
 */
async function marcarIgnoradoNoImport(chaveExport: string): Promise<VinculoAtualizado> {
  const mapeamento = await prisma.ativo_mapeado.upsert({
    where: { chave_export: chaveExport },
    create: {
      chave_export: chaveExport,
      alvo_id: null,
      fora_da_carteira: false,
      ignorar_no_import: true,
      reserva_emergencia: false,
    },
    update: {
      alvo_id: null,
      fora_da_carteira: false,
      ignorar_no_import: true,
      reserva_emergencia: false,
    },
  });

  const substituta = await existePosicaoManualSubstituta(chaveExport);

  return {
    chaveExport: mapeamento.chave_export,
    alvoId: substituta?.alvoId ?? null,
    nomeAlvo: substituta?.nomeAlvo ?? null,
    foraDaCarteira: false,
    reservaEmergencia: false,
    ignorarNoImport: true,
    posicaoManualPendente: substituta === null,
  };
}
