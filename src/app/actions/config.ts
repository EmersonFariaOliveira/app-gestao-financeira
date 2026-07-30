"use server";

/**
 * src/app/actions/config.ts — Server actions da tela de Configurações
 * (tela 6.8, contracts/server-actions.md "config.ts (tela 6.8)").
 *
 * Regra de camadas (CLAUDE.md / eslint.config.mjs): esta é a ÚNICA borda
 * entre a UI (src/app/**) e a camada de serviços. Zero lógica de negócio
 * aqui — apenas checagem de shape do input vindo do formulário e tradução
 * de exceções do serviço em `{ ok: false, erro }` amigável. Toda a regra de
 * settings/export/import vive em `src/services/config-service.ts` — nunca
 * duplicada aqui.
 *
 * Formato de retorno padrão (contracts/server-actions.md):
 * `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.
 */
import path from "node:path";

import {
  exportarConfigJson as exportarConfigJsonService,
  getAllConfig,
  importarConfigJson as importarConfigJsonService,
  setConfig,
  type ChaveConfig,
  type ConfigExportJson,
  type ImportarConfigResultado,
} from "@/services/config-service";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; erro: string; detalhes?: unknown };

/** Mensagens de erro do serviço já são amigáveis (pt-BR) — apenas evita vazar stack trace de exceções não previstas. */
function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return "Erro inesperado ao processar a solicitação.";
}

export interface ConfigAtualDto {
  bandaToleranciaBps: number;
  aporteMinimoCentavos: number;
  retencaoBackups: number;
  /** Caminho absoluto do arquivo SQLite (apenas informativo — nunca acessado diretamente pela UI). */
  caminhoDb: string;
  /** Caminho absoluto da pasta de backups automáticos (mesma lógica de `backup-service.ts`: `<cwd>/backups`). */
  caminhoBackups: string;
}

/**
 * Resolve o caminho do `.db` a partir de `DATABASE_URL` (`.env`,
 * ex.: `file:../data/app.db`), relativo a `prisma/schema.prisma` — mesma
 * convenção usada pelo Prisma. Mantido aqui (não em backup-service.ts)
 * porque é puramente informativo para exibição na tela 6.8, não uma
 * operação de backup.
 */
function resolverCaminhoDb(): string {
  const url = process.env.DATABASE_URL ?? "file:../data/app.db";
  const semPrefixo = url.replace(/^file:/, "");
  return path.resolve(process.cwd(), "prisma", semPrefixo);
}

/** Mesma convenção de `backup-service.ts` (`diretorioBackupsPadrao`): `<cwd>/backups`. */
function resolverCaminhoBackups(): string {
  return path.resolve(process.cwd(), "backups");
}

/** Lê as configurações atuais + caminhos informativos do `.db` e da pasta de backups (FR-043). */
export async function lerConfig(): Promise<ActionResult<ConfigAtualDto>> {
  try {
    const config = await getAllConfig();
    return {
      ok: true,
      data: {
        bandaToleranciaBps: config.banda_tolerancia_bps as number,
        aporteMinimoCentavos: config.aporte_minimo_centavos as number,
        retencaoBackups: config.retencao_backups as number,
        caminhoDb: resolverCaminhoDb(),
        caminhoBackups: resolverCaminhoBackups(),
      },
    };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

export interface SalvarConfigInput {
  bandaToleranciaBps?: number;
  aporteMinimoCentavos?: number;
  retencaoBackups?: number;
}

const CHAVE_POR_CAMPO: Record<keyof SalvarConfigInput, ChaveConfig> = {
  bandaToleranciaBps: "banda_tolerancia_bps",
  aporteMinimoCentavos: "aporte_minimo_centavos",
  retencaoBackups: "retencao_backups",
};

/** Salva (upsert) as chaves de configuração informadas e devolve o estado atualizado (FR-043). */
export async function salvarConfig(
  input: SalvarConfigInput,
): Promise<ActionResult<ConfigAtualDto>> {
  for (const campo of Object.keys(input) as (keyof SalvarConfigInput)[]) {
    const valor = input[campo];
    if (valor === undefined) continue;
    if (!Number.isInteger(valor) || valor < 0) {
      return { ok: false, erro: `Valor inválido para "${campo}" — esperado um inteiro não negativo.` };
    }
  }

  try {
    for (const campo of Object.keys(input) as (keyof SalvarConfigInput)[]) {
      const valor = input[campo];
      if (valor === undefined) continue;
      await setConfig(CHAVE_POR_CAMPO[campo], valor);
    }
    return await lerConfig();
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/** Monta o JSON portável de configuração (alvos da vigência aberta + vínculos resolvidos + settings) para download/exibição. */
export async function exportarConfigJson(): Promise<ActionResult<ConfigExportJson>> {
  try {
    const data = await exportarConfigJsonService();
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}

/**
 * Restaura o estado configurável a partir de um JSON colado/enviado pelo
 * usuário. `json` chega como texto bruto (vindo de um `<textarea>`/upload de
 * arquivo) — o parse de JSON e a validação de formato ficam a cargo do
 * serviço (`importarConfigJson`/`validarConfigJson`), que lança erros
 * amigáveis; aqui só traduzimos para `{ ok: false, erro }`.
 */
export async function importarConfigJson(
  jsonTexto: string,
): Promise<ActionResult<ImportarConfigResultado>> {
  let json: unknown;
  try {
    json = JSON.parse(jsonTexto);
  } catch {
    return { ok: false, erro: "O conteúdo informado não é um JSON válido." };
  }

  try {
    const data = await importarConfigJsonService(json);
    return { ok: true, data };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro) };
  }
}
