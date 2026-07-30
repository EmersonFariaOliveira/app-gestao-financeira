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

/** Preview do que os CSVs trazem: 100% em memória, nada persiste (FR-006/007/009, R9). */
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

  try {
    const resultado = await confirmarImportService({
      arquivos,
      mesReferencia,
      confirmouInstituicoesFaltantes,
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
