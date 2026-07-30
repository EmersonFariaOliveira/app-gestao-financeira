import { prisma } from "@/db/client";
import { parseArquivoMyCapital } from "@/parser/mycapital";
import type { ArquivoImport, ArquivoParseado, ErroParse } from "@/parser/types";
import { executarBackupComRetencao } from "@/services/backup-service";

// Serviço de import mensal (T036): orquestra o parse em memória (preview,
// sem persistir nada) e a confirmação (backup + transação Prisma) de uma
// sessão de import (data-model.md `sessao_import`/`posicao`). Camada de
// I/O — pode importar Prisma/parser livremente; não é importada por
// src/core/** (ver eslint.config.mjs).
//
// Regra inviolável (data-model.md, seção "Regras de integridade
// transversais" e docs/app-gestao-aportes.md seção 4): nenhuma sessão ou
// posição anterior é deletada ou tem UPDATE de conteúdo — só a transição de
// `status` de VIGENTE para SUBSTITUIDO. Erro de parse em qualquer arquivo
// (preview ou confirmação) invalida a operação inteira: nada persiste.

/** Resumo por instituição exibido no preview (contracts/server-actions.md). */
export interface PreviewInstituicaoResumo {
  instituicao: string;
  totalCentavos: number;
  qtdAtivos: number;
  dataMaisRecente: string | null;
}

export interface AvisoSubstituicao {
  /** `mes_referencia` proposto/informado para este import. */
  mes: string;
  /** `data_export` (ISO) da sessão VIGENTE que será substituída. */
  dataAnterior: string;
}

export interface VariacaoGrande {
  chaveExport: string;
  valorAnteriorCentavos: number;
  valorNovoCentavos: number;
  /** Sinalizada: positiva = aumentou, negativa = diminuiu. */
  variacaoPercentual: number;
}

/**
 * Diff de posições consolidadas por `chave_export` desta sessão contra uma
 * sessão de referência (decisão de design, ver `resolverSessaoParaDiff`).
 */
export interface DiffPosicoes {
  /** Chaves que não existiam na sessão de referência. */
  novos: string[];
  /** Chaves que existiam na sessão de referência e não vieram neste import. */
  sumiram: string[];
  variacoesGrandes: VariacaoGrande[];
}

export type PreviewImportResultado =
  | {
      ok: true;
      arquivos: PreviewInstituicaoResumo[];
      mesReferenciaProposto: string;
      dataExport: string;
      avisoSubstituicao?: AvisoSubstituicao;
      instituicoesFaltantes?: string[];
      diff?: DiffPosicoes;
    }
  | { ok: false; erros: ErroParse[] };

export interface ConfirmarImportInput {
  arquivos: ArquivoImport[];
  /** `mes_referencia` (`YYYY-MM`) — respeita edição manual feita no preview (research.md R9). */
  mesReferencia: string;
  /** Exigido explicitamente (`=== true`) quando há instituição faltante vs. a sessão anterior (seção 6.2). */
  confirmouInstituicoesFaltantes?: boolean;
}

export type ConfirmarImportResultado =
  | { ok: true; sessaoId: string; pendenciasVinculo: string[] }
  | { ok: false; erro: string; erros?: ErroParse[]; instituicoesFaltantes?: string[] };

/**
 * Limiar de "variação grande" no diff (regra intencionalmente deixada em
 * aberto pela spec — "ex. 20%"): variação relativa >= 20% em módulo, para
 * chaves presentes em ambas as sessões. Documentado aqui como a única fonte
 * da verdade deste número; se um dia virar configurável, este é o ponto de
 * extensão.
 */
const LIMIAR_VARIACAO_GRANDE_PCT = 20;

/** Formato exato do parser: ISO date/datetime — comparável lexicograficamente. */
function derivarDataExportISO(arquivos: ArquivoParseado[]): string {
  let maxData: string | null = null;
  for (const arquivo of arquivos) {
    if (arquivo.dataMaisRecente === null) continue;
    if (maxData === null || arquivo.dataMaisRecente > maxData) {
      maxData = arquivo.dataMaisRecente;
    }
  }
  // Nenhuma linha de nenhum arquivo trouxe dataUltimaCotacao (ex.: import só
  // com EXTERIOR/Avenue, onde a data vem "null" literal em todas as linhas):
  // não há como derivar a data das posições a partir do CSV. Decisão de
  // design: cair para "agora" (o usuário ainda pode editar mesReferencia no
  // preview antes de confirmar — R9). Alternativa rejeitada: lançar erro,
  // que bloquearia um cenário legítimo (import só de instituição EXTERIOR).
  return maxData ?? new Date().toISOString();
}

function derivarMesReferencia(dataExportISO: string): string {
  return dataExportISO.slice(0, 7);
}

/** Soma `patrimonioHojeCentavos`/`patrimonio_hoje_centavos` por `chave_export` (consolidação em leitura — data-model.md). */
function consolidarPorChave(
  linhas: { chaveExport: string; valorCentavos: number }[],
): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const linha of linhas) {
    mapa.set(linha.chaveExport, (mapa.get(linha.chaveExport) ?? 0) + linha.valorCentavos);
  }
  return mapa;
}

function calcularDiff(
  novoConsolidado: Map<string, number>,
  anteriorConsolidado: Map<string, number>,
): DiffPosicoes {
  const novos: string[] = [];
  const sumiram: string[] = [];
  const variacoesGrandes: VariacaoGrande[] = [];

  for (const chave of novoConsolidado.keys()) {
    if (!anteriorConsolidado.has(chave)) novos.push(chave);
  }
  for (const chave of anteriorConsolidado.keys()) {
    if (!novoConsolidado.has(chave)) sumiram.push(chave);
  }
  for (const [chave, valorNovoCentavos] of novoConsolidado) {
    const valorAnteriorCentavos = anteriorConsolidado.get(chave);
    // Ausente em um dos lados já virou novos/sumiram acima; valor anterior
    // zero tornaria a variação percentual indefinida/infinita — sem sinal
    // útil, então não entra em variacoesGrandes (não é um "sumiu" nem um
    // "novo", mas também não há base para medir variação relativa).
    if (valorAnteriorCentavos === undefined || valorAnteriorCentavos === 0) continue;

    const variacaoPercentual =
      ((valorNovoCentavos - valorAnteriorCentavos) / valorAnteriorCentavos) * 100;
    if (Math.abs(variacaoPercentual) >= LIMIAR_VARIACAO_GRANDE_PCT) {
      variacoesGrandes.push({
        chaveExport: chave,
        valorAnteriorCentavos,
        valorNovoCentavos,
        variacaoPercentual,
      });
    }
  }

  return { novos, sumiram, variacoesGrandes };
}

/** Parseia todos os arquivos; falha alto: qualquer erro em qualquer arquivo invalida a operação inteira. */
function parseTodos(
  arquivos: ArquivoImport[],
): { ok: true; arquivos: ArquivoParseado[] } | { ok: false; erros: ErroParse[] } {
  const resultados = arquivos.map((arquivo) => parseArquivoMyCapital(arquivo));
  const erros: ErroParse[] = [];
  for (const resultado of resultados) {
    if (!resultado.ok) erros.push(...resultado.erros);
  }
  if (erros.length > 0) return { ok: false, erros };

  const arquivosParseados = resultados.map((r) => (r as { ok: true; arquivo: ArquivoParseado }).arquivo);
  return { ok: true, arquivos: arquivosParseados };
}

/** Sessão VIGENTE mais recente entre TODOS os meses (mesma noção usada em aporte-service). */
async function obterSessaoVigenteMaisRecente() {
  return prisma.sessao_import.findFirst({
    where: { status: "VIGENTE" },
    orderBy: [{ data_export: "desc" }, { criado_em: "desc" }],
  });
}

/** Sessão VIGENTE do `mes_referencia` informado, se houver (no máximo uma — invariante de aplicação). */
async function obterSessaoVigenteDoMes(mesReferencia: string) {
  return prisma.sessao_import.findFirst({
    where: { mes_referencia: mesReferencia, status: "VIGENTE" },
  });
}

/** Instituições ausentes neste import em relação a uma sessão de referência (JSON `instituicoes`). */
function calcularInstituicoesFaltantes(
  instituicoesAtuais: string[],
  sessaoReferencia: { instituicoes: string } | null,
): string[] {
  if (!sessaoReferencia) return [];
  const instituicoesAnteriores: string[] = JSON.parse(sessaoReferencia.instituicoes);
  return instituicoesAnteriores.filter((i) => !instituicoesAtuais.includes(i));
}

/** Chaves pendentes de vínculo (data-model.md: `alvo_id = null AND fora_da_carteira = false`, ou sem registro algum). */
async function listarPendenciasDaSessao(sessaoId: string): Promise<string[]> {
  const posicoes = await prisma.posicao.findMany({
    where: { sessao_import_id: sessaoId },
    select: { chave_export: true },
    distinct: ["chave_export"],
  });
  const chaves = posicoes.map((p) => p.chave_export);
  if (chaves.length === 0) return [];

  const mapeamentos = await prisma.ativo_mapeado.findMany({
    where: { chave_export: { in: chaves } },
  });
  const mapaPorChave = new Map(mapeamentos.map((m) => [m.chave_export, m]));

  return chaves.filter((chave) => {
    const mapeamento = mapaPorChave.get(chave);
    return !mapeamento || (mapeamento.alvo_id === null && !mapeamento.fora_da_carteira);
  });
}

/**
 * Preview de um import multi-arquivo: parse 100% EM MEMÓRIA — nada persiste,
 * inclusive quando há erro de parse (retorna `ok: false` com todos os erros
 * de todos os arquivos, nunca resultado parcial).
 *
 * Decisões de design documentadas aqui (spec deixava espaço):
 * - `instituicoesFaltantes` compara contra a sessão VIGENTE mais recente de
 *   QUALQUER mês (não necessariamente do mesmo mês do import) — é a leitura
 *   mais direta de "a sessão anterior" quando ainda não existe sessão do mês
 *   corrente (primeiro import de um mês novo).
 * - `avisoSubstituicao` compara contra a sessão VIGENTE do MESMO
 *   `mes_referencia` proposto — é especificamente o aviso de substituição.
 * - `diff` usa a sessão VIGENTE do mesmo mês quando existe (caso comum:
 *   reimport do mês corrente); na ausência dela, cai para a sessão VIGENTE
 *   mais recente de qualquer mês (fallback razoável: comparar com "como a
 *   carteira estava da última vez que sabíamos"). Sem nenhuma sessão
 *   VIGENTE anterior (primeiro import do app), `diff` é omitido.
 */
export async function previewImport(arquivos: ArquivoImport[]): Promise<PreviewImportResultado> {
  const parse = parseTodos(arquivos);
  if (!parse.ok) return { ok: false, erros: parse.erros };

  const arquivosParseados = parse.arquivos;

  const resumoPorInstituicao: PreviewInstituicaoResumo[] = arquivosParseados.map((a) => ({
    instituicao: a.instituicao,
    totalCentavos: a.totalCentavos,
    qtdAtivos: a.linhas.length,
    dataMaisRecente: a.dataMaisRecente,
  }));

  const dataExport = derivarDataExportISO(arquivosParseados);
  const mesReferenciaProposto = derivarMesReferencia(dataExport);
  const instituicoesAtuais = arquivosParseados.map((a) => a.instituicao);

  const [sessaoMesmoMes, sessaoMaisRecenteQualquerMes] = await Promise.all([
    obterSessaoVigenteDoMes(mesReferenciaProposto),
    obterSessaoVigenteMaisRecente(),
  ]);

  const avisoSubstituicao: AvisoSubstituicao | undefined = sessaoMesmoMes
    ? { mes: mesReferenciaProposto, dataAnterior: sessaoMesmoMes.data_export.toISOString() }
    : undefined;

  const faltantes = calcularInstituicoesFaltantes(instituicoesAtuais, sessaoMaisRecenteQualquerMes);
  const instituicoesFaltantes = faltantes.length > 0 ? faltantes : undefined;

  const sessaoParaDiff = sessaoMesmoMes ?? sessaoMaisRecenteQualquerMes;
  let diff: DiffPosicoes | undefined;
  if (sessaoParaDiff) {
    const posicoesAnteriores = await prisma.posicao.findMany({
      where: { sessao_import_id: sessaoParaDiff.id },
    });
    const anteriorConsolidado = consolidarPorChave(
      posicoesAnteriores.map((p) => ({
        chaveExport: p.chave_export,
        valorCentavos: p.patrimonio_hoje_centavos,
      })),
    );
    const novoConsolidado = consolidarPorChave(
      arquivosParseados.flatMap((a) =>
        a.linhas.map((linha) => ({
          chaveExport: linha.chaveExport,
          valorCentavos: linha.patrimonioHojeCentavos,
        })),
      ),
    );
    diff = calcularDiff(novoConsolidado, anteriorConsolidado);
  }

  return {
    ok: true,
    arquivos: resumoPorInstituicao,
    mesReferenciaProposto,
    dataExport,
    avisoSubstituicao,
    instituicoesFaltantes,
    diff,
  };
}

/**
 * Confirma um import: cria a sessão VIGENTE + posições + pendências de
 * vínculo em transação, precedida do backup datado (research.md R8) e do
 * bloqueio explícito de instituição faltante sem confirmação.
 *
 * Estratégia de reuso do preview (decisão de design documentada): esta
 * função RE-PARSEIA os arquivos recebidos em vez de aceitar um token de
 * cache do preview. Justificativa: `import-service` é uma camada de
 * serviço stateless (sem sessão HTTP própria); introduzir um cache
 * in-memory ou persistido só para evitar um re-parse (operação barata, em
 * memória, sem I/O) trocaria simplicidade e correção por uma otimização
 * sem necessidade demonstrada — e evita invalidação de cache (arquivo
 * mudou entre preview e confirmação?). Se a camada de UI (T038) quiser
 * evitar reenviar os arquivos, ela pode manter os `File`/bytes no cliente
 * e reenviar no `confirmarImport`; a responsabilidade de "token" fica na
 * borda (server action), não neste serviço.
 */
export async function confirmarImport(
  input: ConfirmarImportInput,
): Promise<ConfirmarImportResultado> {
  const parse = parseTodos(input.arquivos);
  if (!parse.ok) {
    return {
      ok: false,
      erro: "Erro de parse em um ou mais arquivos — nada foi persistido.",
      erros: parse.erros,
    };
  }
  const arquivosParseados = parse.arquivos;

  if (!/^\d{4}-\d{2}$/.test(input.mesReferencia)) {
    return {
      ok: false,
      erro: `mesReferencia inválido: "${input.mesReferencia}" (esperado "YYYY-MM").`,
    };
  }

  const instituicoesAtuais = arquivosParseados.map((a) => a.instituicao);

  // Checagem de completude (seção 6.2): contra a sessão VIGENTE mais recente
  // de QUALQUER mês — mesma referência usada no preview (ver comentário de
  // `previewImport`), para que o aviso mostrado ao usuário e a checagem
  // exigida na confirmação sejam sempre a mesma comparação.
  const sessaoMaisRecenteQualquerMes = await obterSessaoVigenteMaisRecente();
  const instituicoesFaltantes = calcularInstituicoesFaltantes(
    instituicoesAtuais,
    sessaoMaisRecenteQualquerMes,
  );
  if (instituicoesFaltantes.length > 0 && input.confirmouInstituicoesFaltantes !== true) {
    return {
      ok: false,
      erro: `Instituições presentes no import anterior e ausentes deste import: ${instituicoesFaltantes.join(", ")}. Confirme explicitamente (confirmouInstituicoesFaltantes: true) para prosseguir.`,
      instituicoesFaltantes,
    };
  }

  const dataExportISO = derivarDataExportISO(arquivosParseados);
  const dataExport = new Date(dataExportISO);
  const instituicoesJson = JSON.stringify(instituicoesAtuais);

  const todasLinhas = arquivosParseados.flatMap((arquivo) =>
    arquivo.linhas.map((linha) => ({ ...linha, instituicao: arquivo.instituicao })),
  );

  // Backup ANTES de qualquer escrita (research.md R8) — fora da transação,
  // e só depois de toda validação acima (parse + completude), para nunca
  // criar um backup datado às vésperas de uma operação que será recusada.
  await executarBackupComRetencao();

  const sessaoId = await prisma.$transaction(async (tx) => {
    const sessaoAnteriorMesmoMes = await tx.sessao_import.findFirst({
      where: { mes_referencia: input.mesReferencia, status: "VIGENTE" },
    });

    const novaSessao = await tx.sessao_import.create({
      data: {
        mes_referencia: input.mesReferencia,
        data_export: dataExport,
        status: "VIGENTE",
        instituicoes: instituicoesJson,
      },
    });

    if (todasLinhas.length > 0) {
      await tx.posicao.createMany({
        data: todasLinhas.map((linha) => ({
          sessao_import_id: novaSessao.id,
          chave_export: linha.chaveExport,
          instituicao: linha.instituicao,
          quantidade: linha.quantidade,
          patrimonio_hoje_centavos: linha.patrimonioHojeCentavos,
          tipo_grupo: linha.tipoGrupo,
          tipo_ativo_internacional: linha.tipoAtivoInternacional,
          data_ultima_cotacao: linha.dataUltimaCotacao ? new Date(linha.dataUltimaCotacao) : null,
        })),
      });
    }

    // Vínculo memorizado (seção 4): só cria `ativo_mapeado` pendente para
    // chaves que NUNCA tiveram registro — uma chave já mapeada (vinculada
    // ou fora-da-carteira) em um import anterior nunca vira pendência de
    // novo, mesmo que a sessão que a criou já tenha sido substituída.
    const chavesUnicas = Array.from(new Set(todasLinhas.map((l) => l.chaveExport)));
    if (chavesUnicas.length > 0) {
      const existentes = await tx.ativo_mapeado.findMany({
        where: { chave_export: { in: chavesUnicas } },
        select: { chave_export: true },
      });
      const chavesExistentes = new Set(existentes.map((e) => e.chave_export));
      const chavesNovas = chavesUnicas.filter((c) => !chavesExistentes.has(c));

      if (chavesNovas.length > 0) {
        await tx.ativo_mapeado.createMany({
          data: chavesNovas.map((chave) => ({
            chave_export: chave,
            alvo_id: null,
            fora_da_carteira: false,
          })),
        });
      }
    }

    // Transição de estado (data-model.md): a sessão VIGENTE anterior do
    // MESMO mes_referencia (se houver) vira SUBSTITUIDO — nunca DELETE,
    // nunca UPDATE de conteúdo além do campo `status`.
    if (sessaoAnteriorMesmoMes) {
      await tx.sessao_import.update({
        where: { id: sessaoAnteriorMesmoMes.id },
        data: { status: "SUBSTITUIDO" },
      });
    }

    return novaSessao.id;
  });

  const pendenciasVinculo = await listarPendenciasDaSessao(sessaoId);

  return { ok: true, sessaoId, pendenciasVinculo };
}
