import { prisma } from "@/db/client";

// Serviço de gestão da carteira alvo (T045): CRUD de `alvo` restrito à
// vigência ABERTA (`vigencia_fim = null`), validação (não bloqueante) da
// soma dos percentuais vigentes, e versionamento por vigência
// (`novaVigencia`) que fecha a vigência atual, clona os alvos e re-aponta os
// vínculos de `ativo_mapeado` — tudo em uma única transação (data-model.md,
// seção 4 de docs/app-gestao-aportes.md). Camada de serviço com I/O: pode
// importar Prisma livremente, mas nunca é importada por src/core/**.

/**
 * Tolerância de arredondamento da soma dos `percentual_alvo_bps` vigentes
 * (data-model.md: "soma dos alvos da vigência ativa = 10000 (validação na
 * tela/serviço, com tolerância ±1 bps de arredondamento)"). Interpretação
 * adotada aqui, documentada explicitamente pois a spec não formaliza a
 * fórmula: **diferença absoluta ≤ 1**, i.e. `soma` é válida quando
 * `Math.abs(soma - 10000) <= 1` — cobre tanto 9999 quanto 10001 como
 * "praticamente 100%", mas nada além disso (9998/10002 já sinalizam
 * inválido). A validação nunca bloqueia o CRUD (o usuário pode estar no
 * meio de um ajuste) — ela é apenas parte do retorno de leitura/gravação.
 */
const TOLERANCIA_SOMA_BPS = 1;
const SOMA_ALVO_BPS = 10000;

function somaValida(somaBps: number): boolean {
  return Math.abs(somaBps - SOMA_ALVO_BPS) <= TOLERANCIA_SOMA_BPS;
}

/** Shape básico de `alvo` para consumo externo (camelCase, sem detalhes do Prisma). */
export interface AlvoDto {
  id: string;
  nome: string;
  percentualAlvoBps: number;
  vigenciaInicio: Date;
  vigenciaFim: Date | null;
  ativo: boolean;
  criadoEm: Date;
}

/** `AlvoDto` com a contagem de `ativo_mapeado` que apontam para ele (FR-019). */
export interface AlvoComContagemDto extends AlvoDto {
  qtdAtivosMapeados: number;
}

export interface ListarAlvosOutput {
  /**
   * Alvos **vigentes** (data-model.md: `vigencia_fim = null AND ativo =
   * true`) — a listagem principal da tela 6.4. Alvos da vigência aberta que
   * foram removidos (`ativo = false`, ver `removerAlvo`) não aparecem aqui.
   */
  alvos: AlvoComContagemDto[];
  somaBps: number;
  somaValida: boolean;
}

export interface DadosAlvo {
  nome: string;
  percentualAlvoBps: number;
}

/** Grupo de alvos de uma vigência fechada (mesmo par `vigencia_inicio`/`vigencia_fim`), para histórico/auditoria. */
export interface VigenciaFechadaDto {
  vigenciaInicio: Date;
  vigenciaFim: Date;
  alvos: AlvoDto[];
}

function paraAlvoDto(a: {
  id: string;
  nome: string;
  percentual_alvo_bps: number;
  vigencia_inicio: Date;
  vigencia_fim: Date | null;
  ativo: boolean;
  criado_em: Date;
}): AlvoDto {
  return {
    id: a.id,
    nome: a.nome,
    percentualAlvoBps: a.percentual_alvo_bps,
    vigenciaInicio: a.vigencia_inicio,
    vigenciaFim: a.vigencia_fim,
    ativo: a.ativo,
    criadoEm: a.criado_em,
  };
}

/**
 * `vigencia_inicio` a usar para um novo alvo criado agora: se já existe
 * algum alvo na vigência aberta, o novo entra na MESMA vigência (reaproveita
 * o `vigencia_inicio` mais antigo entre os abertos); se não há nenhum alvo
 * aberto ainda (carteira nova), abre a primeira vigência agora.
 */
async function obterVigenciaInicioAberta(): Promise<Date> {
  const existente = await prisma.alvo.findFirst({
    where: { vigencia_fim: null },
    orderBy: { vigencia_inicio: "asc" },
  });
  return existente?.vigencia_inicio ?? new Date();
}

/**
 * Lista os alvos vigentes com a soma dos percentuais e o indicador de
 * validade (não bloqueante — contracts/server-actions.md, `listarAlvos`) e a
 * contagem de `ativo_mapeado` de cada um (FR-019).
 */
export async function listarAlvos(): Promise<ListarAlvosOutput> {
  const alvosVigentes = await prisma.alvo.findMany({
    where: { vigencia_fim: null, ativo: true },
    orderBy: { criado_em: "asc" },
  });

  const contagemPorAlvoId = await contarAtivosPorAlvoId(alvosVigentes.map((a) => a.id));

  const somaBps = alvosVigentes.reduce((acc, a) => acc + a.percentual_alvo_bps, 0);

  return {
    alvos: alvosVigentes.map((a) => ({
      ...paraAlvoDto(a),
      qtdAtivosMapeados: contagemPorAlvoId.get(a.id) ?? 0,
    })),
    somaBps,
    somaValida: somaValida(somaBps),
  };
}

async function contarAtivosPorAlvoId(alvoIds: string[]): Promise<Map<string, number>> {
  if (alvoIds.length === 0) return new Map();
  const vinculos = await prisma.ativo_mapeado.findMany({
    where: { alvo_id: { in: alvoIds } },
    select: { alvo_id: true },
  });
  const contagem = new Map<string, number>();
  for (const v of vinculos) {
    if (!v.alvo_id) continue;
    contagem.set(v.alvo_id, (contagem.get(v.alvo_id) ?? 0) + 1);
  }
  return contagem;
}

/**
 * Quais `chave_export` apontam hoje para um dado alvo (FR-019) — usado pela
 * tela para mostrar "N ativos apontam para este alvo" e por confirmações de
 * remoção.
 */
export async function ativosPorAlvo(alvoId: string): Promise<string[]> {
  const vinculos = await prisma.ativo_mapeado.findMany({
    where: { alvo_id: alvoId },
    select: { chave_export: true },
  });
  return vinculos.map((v) => v.chave_export);
}

function validarDadosAlvo(dados: Partial<DadosAlvo>): void {
  if (dados.nome !== undefined && dados.nome.trim() === "") {
    throw new Error("Nome do alvo não pode ser vazio.");
  }
  if (dados.percentualAlvoBps !== undefined && !(dados.percentualAlvoBps > 0)) {
    throw new Error("percentualAlvoBps deve ser um inteiro positivo (bps).");
  }
}

/** Cria um alvo novo na vigência ABERTA (FR-017). */
export async function criarAlvo(dados: DadosAlvo): Promise<AlvoDto> {
  validarDadosAlvo(dados);
  if (!dados.nome || dados.percentualAlvoBps === undefined) {
    throw new Error("criarAlvo: nome e percentualAlvoBps são obrigatórios.");
  }

  const vigenciaInicio = await obterVigenciaInicioAberta();

  const criado = await prisma.alvo.create({
    data: {
      nome: dados.nome,
      percentual_alvo_bps: dados.percentualAlvoBps,
      vigencia_inicio: vigenciaInicio,
      vigencia_fim: null,
      ativo: true,
    },
  });

  return paraAlvoDto(criado);
}

/**
 * Garante que o alvo existe e pertence à vigência aberta — alvos de
 * vigência fechada são somente-leitura (data-model.md, regra de
 * integridade 1); qualquer tentativa de alterá-los é rejeitada com erro
 * claro, sem tocar no banco.
 */
async function exigirAlvoDaVigenciaAberta(alvoId: string) {
  const alvo = await prisma.alvo.findUnique({ where: { id: alvoId } });
  if (!alvo) {
    throw new Error(`Alvo "${alvoId}" não encontrado.`);
  }
  if (alvo.vigencia_fim !== null) {
    throw new Error(
      `Alvo "${alvo.nome}" pertence a uma vigência fechada (vigência encerrada em ${alvo.vigencia_fim.toISOString()}) — somente leitura. Use novaVigencia() para editar uma cópia na vigência aberta.`,
    );
  }
  return alvo;
}

/** Atualiza nome e/ou percentual de um alvo — só permitido na vigência aberta (FR-017). */
export async function atualizarAlvo(
  alvoId: string,
  dados: Partial<DadosAlvo>,
): Promise<AlvoDto> {
  validarDadosAlvo(dados);
  await exigirAlvoDaVigenciaAberta(alvoId);

  const atualizado = await prisma.alvo.update({
    where: { id: alvoId },
    data: {
      ...(dados.nome !== undefined ? { nome: dados.nome } : {}),
      ...(dados.percentualAlvoBps !== undefined
        ? { percentual_alvo_bps: dados.percentualAlvoBps }
        : {}),
    },
  });

  return paraAlvoDto(atualizado);
}

/**
 * Remove um alvo da vigência aberta. Implementado como **soft delete**
 * (`ativo = false`), nunca `DELETE` físico: o campo `ativo` existe
 * exatamente para isso (data-model.md define "alvos vigentes" como
 * `vigencia_fim = null AND ativo = true`), e um `DELETE` quebraria a FK de
 * qualquer `ativo_mapeado` que já aponte para ele. Só permitido na vigência
 * aberta — remover um alvo de vigência fechada é rejeitado (somente
 * leitura, histórico nunca é alterado).
 *
 * Bloqueia a remoção (sem tocar no banco) se ainda existir algum
 * `ativo_mapeado` vinculado a este alvo (`alvo_id` = id do alvo): um alvo
 * removido é filtrado da lista de `alvos` usada pelo motor
 * (`aporte-service.montarContextoEntradaMotor`, `ativo: true`), mas o
 * patrimônio da chave vinculada continua entrando em
 * `patrimonioBaseCentavos` (regra 1) sem nunca ser creditado a nenhum alvo
 * real na fila/divisão — um "vínculo zumbi" que distorce o déficit de todos
 * os alvos em silêncio, violando a regra 4 (seção 5: ativos fora da
 * carteira alvo não participam da base) e o princípio de "falhar alto,
 * nunca em silêncio". Seguindo o mesmo padrão já usado para vigência
 * fechada (recusar com erro claro em vez de decidir sozinho o que fazer com
 * os vínculos), a resolução (revincular a outro alvo ou marcar fora da
 * carteira) é responsabilidade do usuário via tela de vínculos — este
 * serviço nunca reassocia automaticamente.
 */
export async function removerAlvo(alvoId: string): Promise<AlvoDto> {
  const alvo = await exigirAlvoDaVigenciaAberta(alvoId);

  const qtdVinculados = await prisma.ativo_mapeado.count({ where: { alvo_id: alvoId } });
  if (qtdVinculados > 0) {
    throw new Error(
      `Não é possível remover o alvo '${alvo.nome}': há ${qtdVinculados} ativo(s) vinculado(s) a ele. Revincule-os a outro alvo ou marque como fora da carteira antes de remover.`,
    );
  }

  const removido = await prisma.alvo.update({
    where: { id: alvoId },
    data: { ativo: false },
  });

  return paraAlvoDto(removido);
}

/**
 * "A carteira de referência mudou" (seção 6.4 / FR-018): fecha a vigência
 * atual (seta `vigencia_fim` em TODOS os alvos com `vigencia_fim = null`,
 * inclusive os já removidos/`ativo = false` — fazem parte da mesma
 * vigência e precisam ser fechados junto) e clona cada um deles numa nova
 * vigência aberta (mesmo nome/percentual/`ativo`, novo id, `vigencia_inicio
 * = agora`, `vigencia_fim = null`). Na mesma transação, re-aponta todo
 * `ativo_mapeado.alvo_id` que apontava para um alvo antigo (agora fechado)
 * para o clone correspondente — a correspondência é feita 1:1 pelo id
 * original capturado no momento da clonagem, o que é estritamente
 * equivalente a "casar pelo nome" (cada clone nasce com o MESMO `nome` do
 * seu original) mas sem ambiguidade caso dois alvos abertos compartilhem o
 * mesmo nome.
 *
 * Lança erro se não houver vigência aberta para fechar (nada a versionar).
 */
export async function novaVigencia(): Promise<{ alvos: AlvoDto[] }> {
  const clones = await prisma.$transaction(async (tx) => {
    const abertos = await tx.alvo.findMany({ where: { vigencia_fim: null } });
    if (abertos.length === 0) {
      throw new Error("novaVigencia: não há vigência aberta para fechar.");
    }

    const agora = new Date();

    await tx.alvo.updateMany({
      where: { id: { in: abertos.map((a) => a.id) } },
      data: { vigencia_fim: agora },
    });

    const clonesCriados: Awaited<ReturnType<typeof tx.alvo.create>>[] = [];
    for (const alvoAntigo of abertos) {
      const clone = await tx.alvo.create({
        data: {
          nome: alvoAntigo.nome,
          percentual_alvo_bps: alvoAntigo.percentual_alvo_bps,
          vigencia_inicio: agora,
          vigencia_fim: null,
          ativo: alvoAntigo.ativo,
        },
      });
      clonesCriados.push(clone);

      // Re-aponta os vínculos que apontavam para o alvo antigo (id original,
      // capturado antes do fechamento) para o clone correspondente.
      await tx.ativo_mapeado.updateMany({
        where: { alvo_id: alvoAntigo.id },
        data: { alvo_id: clone.id },
      });
    }

    return clonesCriados;
  });

  return { alvos: clones.map(paraAlvoDto) };
}

/**
 * Histórico das vigências já fechadas, agrupado por par
 * (`vigencia_inicio`, `vigencia_fim`) — cada grupo representa uma vigência
 * inteira que foi encerrada de uma vez por `novaVigencia()`. Nunca inclui
 * `DELETE`: alvos de vigência fechada continuam para sempre no banco,
 * acessíveis para auditoria/leitura (data-model.md, regra de integridade 1).
 */
export async function listarVigenciasFechadas(): Promise<VigenciaFechadaDto[]> {
  const fechados = await prisma.alvo.findMany({
    where: { vigencia_fim: { not: null } },
    orderBy: [{ vigencia_inicio: "asc" }, { criado_em: "asc" }],
  });

  const grupos = new Map<string, typeof fechados>();
  for (const alvo of fechados) {
    const chave = `${alvo.vigencia_inicio.toISOString()}|${alvo.vigencia_fim!.toISOString()}`;
    const lista = grupos.get(chave);
    if (lista) {
      lista.push(alvo);
    } else {
      grupos.set(chave, [alvo]);
    }
  }

  return Array.from(grupos.values()).map((alvos) => ({
    vigenciaInicio: alvos[0].vigencia_inicio,
    vigenciaFim: alvos[0].vigencia_fim!,
    alvos: alvos.map(paraAlvoDto),
  }));
}
