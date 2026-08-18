"use server";

/**
 * src/app/actions/dividendos.ts — Server actions da tela de Dividendos (tela
 * 6.6, contracts/server-actions.md "dividendos.ts").
 *
 * Regra de camadas (CLAUDE.md / eslint.config.mjs): esta é a ÚNICA borda
 * entre a UI (src/app/**) e a camada de serviços. Aqui NÃO existe lógica de
 * negócio — apenas checagem de shape do input vindo do formulário e
 * tradução de exceções do serviço em `{ ok: false, erro }` amigável (nunca
 * vazando stack trace). Toda a regra de disponibilidade/imutabilidade de
 * `dividendo` vive em `src/services/dividendo-service.ts` — nunca duplicada
 * aqui.
 *
 * Formato de retorno padrão (contracts/server-actions.md):
 * `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.
 *
 * `listarAtivosConhecidos`: a tela 6.6 precisa de um dropdown de "ativos já
 * conhecidos pelos imports" (seção 5.1) para o lançamento rápido. Em vez de
 * criar uma nova leitura em `mapeamento-service.ts` só para isso, reaproveita
 * `listarVinculos` (já exposta em `src/app/actions/vinculos.ts`, tela 6.3) e
 * funde pendentes + vinculados + fora-da-carteira — exatamente o universo de
 * `ativo_mapeado` aceito por `dividendo-service.exigirAtivoConhecido`
 * (qualquer registro, em qualquer estado). Decisão documentada aqui conforme
 * pedido da task T052.
 */
import {
  editarDividendo as editarDividendoService,
  excluirDividendo as excluirDividendoService,
  lancarDividendo as lancarDividendoService,
  listarDividendos as listarDividendosService,
  type DividendoDto,
  type EditarDividendoInput,
  type LancarDividendoInput,
  type ListarDividendosInput,
  type ListarDividendosOutput,
} from "@/services/dividendo-service";
import { listarVinculos as listarVinculosAction } from "@/app/actions/vinculos";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; erro: string; detalhes?: unknown };

/** Mensagens de erro do serviço já são amigáveis (pt-BR) — apenas evita vazar stack trace de exceções não previstas. */
function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return "Erro inesperado ao processar a solicitação.";
}

/**
 * Lista lançamentos (opcionalmente filtrados por `mes`) + o total disponível
 * GERAL (FR-032) — mesmo número oferecido pela calculadora
 * (`aporte-service.prepararCalculadora`).
 */
export async function listarDividendos(
  input: ListarDividendosInput = {},
): Promise<ActionResult<ListarDividendosOutput>> {
  try {
    const data = await listarDividendosService(input);
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

export async function lancarDividendo(
  input: LancarDividendoInput,
): Promise<ActionResult<DividendoDto>> {
  if (typeof input?.chaveExport !== "string" || !input.chaveExport.trim()) {
    return { ok: false, erro: "Selecione o ativo do dividendo." };
  }
  if (typeof input.mesReferencia !== "string" || !input.mesReferencia.trim()) {
    return { ok: false, erro: "Informe o mês de referência (AAAA-MM)." };
  }
  if (!Number.isInteger(input.valorCentavos) || input.valorCentavos <= 0) {
    return { ok: false, erro: "Informe um valor de dividendo maior que zero." };
  }

  try {
    const data = await lancarDividendoService(input);
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

export async function editarDividendo(
  input: EditarDividendoInput,
): Promise<ActionResult<DividendoDto>> {
  if (typeof input?.id !== "string" || !input.id.trim()) {
    return { ok: false, erro: "id é obrigatório." };
  }
  if (
    input.valorCentavos !== undefined &&
    (!Number.isInteger(input.valorCentavos) || input.valorCentavos <= 0)
  ) {
    return { ok: false, erro: "Informe um valor de dividendo maior que zero." };
  }

  try {
    const data = await editarDividendoService(input);
    return { ok: true, data };
  } catch (erro) {
    // Recusa de dividendo já utilizado (aporte_id != null) vira mensagem
    // amigável aqui, sem stack trace — nunca deixar vazar.
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

export async function excluirDividendo(
  input: { id: string },
): Promise<ActionResult<null>> {
  if (typeof input?.id !== "string" || !input.id.trim()) {
    return { ok: false, erro: "id é obrigatório." };
  }

  try {
    await excluirDividendoService(input.id);
    return { ok: true, data: null };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/** Ativo conhecido pelos imports — item de dropdown do lançamento rápido (tela 6.6). */
export interface AtivoConhecido {
  chaveExport: string;
  /** Nome do alvo vinculado, "Fora da carteira" para esses, ou `null` para pendentes. */
  rotulo: string | null;
}

export async function listarAtivosConhecidos(): Promise<ActionResult<AtivoConhecido[]>> {
  const resp = await listarVinculosAction();
  if (!resp.ok) return resp;

  const itens: AtivoConhecido[] = [
    ...resp.data.pendentes.map((p) => ({ chaveExport: p.chaveExport, rotulo: null })),
    ...resp.data.vinculados.map((v) => ({ chaveExport: v.chaveExport, rotulo: v.nomeAlvo })),
    ...resp.data.foraDaCarteira.map((f) => ({
      chaveExport: f.chaveExport,
      rotulo: "Fora da carteira",
    })),
  ];
  itens.sort((a, b) => a.chaveExport.localeCompare(b.chaveExport));

  return { ok: true, data: itens };
}
