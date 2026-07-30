import { prisma } from "@/db/client";

// Serviço de configuração (T011): chave-valor em JSON (model `config`),
// com defaults conforme data-model.md quando a chave ainda não existe no
// banco. Camada de serviço com I/O — pode importar Prisma livremente, mas
// NÃO deve ser importada por src/core/** (motor é lógica pura).

/**
 * Chaves de configuração conhecidas e seus valores default
 * (specs/001-gestao-aportes-v0-v1/data-model.md, tabela "Chaves e defaults").
 */
export const CONFIG_DEFAULTS = {
  /** ±1,5 p.p. — banda de tolerância visual do dashboard (regra 8). */
  banda_tolerancia_bps: 150,
  /** R$ 500,00 em centavos — aporte mínimo por transação (regra 5). */
  aporte_minimo_centavos: 50000,
  /** Cópias de backup mantidas em backups/. */
  retencao_backups: 12,
} as const;

export type ChaveConfig = keyof typeof CONFIG_DEFAULTS;

/**
 * Lê uma chave de configuração, com fallback para o default documentado
 * quando a chave ainda não existir no banco (primeira execução).
 */
export async function getConfig<K extends ChaveConfig>(
  chave: K,
): Promise<(typeof CONFIG_DEFAULTS)[K]>;
export async function getConfig(chave: string): Promise<unknown>;
export async function getConfig(chave: string): Promise<unknown> {
  const registro = await prisma.config.findUnique({ where: { chave } });

  if (!registro) {
    if (chave in CONFIG_DEFAULTS) {
      return CONFIG_DEFAULTS[chave as ChaveConfig];
    }
    return undefined;
  }

  return JSON.parse(registro.valor);
}

/**
 * Grava (upsert) uma chave de configuração, serializando o valor como JSON.
 */
export async function setConfig(chave: string, valor: unknown): Promise<void> {
  const serializado = JSON.stringify(valor);

  await prisma.config.upsert({
    where: { chave },
    update: { valor: serializado },
    create: { chave, valor: serializado },
  });
}

/**
 * Retorna todas as chaves conhecidas com seus valores atuais (default
 * incluso quando ainda não configuradas). Usado pela tela de configurações
 * e pelo export/import de configuração (T058).
 */
export async function getAllConfig(): Promise<Record<ChaveConfig, unknown>> {
  const chaves = Object.keys(CONFIG_DEFAULTS) as ChaveConfig[];
  const entradas = await Promise.all(
    chaves.map(async (chave) => [chave, await getConfig(chave)] as const),
  );
  return Object.fromEntries(entradas) as Record<ChaveConfig, unknown>;
}
