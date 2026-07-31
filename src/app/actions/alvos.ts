"use server";

/**
 * src/app/actions/alvos.ts — Server actions da Carteira alvo (tela 6.4,
 * contracts/server-actions.md "alvos.ts").
 *
 * Regra de camadas (CLAUDE.md / eslint.config.mjs): esta é a ÚNICA borda
 * entre a UI (src/app/**) e a camada de serviços. Aqui NÃO existe lógica de
 * negócio — apenas checagem de shape do input vindo do formulário e
 * tradução de exceções do serviço em `{ ok: false, erro }` amigável. Toda a
 * regra de CRUD restrito à vigência aberta, validação (não bloqueante) da
 * soma dos percentuais e versionamento por vigência vive em
 * `src/services/alvo-service.ts` — nunca duplicada aqui.
 *
 * Formato de retorno padrão (contracts/server-actions.md):
 * `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.
 */
import {
  atualizarAlvo as atualizarAlvoService,
  criarAlvo as criarAlvoService,
  listarAlvos as listarAlvosService,
  listarTagsExistentes as listarTagsExistentesService,
  novaVigencia as novaVigenciaService,
  removerAlvo as removerAlvoService,
  type ListarAlvosOutput,
} from "@/services/alvo-service";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; erro: string; detalhes?: unknown };

/** Mensagens de erro do serviço já são amigáveis (pt-BR) — apenas evita vazar stack trace de exceções não previstas. */
function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return "Erro inesperado ao processar a solicitação.";
}

/** Lista os alvos vigentes com a soma dos percentuais (bps) e a contagem de ativos vinculados a cada um (FR-019). */
export async function listarAlvos(): Promise<ActionResult<ListarAlvosOutput>> {
  try {
    const data = await listarAlvosService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * Tags distintas já usadas em qualquer alvo (todas as vigências), ordenadas
 * alfabeticamente — alimenta o autocomplete do campo "Tag" no formulário de
 * alvo (tela 6.4). Campo livre: nenhuma validação de conteúdo aqui, só
 * repasse ao serviço.
 */
export async function listarTagsExistentes(): Promise<ActionResult<string[]>> {
  try {
    const data = await listarTagsExistentesService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * Input do formulário de alvo (tela 6.4): `id` presente ⇒ atualiza o alvo
 * existente (só permitido na vigência aberta); `id` ausente ⇒ cria um alvo
 * novo. `percentualAlvoBps` já chega convertido em bps — a conversão de
 * texto digitado ("12,5%"/"12.5") para bps é responsabilidade da UI
 * (borda de exibição), não desta action. `tag` é campo livre (categorização
 * do usuário, ex.: "A-AÇÕES") — mesmo padrão partial-update de
 * `alvo-service.ts`: chave ausente = não mexe na tag existente; `null`/string
 * vazia limpa a tag. Sem validação de conteúdo (é livre por design), só de
 * shape (deve ser string/null/undefined).
 */
export interface SalvarAlvoInput {
  id?: string;
  nome: string;
  percentualAlvoBps: number;
  tag?: string | null;
}

/** Cria ou atualiza um alvo (dependendo de `id`) e devolve a lista atualizada + status da soma (FR-017). */
export async function salvarAlvo(
  input: SalvarAlvoInput,
): Promise<ActionResult<ListarAlvosOutput>> {
  if (typeof input.nome !== "string" || !input.nome.trim()) {
    return { ok: false, erro: "Informe o nome do alvo." };
  }
  if (!Number.isInteger(input.percentualAlvoBps) || input.percentualAlvoBps <= 0) {
    return { ok: false, erro: "Informe um percentual maior que zero para o alvo." };
  }
  if (input.tag !== undefined && input.tag !== null && typeof input.tag !== "string") {
    return { ok: false, erro: "Tag inválida." };
  }

  try {
    if (input.id) {
      await atualizarAlvoService(input.id, {
        nome: input.nome,
        percentualAlvoBps: input.percentualAlvoBps,
        ...(input.tag !== undefined ? { tag: input.tag } : {}),
      });
    } else {
      await criarAlvoService({
        nome: input.nome,
        percentualAlvoBps: input.percentualAlvoBps,
        tag: input.tag,
      });
    }
    const data = await listarAlvosService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/** Remove (soft-delete) um alvo da vigência aberta e devolve a lista atualizada + status da soma. */
export async function removerAlvo(input: {
  alvoId: string;
}): Promise<ActionResult<ListarAlvosOutput>> {
  if (!input.alvoId) {
    return { ok: false, erro: "Alvo não informado." };
  }

  try {
    await removerAlvoService(input.alvoId);
    const data = await listarAlvosService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * "A carteira de referência mudou" (FR-018): fecha a vigência atual, clona
 * os alvos numa nova vigência aberta e re-aponta os vínculos existentes.
 * Devolve a lista já recalculada (nova vigência) + status da soma, para a
 * UI exibir os alvos clonados diretamente, sem uma segunda chamada.
 */
export async function novaVigencia(): Promise<ActionResult<ListarAlvosOutput>> {
  try {
    await novaVigenciaService();
    const data = await listarAlvosService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}
