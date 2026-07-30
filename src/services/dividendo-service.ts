import { prisma } from "@/db/client";

// Serviço de lançamento e utilização de dividendos (T049): fonte da verdade
// para `dividendo` (data-model.md) — lançamento manual independente das
// sessões de import, edição/exclusão restritas a "ainda disponível"
// (`aporte_id = null`), e o total disponível global reaproveitado tanto pela
// tela 6.6 quanto pela calculadora (`aporte-service.prepararCalculadora`).
// Camada de I/O: importa Prisma livremente; nunca é importado por
// src/core/**.
//
// Estados (data-model.md, `dividendo`): disponível (`aporte_id = null`) →
// utilizado (`aporte_id` setado, na transação de `registrarAporte` de
// aporte-service.ts). Transição unidirecional — nenhuma função deste módulo
// desfaz uma utilização. Múltiplos lançamentos por `chave_export`/mês são
// permitidos (não é upsert: `lancarDividendo` sempre cria um registro novo).
// Re-imports (`import-service.ts`) nunca tocam `dividendo` — confirmado por
// leitura: não há nenhuma referência a `prisma.dividendo` naquele arquivo.

const REGEX_MES_REFERENCIA = /^\d{4}-\d{2}$/;

/** Shape básico de `dividendo` para consumo externo (camelCase, sem detalhes do Prisma). */
export interface DividendoDto {
  id: string;
  chaveExport: string;
  mesReferencia: string;
  valorCentavos: number;
  /** `null` = disponível; preenchido = utilizado (id do `aporte`). */
  aporteId: string | null;
  criadoEm: Date;
}

export interface LancarDividendoInput {
  chaveExport: string;
  mesReferencia: string;
  valorCentavos: number;
}

export interface EditarDividendoInput {
  id: string;
  chaveExport?: string;
  mesReferencia?: string;
  valorCentavos?: number;
}

export interface ListarDividendosInput {
  /** Filtro de exibição (`YYYY-MM`); se omitido, lista todos os lançamentos. */
  mes?: string;
}

export interface ListarDividendosOutput {
  lancamentos: DividendoDto[];
  /**
   * Total disponível GERAL (soma de todo `dividendo` com `aporte_id = null`),
   * **independente** do filtro `mes` acima — ver nota em `totalDisponivelCentavos`.
   */
  totalDisponivelCentavos: number;
}

function paraDividendoDto(d: {
  id: string;
  chave_export: string;
  mes_referencia: string;
  valor_centavos: number;
  aporte_id: string | null;
  criado_em: Date;
}): DividendoDto {
  return {
    id: d.id,
    chaveExport: d.chave_export,
    mesReferencia: d.mes_referencia,
    valorCentavos: d.valor_centavos,
    aporteId: d.aporte_id,
    criadoEm: d.criado_em,
  };
}

function validarMesReferencia(mesReferencia: string): void {
  if (!REGEX_MES_REFERENCIA.test(mesReferencia)) {
    throw new Error(
      `mesReferencia inválido: "${mesReferencia}" (esperado "YYYY-MM").`,
    );
  }
}

/**
 * Confirma que a `chave_export` é conhecida (existe algum registro em
 * `ativo_mapeado`, em qualquer estado — pendente, vinculado ou
 * fora-da-carteira). Dividendo só pode ser lançado para um ativo que já
 * apareceu em algum import (data-model.md: `dividendo.chave_export` é FK
 * para `ativo_mapeado.chave_export`).
 */
async function exigirAtivoConhecido(chaveExport: string): Promise<void> {
  const mapeamento = await prisma.ativo_mapeado.findUnique({
    where: { chave_export: chaveExport },
  });
  if (!mapeamento) {
    throw new Error(
      `lancarDividendo: ativo "${chaveExport}" desconhecido — não existe nenhum registro em ativo_mapeado para essa chave. Só é possível lançar dividendo para um ativo que já apareceu em algum import.`,
    );
  }
}

/**
 * Soma de todo `dividendo` com `aporte_id = null` (disponível) — a MESMA
 * função usada por `listarDividendos` (campo `totalDisponivelCentavos`) e por
 * `aporte-service.prepararCalculadora`/`calcular` (via `listarDividendosDisponiveis`,
 * candidato a delegar aqui — ver nota de refatoração no relatório da task).
 * Deliberadamente **não recebe filtro de mês**: dividendo não utilizado não
 * expira ao virar o mês (data-model.md, "Estados": disponível → utilizado é a
 * única transição; nada expira um lançamento de volta a "não oferecido").
 */
export async function totalDisponivelCentavos(): Promise<number> {
  const resultado = await prisma.dividendo.aggregate({
    where: { aporte_id: null },
    _sum: { valor_centavos: true },
  });
  return resultado._sum.valor_centavos ?? 0;
}

/**
 * Lança um novo dividendo (contracts/server-actions.md, `dividendos.ts`).
 * SEMPRE cria um registro novo — múltiplos lançamentos para a mesma
 * chave/mês são permitidos por design (data-model.md), então esta função
 * nunca faz upsert por (chaveExport, mesReferencia).
 */
export async function lancarDividendo(
  input: LancarDividendoInput,
): Promise<DividendoDto> {
  validarMesReferencia(input.mesReferencia);
  if (!(input.valorCentavos > 0)) {
    throw new Error("lancarDividendo: valorCentavos deve ser > 0.");
  }
  await exigirAtivoConhecido(input.chaveExport);

  const criado = await prisma.dividendo.create({
    data: {
      chave_export: input.chaveExport,
      mes_referencia: input.mesReferencia,
      valor_centavos: input.valorCentavos,
    },
  });

  return paraDividendoDto(criado);
}

/**
 * Lista lançamentos, opcionalmente filtrados por `mes_referencia` (exibição),
 * e o total disponível GERAL — o mesmo número usado pela calculadora
 * (contracts/server-actions.md: "lançamentos + total disponível (mesmo
 * número da calculadora)", FR-032).
 *
 * Sutileza documentada explicitamente (pedida pela task): o filtro `mes`
 * afeta APENAS a lista `lancamentos` retornada para exibição. O
 * `totalDisponivelCentavos` é sempre a soma global de todos os dividendos com
 * `aporte_id = null`, de qualquer mês — dividendos de meses anteriores não
 * utilizados continuam disponíveis nos meses seguintes (data-model.md), então
 * filtrar o total pelo mês corrente esconderia dinheiro genuinamente
 * disponível e divergiria do valor oferecido em `prepararCalculadora`.
 */
export async function listarDividendos(
  input: ListarDividendosInput = {},
): Promise<ListarDividendosOutput> {
  const [lancamentos, total] = await Promise.all([
    prisma.dividendo.findMany({
      where: input.mes !== undefined ? { mes_referencia: input.mes } : undefined,
      orderBy: [{ mes_referencia: "desc" }, { criado_em: "desc" }],
    }),
    totalDisponivelCentavos(),
  ]);

  return {
    lancamentos: lancamentos.map(paraDividendoDto),
    totalDisponivelCentavos: total,
  };
}

/**
 * Garante que o dividendo existe e ainda está disponível (`aporte_id =
 * null`) — utilizado é imutável (data-model.md: "Edição/exclusão permitidas
 * apenas enquanto disponível"). Lança erro claro sem tocar no banco.
 */
async function exigirDividendoDisponivel(id: string) {
  const dividendo = await prisma.dividendo.findUnique({ where: { id } });
  if (!dividendo) {
    throw new Error(`Dividendo "${id}" não encontrado.`);
  }
  if (dividendo.aporte_id !== null) {
    throw new Error(
      `Dividendo "${id}" já foi utilizado no aporte "${dividendo.aporte_id}" — utilizado é imutável, não pode ser editado nem excluído.`,
    );
  }
  return dividendo;
}

/** Edita um dividendo AINDA disponível. Recusa com erro claro se já utilizado. */
export async function editarDividendo(
  input: EditarDividendoInput,
): Promise<DividendoDto> {
  await exigirDividendoDisponivel(input.id);

  if (input.mesReferencia !== undefined) validarMesReferencia(input.mesReferencia);
  if (input.valorCentavos !== undefined && !(input.valorCentavos > 0)) {
    throw new Error("editarDividendo: valorCentavos deve ser > 0.");
  }
  if (input.chaveExport !== undefined) {
    await exigirAtivoConhecido(input.chaveExport);
  }

  const atualizado = await prisma.dividendo.update({
    where: { id: input.id },
    data: {
      ...(input.chaveExport !== undefined ? { chave_export: input.chaveExport } : {}),
      ...(input.mesReferencia !== undefined ? { mes_referencia: input.mesReferencia } : {}),
      ...(input.valorCentavos !== undefined ? { valor_centavos: input.valorCentavos } : {}),
    },
  });

  return paraDividendoDto(atualizado);
}

/** Exclui um dividendo AINDA disponível. Recusa com erro claro se já utilizado. */
export async function excluirDividendo(id: string): Promise<void> {
  await exigirDividendoDisponivel(id);
  await prisma.dividendo.delete({ where: { id } });
}
