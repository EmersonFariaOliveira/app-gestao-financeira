/**
 * tests/services/rendimento-service.test.ts — testes de integração (T009) de
 * src/services/rendimento-service.ts contra um SQLite TEMPORÁRIO, isolado do
 * `data/app.db` real/seed.
 *
 * Mesma estratégia de `tests/services/dashboard-service.test.ts`/
 * `aporte-service.test.ts`: `DATABASE_URL` é redirecionado para um arquivo
 * temporário ANTES de qualquer import de `@/db/client`/serviços (por isso os
 * imports são dinâmicos dentro de `beforeAll`), com o schema aplicado via
 * `prisma migrate deploy`.
 *
 * Escopo desta suíte (User Story 1, P1): resolução de fonte de valor
 * investido (R4), fórmulas de ponto/período (R5), resolução de período
 * (presets + customizado). Não cobre US2-US4 (segmentação por bucket,
 * gráfico, movimentação não explicada) — ficam para tasks futuras.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let rendimentoService: typeof import("@/services/rendimento-service");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rendimento-service-test-"));
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
  rendimentoService = await import("@/services/rendimento-service");
}, 30_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Limpa todas as tabelas (ordem respeita FKs, igual a prisma/seed.ts). */
async function resetDb() {
  await prisma.dividendo.deleteMany();
  await prisma.incremento_valor_investido_pendente.deleteMany();
  await prisma.aporte.deleteMany();
  await prisma.posicao.deleteMany();
  await prisma.posicao_manual_valor.deleteMany();
  await prisma.posicao_manual.deleteMany();
  await prisma.ajuste_valor_investido.deleteMany();
  await prisma.ativo_mapeado.deleteMany();
  await prisma.sessao_import.deleteMany();
  await prisma.alvo.deleteMany();
  await prisma.config.deleteMany();
}

beforeEach(async () => {
  await resetDb();
});

describe("rendimento-service", () => {
  describe("resolverValorInvestido (R4 — prioridade de fonte)", () => {
    it("usa ajuste_valor_investido.valor_investido_corrigido_centavos quando existe e não é null (prioridade 1)", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "FUNDO-X", fora_da_carteira: false },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "FUNDO-X",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 100_000,
          patrimonio_investido_centavos: 100_000, // CSV "errado" (fundo sempre vem igual ao atual)
          tipo_grupo: "OUTROS_FUNDOS",
        },
      });
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "FUNDO-X",
          sessao_import_id: sessao.id,
          valor_investido_corrigido_centavos: 70_000,
        },
      });

      const resolvido = await rendimentoService.resolverValorInvestido("FUNDO-X", sessao.id);
      expect(resolvido).toEqual({
        chaveExport: "FUNDO-X",
        valorInvestidoCentavos: 70_000,
        fonte: "ajuste",
      });
    });

    it("usa posicao.patrimonio_investido_centavos quando não há ajuste (prioridade 2)", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 300_000,
          patrimonio_investido_centavos: 250_000,
          tipo_grupo: "ACOES",
        },
      });

      const resolvido = await rendimentoService.resolverValorInvestido("PRIO3", sessao.id);
      expect(resolvido).toEqual({
        chaveExport: "PRIO3",
        valorInvestidoCentavos: 250_000,
        fonte: "csv",
      });
    });

    it("usa posicao.patrimonio_investido_centavos quando ajuste existe mas o campo é null (ajuste não ativo/preenchido)", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "FUNDO-Y", fora_da_carteira: false },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "FUNDO-Y",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 50_000,
          patrimonio_investido_centavos: 45_000,
          tipo_grupo: "OUTROS_FUNDOS",
        },
      });
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "FUNDO-Y",
          sessao_import_id: sessao.id,
          valor_investido_corrigido_centavos: null,
        },
      });

      const resolvido = await rendimentoService.resolverValorInvestido("FUNDO-Y", sessao.id);
      expect(resolvido).toEqual({
        chaveExport: "FUNDO-Y",
        valorInvestidoCentavos: 45_000,
        fonte: "csv",
      });
    });

    it("retorna 'indisponivel' (valorInvestidoCentavos: null) quando não há ajuste nem CSV (sem histórico suficiente, FR-010)", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "TESOURO-IPCA-2035",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 12_000,
          patrimonio_investido_centavos: null,
          tipo_grupo: "TESOURO_DIRETO",
        },
      });

      const resolvido = await rendimentoService.resolverValorInvestido(
        "TESOURO-IPCA-2035",
        sessao.id,
      );
      expect(resolvido).toEqual({
        chaveExport: "TESOURO-IPCA-2035",
        valorInvestidoCentavos: null,
        fonte: "indisponivel",
      });
    });

    it("soma patrimonio_investido_centavos de TODAS as linhas posicao de uma chave espalhada por instituições diferentes (mesma sessão)", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú", "Nubank"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "WRLD11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 500_000,
          patrimonio_investido_centavos: 460_000,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "WRLD11",
          instituicao: "Nubank",
          quantidade: "6",
          patrimonio_hoje_centavos: 300_000,
          patrimonio_investido_centavos: 276_000,
          tipo_grupo: "ACOES",
        },
      });

      const resolvido = await rendimentoService.resolverValorInvestido("WRLD11", sessao.id);
      expect(resolvido).toEqual({
        chaveExport: "WRLD11",
        valorInvestidoCentavos: 736_000,
        fonte: "csv",
      });
    });

    it("chave com múltiplas linhas posicao onde UMA tem patrimonio_investido_centavos null resulta em indisponivel (nunca soma parcial)", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú", "Nubank"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "WRLD11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 500_000,
          patrimonio_investido_centavos: 460_000,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "WRLD11",
          instituicao: "Nubank",
          quantidade: "6",
          patrimonio_hoje_centavos: 300_000,
          patrimonio_investido_centavos: null,
          tipo_grupo: "ACOES",
        },
      });

      const resolvido = await rendimentoService.resolverValorInvestido("WRLD11", sessao.id);
      expect(resolvido).toEqual({
        chaveExport: "WRLD11",
        valorInvestidoCentavos: null,
        fonte: "indisponivel",
      });
    });

    it("ajuste_valor_investido (prioridade 1) ainda prevalece mesmo quando a chave tem múltiplas linhas posicao com dado incompleto", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú", "Nubank"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "WRLD11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 500_000,
          patrimonio_investido_centavos: 460_000,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "WRLD11",
          instituicao: "Nubank",
          quantidade: "6",
          patrimonio_hoje_centavos: 300_000,
          patrimonio_investido_centavos: null,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "WRLD11", fora_da_carteira: false },
      });
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "WRLD11",
          sessao_import_id: sessao.id,
          valor_investido_corrigido_centavos: 800_000,
        },
      });

      const resolvido = await rendimentoService.resolverValorInvestido("WRLD11", sessao.id);
      expect(resolvido).toEqual({
        chaveExport: "WRLD11",
        valorInvestidoCentavos: 800_000,
        fonte: "ajuste",
      });
    });
  });

  describe("calcularRendimentoPonto (fórmula R5 — sessão única)", () => {
    it("calcula rendimentoCentavos e rendimentoPct quando valorInvestidoCentavos > 0", () => {
      const ponto = rendimentoService.calcularRendimentoPonto({
        valorAtualCentavos: 300_000,
        valorInvestidoCentavos: 250_000,
      });
      expect(ponto.valorAtualCentavos).toBe(300_000);
      expect(ponto.valorInvestidoCentavos).toBe(250_000);
      expect(ponto.rendimentoCentavos).toBe(50_000);
      // 50_000 / 250_000 * 100 = 20%
      expect(ponto.rendimentoPct).toBeCloseTo(20, 6);
    });

    it("rendimentoPct é null quando valorInvestidoCentavos = 0 (nunca Infinity/NaN)", () => {
      const ponto = rendimentoService.calcularRendimentoPonto({
        valorAtualCentavos: 1_000,
        valorInvestidoCentavos: 0,
      });
      expect(ponto.rendimentoCentavos).toBe(1_000);
      expect(ponto.rendimentoPct).toBeNull();
      expect(Number.isFinite(ponto.rendimentoPct as unknown as number)).toBe(false);
    });

    it("rendimentoCentavos e rendimentoPct são null quando valorInvestidoCentavos é null (FR-010, sem histórico suficiente)", () => {
      const ponto = rendimentoService.calcularRendimentoPonto({
        valorAtualCentavos: 12_000,
        valorInvestidoCentavos: null,
      });
      expect(ponto.valorAtualCentavos).toBe(12_000);
      expect(ponto.valorInvestidoCentavos).toBeNull();
      expect(ponto.rendimentoCentavos).toBeNull();
      expect(ponto.rendimentoPct).toBeNull();
    });

    it("rendimento negativo (prejuízo) calcula percentual negativo corretamente", () => {
      const ponto = rendimentoService.calcularRendimentoPonto({
        valorAtualCentavos: 80_000,
        valorInvestidoCentavos: 100_000,
      });
      expect(ponto.rendimentoCentavos).toBe(-20_000);
      expect(ponto.rendimentoPct).toBeCloseTo(-20, 6);
    });
  });

  describe("calcularRendimentoPeriodo (fórmula R5 — variação entre duas sessões)", () => {
    it("deltaRendimentoCentavos e rendimentoPctPeriodo usam SEMPRE o valorInvestidoCentavos do INÍCIO como base", () => {
      const periodo = rendimentoService.calcularRendimentoPeriodo({
        sessaoInicioId: "sessao-inicio",
        sessaoFimId: "sessao-fim",
        pontoInicio: {
          valorAtualCentavos: 200_000,
          valorInvestidoCentavos: 200_000,
        },
        pontoFim: {
          // Aporte novo no meio do período aumenta o valor investido no fim,
          // mas a base do percentual continua sendo a do início (Clarifications).
          valorAtualCentavos: 350_000,
          valorInvestidoCentavos: 300_000,
        },
      });

      expect(periodo.sessaoInicioId).toBe("sessao-inicio");
      expect(periodo.sessaoFimId).toBe("sessao-fim");
      // rendimentoCentavos(início) = 200_000 - 200_000 = 0
      // rendimentoCentavos(fim) = 350_000 - 300_000 = 50_000
      // delta = 50_000 - 0 = 50_000
      expect(periodo.rendimentoCentavos).toBe(50_000);
      // base = valorInvestidoCentavos(início) = 200_000 → 50_000/200_000*100 = 25%
      expect(periodo.rendimentoPct).toBeCloseTo(25, 6);
      expect(periodo.pontoInicio.rendimentoCentavos).toBe(0);
      expect(periodo.pontoFim.rendimentoCentavos).toBe(50_000);
    });

    it("rendimentoPct do período é null quando valorInvestidoCentavos do início é 0 (guarda de divisão por zero)", () => {
      const periodo = rendimentoService.calcularRendimentoPeriodo({
        sessaoInicioId: "sessao-inicio",
        sessaoFimId: "sessao-fim",
        pontoInicio: { valorAtualCentavos: 0, valorInvestidoCentavos: 0 },
        pontoFim: { valorAtualCentavos: 10_000, valorInvestidoCentavos: 8_000 },
      });

      expect(periodo.rendimentoPct).toBeNull();
      // rendimentoCentavos ainda é calculável (diferença exata em centavos).
      expect(periodo.rendimentoCentavos).toBe(2_000);
    });

    it("rendimentoCentavos e rendimentoPct são null quando qualquer ponto não tem valorInvestidoCentavos (FR-010)", () => {
      const periodo = rendimentoService.calcularRendimentoPeriodo({
        sessaoInicioId: "sessao-inicio",
        sessaoFimId: "sessao-fim",
        pontoInicio: { valorAtualCentavos: 5_000, valorInvestidoCentavos: null },
        pontoFim: { valorAtualCentavos: 10_000, valorInvestidoCentavos: 8_000 },
      });

      expect(periodo.rendimentoCentavos).toBeNull();
      expect(periodo.rendimentoPct).toBeNull();
    });
  });

  describe("resolverPeriodo (presets + customizado)", () => {
    /** Cria N sessões VIGENTE consecutivas por mes_referencia (2026-01 .. 2026-0N). */
    async function criarSessoesMensais(qtd: number) {
      const sessoes = [];
      for (let i = 1; i <= qtd; i++) {
        const mes = String(i).padStart(2, "0");
        const sessao = await prisma.sessao_import.create({
          data: {
            mes_referencia: `2026-${mes}`,
            data_export: new Date(`2026-${mes}-28`),
            status: "VIGENTE",
            instituicoes: JSON.stringify(["Itaú"]),
          },
        });
        sessoes.push(sessao);
      }
      return sessoes;
    }

    it("preset '1M' resolve da sessão vigente mais recente até 1 mês antes", async () => {
      const sessoes = await criarSessoesMensais(4); // 2026-01..04
      const periodo = await rendimentoService.resolverPeriodo({ tipo: "1M" });

      expect(periodo.tipo).toBe("1M");
      expect(periodo.sessaoFimId).toBe(sessoes[3].id); // 2026-04, mais recente
      expect(periodo.sessaoInicioId).toBe(sessoes[2].id); // 2026-03, 1 mês antes
    });

    it("preset '3M' resolve da sessão vigente mais recente até 3 meses antes", async () => {
      const sessoes = await criarSessoesMensais(6); // 2026-01..06
      const periodo = await rendimentoService.resolverPeriodo({ tipo: "3M" });

      expect(periodo.sessaoFimId).toBe(sessoes[5].id); // 2026-06
      expect(periodo.sessaoInicioId).toBe(sessoes[2].id); // 2026-03
    });

    it("preset '6M'/'12M' usam a sessão vigente mais próxima disponível quando não há exatamente N meses de histórico (nunca interpolada)", async () => {
      const sessoes = await criarSessoesMensais(3); // 2026-01..03, só 3 meses de histórico
      const periodo6m = await rendimentoService.resolverPeriodo({ tipo: "6M" });
      const periodo12m = await rendimentoService.resolverPeriodo({ tipo: "12M" });

      // Nenhuma sessão 6/12 meses antes existe — usa a mais antiga disponível.
      expect(periodo6m.sessaoFimId).toBe(sessoes[2].id);
      expect(periodo6m.sessaoInicioId).toBe(sessoes[0].id);
      expect(periodo12m.sessaoFimId).toBe(sessoes[2].id);
      expect(periodo12m.sessaoInicioId).toBe(sessoes[0].id);
    });

    it("preset 'DESDE_INICIO' resolve da primeira sessão vigente até a mais recente", async () => {
      const sessoes = await criarSessoesMensais(5);
      const periodo = await rendimentoService.resolverPeriodo({ tipo: "DESDE_INICIO" });

      expect(periodo.sessaoInicioId).toBe(sessoes[0].id);
      expect(periodo.sessaoFimId).toBe(sessoes[4].id);
    });

    it("período customizado usa sessaoInicioId/sessaoFimId explícitos, sem recalcular nada", async () => {
      const sessoes = await criarSessoesMensais(4);
      const periodo = await rendimentoService.resolverPeriodo({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: sessoes[1].id,
        sessaoFimId: sessoes[3].id,
      });

      expect(periodo.tipo).toBe("CUSTOMIZADO");
      expect(periodo.sessaoInicioId).toBe(sessoes[1].id);
      expect(periodo.sessaoFimId).toBe(sessoes[3].id);
    });

    it("nenhuma sessão VIGENTE existente → sessaoInicioId/sessaoFimId null, nunca lança exceção", async () => {
      const periodo = await rendimentoService.resolverPeriodo({ tipo: "DESDE_INICIO" });

      expect(periodo.sessaoInicioId).toBeNull();
      expect(periodo.sessaoFimId).toBeNull();

      const periodo1m = await rendimentoService.resolverPeriodo({ tipo: "1M" });
      expect(periodo1m.sessaoInicioId).toBeNull();
      expect(periodo1m.sessaoFimId).toBeNull();
    });

    it("apenas uma sessão VIGENTE existente → início e fim resolvem para a mesma sessão (US1 cenário 2, ponto único)", async () => {
      const sessoes = await criarSessoesMensais(1);
      const periodo = await rendimentoService.resolverPeriodo({ tipo: "DESDE_INICIO" });

      expect(periodo.sessaoInicioId).toBe(sessoes[0].id);
      expect(periodo.sessaoFimId).toBe(sessoes[0].id);
    });

    it("sessões SUBSTITUIDAS nunca entram na resolução de período (só VIGENTE)", async () => {
      const sessaoSubstituida = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-01",
          data_export: new Date("2026-01-10"),
          status: "SUBSTITUIDO",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      const sessaoVigente = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-01",
          data_export: new Date("2026-01-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });

      const periodo = await rendimentoService.resolverPeriodo({ tipo: "DESDE_INICIO" });
      expect(periodo.sessaoInicioId).toBe(sessaoVigente.id);
      expect(periodo.sessaoFimId).toBe(sessaoVigente.id);
      expect(periodo.sessaoInicioId).not.toBe(sessaoSubstituida.id);
    });
  });

  describe("dadosRendimento / consolidadoDoPeriodo (agregação por período — correção do bug de exclusão total)", () => {
    /** Cria uma sessão VIGENTE com `mes_referencia`/`data_export` dados. */
    async function criarSessao(mesReferencia: string) {
      return prisma.sessao_import.create({
        data: {
          mes_referencia: mesReferencia,
          data_export: new Date(`${mesReferencia}-28`),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
    }

    /** Cria uma `posicao` mínima válida para uma chave numa sessão. */
    async function criarPosicao(
      sessaoId: string,
      chaveExport: string,
      patrimonioHojeCentavos: number,
      patrimonioInvestidoCentavos: number | null,
    ) {
      return prisma.posicao.create({
        data: {
          sessao_import_id: sessaoId,
          chave_export: chaveExport,
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: patrimonioHojeCentavos,
          patrimonio_investido_centavos: patrimonioInvestidoCentavos,
          tipo_grupo: "ACOES",
        },
      });
    }

    it("todas as chaves elegíveis com dado completo em ambas as sessões: soma normal, nenhuma exclusão", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await criarPosicao(inicio.id, "AAA11", 100_000, 80_000);
      await criarPosicao(inicio.id, "BBB11", 50_000, 40_000);
      await criarPosicao(fim.id, "AAA11", 110_000, 80_000);
      await criarPosicao(fim.id, "BBB11", 55_000, 40_000);

      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: inicio.id,
        sessaoFimId: fim.id,
      });

      expect(resultado.vazio).toBe(false);
      expect(resultado.consolidado.pontoInicio.valorAtualCentavos).toBe(150_000);
      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).toBe(120_000);
      expect(resultado.consolidado.pontoFim.valorAtualCentavos).toBe(165_000);
      expect(resultado.consolidado.pontoFim.valorInvestidoCentavos).toBe(120_000);
      // rendimento(fim) = 165_000 - 120_000 = 45_000; rendimento(início) = 150_000 - 120_000 = 30_000
      expect(resultado.consolidado.rendimentoCentavos).toBe(15_000);
    });

    it("chave com valorInvestidoCentavos ausente em UMA sessão é excluída dos totais de AMBAS as sessões (nunca só de uma)", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await criarPosicao(inicio.id, "AAA11", 100_000, 80_000);
      await criarPosicao(fim.id, "AAA11", 110_000, 80_000);
      // DDD11 tem dado no início mas NÃO no fim (caso real do seed: Tesouro
      // IPCA+ 2035 com patrimonio_investido_centavos null só em 2026-08).
      await criarPosicao(inicio.id, "DDD11", 20_000, 15_000);
      await criarPosicao(fim.id, "DDD11", 22_000, null);

      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: inicio.id,
        sessaoFimId: fim.id,
      });

      // DDD11 fica de fora dos DOIS totais — nem o valorAtual de início
      // (20_000) nem o de fim (22_000) entram na soma.
      expect(resultado.consolidado.pontoInicio.valorAtualCentavos).toBe(100_000);
      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).toBe(80_000);
      expect(resultado.consolidado.pontoFim.valorAtualCentavos).toBe(110_000);
      expect(resultado.consolidado.pontoFim.valorInvestidoCentavos).toBe(80_000);
      // rendimento(fim) = 110_000 - 80_000 = 30_000; rendimento(início) = 100_000 - 80_000 = 20_000
      expect(resultado.consolidado.rendimentoCentavos).toBe(10_000);
      expect(resultado.consolidado.rendimentoCentavos).not.toBeNull();
    });

    it("chave que só existe na sessão de FIM (comprada no meio do período) é excluída dos totais, sem lançar erro", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await criarPosicao(inicio.id, "AAA11", 100_000, 80_000);
      await criarPosicao(fim.id, "AAA11", 110_000, 80_000);
      // FFF11 é um ativo NOVO: não existia na sessão de início, só aparece no
      // fim (compra no meio do período) — não pode gerar ganho/prejuízo
      // fabricado nem lançar exceção.
      await criarPosicao(fim.id, "FFF11", 40_000, 40_000);

      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: inicio.id,
        sessaoFimId: fim.id,
      });

      expect(resultado.vazio).toBe(false);
      expect(resultado.consolidado.pontoInicio.valorAtualCentavos).toBe(100_000);
      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).toBe(80_000);
      // FFF11 (40_000/40_000) NÃO entra no total de fim, pois estava ausente
      // no início — só AAA11 (110_000/80_000) contribui.
      expect(resultado.consolidado.pontoFim.valorAtualCentavos).toBe(110_000);
      expect(resultado.consolidado.pontoFim.valorInvestidoCentavos).toBe(80_000);
      expect(resultado.consolidado.rendimentoCentavos).toBe(10_000);
    });

    it("chave que só existia na sessão de INÍCIO e some no fim (venda/substituição) é excluída dos totais, sem lançar erro", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await criarPosicao(inicio.id, "AAA11", 100_000, 80_000);
      await criarPosicao(fim.id, "AAA11", 110_000, 80_000);
      // GGG11 existia só no início e foi vendida antes do fim.
      await criarPosicao(inicio.id, "GGG11", 30_000, 25_000);

      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: inicio.id,
        sessaoFimId: fim.id,
      });

      expect(resultado.vazio).toBe(false);
      // GGG11 (30_000/25_000) NÃO entra no total de início, pois estava
      // ausente no fim — só AAA11 contribui.
      expect(resultado.consolidado.pontoInicio.valorAtualCentavos).toBe(100_000);
      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).toBe(80_000);
      expect(resultado.consolidado.pontoFim.valorAtualCentavos).toBe(110_000);
      expect(resultado.consolidado.pontoFim.valorInvestidoCentavos).toBe(80_000);
      expect(resultado.consolidado.rendimentoCentavos).toBe(10_000);
    });

    it("nenhuma chave com dado em ambas as pontas: valorInvestidoCentavos null em início e fim, rendimentoCentavos consolidado null", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      // EEE11 só existe na sessão de início (vendida antes do fim) — ausente
      // por completo da sessão de fim, não apenas sem valor investido.
      await criarPosicao(inicio.id, "EEE11", 30_000, 25_000);

      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: inicio.id,
        sessaoFimId: fim.id,
      });

      expect(resultado.consolidado.pontoInicio.valorAtualCentavos).toBe(0);
      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).toBeNull();
      expect(resultado.consolidado.pontoFim.valorAtualCentavos).toBe(0);
      expect(resultado.consolidado.pontoFim.valorInvestidoCentavos).toBeNull();
      expect(resultado.consolidado.rendimentoCentavos).toBeNull();
    });
  });

  describe("dadosRendimento — bordas adicionais", () => {
    async function criarSessao(mesReferencia: string) {
      return prisma.sessao_import.create({
        data: {
          mes_referencia: mesReferencia,
          data_export: new Date(`${mesReferencia}-28`),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
    }

    it("nenhuma sessão VIGENTE existente: retorna vazio:true, consolidado sem dado, periodosDisponiveis vazio", async () => {
      const resultado = await rendimentoService.dadosRendimento({ tipo: "DESDE_INICIO" });

      expect(resultado.vazio).toBe(true);
      expect(resultado.periodo.sessaoInicioId).toBeNull();
      expect(resultado.periodo.sessaoFimId).toBeNull();
      expect(resultado.consolidado.rendimentoCentavos).toBeNull();
      expect(resultado.consolidado.rendimentoPct).toBeNull();
      expect(resultado.periodosDisponiveis).toEqual([]);
      // vazio:true → sinalizador de comparação não faz sentido, valor neutro false.
      expect(resultado.semPeriodoAnteriorParaComparacao).toBe(false);
    });

    it("sessões VIGENTE existem mas sem nenhuma posicao/posicao_manual: vazio:false, consolidado com valorInvestidoCentavos null (nunca erro)", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: inicio.id,
        sessaoFimId: fim.id,
      });

      expect(resultado.vazio).toBe(false);
      expect(resultado.consolidado.pontoInicio.valorAtualCentavos).toBe(0);
      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).toBeNull();
      expect(resultado.consolidado.pontoFim.valorAtualCentavos).toBe(0);
      expect(resultado.consolidado.pontoFim.valorInvestidoCentavos).toBeNull();
      expect(resultado.consolidado.rendimentoCentavos).toBeNull();
    });

    it("valorInvestidoCentavos = 0 (via ajuste explícito) é tratado como dado presente, distinto de null: rendimentoCentavos calculável, rendimentoPct null (guarda de divisão por zero)", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await prisma.posicao.create({
        data: {
          sessao_import_id: inicio.id,
          chave_export: "ZERO1",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 5_000,
          patrimonio_investido_centavos: 5_000,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: fim.id,
          chave_export: "ZERO1",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 6_000,
          patrimonio_investido_centavos: 5_000,
          tipo_grupo: "ACOES",
        },
      });
      // Ajuste manual zera o valor investido de início explicitamente (0, não null).
      await prisma.ativo_mapeado.create({ data: { chave_export: "ZERO1", fora_da_carteira: false } });
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "ZERO1",
          sessao_import_id: inicio.id,
          valor_investido_corrigido_centavos: 0,
        },
      });

      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: inicio.id,
        sessaoFimId: fim.id,
      });

      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).toBe(0);
      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).not.toBeNull();
      // rendimentoCentavos(início) = 5_000 - 0 = 5_000; rendimentoCentavos(fim) = 6_000 - 5_000 = 1_000
      // delta = 1_000 - 5_000 = -4_000
      expect(resultado.consolidado.rendimentoCentavos).toBe(-4_000);
      // base do percentual do período = valorInvestidoCentavos(início) = 0 → guarda de divisão por zero.
      expect(resultado.consolidado.rendimentoPct).toBeNull();
    });

    it("período customizado com sessaoInicioId/sessaoFimId inexistentes no banco: não lança exceção, retorna sem dado (nunca 500)", async () => {
      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: "sessao-que-nao-existe-1",
        sessaoFimId: "sessao-que-nao-existe-2",
      });

      expect(resultado.vazio).toBe(false);
      expect(resultado.consolidado.pontoInicio.valorAtualCentavos).toBe(0);
      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).toBeNull();
      expect(resultado.consolidado.pontoFim.valorAtualCentavos).toBe(0);
      expect(resultado.consolidado.pontoFim.valorInvestidoCentavos).toBeNull();
      expect(resultado.consolidado.rendimentoCentavos).toBeNull();
    });

    it("período customizado com sessões trocadas (fim cronologicamente antes do início): calcula normalmente sobre os ids como passados, sem validar ordem cronológica", async () => {
      const maisAntiga = await criarSessao("2026-07");
      const maisRecente = await criarSessao("2026-08");
      await criarPosicaoZeroHelperMaisAntiga();

      async function criarPosicaoZeroHelperMaisAntiga() {
        await prisma.posicao.create({
          data: {
            sessao_import_id: maisAntiga.id,
            chave_export: "AAA11",
            instituicao: "Itaú",
            quantidade: "10",
            patrimonio_hoje_centavos: 100_000,
            patrimonio_investido_centavos: 80_000,
            tipo_grupo: "ACOES",
          },
        });
        await prisma.posicao.create({
          data: {
            sessao_import_id: maisRecente.id,
            chave_export: "AAA11",
            instituicao: "Itaú",
            quantidade: "10",
            patrimonio_hoje_centavos: 110_000,
            patrimonio_investido_centavos: 80_000,
            tipo_grupo: "ACOES",
          },
        });
      }

      // Usuário passa sessaoInicioId = sessão mais RECENTE e sessaoFimId = sessão mais ANTIGA (invertido).
      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: maisRecente.id,
        sessaoFimId: maisAntiga.id,
      });

      expect(resultado.vazio).toBe(false);
      expect(resultado.consolidado.sessaoInicioId).toBe(maisRecente.id);
      expect(resultado.consolidado.sessaoFimId).toBe(maisAntiga.id);
      // pontoInicio usa os dados da sessão "mais recente" (110_000/80_000), pontoFim os da "mais antiga" (100_000/80_000).
      expect(resultado.consolidado.pontoInicio.valorAtualCentavos).toBe(110_000);
      expect(resultado.consolidado.pontoFim.valorAtualCentavos).toBe(100_000);
      // rendimentoCentavos(fim) = 100_000 - 80_000 = 20_000; rendimentoCentavos(início) = 110_000 - 80_000 = 30_000
      expect(resultado.consolidado.rendimentoCentavos).toBe(-10_000);
      // duas sessões distintas → sinalizador false.
      expect(resultado.semPeriodoAnteriorParaComparacao).toBe(false);
    });
  });

  describe("dadosRendimento — apenas uma sessão VIGENTE (US1 Acceptance Scenario 2, correção do bug de delta 0 enganoso)", () => {
    async function criarSessao(mesReferencia: string) {
      return prisma.sessao_import.create({
        data: {
          mes_referencia: mesReferencia,
          data_export: new Date(`${mesReferencia}-28`),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
    }

    it("rendimento POSITIVO: consolidado reflete valorAtual - valorInvestido da sessão única, não um delta 0", async () => {
      const unica = await criarSessao("2026-08");
      await prisma.posicao.create({
        data: {
          sessao_import_id: unica.id,
          chave_export: "AAA11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 120_000,
          patrimonio_investido_centavos: 100_000,
          tipo_grupo: "ACOES",
        },
      });

      const resultado = await rendimentoService.dadosRendimento({ tipo: "DESDE_INICIO" });

      expect(resultado.vazio).toBe(false);
      expect(resultado.periodo.sessaoInicioId).toBe(unica.id);
      expect(resultado.periodo.sessaoFimId).toBe(unica.id);
      expect(resultado.semPeriodoAnteriorParaComparacao).toBe(true);
      // NUNCA 0: rendimento real da sessão isolada = 120_000 - 100_000 = 20_000.
      expect(resultado.consolidado.rendimentoCentavos).toBe(20_000);
      expect(resultado.consolidado.rendimentoPct).toBeCloseTo(20, 5);
      expect(resultado.consolidado.pontoInicio).toEqual(resultado.consolidado.pontoFim);
      expect(resultado.consolidado.pontoInicio.valorAtualCentavos).toBe(120_000);
      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).toBe(100_000);
    });

    it("rendimento NEGATIVO: consolidado reflete a perda real da sessão única, não um delta 0", async () => {
      const unica = await criarSessao("2026-08");
      await prisma.posicao.create({
        data: {
          sessao_import_id: unica.id,
          chave_export: "BBB11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 80_000,
          patrimonio_investido_centavos: 100_000,
          tipo_grupo: "ACOES",
        },
      });

      const resultado = await rendimentoService.dadosRendimento({ tipo: "DESDE_INICIO" });

      expect(resultado.semPeriodoAnteriorParaComparacao).toBe(true);
      expect(resultado.consolidado.rendimentoCentavos).toBe(-20_000);
      expect(resultado.consolidado.rendimentoPct).toBeCloseTo(-20, 5);
    });

    it("valor investido indisponível na sessão única: rendimentoCentavos/rendimentoPct null (FR-010), não 0", async () => {
      const unica = await criarSessao("2026-08");
      await prisma.posicao.create({
        data: {
          sessao_import_id: unica.id,
          chave_export: "CCC11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 50_000,
          patrimonio_investido_centavos: null,
          tipo_grupo: "ACOES",
        },
      });

      const resultado = await rendimentoService.dadosRendimento({ tipo: "DESDE_INICIO" });

      expect(resultado.semPeriodoAnteriorParaComparacao).toBe(true);
      // CCC11 não tem valorInvestidoCentavos resolvível → excluída dos totais
      // (mesma regra de consolidadoDoPeriodo para duas sessões: "nunca um
      // número parcial disfarçado de completo"), valorAtualCentavos fica 0.
      expect(resultado.consolidado.pontoInicio.valorAtualCentavos).toBe(0);
      expect(resultado.consolidado.pontoInicio.valorInvestidoCentavos).toBeNull();
      expect(resultado.consolidado.rendimentoCentavos).toBeNull();
      expect(resultado.consolidado.rendimentoPct).toBeNull();
    });
  });

  describe("integração: valor investido via posicao_manual (feature 002, inalterado)", () => {
    it("resolverValorInvestido para chave de posicao_manual usa sempre posicao_manual_valor.valor_investido_centavos", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB manual",
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManual.id,
          sessao_import_id: sessao.id,
          valor_investido_centavos: 10_000,
          valor_atual_centavos: 11_000,
        },
      });

      const resolvido = await rendimentoService.resolverValorInvestido(
        "CDB-ITAU-2029",
        sessao.id,
      );
      expect(resolvido).toEqual({
        chaveExport: "CDB-ITAU-2029",
        valorInvestidoCentavos: 10_000,
        fonte: "csv",
      });
    });
  });
});
