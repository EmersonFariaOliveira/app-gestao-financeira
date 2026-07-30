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

// ---------------------------------------------------------------------------
// Export/import de configuração em JSON portável (T058, FR-044,
// contracts/server-actions.md § config.ts).
//
// Escopo do que é "configuração" para efeito deste export/import — contraste
// deliberado com o restante do banco:
//   - Alvos da vigência ABERTA (o estado "editável" hoje; vigências FECHADAS
//     são histórico/auditoria, nunca fazem parte de um backup portável de
//     configuração — reimportar não deve ressuscitar nem duplicar histórico).
//   - Vínculos RESOLVIDOS de `ativo_mapeado` (apontando para um alvo ou
//     marcados fora-da-carteira). Vínculos PENDENTES (alvo_id null AND
//     fora_da_carteira false) são deliberadamente EXCLUÍDOS: são estado
//     transiente nascido de um import de CSV (import-service), não
//     "configuração" — um novo import recria as pendências que ainda
//     existirem, então não há necessidade (nem sentido) de portá-las.
//   - Settings (`config`).
//   - NUNCA `sessao_import`/`posicao`/`aporte`/`dividendo` — são dados
//     transacionais imutáveis, não configuração, e a regra inviolável do
//     projeto veda qualquer toque nessas tabelas por este fluxo.
// ---------------------------------------------------------------------------

/** Versões do formato de export suportadas por `importarConfigJson`. */
const VERSOES_SUPORTADAS = [1] as const;
type VersaoSuportada = (typeof VERSOES_SUPORTADAS)[number];
const VERSAO_ATUAL: VersaoSuportada = 1;

/** Alvo portável — nome é a chave de correspondência (não o `id` interno, que não sobrevive à troca de banco). */
export interface ConfigExportAlvo {
  nome: string;
  percentualAlvoBps: number;
}

/**
 * Vínculo portável — referencia o alvo pelo NOME (resolvido para o `id`
 * recém-criado no destino durante o import). `alvoNome` é `null` quando
 * `foraDaCarteira` é `true` (exclusão mútua, igual à invariante de
 * `ativo_mapeado`).
 */
export interface ConfigExportVinculo {
  chaveExport: string;
  alvoNome: string | null;
  foraDaCarteira: boolean;
}

/** Shape do JSON portável produzido por `exportarConfigJson` / consumido por `importarConfigJson`. */
export interface ConfigExportJson {
  /** Versão do formato — permite evolução futura sem quebrar imports antigos (campos novos com default seguro). */
  versao: VersaoSuportada;
  /** ISO 8601 — apenas informativo/auditoria, não influencia a importação. */
  exportadoEm: string;
  settings: {
    banda_tolerancia_bps: number;
    aporte_minimo_centavos: number;
    retencao_backups: number;
  };
  alvos: ConfigExportAlvo[];
  vinculos: ConfigExportVinculo[];
}

/**
 * Monta o JSON portável do estado configurável atual: alvos da vigência
 * aberta, vínculos resolvidos (por nome de alvo) e settings — nunca inclui
 * histórico de vigências fechadas nem dados transacionais (sessões,
 * posições, aportes, dividendos).
 */
export async function exportarConfigJson(): Promise<ConfigExportJson> {
  const [settings, alvosAbertos, vinculosResolvidos] = await Promise.all([
    getAllConfig(),
    prisma.alvo.findMany({
      where: { vigencia_fim: null, ativo: true },
      orderBy: { criado_em: "asc" },
    }),
    prisma.ativo_mapeado.findMany({
      where: {
        OR: [{ alvo_id: { not: null } }, { fora_da_carteira: true }],
      },
      include: { alvo: true },
      orderBy: { chave_export: "asc" },
    }),
  ]);

  return {
    versao: VERSAO_ATUAL,
    exportadoEm: new Date().toISOString(),
    settings: {
      banda_tolerancia_bps: settings.banda_tolerancia_bps as number,
      aporte_minimo_centavos: settings.aporte_minimo_centavos as number,
      retencao_backups: settings.retencao_backups as number,
    },
    alvos: alvosAbertos.map((a) => ({
      nome: a.nome,
      percentualAlvoBps: a.percentual_alvo_bps,
    })),
    vinculos: vinculosResolvidos.map((v) => ({
      chaveExport: v.chave_export,
      alvoNome: v.fora_da_carteira ? null : (v.alvo?.nome ?? null),
      foraDaCarteira: v.fora_da_carteira,
    })),
  };
}

/** Erro claro de validação de formato — lançado por `importarConfigJson` antes de tocar no banco. */
class ConfigJsonInvalidoError extends Error {
  constructor(motivo: string) {
    super(`importarConfigJson: JSON de configuração inválido — ${motivo}`);
    this.name = "ConfigJsonInvalidoError";
  }
}

/**
 * Valida o formato do JSON portável (versão suportada + campos
 * obrigatórios) antes de qualquer escrita. Função de asserção: se não
 * lançar, `json` pode ser tratado como `ConfigExportJson` dali em diante.
 */
function validarConfigJson(json: unknown): asserts json is ConfigExportJson {
  if (typeof json !== "object" || json === null) {
    throw new ConfigJsonInvalidoError("esperado um objeto JSON.");
  }
  const obj = json as Record<string, unknown>;

  if (typeof obj.versao !== "number" || !VERSOES_SUPORTADAS.includes(obj.versao as VersaoSuportada)) {
    throw new ConfigJsonInvalidoError(
      `versão "${String(obj.versao)}" não suportada. Versões suportadas: ${VERSOES_SUPORTADAS.join(", ")}.`,
    );
  }

  if (typeof obj.settings !== "object" || obj.settings === null) {
    throw new ConfigJsonInvalidoError("campo \"settings\" ausente ou inválido.");
  }
  const settings = obj.settings as Record<string, unknown>;
  for (const chave of Object.keys(CONFIG_DEFAULTS)) {
    if (typeof settings[chave] !== "number") {
      throw new ConfigJsonInvalidoError(`settings.${chave} ausente ou não numérico.`);
    }
  }

  if (!Array.isArray(obj.alvos)) {
    throw new ConfigJsonInvalidoError("campo \"alvos\" ausente ou não é um array.");
  }
  const nomesVistos = new Set<string>();
  for (const [i, a] of obj.alvos.entries()) {
    if (
      typeof a !== "object" ||
      a === null ||
      typeof (a as Record<string, unknown>).nome !== "string" ||
      (a as Record<string, unknown>).nome === "" ||
      typeof (a as Record<string, unknown>).percentualAlvoBps !== "number"
    ) {
      throw new ConfigJsonInvalidoError(`alvos[${i}] inválido — esperado {nome: string, percentualAlvoBps: number}.`);
    }
    const nome = (a as { nome: string }).nome;
    if (nomesVistos.has(nome)) {
      throw new ConfigJsonInvalidoError(
        `alvos[${i}] tem nome "${nome}" duplicado — nomes de alvo devem ser únicos no JSON (são a chave de correspondência do import).`,
      );
    }
    nomesVistos.add(nome);
  }

  if (!Array.isArray(obj.vinculos)) {
    throw new ConfigJsonInvalidoError("campo \"vinculos\" ausente ou não é um array.");
  }
  for (const [i, v] of obj.vinculos.entries()) {
    if (typeof v !== "object" || v === null) {
      throw new ConfigJsonInvalidoError(`vinculos[${i}] inválido.`);
    }
    const vinculo = v as Record<string, unknown>;
    if (typeof vinculo.chaveExport !== "string" || vinculo.chaveExport === "") {
      throw new ConfigJsonInvalidoError(`vinculos[${i}].chaveExport ausente ou vazio.`);
    }
    if (typeof vinculo.foraDaCarteira !== "boolean") {
      throw new ConfigJsonInvalidoError(`vinculos[${i}].foraDaCarteira ausente ou não booleano.`);
    }
    if (!vinculo.foraDaCarteira && typeof vinculo.alvoNome !== "string") {
      throw new ConfigJsonInvalidoError(
        `vinculos[${i}] não está fora da carteira, mas "alvoNome" não é uma string.`,
      );
    }
    if (vinculo.foraDaCarteira && vinculo.alvoNome !== null && vinculo.alvoNome !== undefined) {
      throw new ConfigJsonInvalidoError(
        `vinculos[${i}] está fora da carteira, mas "alvoNome" deveria ser null (exclusão mútua).`,
      );
    }
  }
}

/** Resumo do resultado de `importarConfigJson`, para exibição na tela 6.8. */
export interface ImportarConfigResultado {
  alvosCriados: number;
  vinculosCriados: number;
  vinculosAtualizados: number;
}

/**
 * Restaura o estado configurável a partir de um JSON exportado por
 * `exportarConfigJson`. Política adotada (documentada aqui por ser uma
 * decisão de design não totalmente formalizada pela spec):
 *
 * 1. **Settings**: aplicados via `setConfig` (upsert simples) — sempre
 *    refletem exatamente o que está no JSON.
 *
 * 2. **Alvos**: a vigência aberta atual é **fechada** (mesmo mecanismo de
 *    `novaVigencia` em alvo-service.ts: `vigencia_fim = agora` em todos os
 *    alvos com `vigencia_fim = null`) e os alvos do JSON são criados como a
 *    NOVA vigência aberta. Escolhido em vez de apagar/recriar in-place
 *    porque: (a) nunca há `DELETE` de `alvo` em lugar nenhum do sistema
 *    (soft delete via `ativo=false` é o padrão estabelecido em
 *    `removerAlvo`) — abrir uma exceção aqui quebraria essa invariante; (b)
 *    preserva o histórico da configuração anterior para auditoria, mesmo
 *    quando o "restore" é destinado a substituí-la; (c) nunca quebra a FK de
 *    `ativo_mapeado` que ainda aponte para os alvos antigos (eles continuam
 *    existindo, só ficam fora da vigência aberta).
 *
 * 3. **Vínculos**: para cada vínculo do JSON, o alvo é resolvido pelo NOME
 *    entre os alvos recém-criados (passo 2) e o registro de
 *    `ativo_mapeado` correspondente é criado/atualizado (upsert) por
 *    `chave_export`. Política de mesclagem escolhida: **vínculos existentes
 *    que não aparecem no JSON NÃO são apagados nem alterados** — ficam como
 *    estavam (o que, após o fechamento da vigência no passo 2, tipicamente
 *    significa que continuam apontando para um alvo agora histórico/fechado,
 *    até o usuário os revincular manualmente na tela de vínculos). Optou-se
 *    por não apagar porque `ativo_mapeado` é referenciado por `dividendo`
 *    (FK `dividendo.chave_export`) — apagar um vínculo "esquecido" no JSON
 *    poderia órfão registros de dividendo que são imutáveis por regra do
 *    projeto. "Restaurar configuração" aqui significa reaplicar exatamente o
 *    que foi exportado, não podar o que não foi.
 *
 * REGRA INVIOLÁVEL: nenhuma linha deste fluxo toca `sessao_import`,
 * `posicao`, `aporte` ou `dividendo`.
 */
export async function importarConfigJson(json: unknown): Promise<ImportarConfigResultado> {
  validarConfigJson(json);

  return prisma.$transaction(async (tx) => {
    // 1. Settings — upsert direto (mesma serialização de `setConfig`, mas
    // via `tx` para ficar na mesma transação atômica dos alvos/vínculos).
    for (const chave of Object.keys(CONFIG_DEFAULTS) as ChaveConfig[]) {
      const valor = json.settings[chave];
      await tx.config.upsert({
        where: { chave },
        update: { valor: JSON.stringify(valor) },
        create: { chave, valor: JSON.stringify(valor) },
      });
    }

    // 2. Alvos — fecha a vigência aberta atual (se houver) e cria os alvos
    // do JSON como a nova vigência aberta.
    const agora = new Date();
    const abertos = await tx.alvo.findMany({ where: { vigencia_fim: null } });
    if (abertos.length > 0) {
      await tx.alvo.updateMany({
        where: { id: { in: abertos.map((a) => a.id) } },
        data: { vigencia_fim: agora },
      });
    }

    const idPorNome = new Map<string, string>();
    for (const a of json.alvos) {
      const criado = await tx.alvo.create({
        data: {
          nome: a.nome,
          percentual_alvo_bps: a.percentualAlvoBps,
          vigencia_inicio: agora,
          vigencia_fim: null,
          ativo: true,
        },
      });
      idPorNome.set(a.nome, criado.id);
    }

    // 3. Vínculos — upsert por chave_export, resolvendo o alvo pelo nome.
    let vinculosCriados = 0;
    let vinculosAtualizados = 0;
    for (const v of json.vinculos) {
      let alvoId: string | null = null;
      if (!v.foraDaCarteira) {
        const id = idPorNome.get(v.alvoNome ?? "");
        if (!id) {
          throw new ConfigJsonInvalidoError(
            `vínculo "${v.chaveExport}" referencia o alvo "${v.alvoNome}", que não está presente na lista de alvos do próprio JSON.`,
          );
        }
        alvoId = id;
      }

      const existente = await tx.ativo_mapeado.findUnique({ where: { chave_export: v.chaveExport } });
      await tx.ativo_mapeado.upsert({
        where: { chave_export: v.chaveExport },
        create: { chave_export: v.chaveExport, alvo_id: alvoId, fora_da_carteira: v.foraDaCarteira },
        update: { alvo_id: alvoId, fora_da_carteira: v.foraDaCarteira },
      });
      if (existente) {
        vinculosAtualizados += 1;
      } else {
        vinculosCriados += 1;
      }
    }

    return {
      alvosCriados: idPorNome.size,
      vinculosCriados,
      vinculosAtualizados,
    };
  });
}
