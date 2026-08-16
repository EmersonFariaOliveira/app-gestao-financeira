/**
 * tests/services/posicao-manual-service.test.ts — testes de integração (T005,
 * feature 002-posicoes-manuais-ajustes) de src/services/posicao-manual-service.ts
 * contra um SQLite TEMPORÁRIO, isolado do `data/app.db` real.
 *
 * Mesma estratégia de tests/services/mapeamento-service.test.ts e
 * tests/services/aporte-service.test.ts: `DATABASE_URL` aponta para um
 * arquivo `.db` temporário ANTES de importar `@/db/client`/
 * `@/services/posicao-manual-service` (imports dinâmicos dentro de
 * `beforeAll`), esquema aplicado via `prisma migrate deploy`.
 *
 * ESCRITO EM TDD (T005): `src/services/posicao-manual-service.ts` ainda NÃO
 * existe neste ponto do trabalho — este arquivo deve FALHAR ao rodar (import
 * dinâmico resolve o módulo, mas as funções chamadas são `undefined`), até
 * T007 implementar o serviço. Isso é o resultado esperado desta task.
 *
 * Casos cobertos (data-model.md, research.md R7/R8, contracts/server-actions.md
 * §posicoes-manuais.ts, contracts/motor-integracao.md §2.3):
 * - criarPosicaoManual: cria posicao_manual + posicao_manual_valor inicial na
 *   MESMA operação, anexado à sessão VIGENTE mais recente (research.md R7).
 * - criarPosicaoManual sem sessão VIGENTE: falha alto com a mesma mensagem já
 *   usada em aporte-service.ts (motor-integracao.md §2.3).
 * - editarPosicaoManual: só campos cadastrais (instituicao/descricao/alvoId);
 *   nunca cria/altera posicao_manual_valor.
 * - encerrarPosicaoManual: ativo:true -> false, irreversível (transição de
 *   estado testada aqui; "some do carry-forward" fica para T018/T019).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let posicaoManualService: typeof import("@/services/posicao-manual-service");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posicao-manual-service-test-"));
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
  // Import dinâmico do módulo alvo desta task — ainda não existe em disco no
  // momento em que T005 é escrita (TDD); espera-se falha na resolução do
  // módulo ou em `posicaoManualService.criarPosicaoManual is not a function`.
  posicaoManualService = await import("@/services/posicao-manual-service");
}, 30_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Limpa todas as tabelas (ordem respeita FKs, igual a prisma/seed.ts). */
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
});

async function criarAlvo(nome: string, percentualBps: number) {
  return prisma.alvo.create({
    data: { nome, percentual_alvo_bps: percentualBps, vigencia_inicio: new Date("2026-01-01") },
  });
}

/** Cria uma sessao_import (mesmo padrão de tests/services/mapeamento-service.test.ts). */
async function criarSessao(mesReferencia: string, dataExport: string, status = "VIGENTE") {
  return prisma.sessao_import.create({
    data: {
      mes_referencia: mesReferencia,
      data_export: new Date(dataExport),
      status,
      instituicoes: JSON.stringify(["Itaú"]),
    },
  });
}

describe("posicao-manual-service", () => {
  describe("criarPosicaoManual", () => {
    it("cria a posicao_manual e anexa um posicao_manual_valor inicial à sessão VIGENTE existente (research.md R7)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");

      const resultado = await posicaoManualService.criarPosicaoManual({
        chaveManual: "CDB-ITAU-2029",
        instituicao: "Itaú",
        descricao: "CDB Itaú 120% CDI 2029",
        alvoId: alvo.id,
        valorInvestidoCentavos: 500_000,
        valorAtualCentavos: 520_000,
      });

      expect(resultado.chaveManual).toBe("CDB-ITAU-2029");
      expect(resultado.instituicao).toBe("Itaú");
      expect(resultado.descricao).toBe("CDB Itaú 120% CDI 2029");
      expect(resultado.alvoId).toBe(alvo.id);
      expect(resultado.ativo).toBe(true);

      const posicaoManualNoBanco = await prisma.posicao_manual.findUniqueOrThrow({
        where: { chave_manual: "CDB-ITAU-2029" },
      });
      expect(posicaoManualNoBanco.alvo_id).toBe(alvo.id);
      expect(posicaoManualNoBanco.ativo).toBe(true);

      const snapshot = await prisma.posicao_manual_valor.findUnique({
        where: {
          posicao_manual_id_sessao_import_id: {
            posicao_manual_id: posicaoManualNoBanco.id,
            sessao_import_id: sessao.id,
          },
        },
      });
      expect(snapshot).not.toBeNull();
      expect(snapshot?.valor_investido_centavos).toBe(500_000);
      expect(snapshot?.valor_atual_centavos).toBe(520_000);

      // Exatamente um snapshot criado — nenhuma sessão "fantasma" gerada.
      expect(await prisma.posicao_manual_valor.count()).toBe(1);
    });

    it("valores monetários gravados sempre como Int (centavos), nunca float", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      await criarSessao("2026-07", "2026-07-28", "VIGENTE");

      await posicaoManualService.criarPosicaoManual({
        chaveManual: "CDB-SANTANDER-2030",
        instituicao: "Santander",
        descricao: "CDB Santander 110% CDI 2030",
        alvoId: alvo.id,
        valorInvestidoCentavos: 123_456,
        valorAtualCentavos: 130_000,
      });

      const snapshot = await prisma.posicao_manual_valor.findFirstOrThrow({
        where: { posicao_manual: { chave_manual: "CDB-SANTANDER-2030" } },
      });
      expect(Number.isInteger(snapshot.valor_investido_centavos)).toBe(true);
      expect(Number.isInteger(snapshot.valor_atual_centavos)).toBe(true);
    });

    it("usa a sessão VIGENTE mais recente, ignorando sessões SUBSTITUIDO", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessaoAntiga = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
      const sessaoAtual = await criarSessao("2026-07", "2026-07-28", "VIGENTE");

      const resultado = await posicaoManualService.criarPosicaoManual({
        chaveManual: "CDB-ITAU-2029",
        instituicao: "Itaú",
        descricao: "CDB Itaú 120% CDI 2029",
        alvoId: alvo.id,
        valorInvestidoCentavos: 500_000,
        valorAtualCentavos: 520_000,
      });

      const posicaoManualNoBanco = await prisma.posicao_manual.findUniqueOrThrow({
        where: { chave_manual: resultado.chaveManual },
      });

      const snapshotNaAtual = await prisma.posicao_manual_valor.findUnique({
        where: {
          posicao_manual_id_sessao_import_id: {
            posicao_manual_id: posicaoManualNoBanco.id,
            sessao_import_id: sessaoAtual.id,
          },
        },
      });
      const snapshotNaAntiga = await prisma.posicao_manual_valor.findUnique({
        where: {
          posicao_manual_id_sessao_import_id: {
            posicao_manual_id: posicaoManualNoBanco.id,
            sessao_import_id: sessaoAntiga.id,
          },
        },
      });

      expect(snapshotNaAtual).not.toBeNull();
      expect(snapshotNaAntiga).toBeNull();
    });

    it("falha alto (fail loud) sem NENHUMA sessão de import ainda criada — mesma mensagem de aporte-service.ts", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);

      await expect(
        posicaoManualService.criarPosicaoManual({
          chaveManual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvoId: alvo.id,
          valorInvestidoCentavos: 500_000,
          valorAtualCentavos: 520_000,
        }),
      ).rejects.toThrow(
        "Nenhuma sessão de import VIGENTE encontrada — realize um import antes de calcular o aporte.",
      );

      // Fail loud: nenhum registro parcial deve ter sido criado.
      expect(await prisma.posicao_manual.count()).toBe(0);
      expect(await prisma.posicao_manual_valor.count()).toBe(0);
    });

    it("falha alto quando só existem sessões SUBSTITUIDO (nenhuma VIGENTE)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");

      await expect(
        posicaoManualService.criarPosicaoManual({
          chaveManual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvoId: alvo.id,
          valorInvestidoCentavos: 500_000,
          valorAtualCentavos: 520_000,
        }),
      ).rejects.toThrow(
        "Nenhuma sessão de import VIGENTE encontrada — realize um import antes de calcular o aporte.",
      );

      expect(await prisma.posicao_manual.count()).toBe(0);
    });
  });

  describe("editarPosicaoManual", () => {
    async function criarPosicaoManualComSnapshot(alvoId: string, sessaoId: string) {
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          alvo_id: alvoId,
          descricao: "CDB Itaú 120% CDI 2029",
          ativo: true,
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManual.id,
          sessao_import_id: sessaoId,
          valor_investido_centavos: 500_000,
          valor_atual_centavos: 520_000,
        },
      });
      return posicaoManual;
    }

    it("atualiza apenas campos cadastrais (instituicao, descricao, alvoId)", async () => {
      const alvoOriginal = await criarAlvo("Pós-fixado", 3000);
      const alvoNovo = await criarAlvo("Tesouro IPCA+", 2000);
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      const posicaoManual = await criarPosicaoManualComSnapshot(alvoOriginal.id, sessao.id);

      const resultado = await posicaoManualService.editarPosicaoManual({
        posicaoManualId: posicaoManual.id,
        instituicao: "Nubank",
        descricao: "CDB Itaú 120% CDI 2029 (renegociado)",
        alvoId: alvoNovo.id,
      });

      expect(resultado.instituicao).toBe("Nubank");
      expect(resultado.descricao).toBe("CDB Itaú 120% CDI 2029 (renegociado)");
      expect(resultado.alvoId).toBe(alvoNovo.id);

      const noBanco = await prisma.posicao_manual.findUniqueOrThrow({
        where: { id: posicaoManual.id },
      });
      expect(noBanco.instituicao).toBe("Nubank");
      expect(noBanco.descricao).toBe("CDB Itaú 120% CDI 2029 (renegociado)");
      expect(noBanco.alvo_id).toBe(alvoNovo.id);
      // chave_manual é imutável — nunca alterada por editarPosicaoManual.
      expect(noBanco.chave_manual).toBe("CDB-ITAU-2029");
    });

    it("NÃO cria nem altera nenhum posicao_manual_valor", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      const posicaoManual = await criarPosicaoManualComSnapshot(alvo.id, sessao.id);

      const antes = await prisma.posicao_manual_valor.findMany();
      expect(antes).toHaveLength(1);

      await posicaoManualService.editarPosicaoManual({
        posicaoManualId: posicaoManual.id,
        descricao: "Nova descrição",
      });

      const depois = await prisma.posicao_manual_valor.findMany();
      expect(depois).toHaveLength(1);
      expect(depois[0].valor_investido_centavos).toBe(antes[0].valor_investido_centavos);
      expect(depois[0].valor_atual_centavos).toBe(antes[0].valor_atual_centavos);
      expect(depois[0].criado_em).toEqual(antes[0].criado_em);
    });

    it("permite editar um subconjunto dos campos (parcial), preservando os demais", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      const posicaoManual = await criarPosicaoManualComSnapshot(alvo.id, sessao.id);

      await posicaoManualService.editarPosicaoManual({
        posicaoManualId: posicaoManual.id,
        instituicao: "Nubank",
      });

      const noBanco = await prisma.posicao_manual.findUniqueOrThrow({
        where: { id: posicaoManual.id },
      });
      expect(noBanco.instituicao).toBe("Nubank");
      // descricao/alvo_id não informados — permanecem como estavam.
      expect(noBanco.descricao).toBe("CDB Itaú 120% CDI 2029");
      expect(noBanco.alvo_id).toBe(alvo.id);
    });
  });

  describe("encerrarPosicaoManual", () => {
    it("marca ativo:true -> false", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          alvo_id: alvo.id,
          descricao: "CDB Itaú 120% CDI 2029",
          ativo: true,
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManual.id,
          sessao_import_id: sessao.id,
          valor_investido_centavos: 500_000,
          valor_atual_centavos: 520_000,
        },
      });

      const resultado = await posicaoManualService.encerrarPosicaoManual({
        posicaoManualId: posicaoManual.id,
      });

      expect(resultado.ativo).toBe(false);

      const noBanco = await prisma.posicao_manual.findUniqueOrThrow({
        where: { id: posicaoManual.id },
      });
      expect(noBanco.ativo).toBe(false);

      // Histórico preservado — encerrar não apaga snapshots anteriores.
      expect(
        await prisma.posicao_manual_valor.count({ where: { posicao_manual_id: posicaoManual.id } }),
      ).toBe(1);
    });

    it("é irreversível: não existe função para reverter, e uma segunda chamada mantém ativo:false", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          alvo_id: alvo.id,
          descricao: "CDB Itaú 120% CDI 2029",
          ativo: true,
        },
      });

      await posicaoManualService.encerrarPosicaoManual({ posicaoManualId: posicaoManual.id });
      // Não há "ativarPosicaoManual" no serviço (Assumption do spec.md) — a
      // única forma de "desfazer" seria chamar encerrar de novo, que deve
      // ser um no-op seguro (idempotente), nunca reativar.
      const segundaChamada = await posicaoManualService.encerrarPosicaoManual({
        posicaoManualId: posicaoManual.id,
      });

      expect(segundaChamada.ativo).toBe(false);
      const noBanco = await prisma.posicao_manual.findUniqueOrThrow({
        where: { id: posicaoManual.id },
      });
      expect(noBanco.ativo).toBe(false);
      expect((posicaoManualService as Record<string, unknown>).ativarPosicaoManual).toBeUndefined();
    });

    // Nota (T005): "some do carry-forward" (posição encerrada não aparece
    // mais na pré-visualização/consumo de posicao-manual-service para novas
    // sessões) é coberto por T018/T019 (carry-forward), quando a função de
    // montagem de posicoesManuaisRevisao existir. Aqui validamos apenas a
    // transição de estado em si, conforme escopo desta task.
  });
});
