/**
 * tests/services/dashboard-service.test.ts — testes de integração (T054) de
 * src/services/dashboard-service.ts contra um SQLite TEMPORÁRIO, isolado do
 * `data/app.db` real/seed.
 *
 * Mesma estratégia de `tests/services/aporte-service.test.ts`: `DATABASE_URL`
 * é redirecionado para um arquivo temporário ANTES de qualquer import de
 * `@/db/client`/serviços (por isso os imports são dinâmicos dentro de
 * `beforeAll`), com o schema aplicado via `prisma migrate deploy`.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let dashboardService: typeof import("@/services/dashboard-service");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-service-test-"));
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
  dashboardService = await import("@/services/dashboard-service");
}, 30_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Limpa todas as tabelas (ordem respeita FKs, igual a prisma/seed.ts). */
async function resetDb() {
  await prisma.dividendo.deleteMany();
  await prisma.aporte.deleteMany();
  await prisma.posicao.deleteMany();
  await prisma.ativo_mapeado.deleteMany();
  await prisma.sessao_import.deleteMany();
  await prisma.alvo.deleteMany();
  await prisma.config.deleteMany();
}

beforeEach(async () => {
  await resetDb();
});

describe("dashboard-service", () => {
  describe("dadosDashboard", () => {
    it("app vazio (nenhuma sessão de import) retorna vazio:true sem lançar exceção", async () => {
      const dados = await dashboardService.dadosDashboard();
      expect(dados.vazio).toBe(true);
      if (dados.vazio) {
        expect(dados.bandaToleranciaBps).toBe(150);
        expect(dados.qtdPendencias).toBe(0);
      }
    });

    it("consolida patrimônio na carteira / fora da carteira / pendente e calcula desvio em bps", async () => {
      const alvoAcoes = await prisma.alvo.create({
        data: {
          nome: "Ações BR",
          percentual_alvo_bps: 6000,
          vigencia_inicio: new Date("2026-01-01"),
        },
      });
      const alvoRendaFixa = await prisma.alvo.create({
        data: {
          nome: "Pós-fixado",
          percentual_alvo_bps: 4000,
          vigencia_inicio: new Date("2026-01-01"),
        },
      });

      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });

      await prisma.posicao.createMany({
        data: [
          // PRIO3 consolidado em 2 instituições: 300_000 + 100_000 = 400_000.
          {
            sessao_import_id: sessao.id,
            chave_export: "PRIO3",
            instituicao: "Itaú",
            quantidade: "100",
            patrimonio_hoje_centavos: 300_000,
            tipo_grupo: "ACOES",
          },
          {
            sessao_import_id: sessao.id,
            chave_export: "PRIO3",
            instituicao: "Nubank",
            quantidade: "50",
            patrimonio_hoje_centavos: 100_000,
            tipo_grupo: "ACOES",
          },
          {
            sessao_import_id: sessao.id,
            chave_export: "Tesouro Selic 2029",
            instituicao: "Itaú",
            quantidade: "1000.00",
            patrimonio_hoje_centavos: 100_000,
            tipo_grupo: "TESOURO_DIRETO",
          },
          {
            sessao_import_id: sessao.id,
            chave_export: "CDB Legado",
            instituicao: "Itaú",
            quantidade: "1",
            patrimonio_hoje_centavos: 50_000,
            tipo_grupo: "OUTROS_FUNDOS",
          },
          {
            sessao_import_id: sessao.id,
            chave_export: "ATIVO-PENDENTE",
            instituicao: "Itaú",
            quantidade: "10",
            patrimonio_hoje_centavos: 20_000,
            tipo_grupo: "ACOES",
          },
        ],
      });

      await prisma.ativo_mapeado.createMany({
        data: [
          { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
          { chave_export: "Tesouro Selic 2029", alvo_id: alvoRendaFixa.id, fora_da_carteira: false },
          { chave_export: "CDB Legado", alvo_id: null, fora_da_carteira: true },
          // ATIVO-PENDENTE: sem nenhum ativo_mapeado — equivalente a pendente.
        ],
      });

      const dados = await dashboardService.dadosDashboard();
      expect(dados.vazio).toBe(false);
      if (dados.vazio) throw new Error("não deveria ser vazio");

      expect(dados.sessaoImportId).toBe(sessao.id);
      expect(dados.mesReferencia).toBe("2026-07");
      expect(dados.dataExport).toEqual(new Date("2026-07-28"));

      // Total = 400_000 (PRIO3) + 100_000 (Tesouro) + 50_000 (CDB) + 20_000 (pendente) = 570_000.
      expect(dados.patrimonioTotalCentavos).toBe(570_000);
      // Na carteira = 400_000 + 100_000 = 500_000 (mesma base do motor).
      expect(dados.patrimonioNaCarteiraCentavos).toBe(500_000);
      expect(dados.patrimonioForaDaCarteiraCentavos).toBe(50_000);
      expect(dados.patrimonioPendenteCentavos).toBe(20_000);
      expect(
        dados.patrimonioNaCarteiraCentavos +
          dados.patrimonioForaDaCarteiraCentavos +
          dados.patrimonioPendenteCentavos,
      ).toBe(dados.patrimonioTotalCentavos);

      expect(dados.foraDaCarteira).toEqual([{ chaveExport: "CDB Legado", valorCentavos: 50_000 }]);
      expect(dados.pendentes).toEqual([
        { chaveExport: "ATIVO-PENDENTE", valorCentavos: 20_000 },
      ]);
      expect(dados.qtdPendencias).toBe(0); // ATIVO-PENDENTE não tem ativo_mapeado nenhum.

      const acoes = dados.alocacao.find((a) => a.alvoId === alvoAcoes.id)!;
      // 400_000 / 500_000 = 80% = 8000 bps; alvo = 6000 bps; desvio = +2000.
      expect(acoes.percentualAtualBps).toBe(8000);
      expect(acoes.desvioBps).toBe(2000);
      expect(acoes.dentroDaBanda).toBe(false); // banda default 150 bps.

      const rendaFixa = dados.alocacao.find((a) => a.alvoId === alvoRendaFixa.id)!;
      // 100_000 / 500_000 = 20% = 2000 bps; alvo = 4000 bps; desvio = -2000.
      expect(rendaFixa.percentualAtualBps).toBe(2000);
      expect(rendaFixa.desvioBps).toBe(-2000);
      expect(rendaFixa.dentroDaBanda).toBe(false);
    });

    it("dentroDaBanda usa banda_tolerancia_bps configurada", async () => {
      const alvo = await prisma.alvo.create({
        data: { nome: "Único", percentual_alvo_bps: 10000, vigencia_inicio: new Date("2026-01-01") },
      });
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
          chave_export: "ÚNICO-ATIVO",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 100_000,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "ÚNICO-ATIVO", alvo_id: alvo.id, fora_da_carteira: false },
      });
      await prisma.config.create({ data: { chave: "banda_tolerancia_bps", valor: "500" } });

      const dados = await dashboardService.dadosDashboard();
      if (dados.vazio) throw new Error("não deveria ser vazio");
      expect(dados.bandaToleranciaBps).toBe(500);
      // Um único alvo com 100% da posição bate exatamente o alvo (desvio 0).
      expect(dados.alocacao[0].desvioBps).toBe(0);
      expect(dados.alocacao[0].dentroDaBanda).toBe(true);
    });

    it("todos os alvos dentro da banda (nenhum 'fora') marca dentroDaBanda=true em todas as linhas", async () => {
      const alvoA = await prisma.alvo.create({
        data: { nome: "A", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });
      const alvoB = await prisma.alvo.create({
        data: { nome: "B", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.createMany({
        data: [
          {
            sessao_import_id: sessao.id,
            chave_export: "ATIVO-A",
            instituicao: "Itaú",
            quantidade: "1",
            patrimonio_hoje_centavos: 50_100,
            tipo_grupo: "ACOES",
          },
          {
            sessao_import_id: sessao.id,
            chave_export: "ATIVO-B",
            instituicao: "Itaú",
            quantidade: "1",
            patrimonio_hoje_centavos: 49_900,
            tipo_grupo: "TESOURO_DIRETO",
          },
        ],
      });
      await prisma.ativo_mapeado.createMany({
        data: [
          { chave_export: "ATIVO-A", alvo_id: alvoA.id, fora_da_carteira: false },
          { chave_export: "ATIVO-B", alvo_id: alvoB.id, fora_da_carteira: false },
        ],
      });

      const dados = await dashboardService.dadosDashboard();
      if (dados.vazio) throw new Error("não deveria ser vazio");
      // Desvios pequenos (dentro da banda default de 150 bps) para os 2 alvos.
      expect(dados.alocacao.every((a) => a.dentroDaBanda)).toBe(true);
      expect(dados.alocacao.some((a) => a.desvioBps !== 0)).toBe(true);
    });

    it("alvo vigente sem nenhuma posição vinculada (patrimônio zero): déficit = 100% do alvo", async () => {
      const alvoComPosicao = await prisma.alvo.create({
        data: { nome: "Com posição", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });
      const alvoZerado = await prisma.alvo.create({
        data: { nome: "Zerado", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });
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
          tipo_grupo: "ACOES",
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvoComPosicao.id, fora_da_carteira: false },
      });

      const dados = await dashboardService.dadosDashboard();
      if (dados.vazio) throw new Error("não deveria ser vazio");

      const zerado = dados.alocacao.find((a) => a.alvoId === alvoZerado.id)!;
      expect(zerado.valorAtualCentavos).toBe(0);
      expect(zerado.percentualAtualBps).toBe(0);
      // Desvio = 0 - 5000 = -5000 (déficit total: 100% do alvo).
      expect(zerado.desvioBps).toBe(-5000);
      expect(zerado.dentroDaBanda).toBe(false);
    });

    it("sessão VIGENTE sem nenhuma posição (patrimônio total zero): não lança exceção e zera tudo", async () => {
      const alvo = await prisma.alvo.create({
        data: { nome: "Único", percentual_alvo_bps: 10000, vigencia_inicio: new Date("2026-01-01") },
      });
      await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });

      const dados = await dashboardService.dadosDashboard();
      if (dados.vazio) throw new Error("não deveria ser vazio");
      expect(dados.patrimonioTotalCentavos).toBe(0);
      expect(dados.patrimonioNaCarteiraCentavos).toBe(0);
      expect(dados.patrimonioForaDaCarteiraCentavos).toBe(0);
      expect(dados.patrimonioPendenteCentavos).toBe(0);
      expect(dados.alocacao.find((a) => a.alvoId === alvo.id)!.percentualAtualBps).toBe(0);
    });

    it("invariante patrimonioTotal = naCarteira + foraDaCarteira + pendente quando TUDO é pendente", async () => {
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
          chave_export: "NAO-MAPEADO",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 42_000,
          tipo_grupo: "ACOES",
        },
      });
      // Nenhum ativo_mapeado criado — a posição fica pendente por completo.

      const dados = await dashboardService.dadosDashboard();
      if (dados.vazio) throw new Error("não deveria ser vazio");
      expect(dados.patrimonioTotalCentavos).toBe(42_000);
      expect(dados.patrimonioNaCarteiraCentavos).toBe(0);
      expect(dados.patrimonioForaDaCarteiraCentavos).toBe(0);
      expect(dados.patrimonioPendenteCentavos).toBe(42_000);
      expect(
        dados.patrimonioNaCarteiraCentavos +
          dados.patrimonioForaDaCarteiraCentavos +
          dados.patrimonioPendenteCentavos,
      ).toBe(dados.patrimonioTotalCentavos);
    });

    it("invariante patrimonioTotal = naCarteira + foraDaCarteira + pendente quando TUDO é fora da carteira", async () => {
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
          chave_export: "CDB Legado",
          instituicao: "Itaú",
          quantidade: "1",
          patrimonio_hoje_centavos: 15_000,
          tipo_grupo: "OUTROS_FUNDOS",
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "CDB Legado", alvo_id: null, fora_da_carteira: true },
      });

      const dados = await dashboardService.dadosDashboard();
      if (dados.vazio) throw new Error("não deveria ser vazio");
      expect(dados.patrimonioTotalCentavos).toBe(15_000);
      expect(dados.patrimonioNaCarteiraCentavos).toBe(0);
      expect(dados.patrimonioForaDaCarteiraCentavos).toBe(15_000);
      expect(dados.patrimonioPendenteCentavos).toBe(0);
      expect(
        dados.patrimonioNaCarteiraCentavos +
          dados.patrimonioForaDaCarteiraCentavos +
          dados.patrimonioPendenteCentavos,
      ).toBe(dados.patrimonioTotalCentavos);
    });

    it("alvo 'zumbi' (vigência fechada, mas com ativo_mapeado ainda apontando pra ele): entra na base mas não aparece em alocacao — replica a regra do motor, documentada em dashboard-service.ts", async () => {
      // Estado hoje inatingível pelos serviços normais (removerAlvo recusa
      // remoção com vínculo ativo, e novaVigencia re-aponta os vínculos para
      // o clone) — construído aqui diretamente via prisma para confirmar que
      // o dashboard não quebra e segue a mesma regra do motor caso esse
      // estado exista por algum caminho não previsto (import direto no banco,
      // dado legado, etc.).
      const alvoVigente = await prisma.alvo.create({
        data: { nome: "Vigente", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });
      const alvoZumbi = await prisma.alvo.create({
        data: {
          nome: "Fechado",
          percentual_alvo_bps: 5000,
          vigencia_inicio: new Date("2025-01-01"),
          vigencia_fim: new Date("2026-01-01"),
        },
      });
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.createMany({
        data: [
          {
            sessao_import_id: sessao.id,
            chave_export: "ATIVO-VIGENTE",
            instituicao: "Itaú",
            quantidade: "1",
            patrimonio_hoje_centavos: 100_000,
            tipo_grupo: "ACOES",
          },
          {
            sessao_import_id: sessao.id,
            chave_export: "ATIVO-ZUMBI",
            instituicao: "Itaú",
            quantidade: "1",
            patrimonio_hoje_centavos: 50_000,
            tipo_grupo: "ACOES",
          },
        ],
      });
      await prisma.ativo_mapeado.createMany({
        data: [
          { chave_export: "ATIVO-VIGENTE", alvo_id: alvoVigente.id, fora_da_carteira: false },
          { chave_export: "ATIVO-ZUMBI", alvo_id: alvoZumbi.id, fora_da_carteira: false },
        ],
      });

      const dados = await dashboardService.dadosDashboard();
      if (dados.vazio) throw new Error("não deveria ser vazio");

      // O valor do vínculo zumbi entra na base "na carteira" (mesma regra do motor)...
      expect(dados.patrimonioNaCarteiraCentavos).toBe(150_000);
      // ...mas só o alvo vigente aparece em `alocacao` — o alvo fechado não é listado.
      expect(dados.alocacao).toHaveLength(1);
      expect(dados.alocacao[0].alvoId).toBe(alvoVigente.id);
      // A soma dos valores exibidos em `alocacao` fica menor que a base — o
      // valor do vínculo zumbi (50_000) não aparece em nenhuma linha (documentado,
      // não é bug novo).
      const somaAlocacao = dados.alocacao.reduce((acc, a) => acc + a.valorAtualCentavos, 0);
      expect(somaAlocacao).toBe(100_000);
      expect(somaAlocacao).toBeLessThan(dados.patrimonioNaCarteiraCentavos);
    });

    describe("alocacaoPorTag", () => {
      it("agrupa por tag (somando múltiplos alvos com a MESMA tag), alvos sem tag caem em 'Sem tag', ordenação alfabética com 'Sem tag' sempre por último (mesmo com tags que viriam depois dela em ordem alfabética), e cada grupo segue a mesma fórmula usada por alvo individual", async () => {
        // Grupo "A-AÇÕES": 2 alvos, deve somar percentual e valor (não sobrescrever).
        const alvoA1 = await prisma.alvo.create({
          data: {
            nome: "Ações BR",
            percentual_alvo_bps: 2000,
            tag: "A-AÇÕES",
            vigencia_inicio: new Date("2026-01-01"),
          },
        });
        const alvoA2 = await prisma.alvo.create({
          data: {
            nome: "Ações US",
            percentual_alvo_bps: 1000,
            tag: "A-AÇÕES",
            vigencia_inicio: new Date("2026-01-01"),
          },
        });
        // Grupo "R-REAL ESTATE": 1 alvo.
        const alvoR = await prisma.alvo.create({
          data: {
            nome: "FIIs",
            percentual_alvo_bps: 3000,
            tag: "R-REAL ESTATE",
            vigencia_inicio: new Date("2026-01-01"),
          },
        });
        // Grupo "Z-CRIPTO": tag que viria alfabeticamente DEPOIS de "Sem tag"
        // se a ordenação fosse puramente alfabética — usado para provar que
        // "Sem tag" é sempre por último por regra explícita, não por acaso.
        const alvoZ = await prisma.alvo.create({
          data: {
            nome: "Cripto",
            percentual_alvo_bps: 1000,
            tag: "Z-CRIPTO",
            vigencia_inicio: new Date("2026-01-01"),
          },
        });
        // Alvo sem tag: cai no grupo "Sem tag".
        const alvoSemTag = await prisma.alvo.create({
          data: {
            nome: "Caixa",
            percentual_alvo_bps: 3000,
            vigencia_inicio: new Date("2026-01-01"),
          },
        });

        const sessao = await prisma.sessao_import.create({
          data: {
            mes_referencia: "2026-07",
            data_export: new Date("2026-07-28"),
            status: "VIGENTE",
            instituicoes: JSON.stringify(["Itaú"]),
          },
        });
        await prisma.posicao.createMany({
          data: [
            {
              sessao_import_id: sessao.id,
              chave_export: "ATIVO-A1",
              instituicao: "Itaú",
              quantidade: "1",
              patrimonio_hoje_centavos: 150_000,
              tipo_grupo: "ACOES",
            },
            {
              sessao_import_id: sessao.id,
              chave_export: "ATIVO-A2",
              instituicao: "Itaú",
              quantidade: "1",
              patrimonio_hoje_centavos: 50_000,
              tipo_grupo: "ACOES",
            },
            {
              sessao_import_id: sessao.id,
              chave_export: "ATIVO-R",
              instituicao: "Itaú",
              quantidade: "1",
              patrimonio_hoje_centavos: 300_000,
              tipo_grupo: "FII_FIAGRO",
            },
            {
              sessao_import_id: sessao.id,
              chave_export: "ATIVO-Z",
              instituicao: "Itaú",
              quantidade: "1",
              patrimonio_hoje_centavos: 100_000,
              tipo_grupo: "OUTROS_FUNDOS",
            },
            {
              sessao_import_id: sessao.id,
              chave_export: "ATIVO-SEM-TAG",
              instituicao: "Itaú",
              quantidade: "1",
              patrimonio_hoje_centavos: 400_000,
              tipo_grupo: "TESOURO_DIRETO",
            },
          ],
        });
        await prisma.ativo_mapeado.createMany({
          data: [
            { chave_export: "ATIVO-A1", alvo_id: alvoA1.id, fora_da_carteira: false },
            { chave_export: "ATIVO-A2", alvo_id: alvoA2.id, fora_da_carteira: false },
            { chave_export: "ATIVO-R", alvo_id: alvoR.id, fora_da_carteira: false },
            { chave_export: "ATIVO-Z", alvo_id: alvoZ.id, fora_da_carteira: false },
            { chave_export: "ATIVO-SEM-TAG", alvo_id: alvoSemTag.id, fora_da_carteira: false },
          ],
        });

        const dados = await dashboardService.dadosDashboard();
        if (dados.vazio) throw new Error("não deveria ser vazio");

        // patrimonioNaCarteiraCentavos = 150k+50k+300k+100k+400k = 1_000_000.
        expect(dados.patrimonioNaCarteiraCentavos).toBe(1_000_000);

        // 4 grupos: A-AÇÕES, R-REAL ESTATE, Z-CRIPTO, Sem tag.
        expect(dados.alocacaoPorTag).toHaveLength(4);

        // Ordenação alfabética, com "Sem tag" sempre por último — mesmo que
        // "Z-CRIPTO" viesse depois dela em ordem puramente alfabética.
        expect(dados.alocacaoPorTag.map((g) => g.tag)).toEqual([
          "A-AÇÕES",
          "R-REAL ESTATE",
          "Z-CRIPTO",
          "Sem tag",
        ]);

        const acoes = dados.alocacaoPorTag.find((g) => g.tag === "A-AÇÕES")!;
        // Soma dos 2 alvos do grupo — não sobrescreve, agrega.
        expect(acoes.qtdAlvos).toBe(2);
        expect(acoes.percentualAlvoBps).toBe(3000); // 2000 + 1000
        expect(acoes.valorAtualCentavos).toBe(200_000); // 150k + 50k
        // Mesma fórmula usada por alvo individual, sobre patrimonioNaCarteiraCentavos.
        expect(acoes.percentualAtualBps).toBe(2000); // 200_000/1_000_000 = 20%
        expect(acoes.desvioBps).toBe(-1000); // 2000 - 3000
        expect(acoes.dentroDaBanda).toBe(false); // banda default 150 bps

        const imoveis = dados.alocacaoPorTag.find((g) => g.tag === "R-REAL ESTATE")!;
        expect(imoveis.qtdAlvos).toBe(1);
        expect(imoveis.percentualAlvoBps).toBe(3000);
        expect(imoveis.valorAtualCentavos).toBe(300_000);
        expect(imoveis.percentualAtualBps).toBe(3000);
        expect(imoveis.desvioBps).toBe(0);
        expect(imoveis.dentroDaBanda).toBe(true);

        const cripto = dados.alocacaoPorTag.find((g) => g.tag === "Z-CRIPTO")!;
        expect(cripto.qtdAlvos).toBe(1);
        expect(cripto.percentualAlvoBps).toBe(1000);
        expect(cripto.valorAtualCentavos).toBe(100_000);
        expect(cripto.percentualAtualBps).toBe(1000);
        expect(cripto.desvioBps).toBe(0);
        expect(cripto.dentroDaBanda).toBe(true);

        const semTag = dados.alocacaoPorTag.find((g) => g.tag === "Sem tag")!;
        expect(semTag.qtdAlvos).toBe(1);
        expect(semTag.percentualAlvoBps).toBe(3000);
        expect(semTag.valorAtualCentavos).toBe(400_000);
        expect(semTag.percentualAtualBps).toBe(4000);
        expect(semTag.desvioBps).toBe(1000);
        expect(semTag.dentroDaBanda).toBe(false);

        // Consistência: a soma dos valores por grupo bate com a soma por alvo
        // individual e com o patrimônio na carteira.
        const somaPorTag = dados.alocacaoPorTag.reduce((acc, g) => acc + g.valorAtualCentavos, 0);
        const somaPorAlvo = dados.alocacao.reduce((acc, a) => acc + a.valorAtualCentavos, 0);
        expect(somaPorTag).toBe(somaPorAlvo);
        expect(somaPorTag).toBe(dados.patrimonioNaCarteiraCentavos);
      });

      it("todos os alvos vigentes sem tag: um único grupo 'Sem tag' contendo todos", async () => {
        const alvo1 = await prisma.alvo.create({
          data: { nome: "A", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        const alvo2 = await prisma.alvo.create({
          data: { nome: "B", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        const sessao = await prisma.sessao_import.create({
          data: {
            mes_referencia: "2026-07",
            data_export: new Date("2026-07-28"),
            status: "VIGENTE",
            instituicoes: JSON.stringify(["Itaú"]),
          },
        });
        await prisma.posicao.createMany({
          data: [
            {
              sessao_import_id: sessao.id,
              chave_export: "ATIVO-A",
              instituicao: "Itaú",
              quantidade: "1",
              patrimonio_hoje_centavos: 100_000,
              tipo_grupo: "ACOES",
            },
            {
              sessao_import_id: sessao.id,
              chave_export: "ATIVO-B",
              instituicao: "Itaú",
              quantidade: "1",
              patrimonio_hoje_centavos: 100_000,
              tipo_grupo: "ACOES",
            },
          ],
        });
        await prisma.ativo_mapeado.createMany({
          data: [
            { chave_export: "ATIVO-A", alvo_id: alvo1.id, fora_da_carteira: false },
            { chave_export: "ATIVO-B", alvo_id: alvo2.id, fora_da_carteira: false },
          ],
        });

        const dados = await dashboardService.dadosDashboard();
        if (dados.vazio) throw new Error("não deveria ser vazio");

        expect(dados.alocacaoPorTag).toHaveLength(1);
        expect(dados.alocacaoPorTag[0].tag).toBe("Sem tag");
        expect(dados.alocacaoPorTag[0].qtdAlvos).toBe(2);
        expect(dados.alocacaoPorTag[0].percentualAlvoBps).toBe(10000);
        expect(dados.alocacaoPorTag[0].valorAtualCentavos).toBe(200_000);
      });
    });
  });

  describe("dadosHistorico", () => {
    it("série mensal só inclui sessões VIGENTES, e sessões SUBSTITUIDAS ficam na auditoria à parte", async () => {
      const sessaoJulhoAntiga = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-10"),
          status: "SUBSTITUIDO",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoJulhoAntiga.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 200_000,
          tipo_grupo: "ACOES",
        },
      });

      const sessaoJulhoNova = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú", "Nubank"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoJulhoNova.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 250_000,
          tipo_grupo: "ACOES",
        },
      });

      const sessaoJunho = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-06",
          data_export: new Date("2026-06-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoJunho.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "90",
          patrimonio_hoje_centavos: 180_000,
          tipo_grupo: "ACOES",
        },
      });

      const historico = await dashboardService.dadosHistorico();

      // Só as 2 sessões VIGENTES, ordenadas por mes_referencia asc.
      expect(historico.serieMensal.map((p) => p.mesReferencia)).toEqual(["2026-06", "2026-07"]);
      expect(historico.serieMensal[1].patrimonioTotalCentavos).toBe(250_000);
      expect(historico.serieMensal[1].sessaoImportId).toBe(sessaoJulhoNova.id);

      // A sessão substituída não aparece na série, mas fica acessível na auditoria.
      expect(historico.sessoesSubstituidas).toHaveLength(1);
      expect(historico.sessoesSubstituidas[0].sessaoImportId).toBe(sessaoJulhoAntiga.id);
      expect(historico.sessoesSubstituidas[0].patrimonioTotalCentavos).toBe(200_000);
      expect(historico.sessoesSubstituidas[0].instituicoes).toEqual(["Itaú"]);
    });

    it("linha do tempo sugerido vs. executado usa o mes_referencia da sessão do aporte, não criado_em", async () => {
      const alvo = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 10000, vigencia_inicio: new Date("2026-01-01") },
      });

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
          tipo_grupo: "ACOES",
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvo.id, fora_da_carteira: false },
      });

      // Aporte "registrado tarde": criado_em em agosto, mas amarrado à sessão de julho.
      const linhaAporte = [
        { alvo_id: alvo.id, nome_alvo: "Ações BR", valor_centavos: 100_000, origem: "DEFICIT" },
      ];
      const linhaExecutada = [
        { alvo_id: alvo.id, nome_alvo: "Ações BR", valor_centavos: 99_000, origem: "DEFICIT" },
      ];
      await prisma.aporte.create({
        data: {
          sessao_import_id: sessao.id,
          valor_total_centavos: 100_000,
          valor_dividendos_centavos: 0,
          sugestao: JSON.stringify(linhaAporte),
          executado: JSON.stringify(linhaExecutada),
          troco_centavos: 1_000,
          criado_em: new Date("2026-08-15"),
        },
      });

      const historico = await dashboardService.dadosHistorico();

      expect(historico.linhaDoTempoAportes).toHaveLength(1);
      const ponto = historico.linhaDoTempoAportes[0];
      expect(ponto.mesReferencia).toBe("2026-07");
      expect(ponto.sugeridoCentavos).toBe(100_000);
      expect(ponto.executadoCentavos).toBe(99_000);
      expect(ponto.trocoCentavos).toBe(1_000);
    });

    it("exatamente 1 sessão VIGENTE: série mensal com um único ponto", async () => {
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
          patrimonio_hoje_centavos: 123_000,
          tipo_grupo: "ACOES",
        },
      });

      const historico = await dashboardService.dadosHistorico();
      expect(historico.serieMensal).toHaveLength(1);
      expect(historico.serieMensal[0]).toMatchObject({
        sessaoImportId: sessao.id,
        mesReferencia: "2026-07",
        patrimonioTotalCentavos: 123_000,
      });
      expect(historico.sessoesSubstituidas).toHaveLength(0);
    });

    it("múltiplos aportes registrados no MESMO mes_referencia: aparecem como pontos SEPARADOS (não somados), ordenados por criado_em", async () => {
      const alvo = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 10000, vigencia_inicio: new Date("2026-01-01") },
      });
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });

      const linhaFn = (valorCentavos: number) =>
        JSON.stringify([
          { alvo_id: alvo.id, nome_alvo: "Ações BR", valor_centavos: valorCentavos, origem: "DEFICIT" },
        ]);

      await prisma.aporte.create({
        data: {
          sessao_import_id: sessao.id,
          valor_total_centavos: 50_000,
          valor_dividendos_centavos: 0,
          sugestao: linhaFn(50_000),
          executado: linhaFn(50_000),
          troco_centavos: 0,
          criado_em: new Date("2026-07-05"),
        },
      });
      await prisma.aporte.create({
        data: {
          sessao_import_id: sessao.id,
          valor_total_centavos: 30_000,
          valor_dividendos_centavos: 0,
          sugestao: linhaFn(30_000),
          executado: linhaFn(30_000),
          troco_centavos: 0,
          criado_em: new Date("2026-07-20"),
        },
      });

      const historico = await dashboardService.dadosHistorico();

      // Dois pontos separados (o serviço NÃO agrega aportes do mesmo mês) —
      // agregação, se desejada, é responsabilidade da UI (não coberta aqui).
      expect(historico.linhaDoTempoAportes).toHaveLength(2);
      expect(historico.linhaDoTempoAportes.every((p) => p.mesReferencia === "2026-07")).toBe(true);
      // Ordenados por criado_em como desempate dentro do mesmo mes_referencia.
      expect(historico.linhaDoTempoAportes.map((p) => p.valorTotalCentavos)).toEqual([50_000, 30_000]);
    });

    it("aporte cuja sessão foi SUBSTITUÍDA depois de registrado: continua na linha do tempo com o mes_referencia original da sessão amarrada", async () => {
      const alvo = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 10000, vigencia_inicio: new Date("2026-01-01") },
      });

      // Sessão de julho, na qual o aporte é calculado e registrado.
      const sessaoJulho = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-10"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoJulho.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 300_000,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvo.id, fora_da_carteira: false },
      });

      const linha = JSON.stringify([
        { alvo_id: alvo.id, nome_alvo: "Ações BR", valor_centavos: 100_000, origem: "DEFICIT" },
      ]);
      const aporte = await prisma.aporte.create({
        data: {
          sessao_import_id: sessaoJulho.id,
          valor_total_centavos: 100_000,
          valor_dividendos_centavos: 0,
          sugestao: linha,
          executado: linha,
          troco_centavos: 0,
          criado_em: new Date("2026-07-15"),
        },
      });

      // Um novo import do MESMO mês chega depois e substitui a sessão de julho
      // (fluxo real: re-import do mesmo mes_referencia marca a antiga como
      // SUBSTITUIDO) — o aporte permanece amarrado ao id da sessão antiga.
      await prisma.sessao_import.update({
        where: { id: sessaoJulho.id },
        data: { status: "SUBSTITUIDO" },
      });
      const sessaoJulhoNova = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú", "Nubank"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessaoJulhoNova.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 310_000,
          tipo_grupo: "ACOES",
        },
      });

      const historico = await dashboardService.dadosHistorico();

      // A sessão antiga (agora SUBSTITUIDO) some da série mensal e aparece na auditoria...
      expect(historico.serieMensal.map((p) => p.sessaoImportId)).toEqual([sessaoJulhoNova.id]);
      expect(historico.sessoesSubstituidas.map((s) => s.sessaoImportId)).toEqual([sessaoJulho.id]);
      // ...mas o aporte continua na linha do tempo, com o mes_referencia da
      // sessão original ("2026-07"), inalterado pela substituição.
      expect(historico.linhaDoTempoAportes).toHaveLength(1);
      expect(historico.linhaDoTempoAportes[0]).toMatchObject({
        aporteId: aporte.id,
        mesReferencia: "2026-07",
        sugeridoCentavos: 100_000,
        executadoCentavos: 100_000,
      });
    });
  });
});
