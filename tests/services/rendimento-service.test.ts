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

  describe("calcularRendimentoPorBucket (US2 — segmentação por reserva/tag/alvo/fora-da-carteira)", () => {
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

    it("reserva de emergência: soma todas as chaves com reserva_emergencia=true, casando o mesmo conjunto entre início/fim", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await prisma.ativo_mapeado.create({
        data: { chave_export: "RESERVA-CDB", reserva_emergencia: true },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "RESERVA-TESOURO", reserva_emergencia: true },
      });
      await criarPosicao(inicio.id, "RESERVA-CDB", 50_000, 50_000);
      await criarPosicao(fim.id, "RESERVA-CDB", 52_000, 50_000);
      await criarPosicao(inicio.id, "RESERVA-TESOURO", 30_000, 28_000);
      await criarPosicao(fim.id, "RESERVA-TESOURO", 31_000, 28_000);
      // Ativo normal (não reserva) não deve entrar neste bucket.
      await prisma.ativo_mapeado.create({ data: { chave_export: "AAA11", fora_da_carteira: false } });
      await criarPosicao(inicio.id, "AAA11", 100_000, 80_000);
      await criarPosicao(fim.id, "AAA11", 110_000, 80_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      // início: 50_000 + 30_000 = 80_000 atual, 50_000 + 28_000 = 78_000 investido
      // fim: 52_000 + 31_000 = 83_000 atual, mesmo investido 78_000
      // rendimento(fim) = 83_000-78_000=5_000; rendimento(início)=80_000-78_000=2_000; delta=3_000
      expect(buckets.reservaEmergencia.pontoInicio.valorAtualCentavos).toBe(80_000);
      expect(buckets.reservaEmergencia.pontoInicio.valorInvestidoCentavos).toBe(78_000);
      expect(buckets.reservaEmergencia.pontoFim.valorAtualCentavos).toBe(83_000);
      expect(buckets.reservaEmergencia.rendimentoCentavos).toBe(3_000);
    });

    it("reservaEmergenciaItens: um item por chave de reserva de emergência, NUNCA agregado num único número", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await prisma.ativo_mapeado.create({
        data: { chave_export: "RESERVA-CDB", reserva_emergencia: true },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "RESERVA-TESOURO", reserva_emergencia: true },
      });
      await criarPosicao(inicio.id, "RESERVA-CDB", 50_000, 50_000);
      await criarPosicao(fim.id, "RESERVA-CDB", 52_000, 50_000);
      await criarPosicao(inicio.id, "RESERVA-TESOURO", 30_000, 28_000);
      await criarPosicao(fim.id, "RESERVA-TESOURO", 31_000, 28_000);
      // Ativo normal (não reserva) não deve entrar neste bucket.
      await prisma.ativo_mapeado.create({ data: { chave_export: "AAA11", fora_da_carteira: false } });
      await criarPosicao(inicio.id, "AAA11", 100_000, 80_000);
      await criarPosicao(fim.id, "AAA11", 110_000, 80_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.reservaEmergenciaItens).toHaveLength(2);
      const itensMap = new Map(buckets.reservaEmergenciaItens.map((r) => [r.chaveExport, r.rendimento]));
      // RESERVA-CDB: rendimento(fim)=52_000-50_000=2_000; rendimento(início)=50_000-50_000=0; delta=2_000
      expect(itensMap.get("RESERVA-CDB")!.rendimentoCentavos).toBe(2_000);
      // RESERVA-TESOURO: rendimento(fim)=31_000-28_000=3_000; rendimento(início)=30_000-28_000=2_000; delta=1_000
      expect(itensMap.get("RESERVA-TESOURO")!.rendimentoCentavos).toBe(1_000);
      // Soma dos itens individuais (2_000 + 1_000 = 3_000) bate com o agregado
      // NESTE caso, mas isso não é garantido em geral por arredondamento de
      // rendimentoPct por chave vs conjunto — a asserção de igualdade acima é
      // sobre rendimentoCentavos (soma exata em centavos, sem % envolvido).
      const somaItens = buckets.reservaEmergenciaItens.reduce(
        (acc, r) => acc + (r.rendimento.rendimentoCentavos ?? 0),
        0,
      );
      expect(somaItens).toBe(buckets.reservaEmergencia.rendimentoCentavos);
    });

    it("reservaEmergenciaItens vazio quando não há nenhuma chave de reserva de emergência: [], nunca omitido", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");
      await prisma.ativo_mapeado.create({ data: { chave_export: "AAA11", fora_da_carteira: false } });
      await criarPosicao(inicio.id, "AAA11", 100_000, 80_000);
      await criarPosicao(fim.id, "AAA11", 110_000, 80_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.reservaEmergenciaItens).toEqual([]);
    });

    it("reserva de emergência sem nenhuma chave: rendimentoCentavos null (FR-010), nunca 0", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");
      await prisma.ativo_mapeado.create({ data: { chave_export: "AAA11", fora_da_carteira: false } });
      await criarPosicao(inicio.id, "AAA11", 100_000, 80_000);
      await criarPosicao(fim.id, "AAA11", 110_000, 80_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.reservaEmergencia.rendimentoCentavos).toBeNull();
      expect(buckets.reservaEmergencia.rendimentoPct).toBeNull();
      expect(buckets.reservaEmergencia.pontoInicio.valorInvestidoCentavos).toBeNull();
    });

    it("porTag: agrupa TODOS os alvos com a mesma tag; porAlvo: cada alvo individualmente dentro da tag", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      const alvoAcao1 = await prisma.alvo.create({
        data: {
          nome: "Ação 1",
          percentual_alvo_bps: 3000,
          tag: "RENDA-VARIAVEL",
          vigencia_inicio: new Date("2026-01-01"),
        },
      });
      const alvoAcao2 = await prisma.alvo.create({
        data: {
          nome: "Ação 2",
          percentual_alvo_bps: 2000,
          tag: "RENDA-VARIAVEL",
          vigencia_inicio: new Date("2026-01-01"),
        },
      });
      const alvoRendaFixa = await prisma.alvo.create({
        data: {
          nome: "Tesouro",
          percentual_alvo_bps: 5000,
          tag: "RENDA-FIXA",
          vigencia_inicio: new Date("2026-01-01"),
        },
      });

      await prisma.ativo_mapeado.create({ data: { chave_export: "ACAO1", alvo_id: alvoAcao1.id } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "ACAO2", alvo_id: alvoAcao2.id } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "TESOURO1", alvo_id: alvoRendaFixa.id } });

      await criarPosicao(inicio.id, "ACAO1", 100_000, 80_000);
      await criarPosicao(fim.id, "ACAO1", 120_000, 80_000);
      await criarPosicao(inicio.id, "ACAO2", 50_000, 40_000);
      await criarPosicao(fim.id, "ACAO2", 55_000, 40_000);
      await criarPosicao(inicio.id, "TESOURO1", 200_000, 190_000);
      await criarPosicao(fim.id, "TESOURO1", 205_000, 190_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      // porAlvo: 3 alvos, cada um com seu próprio rendimento.
      expect(buckets.porAlvo).toHaveLength(3);
      const porAlvoMap = new Map(buckets.porAlvo.map((a) => [a.alvoId, a]));
      expect(porAlvoMap.get(alvoAcao1.id)).toMatchObject({
        nomeAlvo: "Ação 1",
        tag: "RENDA-VARIAVEL",
      });
      // ACAO1: rendimento(fim)=120_000-80_000=40_000; rendimento(início)=100_000-80_000=20_000; delta=20_000
      expect(porAlvoMap.get(alvoAcao1.id)!.rendimento.rendimentoCentavos).toBe(20_000);
      // ACAO2: rendimento(fim)=55_000-40_000=15_000; rendimento(início)=50_000-40_000=10_000; delta=5_000
      expect(porAlvoMap.get(alvoAcao2.id)!.rendimento.rendimentoCentavos).toBe(5_000);
      // TESOURO1: rendimento(fim)=205_000-190_000=15_000; rendimento(início)=200_000-190_000=10_000; delta=5_000
      expect(porAlvoMap.get(alvoRendaFixa.id)!.rendimento.rendimentoCentavos).toBe(5_000);

      // porTag: 2 tags, RENDA-VARIAVEL agrega ACAO1+ACAO2, RENDA-FIXA só TESOURO1.
      expect(buckets.porTag).toHaveLength(2);
      const porTagMap = new Map(buckets.porTag.map((t) => [t.tag, t]));
      const rendaVariavel = porTagMap.get("RENDA-VARIAVEL")!;
      expect(rendaVariavel.rendimento.pontoInicio.valorAtualCentavos).toBe(150_000); // 100_000+50_000
      expect(rendaVariavel.rendimento.pontoInicio.valorInvestidoCentavos).toBe(120_000); // 80_000+40_000
      expect(rendaVariavel.rendimento.pontoFim.valorAtualCentavos).toBe(175_000); // 120_000+55_000
      // rendimento(fim)=175_000-120_000=55_000; rendimento(início)=150_000-120_000=30_000; delta=25_000
      expect(rendaVariavel.rendimento.rendimentoCentavos).toBe(25_000);

      const rendaFixa = porTagMap.get("RENDA-FIXA")!;
      expect(rendaFixa.rendimento.rendimentoCentavos).toBe(5_000);
    });

    it("alvo sem tag: não aparece em porTag (só alvos com tag não-nula agregam), mas aparece em porAlvo com tag:null", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      const alvoSemTag = await prisma.alvo.create({
        data: {
          nome: "Alvo sem tag",
          percentual_alvo_bps: 1000,
          tag: null,
          vigencia_inicio: new Date("2026-01-01"),
        },
      });
      await prisma.ativo_mapeado.create({ data: { chave_export: "SEMTAG1", alvo_id: alvoSemTag.id } });
      await criarPosicao(inicio.id, "SEMTAG1", 10_000, 8_000);
      await criarPosicao(fim.id, "SEMTAG1", 11_000, 8_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.porTag).toHaveLength(0);
      expect(buckets.porAlvo).toHaveLength(1);
      expect(buckets.porAlvo[0]).toMatchObject({ alvoId: alvoSemTag.id, tag: null });
    });

    it("um alvo sem NENHUMA chave com dado completo nas duas pontas: rendimentoCentavos null (FR-010), nunca 0", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      const alvo = await prisma.alvo.create({
        data: {
          nome: "Alvo sem histórico",
          percentual_alvo_bps: 1000,
          vigencia_inicio: new Date("2026-01-01"),
        },
      });
      await prisma.ativo_mapeado.create({ data: { chave_export: "SEMHIST", alvo_id: alvo.id } });
      // Só existe na sessão de início (vendido antes do fim) — sem dado completo nas duas pontas.
      await criarPosicao(inicio.id, "SEMHIST", 10_000, 8_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.porAlvo).toHaveLength(1);
      expect(buckets.porAlvo[0].rendimento.rendimentoCentavos).toBeNull();
      expect(buckets.porAlvo[0].rendimento.pontoInicio.valorInvestidoCentavos).toBeNull();
    });

    it("foraDaCarteira: um item por chave, NUNCA agregado num único número", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await prisma.ativo_mapeado.create({ data: { chave_export: "FORA1", fora_da_carteira: true } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "FORA2", fora_da_carteira: true } });
      await criarPosicao(inicio.id, "FORA1", 20_000, 15_000);
      await criarPosicao(fim.id, "FORA1", 22_000, 15_000);
      await criarPosicao(inicio.id, "FORA2", 5_000, 5_000);
      await criarPosicao(fim.id, "FORA2", 4_000, 5_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.foraDaCarteira).toHaveLength(2);
      const foraMap = new Map(buckets.foraDaCarteira.map((f) => [f.chaveExport, f.rendimento]));
      // FORA1: rendimento(fim)=22_000-15_000=7_000; rendimento(início)=20_000-15_000=5_000; delta=2_000
      expect(foraMap.get("FORA1")!.rendimentoCentavos).toBe(2_000);
      // FORA2: rendimento(fim)=4_000-5_000=-1_000; rendimento(início)=5_000-5_000=0; delta=-1_000
      expect(foraMap.get("FORA2")!.rendimentoCentavos).toBe(-1_000);
    });

    it("foraDaCarteiraTotal: agregado calculado sobre o CONJUNTO das chaves (não é soma ingênua dos itens individuais)", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await prisma.ativo_mapeado.create({ data: { chave_export: "FORA1", fora_da_carteira: true } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "FORA2", fora_da_carteira: true } });
      await criarPosicao(inicio.id, "FORA1", 20_000, 15_000);
      await criarPosicao(fim.id, "FORA1", 22_000, 15_000);
      await criarPosicao(inicio.id, "FORA2", 5_000, 5_000);
      await criarPosicao(fim.id, "FORA2", 4_000, 5_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      // início: 20_000+5_000=25_000 atual, 15_000+5_000=20_000 investido
      // fim: 22_000+4_000=26_000 atual, mesmo investido 20_000
      // rendimento(fim)=26_000-20_000=6_000; rendimento(início)=25_000-20_000=5_000; delta=1_000
      expect(buckets.foraDaCarteiraTotal.pontoInicio.valorAtualCentavos).toBe(25_000);
      expect(buckets.foraDaCarteiraTotal.pontoInicio.valorInvestidoCentavos).toBe(20_000);
      expect(buckets.foraDaCarteiraTotal.pontoFim.valorAtualCentavos).toBe(26_000);
      expect(buckets.foraDaCarteiraTotal.rendimentoCentavos).toBe(1_000);

      // Confere que bate com a soma exata (em centavos) dos itens individuais
      // (FORA1: 2_000, FORA2: -1_000 -> 1_000), mas o cálculo em si NÃO foi
      // feito somando os itens — foi uma única chamada sobre o conjunto.
      const somaItens = buckets.foraDaCarteira.reduce(
        (acc, f) => acc + (f.rendimento.rendimentoCentavos ?? 0),
        0,
      );
      expect(somaItens).toBe(buckets.foraDaCarteiraTotal.rendimentoCentavos);
    });

    it("foraDaCarteiraTotal vazio (rendimentoCentavos null, FR-010) quando nenhum ativo é fora da carteira", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");
      await prisma.ativo_mapeado.create({ data: { chave_export: "AAA11", fora_da_carteira: false } });
      await criarPosicao(inicio.id, "AAA11", 100_000, 80_000);
      await criarPosicao(fim.id, "AAA11", 110_000, 80_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.foraDaCarteira).toEqual([]);
      expect(buckets.foraDaCarteiraTotal.rendimentoCentavos).toBeNull();
      expect(buckets.foraDaCarteiraTotal.rendimentoPct).toBeNull();
      expect(buckets.foraDaCarteiraTotal.pontoInicio.valorInvestidoCentavos).toBeNull();
    });

    it("carteiraAlvoTotal: inclui chaves de alvo COM tag e SEM tag (bug que subestimava o total somando só porTag)", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      const alvoComTag = await prisma.alvo.create({
        data: {
          nome: "Ação com tag",
          percentual_alvo_bps: 3000,
          tag: "RENDA-VARIAVEL",
          vigencia_inicio: new Date("2026-01-01"),
        },
      });
      const alvoSemTag = await prisma.alvo.create({
        data: {
          nome: "Alvo sem tag",
          percentual_alvo_bps: 1000,
          tag: null,
          vigencia_inicio: new Date("2026-01-01"),
        },
      });
      await prisma.ativo_mapeado.create({ data: { chave_export: "COMTAG1", alvo_id: alvoComTag.id } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "SEMTAG1", alvo_id: alvoSemTag.id } });

      await criarPosicao(inicio.id, "COMTAG1", 100_000, 80_000);
      await criarPosicao(fim.id, "COMTAG1", 120_000, 80_000);
      await criarPosicao(inicio.id, "SEMTAG1", 10_000, 8_000);
      await criarPosicao(fim.id, "SEMTAG1", 11_000, 8_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      // Soma de porTag SOZINHO exclui o alvo sem tag (bug que motivou este
      // teste): SEMTAG1 nunca aparece em nenhuma tag.
      const somaPorTag = buckets.porTag.reduce((acc, t) => acc + (t.rendimento.rendimentoCentavos ?? 0), 0);
      // COMTAG1: rendimento(fim)=120_000-80_000=40_000; rendimento(início)=100_000-80_000=20_000; delta=20_000
      expect(somaPorTag).toBe(20_000);

      // carteiraAlvoTotal inclui AMBOS: investido início 80_000+8_000=88_000,
      // atual início 100_000+10_000=110_000; atual fim 120_000+11_000=131_000.
      // rendimento(fim)=131_000-88_000=43_000; rendimento(início)=110_000-88_000=22_000; delta=21_000
      expect(buckets.carteiraAlvoTotal.pontoInicio.valorAtualCentavos).toBe(110_000);
      expect(buckets.carteiraAlvoTotal.pontoInicio.valorInvestidoCentavos).toBe(88_000);
      expect(buckets.carteiraAlvoTotal.pontoFim.valorAtualCentavos).toBe(131_000);
      expect(buckets.carteiraAlvoTotal.rendimentoCentavos).toBe(21_000);

      // O total correto (com o alvo sem tag) é maior que a soma de porTag
      // sozinho — é exatamente o cenário do bug relatado pelo desenvolvedor-ui.
      expect(buckets.carteiraAlvoTotal.rendimentoCentavos).not.toBe(somaPorTag);
    });

    it("carteiraAlvoTotal vazio (rendimentoCentavos null, FR-010) quando não há nenhum alvo com chave elegível", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");
      await prisma.ativo_mapeado.create({ data: { chave_export: "FORA1", fora_da_carteira: true } });
      await criarPosicao(inicio.id, "FORA1", 20_000, 15_000);
      await criarPosicao(fim.id, "FORA1", 22_000, 15_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.carteiraAlvoTotal.rendimentoCentavos).toBeNull();
      expect(buckets.carteiraAlvoTotal.rendimentoPct).toBeNull();
      expect(buckets.carteiraAlvoTotal.pontoInicio.valorInvestidoCentavos).toBeNull();
    });

    it("ativo ignorar_no_import continua excluído de todos os buckets (FR-012)", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await prisma.ativo_mapeado.create({
        data: { chave_export: "IGNORADO", ignorar_no_import: true, fora_da_carteira: false },
      });
      await criarPosicao(inicio.id, "IGNORADO", 10_000, 10_000);
      await criarPosicao(fim.id, "IGNORADO", 10_000, 10_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.foraDaCarteira).toHaveLength(0);
      expect(buckets.porAlvo).toHaveLength(0);
      expect(buckets.porTag).toHaveLength(0);
      expect(buckets.reservaEmergencia.rendimentoCentavos).toBeNull();
    });

    it("ativo pendente de vínculo (sem alvo_id/fora_da_carteira/reserva_emergencia) não influencia nenhum bucket (FR-017)", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      // Sem ativo_mapeado nenhum -> tratado como pendente (defensivo).
      await criarPosicao(inicio.id, "PENDENTE1", 10_000, 10_000);
      await criarPosicao(fim.id, "PENDENTE1", 11_000, 10_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.foraDaCarteira).toHaveLength(0);
      expect(buckets.porAlvo).toHaveLength(0);
      expect(buckets.porTag).toHaveLength(0);
      expect(buckets.reservaEmergencia.rendimentoCentavos).toBeNull();
    });

    it("posicao_manual reserva_emergencia/fora_da_carteira/alvo entram nos buckets corretos, mesma máquina de estados do CSV", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      const alvo = await prisma.alvo.create({
        data: {
          nome: "CDB manual",
          percentual_alvo_bps: 1000,
          tag: "RENDA-FIXA",
          vigencia_inicio: new Date("2026-01-01"),
        },
      });

      const posManualReserva = await prisma.posicao_manual.create({
        data: {
          chave_manual: "RESERVA-MANUAL",
          instituicao: "Nubank",
          descricao: "Reserva manual",
          reserva_emergencia: true,
        },
      });
      const posManualFora = await prisma.posicao_manual.create({
        data: {
          chave_manual: "FORA-MANUAL",
          instituicao: "Nubank",
          descricao: "Fora manual",
          fora_da_carteira: true,
        },
      });
      const posManualAlvo = await prisma.posicao_manual.create({
        data: {
          chave_manual: "ALVO-MANUAL",
          instituicao: "Nubank",
          descricao: "Alvo manual",
          alvo_id: alvo.id,
        },
      });

      for (const [posicaoManual, atualInicio, atualFim, investido] of [
        [posManualReserva, 10_000, 10_500, 9_000],
        [posManualFora, 5_000, 5_200, 4_500],
        [posManualAlvo, 20_000, 20_800, 18_000],
      ] as const) {
        await prisma.posicao_manual_valor.create({
          data: {
            posicao_manual_id: posicaoManual.id,
            sessao_import_id: inicio.id,
            valor_investido_centavos: investido,
            valor_atual_centavos: atualInicio,
          },
        });
        await prisma.posicao_manual_valor.create({
          data: {
            posicao_manual_id: posicaoManual.id,
            sessao_import_id: fim.id,
            valor_investido_centavos: investido,
            valor_atual_centavos: atualFim,
          },
        });
      }

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.reservaEmergencia.pontoInicio.valorAtualCentavos).toBe(10_000);
      expect(buckets.reservaEmergencia.pontoFim.valorAtualCentavos).toBe(10_500);
      expect(buckets.foraDaCarteira).toHaveLength(1);
      expect(buckets.foraDaCarteira[0].chaveExport).toBe("FORA-MANUAL");
      expect(buckets.porAlvo).toHaveLength(1);
      expect(buckets.porAlvo[0]).toMatchObject({ alvoId: alvo.id, tag: "RENDA-FIXA" });
      expect(buckets.porTag).toHaveLength(1);
      expect(buckets.porTag[0].tag).toBe("RENDA-FIXA");
    });

    it("porAlvo: um alvo com MAIS de um ativo elegível (posicao CSV + posicao_manual) soma os dois no mesmo bucket", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      const alvo = await prisma.alvo.create({
        data: {
          nome: "Renda fixa mista",
          percentual_alvo_bps: 4000,
          tag: "RENDA-FIXA",
          vigencia_inicio: new Date("2026-01-01"),
        },
      });
      await prisma.ativo_mapeado.create({ data: { chave_export: "TESOURO-CSV", alvo_id: alvo.id } });
      await criarPosicao(inicio.id, "TESOURO-CSV", 100_000, 90_000);
      await criarPosicao(fim.id, "TESOURO-CSV", 108_000, 90_000);

      const posManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-MANUAL",
          instituicao: "Nubank",
          descricao: "CDB manual do mesmo alvo",
          alvo_id: alvo.id,
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posManual.id,
          sessao_import_id: inicio.id,
          valor_investido_centavos: 30_000,
          valor_atual_centavos: 32_000,
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posManual.id,
          sessao_import_id: fim.id,
          valor_investido_centavos: 30_000,
          valor_atual_centavos: 33_000,
        },
      });

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.porAlvo).toHaveLength(1);
      const rendimentoAlvo = buckets.porAlvo[0].rendimento;
      // início: 100_000+32_000=132_000 atual, 90_000+30_000=120_000 investido
      // fim: 108_000+33_000=141_000 atual, mesmo investido 120_000
      expect(rendimentoAlvo.pontoInicio.valorAtualCentavos).toBe(132_000);
      expect(rendimentoAlvo.pontoInicio.valorInvestidoCentavos).toBe(120_000);
      expect(rendimentoAlvo.pontoFim.valorAtualCentavos).toBe(141_000);
      expect(rendimentoAlvo.pontoFim.valorInvestidoCentavos).toBe(120_000);
      // rendimento(fim)=141_000-120_000=21_000; rendimento(início)=132_000-120_000=12_000; delta=9_000
      expect(rendimentoAlvo.rendimentoCentavos).toBe(9_000);
    });

    it("reserva de emergência: mistura chave de ativo_mapeado.reserva_emergencia=true e posicao_manual.reserva_emergencia=true no MESMO bucket", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await prisma.ativo_mapeado.create({
        data: { chave_export: "RESERVA-CSV", reserva_emergencia: true },
      });
      await criarPosicao(inicio.id, "RESERVA-CSV", 20_000, 20_000);
      await criarPosicao(fim.id, "RESERVA-CSV", 20_500, 20_000);

      const posManualReserva = await prisma.posicao_manual.create({
        data: {
          chave_manual: "RESERVA-MANUAL-2",
          instituicao: "Nubank",
          descricao: "Reserva manual",
          reserva_emergencia: true,
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posManualReserva.id,
          sessao_import_id: inicio.id,
          valor_investido_centavos: 15_000,
          valor_atual_centavos: 15_000,
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posManualReserva.id,
          sessao_import_id: fim.id,
          valor_investido_centavos: 15_000,
          valor_atual_centavos: 15_800,
        },
      });

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      // início: 20_000 (CSV) + 15_000 (manual) = 35_000 atual, 20_000+15_000=35_000 investido
      // fim: 20_500 + 15_800 = 36_300 atual, mesmo investido 35_000
      expect(buckets.reservaEmergencia.pontoInicio.valorAtualCentavos).toBe(35_000);
      expect(buckets.reservaEmergencia.pontoInicio.valorInvestidoCentavos).toBe(35_000);
      expect(buckets.reservaEmergencia.pontoFim.valorAtualCentavos).toBe(36_300);
      // rendimento(fim)=36_300-35_000=1_300; rendimento(início)=35_000-35_000=0; delta=1_300
      expect(buckets.reservaEmergencia.rendimentoCentavos).toBe(1_300);
    });

    it("SC-006: soma de TODOS os buckets (reserva + cada tag + fora da carteira) bate EXATAMENTE com o consolidado, quando há dado suficiente em tudo e não há pendentes de vínculo", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      const alvoAcao = await prisma.alvo.create({
        data: {
          nome: "Ações",
          percentual_alvo_bps: 3000,
          tag: "RENDA-VARIAVEL",
          vigencia_inicio: new Date("2026-01-01"),
        },
      });
      const alvoFii = await prisma.alvo.create({
        data: {
          nome: "FIIs",
          percentual_alvo_bps: 2000,
          tag: "RENDA-VARIAVEL",
          vigencia_inicio: new Date("2026-01-01"),
        },
      });

      await prisma.ativo_mapeado.create({ data: { chave_export: "RESERVA1", reserva_emergencia: true } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "FORA1", fora_da_carteira: true } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "ACAO1", alvo_id: alvoAcao.id } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "FII1", alvo_id: alvoFii.id } });

      await criarPosicao(inicio.id, "RESERVA1", 40_000, 35_000);
      await criarPosicao(fim.id, "RESERVA1", 41_000, 35_000);
      await criarPosicao(inicio.id, "FORA1", 15_000, 12_000);
      await criarPosicao(fim.id, "FORA1", 16_000, 12_000);
      await criarPosicao(inicio.id, "ACAO1", 100_000, 80_000);
      await criarPosicao(fim.id, "ACAO1", 115_000, 80_000);
      await criarPosicao(inicio.id, "FII1", 60_000, 55_000);
      await criarPosicao(fim.id, "FII1", 63_000, 55_000);

      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: inicio.id,
        sessaoFimId: fim.id,
      });

      const somaBuckets =
        (resultado.reservaEmergencia.rendimentoCentavos ?? 0) +
        resultado.foraDaCarteira.reduce((acc, f) => acc + (f.rendimento.rendimentoCentavos ?? 0), 0) +
        resultado.porTag.reduce((acc, t) => acc + (t.rendimento.rendimentoCentavos ?? 0), 0);

      expect(resultado.consolidado.rendimentoCentavos).not.toBeNull();
      expect(somaBuckets).toBe(resultado.consolidado.rendimentoCentavos);

      // Confirma também que porAlvo (RENDA-VARIAVEL) soma exatamente o mesmo que porTag daquela tag.
      const somaPorAlvoRendaVariavel = resultado.porAlvo
        .filter((a) => a.tag === "RENDA-VARIAVEL")
        .reduce((acc, a) => acc + (a.rendimento.rendimentoCentavos ?? 0), 0);
      const porTagRendaVariavel = resultado.porTag.find((t) => t.tag === "RENDA-VARIAVEL")!;
      expect(somaPorAlvoRendaVariavel).toBe(porTagRendaVariavel.rendimento.rendimentoCentavos);
    });

    // [ACHADO FR-017/FR-014] originalmente documentava que
    // `calcularRendimentoPorBucket` excluía chaves pendentes de vínculo de
    // TODOS os campos de `RendimentoOutput`, quebrando a igualdade
    // soma-dos-buckets == consolidado. Corrigido por arquiteto-dados
    // adicionando o campo `pendentes` (mesmo shape de `foraDaCarteira`, um
    // item por chave, nunca agregado) — agora a soma INCLUINDO `pendentes`
    // bate exatamente com o consolidado, cumprindo FR-017 ("exibidos à
    // parte, sem influenciar alvo/tag") e FR-014 (soma dos buckets ==
    // consolidado, incluindo "pendentes com dado disponível").
    it("[ACHADO FR-017/FR-014] chave pendente de vínculo com dado completo aparece em `pendentes` e a soma dos buckets (incluindo pendentes) bate com o consolidado", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      await prisma.ativo_mapeado.create({ data: { chave_export: "RESERVA1", reserva_emergencia: true } });
      await criarPosicao(inicio.id, "RESERVA1", 40_000, 35_000);
      await criarPosicao(fim.id, "RESERVA1", 41_000, 35_000);

      // PENDENTE1 não tem ativo_mapeado nenhum -> classificado como
      // "pendente" por classificarChavesPorBucket, mas tem dado completo nas
      // duas pontas (entraria no consolidado normalmente).
      await criarPosicao(inicio.id, "PENDENTE1", 10_000, 8_000);
      await criarPosicao(fim.id, "PENDENTE1", 10_500, 8_000);

      const resultado = await rendimentoService.dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: inicio.id,
        sessaoFimId: fim.id,
      });

      const somaBuckets =
        (resultado.reservaEmergencia.rendimentoCentavos ?? 0) +
        resultado.foraDaCarteira.reduce((acc, f) => acc + (f.rendimento.rendimentoCentavos ?? 0), 0) +
        resultado.porTag.reduce((acc, t) => acc + (t.rendimento.rendimentoCentavos ?? 0), 0) +
        resultado.pendentes.reduce((acc, p) => acc + (p.rendimento.rendimentoCentavos ?? 0), 0);

      // PENDENTE1 contribui rendimento(fim)=10_500-8_000=2_500,
      // rendimento(início)=10_000-8_000=2_000, delta=500 — presente no
      // consolidado E em `pendentes`, individualmente (nunca agregado a
      // outro bucket).
      expect(resultado.pendentes).toHaveLength(1);
      expect(resultado.pendentes[0].chaveExport).toBe("PENDENTE1");
      expect(resultado.pendentes[0].rendimento.rendimentoCentavos).toBe(500);
      expect(resultado.consolidado.rendimentoCentavos).not.toBeNull();
      expect(somaBuckets).toBe(resultado.consolidado.rendimentoCentavos);
    });

    it("pendentesTotal: agregado calculado sobre o CONJUNTO das chaves pendentes (não é soma ingênua dos itens individuais)", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");

      // Sem ativo_mapeado -> "pendente" (defensivo).
      await criarPosicao(inicio.id, "PENDENTE1", 10_000, 8_000);
      await criarPosicao(fim.id, "PENDENTE1", 10_500, 8_000);
      await criarPosicao(inicio.id, "PENDENTE2", 5_000, 5_000);
      await criarPosicao(fim.id, "PENDENTE2", 4_500, 5_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      // início: 10_000+5_000=15_000 atual, 8_000+5_000=13_000 investido
      // fim: 10_500+4_500=15_000 atual, mesmo investido 13_000
      // rendimento(fim)=15_000-13_000=2_000; rendimento(início)=15_000-13_000=2_000; delta=0
      expect(buckets.pendentesTotal.pontoInicio.valorAtualCentavos).toBe(15_000);
      expect(buckets.pendentesTotal.pontoInicio.valorInvestidoCentavos).toBe(13_000);
      expect(buckets.pendentesTotal.rendimentoCentavos).toBe(0);

      const somaItens = buckets.pendentes.reduce(
        (acc, p) => acc + (p.rendimento.rendimentoCentavos ?? 0),
        0,
      );
      expect(somaItens).toBe(buckets.pendentesTotal.rendimentoCentavos);
    });

    it("pendentesTotal vazio (rendimentoCentavos null, FR-010) quando não há nenhuma chave pendente", async () => {
      const inicio = await criarSessao("2026-07");
      const fim = await criarSessao("2026-08");
      const alvo = await prisma.alvo.create({
        data: {
          nome: "Alvo AAA11",
          percentual_alvo_bps: 1000,
          vigencia_inicio: new Date("2026-01-01"),
        },
      });
      // Vinculada a um alvo (não pendente, não fora da carteira).
      await prisma.ativo_mapeado.create({
        data: { chave_export: "AAA11", fora_da_carteira: false, alvo_id: alvo.id },
      });
      await criarPosicao(inicio.id, "AAA11", 100_000, 80_000);
      await criarPosicao(fim.id, "AAA11", 110_000, 80_000);

      const buckets = await rendimentoService.calcularRendimentoPorBucket(inicio.id, fim.id);

      expect(buckets.pendentes).toEqual([]);
      expect(buckets.pendentesTotal.rendimentoCentavos).toBeNull();
      expect(buckets.pendentesTotal.rendimentoPct).toBeNull();
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

  describe("montarSerieRendimento (US3 — um ponto por sessão VIGENTE no período, FR-013)", () => {
    async function criarSessao(mesReferencia: string, status: "VIGENTE" | "SUBSTITUIDO" = "VIGENTE") {
      return prisma.sessao_import.create({
        data: {
          mes_referencia: mesReferencia,
          data_export: new Date(`${mesReferencia}-28`),
          status,
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
    }

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

    it("produz um ponto por sessão VIGENTE dentro do período (início/fim inclusive), ordenado cronologicamente por mes_referencia", async () => {
      const s1 = await criarSessao("2026-01");
      const s2 = await criarSessao("2026-02");
      const s3 = await criarSessao("2026-03");
      const s4 = await criarSessao("2026-04");

      for (const s of [s1, s2, s3, s4]) {
        await criarPosicao(s.id, "AAA11", 100_000, 80_000);
      }

      const serie = await rendimentoService.montarSerieRendimento(s2.id, s4.id);

      expect(serie).toHaveLength(3);
      expect(serie.map((p) => p.mesReferencia)).toEqual(["2026-02", "2026-03", "2026-04"]);
      expect(serie.map((p) => p.sessaoImportId)).toEqual([s2.id, s3.id, s4.id]);
    });

    it("cada ponto segue o shape PontoSerieRendimento (data-model.md), incluindo rendimentoCentavos/rendimentoPct calculados como PONTO", async () => {
      const s1 = await criarSessao("2026-01");
      await criarPosicao(s1.id, "AAA11", 120_000, 100_000);

      const serie = await rendimentoService.montarSerieRendimento(s1.id, s1.id);

      expect(serie).toHaveLength(1);
      const ponto = serie[0];
      expect(ponto.sessaoImportId).toBe(s1.id);
      expect(ponto.mesReferencia).toBe("2026-01");
      expect(ponto.dataExport).toEqual(s1.data_export);
      expect(ponto.valorInvestidoCentavos).toBe(100_000);
      expect(ponto.valorAtualCentavos).toBe(120_000);
      expect(ponto.rendimentoCentavos).toBe(20_000);
      expect(ponto.rendimentoPct).toBeCloseTo(20, 5);
    });

    it("EXCLUI sessões SUBSTITUIDO do período, mesmo com mes_referencia dentro do intervalo", async () => {
      const s1 = await criarSessao("2026-01");
      const substituida = await criarSessao("2026-02", "SUBSTITUIDO");
      const s2Vigente = await criarSessao("2026-02"); // mesmo mês, reimport — vigente
      const s3 = await criarSessao("2026-03");

      for (const s of [s1, s2Vigente, s3]) {
        await criarPosicao(s.id, "AAA11", 100_000, 80_000);
      }
      await criarPosicao(substituida.id, "AAA11", 999_999, 999_999);

      const serie = await rendimentoService.montarSerieRendimento(s1.id, s3.id);

      expect(serie).toHaveLength(3);
      expect(serie.map((p) => p.sessaoImportId)).not.toContain(substituida.id);
      expect(serie.map((p) => p.sessaoImportId)).toEqual([s1.id, s2Vigente.id, s3.id]);
    });

    it("sessão sem histórico de valor investido (patrimonio_investido_centavos: null) ainda gera um ponto na série, com valorInvestidoCentavos/rendimentoCentavos null — NUNCA omitido silenciosamente", async () => {
      const s1 = await criarSessao("2026-01");
      const s2SemHistorico = await criarSessao("2026-02");
      const s3 = await criarSessao("2026-03");

      await criarPosicao(s1.id, "AAA11", 100_000, 80_000);
      await criarPosicao(s2SemHistorico.id, "AAA11", 105_000, null);
      await criarPosicao(s3.id, "AAA11", 110_000, 80_000);

      const serie = await rendimentoService.montarSerieRendimento(s1.id, s3.id);

      expect(serie).toHaveLength(3);
      const pontoSemHistorico = serie.find((p) => p.sessaoImportId === s2SemHistorico.id);
      expect(pontoSemHistorico).toBeDefined();
      expect(pontoSemHistorico!.valorInvestidoCentavos).toBeNull();
      expect(pontoSemHistorico!.rendimentoCentavos).toBeNull();
      expect(pontoSemHistorico!.rendimentoPct).toBeNull();
    });

    it("período com sessaoInicioId/sessaoFimId invertidos (fim cronologicamente antes do início): resolve o mesmo intervalo de mes_referencia, ordenado cronologicamente", async () => {
      const s1 = await criarSessao("2026-01");
      const s2 = await criarSessao("2026-02");
      for (const s of [s1, s2]) await criarPosicao(s.id, "AAA11", 100_000, 80_000);

      const serie = await rendimentoService.montarSerieRendimento(s2.id, s1.id);

      expect(serie.map((p) => p.mesReferencia)).toEqual(["2026-01", "2026-02"]);
    });

    it("sessaoInicioId/sessaoFimId inexistentes no banco: retorna série vazia, nunca lança exceção", async () => {
      const serie = await rendimentoService.montarSerieRendimento(
        "sessao-que-nao-existe-1",
        "sessao-que-nao-existe-2",
      );
      expect(serie).toEqual([]);
    });
  });

  describe("contarAtivosComValorInvestidoRastreavel (US4, R6 — conjunto NOVO, diferente de aporte-service.gerarIncrementosPendentes)", () => {
    async function criarAlvo(nome = "Alvo Teste") {
      return prisma.alvo.create({
        data: { nome, percentual_alvo_bps: 1000, vigencia_inicio: new Date("2026-01-01") },
      });
    }

    it("n=0: alvo sem nenhuma posicao_manual/ativo_mapeado vinculado ainda", async () => {
      const alvo = await criarAlvo();
      const resultado = await rendimentoService.contarAtivosComValorInvestidoRastreavel(alvo.id);
      expect(resultado.n).toBe(0);
      expect(resultado.elegiveis).toEqual([]);
    });

    it("n=1: um único chave_export vinculado (fora_da_carteira=false, ignorar_no_import=false) — SEM exigir ajuste ativo (diferente da feature 002)", async () => {
      const alvo = await criarAlvo();
      await prisma.ativo_mapeado.create({
        data: { chave_export: "AAA11", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });

      const resultado = await rendimentoService.contarAtivosComValorInvestidoRastreavel(alvo.id);
      expect(resultado.n).toBe(1);
      expect(resultado.elegiveis).toEqual([{ chaveExport: "AAA11" }]);
    });

    it("n=1: uma única posicao_manual ATIVA vinculada", async () => {
      const alvo = await criarAlvo();
      const pm = await prisma.posicao_manual.create({
        data: { chave_manual: "CDB-X", instituicao: "Itaú", alvo_id: alvo.id, descricao: "CDB", ativo: true },
      });

      const resultado = await rendimentoService.contarAtivosComValorInvestidoRastreavel(alvo.id);
      expect(resultado.n).toBe(1);
      expect(resultado.elegiveis).toEqual([{ posicaoManualId: pm.id }]);
    });

    it("n>=2: chave_export + posicao_manual do mesmo alvo somam", async () => {
      const alvo = await criarAlvo();
      await prisma.ativo_mapeado.create({
        data: { chave_export: "AAA11", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      await prisma.posicao_manual.create({
        data: { chave_manual: "CDB-X", instituicao: "Itaú", alvo_id: alvo.id, descricao: "CDB", ativo: true },
      });

      const resultado = await rendimentoService.contarAtivosComValorInvestidoRastreavel(alvo.id);
      expect(resultado.n).toBe(2);
    });

    it("exclui chave_export fora_da_carteira=true e ignorar_no_import=true", async () => {
      const alvo = await criarAlvo();
      await prisma.ativo_mapeado.create({
        data: { chave_export: "FORA1", alvo_id: alvo.id, fora_da_carteira: true },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "IGN1", alvo_id: alvo.id, ignorar_no_import: true },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "VALIDO1", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });

      const resultado = await rendimentoService.contarAtivosComValorInvestidoRastreavel(alvo.id);
      expect(resultado.n).toBe(1);
      expect(resultado.elegiveis).toEqual([{ chaveExport: "VALIDO1" }]);
    });

    it("exclui posicao_manual inativa (ativo=false)", async () => {
      const alvo = await criarAlvo();
      await prisma.posicao_manual.create({
        data: { chave_manual: "CDB-INATIVA", instituicao: "Itaú", alvo_id: alvo.id, descricao: "CDB", ativo: false },
      });

      const resultado = await rendimentoService.contarAtivosComValorInvestidoRastreavel(alvo.id);
      expect(resultado.n).toBe(0);
    });
  });

  describe("calcularMovimentacaoNaoExplicada (US4, FR-011/FR-011a/FR-018)", () => {
    async function criarAlvo(nome = "Alvo Teste") {
      return prisma.alvo.create({
        data: { nome, percentual_alvo_bps: 1000, vigencia_inicio: new Date("2026-01-01") },
      });
    }

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

    it("n=0: retorna null, nada a validar", async () => {
      const alvo = await criarAlvo();
      const sessaoAnterior = await criarSessao("2026-07");

      const resultado = await rendimentoService.calcularMovimentacaoNaoExplicada(
        { alvoId: alvo.id, nomeAlvo: alvo.nome, valorInvestidoRealCentavos: 100_000 },
        sessaoAnterior.id,
      );
      expect(resultado).toBeNull();
    });

    it("n=1 (ativo único): granularidade 'ativo', aponta chaveExport; real bate com esperado dentro da tolerância → excedeTolerancia false", async () => {
      const alvo = await criarAlvo();
      await prisma.ativo_mapeado.create({
        data: { chave_export: "AAA11", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      const sessaoAnterior = await criarSessao("2026-07");
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          chave_export: "AAA11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 100_000,
          patrimonio_investido_centavos: 80_000,
          tipo_grupo: "ACOES",
        },
      });

      // valorInvestidoEsperado = 80_000 (anterior) + 0 (nenhum aporte executado) = 80_000
      // real = 80_500 → diferença de R$5,00, bem abaixo do piso de R$20,00.
      const resultado = await rendimentoService.calcularMovimentacaoNaoExplicada(
        { alvoId: alvo.id, nomeAlvo: alvo.nome, valorInvestidoRealCentavos: 80_500 },
        sessaoAnterior.id,
      );
      expect(resultado).not.toBeNull();
      expect(resultado!.granularidade).toBe("ativo");
      expect(resultado!.chaveExport).toBe("AAA11");
      expect(resultado!.posicaoManualId).toBeUndefined();
      expect(resultado!.alvoId).toBe(alvo.id);
      expect(resultado!.valorInvestidoEsperadoCentavos).toBe(80_000);
      expect(resultado!.valorInvestidoRealCentavos).toBe(80_500);
      expect(resultado!.diferencaCentavos).toBe(500);
      expect(resultado!.excedeTolerancia).toBe(false);
    });

    it("n=1: soma aporte.executado (por alvo_id) da sessão anterior ao valor investido esperado (R7)", async () => {
      const alvo = await criarAlvo();
      await prisma.ativo_mapeado.create({
        data: { chave_export: "AAA11", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      const sessaoAnterior = await criarSessao("2026-07");
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          chave_export: "AAA11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 100_000,
          patrimonio_investido_centavos: 80_000,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.aporte.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          valor_total_centavos: 20_000,
          valor_dividendos_centavos: 0,
          sugestao: JSON.stringify([{ alvo_id: alvo.id, nome_alvo: alvo.nome, valor_centavos: 20_000 }]),
          executado: JSON.stringify([{ alvo_id: alvo.id, nome_alvo: alvo.nome, valor_centavos: 20_000 }]),
          troco_centavos: 0,
        },
      });

      // esperado = 80_000 (anterior) + 20_000 (aporte executado) = 100_000; real bate exatamente.
      const resultado = await rendimentoService.calcularMovimentacaoNaoExplicada(
        { alvoId: alvo.id, nomeAlvo: alvo.nome, valorInvestidoRealCentavos: 100_000 },
        sessaoAnterior.id,
      );
      expect(resultado!.valorInvestidoEsperadoCentavos).toBe(100_000);
      expect(resultado!.diferencaCentavos).toBe(0);
      expect(resultado!.excedeTolerancia).toBe(false);
    });

    it("n=1: aporte.executado de OUTRO alvo na mesma sessão não contamina a soma", async () => {
      const alvo = await criarAlvo("Alvo A");
      const outroAlvo = await criarAlvo("Alvo B");
      await prisma.ativo_mapeado.create({
        data: { chave_export: "AAA11", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      const sessaoAnterior = await criarSessao("2026-07");
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          chave_export: "AAA11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 100_000,
          patrimonio_investido_centavos: 80_000,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.aporte.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          valor_total_centavos: 50_000,
          valor_dividendos_centavos: 0,
          sugestao: JSON.stringify([{ alvo_id: outroAlvo.id, nome_alvo: outroAlvo.nome, valor_centavos: 50_000 }]),
          executado: JSON.stringify([{ alvo_id: outroAlvo.id, nome_alvo: outroAlvo.nome, valor_centavos: 50_000 }]),
          troco_centavos: 0,
        },
      });

      const resultado = await rendimentoService.calcularMovimentacaoNaoExplicada(
        { alvoId: alvo.id, nomeAlvo: alvo.nome, valorInvestidoRealCentavos: 80_000 },
        sessaoAnterior.id,
      );
      expect(resultado!.valorInvestidoEsperadoCentavos).toBe(80_000);
    });

    it("n>=2: granularidade 'alvo', SEM apontar chaveExport/posicaoManualId (soma agregada, FR-011a)", async () => {
      const alvo = await criarAlvo();
      await prisma.ativo_mapeado.create({
        data: { chave_export: "AAA11", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "BBB11", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      const sessaoAnterior = await criarSessao("2026-07");
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          chave_export: "AAA11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 100_000,
          patrimonio_investido_centavos: 50_000,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          chave_export: "BBB11",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 50_000,
          patrimonio_investido_centavos: 30_000,
          tipo_grupo: "ACOES",
        },
      });

      // esperado = 50_000 + 30_000 = 80_000; real = 200_000 (bem além dos dois limiares).
      const resultado = await rendimentoService.calcularMovimentacaoNaoExplicada(
        { alvoId: alvo.id, nomeAlvo: alvo.nome, valorInvestidoRealCentavos: 200_000 },
        sessaoAnterior.id,
      );
      expect(resultado!.granularidade).toBe("alvo");
      expect(resultado!.chaveExport).toBeUndefined();
      expect(resultado!.posicaoManualId).toBeUndefined();
      expect(resultado!.valorInvestidoEsperadoCentavos).toBe(80_000);
      expect(resultado!.diferencaCentavos).toBe(120_000);
      expect(resultado!.excedeTolerancia).toBe(true);
    });

    it("tolerância FR-018: excede o percentual (5%) mas NÃO o piso (R$20,00) → excedeTolerancia false (nunca sinaliza só por um dos dois)", async () => {
      const alvo = await criarAlvo();
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PEQUENO1", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      const sessaoAnterior = await criarSessao("2026-07");
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          chave_export: "PEQUENO1",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 1_000,
          patrimonio_investido_centavos: 1_000, // esperado = 1_000 (10 reais)
          tipo_grupo: "ACOES",
        },
      });

      // diferença = 200 centavos (20%, > 5%) mas < 2_000 centavos (piso R$20,00).
      const resultado = await rendimentoService.calcularMovimentacaoNaoExplicada(
        { alvoId: alvo.id, nomeAlvo: alvo.nome, valorInvestidoRealCentavos: 1_200 },
        sessaoAnterior.id,
      );
      expect(resultado!.diferencaCentavos).toBe(200);
      expect(resultado!.excedeTolerancia).toBe(false);
    });

    it("tolerância FR-018: excede o piso (R$20,00) mas NÃO o percentual (5%) → excedeTolerancia false", async () => {
      const alvo = await criarAlvo();
      await prisma.ativo_mapeado.create({
        data: { chave_export: "GRANDE1", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      const sessaoAnterior = await criarSessao("2026-07");
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          chave_export: "GRANDE1",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 10_000_000,
          patrimonio_investido_centavos: 10_000_000, // esperado = R$100.000,00
          tipo_grupo: "ACOES",
        },
      });

      // diferença = 3_000 centavos (R$30,00, > R$20,00 piso) mas só 0.03% (< 5%).
      const resultado = await rendimentoService.calcularMovimentacaoNaoExplicada(
        { alvoId: alvo.id, nomeAlvo: alvo.nome, valorInvestidoRealCentavos: 10_003_000 },
        sessaoAnterior.id,
      );
      expect(resultado!.diferencaCentavos).toBe(3_000);
      expect(resultado!.excedeTolerancia).toBe(false);
    });

    it("tolerância FR-018: excede AMBOS simultaneamente → excedeTolerancia true", async () => {
      const alvo = await criarAlvo();
      await prisma.ativo_mapeado.create({
        data: { chave_export: "AMBOS1", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      const sessaoAnterior = await criarSessao("2026-07");
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          chave_export: "AMBOS1",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 100_000,
          patrimonio_investido_centavos: 100_000, // esperado = R$1.000,00
          tipo_grupo: "ACOES",
        },
      });

      // diferença = 10_000 centavos (R$100,00, > R$20,00 piso E 10% > 5%).
      const resultado = await rendimentoService.calcularMovimentacaoNaoExplicada(
        { alvoId: alvo.id, nomeAlvo: alvo.nome, valorInvestidoRealCentavos: 110_000 },
        sessaoAnterior.id,
      );
      expect(resultado!.diferencaCentavos).toBe(10_000);
      expect(resultado!.excedeTolerancia).toBe(true);
    });

    it("US4 Acceptance Scenario 3: ativo novo (primeira aparição, sem sessão anterior) — esperado=0 não gera alerta ('não há base de comparação')", async () => {
      const alvo = await criarAlvo();
      // Elegível AGORA (vínculo vigente no momento da consulta), mas SEM
      // nenhuma linha `posicao`/snapshot na sessão anterior — genuinamente
      // novo, apareceu pela primeira vez nesta sessão.
      await prisma.ativo_mapeado.create({
        data: { chave_export: "NOVO1", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      const sessaoAnterior = await criarSessao("2026-07");
      // Nenhum prisma.posicao.create para "NOVO1" na sessaoAnterior.

      const resultado = await rendimentoService.calcularMovimentacaoNaoExplicada(
        { alvoId: alvo.id, nomeAlvo: alvo.nome, valorInvestidoRealCentavos: 50_000 },
        sessaoAnterior.id,
      );

      expect(resultado!.valorInvestidoEsperadoCentavos).toBe(0);
      // Spec.md US4 Acceptance Scenario 3: "ativo novo... nenhum alerta de
      // divergência é gerado para ele (não há base de comparação)".
      expect(resultado!.excedeTolerancia).toBe(false);
    });

    it("garantia estrutural (FR-019): a função NUNCA persiste nada — posicao.patrimonio_investido_centavos continua com o valor REAL original após o cálculo", async () => {
      const alvo = await criarAlvo();
      await prisma.ativo_mapeado.create({
        data: { chave_export: "SAFE1", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: false },
      });
      const sessaoAnterior = await criarSessao("2026-07");
      const posicaoOriginal = await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoAnterior.id,
          chave_export: "SAFE1",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 100_000,
          patrimonio_investido_centavos: 80_000,
          tipo_grupo: "ACOES",
        },
      });

      // "real" simulado bem diferente do esperado — a função só COMPARA, nunca grava.
      await rendimentoService.calcularMovimentacaoNaoExplicada(
        { alvoId: alvo.id, nomeAlvo: alvo.nome, valorInvestidoRealCentavos: 999_999 },
        sessaoAnterior.id,
      );

      const posicaoDepois = await prisma.posicao.findUnique({ where: { id: posicaoOriginal.id } });
      expect(posicaoDepois!.patrimonio_investido_centavos).toBe(80_000);
    });
  });
});
