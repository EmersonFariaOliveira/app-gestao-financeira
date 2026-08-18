/**
 * tests/services/aporte-import-ciclo-completo.test.ts — teste de integração
 * PONTA A PONTA (engenheiro-testes, revisão final da feature
 * 002-posicoes-manuais-ajustes, T026/US4) atravessando as camadas de
 * serviço `aporte-service` + `posicao-manual-service` + `import-service`
 * juntas, contra o MESMO SQLite temporário — diferente de
 * tests/services/aporte-service.test.ts e tests/services/import-service.test.ts,
 * que testam cada serviço isoladamente e SIMULAM o estado de banco que o
 * outro serviço produziria (ex.: `criarPendenciaIncremento` via Prisma
 * direto, em vez de chamar `aporteService.registrarAporte` de verdade).
 *
 * Ciclo coberto aqui (motor-integracao.md §4, FR-010 a FR-013):
 *   1. registrarAporte (aporte-service) gera incremento_valor_investido_pendente
 *      de verdade — tanto o caso exclusivo (1 elegível) quanto o ambíguo
 *      (2+ elegíveis).
 *   2. previewImport (import-service) do próximo mês SOMA esse incremento
 *      de verdade na revisão (posicoesManuaisRevisao/incrementosAmbiguosPendentes).
 *   3. confirmarImport marca a pendência como aplicada NA MESMA transação
 *      que persiste a nova sessão.
 *   4. Um novo previewImport (simulando reimport do mês seguinte) NÃO soma
 *      mais a mesma pendência — sem duplicação.
 *
 * Mesma estratégia de DATABASE_URL temporário + imports dinâmicos dos
 * outros arquivos de tests/services/*.test.ts.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArquivoImport } from "@/parser/types";

let tmpDir: string;
let backupsDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let aporteService: typeof import("@/services/aporte-service");
let importService: typeof import("@/services/import-service");
let posicaoManualService: typeof import("@/services/posicao-manual-service");
let backupService: typeof import("@/services/backup-service");

const COLUNAS = ["Ação", "Quantidade", "Patrimônio Hoje", "Tipo de Grupo", "dataUltimaCotacao"];

function bytesDoArquivo(linhas: string[]): Uint8Array {
  return new TextEncoder().encode(linhas.join("\n"));
}

function header(): string {
  return COLUNAS.join(";");
}

function linha(opts?: { acao?: string; patrimonioHoje?: string }): string {
  const { acao = "PRIO3", patrimonioHoje = "1234.56" } = opts ?? {};
  return [acao, "100", patrimonioHoje, "ACOES", "2026-07-28T03:00:00.000Z"].join(";");
}

function arquivoInstituicao(instituicao: string, linhasDados: string[]): ArquivoImport {
  return { nomeArquivo: `Export_${instituicao}.csv`, conteudo: bytesDoArquivo([header(), ...linhasDados]) };
}

function linhaAporteExecutada(alvoId: string, nomeAlvo: string, valorCentavos: number) {
  return { alvo_id: alvoId, nome_alvo: nomeAlvo, valor_centavos: valorCentavos, origem: "DEFICIT" as const };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aporte-import-ciclo-completo-test-"));
  backupsDir = path.join(tmpDir, "backups");
  const dbPath = path.join(tmpDir, "test.db").split(path.sep).join("/");
  const databaseUrl = `file:${dbPath}`;
  process.env.DATABASE_URL = databaseUrl;

  try {
    execSync("npx prisma migrate deploy", {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
  } catch (erro) {
    console.error((erro as { stdout?: Buffer }).stdout?.toString());
    throw erro;
  }

  const dbModule = await import("@/db/client");
  prisma = dbModule.prisma;
  aporteService = await import("@/services/aporte-service");
  importService = await import("@/services/import-service");
  posicaoManualService = await import("@/services/posicao-manual-service");
  backupService = await import("@/services/backup-service");
}, 30_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function resetDb() {
  await prisma.incremento_valor_investido_pendente.deleteMany();
  await prisma.dividendo.deleteMany();
  await prisma.posicao_manual_valor.deleteMany();
  await prisma.ajuste_valor_investido.deleteMany();
  await prisma.aporte.deleteMany();
  await prisma.posicao.deleteMany();
  await prisma.ativo_mapeado.deleteMany();
  await prisma.posicao_manual.deleteMany();
  await prisma.sessao_import.deleteMany();
  await prisma.alvo.deleteMany();
  await prisma.config.deleteMany();
}

beforeEach(async () => {
  await resetDb();
  if (fs.existsSync(backupsDir)) fs.rmSync(backupsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  // Mesmo racional de tests/services/import-service.test.ts: nunca gravar
  // backup real fora do diretório temporário do teste.
  vi.spyOn(backupService, "executarBackupComRetencao").mockResolvedValue({
    backup: { caminho: path.join(backupsDir, "mock.db"), nomeArquivo: "mock.db" },
    removidos: [],
  });
});

async function criarAlvo(nome: string, percentualBps: number) {
  return prisma.alvo.create({
    data: { nome, percentual_alvo_bps: percentualBps, vigencia_inicio: new Date("2026-01-01") },
  });
}

describe("ciclo completo: registrarAporte -> previewImport -> confirmarImport -> reimport não duplica (T026, motor-integracao.md §4)", () => {
  it("caso EXCLUSIVO (1 posição manual elegível): incremento gerado por registrarAporte é somado no próximo previewImport, aplicado na confirmação, e não reaparece no import seguinte", async () => {
    const alvo = await criarAlvo("Pós-fixado exclusivo", 3000);

    const r1 = await importService.confirmarImport({
      arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
      mesReferencia: "2026-06",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const posicaoManual = await posicaoManualService.criarPosicaoManual({
      chaveManual: "CDB-ITAU-2029",
      instituicao: "Itaú",
      descricao: "CDB Itaú 120% CDI 2029",
      alvoId: alvo.id,
      valorInvestidoCentavos: 500_000,
      valorAtualCentavos: 520_000,
    });

    // 1) registrarAporte de verdade gera o incremento (não simulado via Prisma direto).
    await aporteService.registrarAporte({
      sessaoImportId: r1.sessaoId,
      sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 40_000)],
      executado: [linhaAporteExecutada(alvo.id, alvo.nome, 40_000)],
      valorTotalCentavos: 40_000,
      valorDividendosCentavos: 0,
      trocoCentavos: 0,
    });

    const pendenciaGerada = await prisma.incremento_valor_investido_pendente.findFirstOrThrow({
      where: { posicao_manual_id: posicaoManual.id },
    });
    expect(pendenciaGerada.valor_incremento_centavos).toBe(40_000);
    expect(pendenciaGerada.aplicado).toBe(false);

    // 2) previewImport do mês seguinte soma o incremento de verdade.
    const preview1 = await importService.previewImport([
      arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })]),
    ]);
    expect(preview1.ok).toBe(true);
    if (!preview1.ok) return;

    expect(preview1.posicoesManuaisRevisao).toHaveLength(1);
    expect(preview1.posicoesManuaisRevisao[0]).toMatchObject({
      posicaoManualId: posicaoManual.id,
      valorInvestidoCentavosAnterior: 500_000,
      incrementoPendenteCentavos: 40_000,
      valorInvestidoCentavosSugerido: 540_000,
    });

    // 3) confirmarImport persiste o valor sugerido e marca a pendência como aplicada.
    const r2 = await importService.confirmarImport({
      arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })])],
      mesReferencia: "2026-07",
      posicoesManuaisConfirmadas: [
        { posicaoManualId: posicaoManual.id, valorInvestidoCentavos: 540_000, valorAtualCentavos: 560_000 },
      ],
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    const pendenciaDepois = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow({
      where: { id: pendenciaGerada.id },
    });
    expect(pendenciaDepois.aplicado).toBe(true);
    expect(pendenciaDepois.sessao_aplicacao_id).toBe(r2.sessaoId);

    // 4) reimport do mês seguinte NÃO soma mais essa pendência (sem duplicação).
    const preview2 = await importService.previewImport([
      arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2100.00" })]),
    ]);
    expect(preview2.ok).toBe(true);
    if (!preview2.ok) return;

    expect(preview2.posicoesManuaisRevisao).toHaveLength(1);
    expect(preview2.posicoesManuaisRevisao[0]).toMatchObject({
      posicaoManualId: posicaoManual.id,
      valorInvestidoCentavosAnterior: 540_000,
      incrementoPendenteCentavos: 0,
      valorInvestidoCentavosSugerido: 540_000,
    });
  });

  it("caso AMBÍGUO (2 posições manuais elegíveis no mesmo alvo): incremento ambíguo gerado por registrarAporte aparece em incrementosAmbiguosPendentes com os 2 elegíveis, é consumido integralmente na confirmação (research.md R5) e não reaparece no import seguinte", async () => {
    const alvo = await criarAlvo("Multimercado ambíguo E2E", 5000);

    const r1 = await importService.confirmarImport({
      arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
      mesReferencia: "2026-06",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const posicaoManual1 = await posicaoManualService.criarPosicaoManual({
      chaveManual: "CDB-1",
      instituicao: "Itaú",
      descricao: "CDB Um",
      alvoId: alvo.id,
      valorInvestidoCentavos: 100_000,
      valorAtualCentavos: 100_000,
    });
    const posicaoManual2 = await posicaoManualService.criarPosicaoManual({
      chaveManual: "CDB-2",
      instituicao: "Itaú",
      descricao: "CDB Dois",
      alvoId: alvo.id,
      valorInvestidoCentavos: 200_000,
      valorAtualCentavos: 200_000,
    });

    // 1) registrarAporte de verdade: n=2 elegíveis ⇒ incremento AMBÍGUO
    // (alvo_id preenchido, chave_export/posicao_manual_id ambos null).
    await aporteService.registrarAporte({
      sessaoImportId: r1.sessaoId,
      sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 60_000)],
      executado: [linhaAporteExecutada(alvo.id, alvo.nome, 60_000)],
      valorTotalCentavos: 60_000,
      valorDividendosCentavos: 0,
      trocoCentavos: 0,
    });

    const pendenciaGerada = await prisma.incremento_valor_investido_pendente.findFirstOrThrow({
      where: { alvo_id: alvo.id },
    });
    expect(pendenciaGerada.chave_export).toBeNull();
    expect(pendenciaGerada.posicao_manual_id).toBeNull();
    expect(pendenciaGerada.valor_incremento_centavos).toBe(60_000);

    // 2) previewImport do mês seguinte agrega a pendência ambígua por alvo,
    // listando os 2 elegíveis para distribuição manual pela UI.
    const preview1 = await importService.previewImport([
      arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })]),
    ]);
    expect(preview1.ok).toBe(true);
    if (!preview1.ok) return;

    expect(preview1.incrementosAmbiguosPendentes).toHaveLength(1);
    expect(preview1.incrementosAmbiguosPendentes[0]).toMatchObject({
      alvoId: alvo.id,
      nomeAlvo: "Multimercado ambíguo E2E",
      valorPendenteCentavos: 60_000,
    });
    expect(preview1.incrementosAmbiguosPendentes[0].elegiveis).toEqual(
      expect.arrayContaining([
        { tipo: "posicaoManual", id: posicaoManual1.id, rotulo: "CDB Um (Itaú)" },
        { tipo: "posicaoManual", id: posicaoManual2.id, rotulo: "CDB Dois (Itaú)" },
      ]),
    );

    // 3) confirmarImport consome a pendência ambígua integralmente
    // (decisão binária, research.md R5) — mesmo sem distribuição explícita
    // entre as duas posições elegíveis nesta chamada.
    const r2 = await importService.confirmarImport({
      arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })])],
      mesReferencia: "2026-07",
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    const pendenciaDepois = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow({
      where: { id: pendenciaGerada.id },
    });
    expect(pendenciaDepois.aplicado).toBe(true);
    expect(pendenciaDepois.sessao_aplicacao_id).toBe(r2.sessaoId);

    // 4) reimport do mês seguinte não soma mais a pendência já consumida.
    const preview2 = await importService.previewImport([
      arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2100.00" })]),
    ]);
    expect(preview2.ok).toBe(true);
    if (!preview2.ok) return;
    expect(preview2.incrementosAmbiguosPendentes).toEqual([]);
  });
});
