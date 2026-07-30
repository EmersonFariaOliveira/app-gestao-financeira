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
// Invariante inviolável (data-model.md, `ativo_mapeado`): `alvo_id` e
// `fora_da_carteira = true` são mutuamente exclusivos. Toda escrita neste
// arquivo zera explicitamente o lado oposto antes de setar um dos dois.

export interface VinculoPendente {
  chaveExport: string;
}

export interface VinculoVinculado {
  chaveExport: string;
  alvoId: string;
  nomeAlvo: string;
}

export interface VinculoForaDaCarteira {
  chaveExport: string;
}

export interface ListarVinculosOutput {
  pendentes: VinculoPendente[];
  vinculados: VinculoVinculado[];
  foraDaCarteira: VinculoForaDaCarteira[];
}

export type VincularAtivoInput =
  | { chaveExport: string; alvoId: string }
  | { chaveExport: string; foraDaCarteira: true }
  | { chaveExport: string; novoAlvo: { nome: string; percentualBps: number } };

export interface VinculoAtualizado {
  chaveExport: string;
  alvoId: string | null;
  nomeAlvo: string | null;
  foraDaCarteira: boolean;
}

/**
 * Estado completo de `ativo_mapeado` (data-model.md, "Estados derivados"),
 * agrupado nos três baldes da tela 6.3. `vinculados` traz `nomeAlvo`
 * denormalizado para exibição direta (N-para-1: vários `chaveExport` podem
 * repetir o mesmo `alvoId`/`nomeAlvo` — agrupável no cliente por `alvoId`).
 */
export async function listarVinculos(): Promise<ListarVinculosOutput> {
  const registros = await prisma.ativo_mapeado.findMany({
    include: { alvo: true },
    orderBy: { chave_export: "asc" },
  });

  const pendentes: VinculoPendente[] = [];
  const vinculados: VinculoVinculado[] = [];
  const foraDaCarteira: VinculoForaDaCarteira[] = [];

  for (const registro of registros) {
    if (registro.fora_da_carteira) {
      // Estado "fora da carteira" — independente de alvo_id (que, pela
      // invariante, deve estar null aqui; ver nota em vincularAtivo).
      foraDaCarteira.push({ chaveExport: registro.chave_export });
    } else if (registro.alvo_id !== null) {
      vinculados.push({
        chaveExport: registro.chave_export,
        alvoId: registro.alvo_id,
        nomeAlvo: registro.alvo?.nome ?? registro.alvo_id,
      });
    } else {
      // Pendente: alvo_id = null AND fora_da_carteira = false — bloqueia a
      // calculadora (FR-015). aporte-service.listarPendencias faz a mesma
      // checagem hoje (duplicada por decisão explícita da task: não alterar
      // aporte-service nesta task); este é o balde equivalente.
      pendentes.push({ chaveExport: registro.chave_export });
    }
  }

  return { pendentes, vinculados, foraDaCarteira };
}

/** Quantidade de `ativo_mapeado` pendentes (alvo_id null AND fora_da_carteira false). */
export async function contarPendencias(): Promise<number> {
  return prisma.ativo_mapeado.count({
    where: { alvo_id: null, fora_da_carteira: false },
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
  if ("novoAlvo" in input) {
    return vincularNovoAlvo(input.chaveExport, input.novoAlvo);
  }
  // Após excluir `novoAlvo`, resta `{alvoId}` | `{foraDaCarteira: true}` — o
  // discriminante `"alvoId" in input` narrowa positivamente para o primeiro
  // e, por eliminação, o `else` só pode ser o segundo (narrowing negativo de
  // `"in"` combinado com `&&` não é confiável no TS, daí a ordem aqui).
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
  // fora_da_carteira, independentemente do estado anterior do registro.
  const mapeamento = await prisma.ativo_mapeado.upsert({
    where: { chave_export: chaveExport },
    create: { chave_export: chaveExport, alvo_id: alvo.id, fora_da_carteira: false },
    update: { alvo_id: alvo.id, fora_da_carteira: false },
  });

  return {
    chaveExport: mapeamento.chave_export,
    alvoId: alvo.id,
    nomeAlvo: alvo.nome,
    foraDaCarteira: false,
  };
}

/** Forma `{chaveExport, foraDaCarteira: true}` — marca fora-da-carteira, zerando alvo_id. */
async function marcarForaDaCarteira(chaveExport: string): Promise<VinculoAtualizado> {
  // Exclusão mútua (data-model.md): marcar fora-da-carteira sempre zera
  // alvo_id, independentemente do estado anterior do registro.
  const mapeamento = await prisma.ativo_mapeado.upsert({
    where: { chave_export: chaveExport },
    create: { chave_export: chaveExport, alvo_id: null, fora_da_carteira: true },
    update: { alvo_id: null, fora_da_carteira: true },
  });

  return {
    chaveExport: mapeamento.chave_export,
    alvoId: null,
    nomeAlvo: null,
    foraDaCarteira: true,
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
      create: { chave_export: chaveExport, alvo_id: alvo.id, fora_da_carteira: false },
      update: { alvo_id: alvo.id, fora_da_carteira: false },
    });

    return {
      chaveExport: mapeamento.chave_export,
      alvoId: alvo.id,
      nomeAlvo: alvo.nome,
      foraDaCarteira: false,
    };
  });
}
