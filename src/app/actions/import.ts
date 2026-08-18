"use server";

/**
 * src/app/actions/import.ts — Server actions do Import mensal (tela 6.2,
 * contracts/server-actions.md "import.ts").
 *
 * Regra de camadas (CLAUDE.md / eslint.config.mjs): esta é a ÚNICA borda
 * entre a UI (src/app/**) e a camada de serviços. Aqui NÃO existe lógica de
 * negócio — apenas extração/conversão do `FormData` recebido do formulário
 * (arquivos → `ArquivoImport[]`, campos de texto → tipos primitivos) e
 * tradução de exceções do serviço em `{ ok: false, erro }` amigável. Toda a
 * regra de parse/diff/completude/backup/transação vive em
 * `src/services/import-service.ts` (que por sua vez delega o parse a
 * `src/parser/**`) — nunca duplicada aqui.
 *
 * Formato de retorno padrão (contracts/server-actions.md):
 * `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.
 */
import type { ArquivoImport, ErroParse } from "@/parser/types";
import {
  confirmarImport as confirmarImportService,
  previewImport as previewImportService,
  type ConfirmarImportInput,
  type ConfirmarImportResultado,
  type PreviewImportResultado,
} from "@/services/import-service";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; erro: string; detalhes?: unknown };

/** Mensagens de erro do serviço já são amigáveis (pt-BR) — apenas evita vazar stack trace de exceções não previstas. */
function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return "Erro inesperado ao processar a solicitação.";
}

/** Extrai todo `File` anexado sob a chave `arquivos` e converte para `ArquivoImport` (bytes crus + nome). */
async function extrairArquivosDoFormData(formData: FormData): Promise<ArquivoImport[]> {
  const arquivos = formData.getAll("arquivos").filter((v): v is File => v instanceof File);
  return Promise.all(
    arquivos.map(async (arquivo) => ({
      nomeArquivo: arquivo.name,
      conteudo: new Uint8Array(await arquivo.arrayBuffer()),
    })),
  );
}

/**
 * Extrai um campo JSON opcional do `FormData` (US3, contracts/server-actions.md
 * "import.ts" — `posicoesManuaisConfirmadas`/`ajustesConfirmados` chegam da UI
 * como texto serializado, já que `FormData` só carrega strings/`File`). Ausente
 * ou vazio é um valor legítimo (import sem nenhuma posição manual/ajuste
 * ainda) — só um JSON malformado é erro.
 */
function extrairJsonDoFormData<T>(formData: FormData, chave: string): T | undefined {
  const valor = formData.get(chave);
  if (typeof valor !== "string" || !valor.trim()) return undefined;
  try {
    return JSON.parse(valor) as T;
  } catch {
    throw new Error(`Campo "${chave}" inválido: não é um JSON bem formado.`);
  }
}

/**
 * Preview do que os CSVs trazem: 100% em memória, nada persiste (FR-006/007/009, R9).
 *
 * `movimentacoesNaoExplicadas` (feature 003, US4, contracts/server-actions.md
 * "import.ts — extensão para US4") já flui aqui automaticamente: como
 * `PreviewImportOutput` é um `Extract<PreviewImportResultado, { ok: true }>` e
 * o `return` abaixo devolve `resultado` inteiro (mesmo padrão de
 * `avisoSubstituicao`/`instituicoesFaltantes`, nenhum campo é reconstruído
 * campo a campo aqui) — repassado sem nenhuma lógica nova nesta action.
 */
export type PreviewImportOutput = Extract<PreviewImportResultado, { ok: true }>;

export async function previewImport(
  formData: FormData,
): Promise<ActionResult<PreviewImportOutput>> {
  let arquivos: ArquivoImport[];
  try {
    arquivos = await extrairArquivosDoFormData(formData);
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }

  if (arquivos.length === 0) {
    return { ok: false, erro: "Selecione ao menos um arquivo CSV para importar." };
  }

  try {
    const resultado = await previewImportService(arquivos);
    if (!resultado.ok) {
      return {
        ok: false,
        erro: "Erro de parse em um ou mais arquivos — nada foi persistido.",
        detalhes: resultado.erros satisfies ErroParse[],
      };
    }
    return { ok: true, data: resultado };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/** Confirmação: cria a sessão VIGENTE (backup antes, transação por dentro — FR-005/008). */
export type ConfirmarImportOutput = Extract<ConfirmarImportResultado, { ok: true }>;

export async function confirmarImport(
  formData: FormData,
): Promise<ActionResult<ConfirmarImportOutput>> {
  let arquivos: ArquivoImport[];
  try {
    arquivos = await extrairArquivosDoFormData(formData);
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }

  if (arquivos.length === 0) {
    return { ok: false, erro: "Selecione ao menos um arquivo CSV para importar." };
  }

  const mesReferencia = formData.get("mesReferencia");
  if (typeof mesReferencia !== "string" || !mesReferencia.trim()) {
    return { ok: false, erro: "Informe o mês de referência do import (AAAA-MM)." };
  }

  const confirmouInstituicoesFaltantes = formData.get("confirmouInstituicoesFaltantes") === "true";

  let posicoesManuaisConfirmadas: ConfirmarImportInput["posicoesManuaisConfirmadas"];
  let ajustesConfirmados: ConfirmarImportInput["ajustesConfirmados"];
  try {
    posicoesManuaisConfirmadas = extrairJsonDoFormData(formData, "posicoesManuaisConfirmadas");
    ajustesConfirmados = extrairJsonDoFormData(formData, "ajustesConfirmados");
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }

  // Defesa em profundidade (bug real encontrado em revisão pós-implementação):
  // mesmo padrão de validação de shape já usado em `criarOuAtualizarAjuste`
  // (src/app/actions/posicoes-manuais.ts) — rejeita ANTES de chamar o
  // serviço um item com `posicaoManualId`/`chaveExport` vazio ou só espaços,
  // em vez de deixá-lo vazar como uma linha inválida (o serviço também trata
  // esse caso, filtrando-o como "não preenchido" — FR-009).
  if (posicoesManuaisConfirmadas) {
    for (const item of posicoesManuaisConfirmadas) {
      if (!item || typeof item.posicaoManualId !== "string" || !item.posicaoManualId.trim()) {
        return {
          ok: false,
          erro: "Cada item de posicoesManuaisConfirmadas precisa de posicaoManualId preenchido.",
        };
      }
    }
  }
  if (ajustesConfirmados) {
    for (const item of ajustesConfirmados) {
      if (!item || typeof item.chaveExport !== "string" || !item.chaveExport.trim()) {
        return {
          ok: false,
          erro: "Cada item de ajustesConfirmados precisa de chaveExport preenchido.",
        };
      }
    }
  }

  try {
    const resultado = await confirmarImportService({
      arquivos,
      mesReferencia,
      confirmouInstituicoesFaltantes,
      posicoesManuaisConfirmadas,
      ajustesConfirmados,
    });
    if (!resultado.ok) {
      return {
        ok: false,
        erro: resultado.erro,
        detalhes: {
          erros: resultado.erros,
          instituicoesFaltantes: resultado.instituicoesFaltantes,
        },
      };
    }
    return { ok: true, data: resultado };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}
