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

/**
 * Cria um `aporte` mínimo (T024) — proveniência obrigatória
 * (`aporte_id`, onDelete Restrict) de `incremento_valor_investido_pendente`.
 * Conteúdo de `sugestao`/`executado` é irrelevante para estes testes
 * (T024 não testa o algoritmo de geração — isso é T023, em
 * tests/services/aporte-service.test.ts); usa-se um JSON vazio de
 * placeholder.
 */
async function criarAporteParaTeste(sessaoId: string, valorTotalCentavos = 100_000) {
  return prisma.aporte.create({
    data: {
      sessao_import_id: sessaoId,
      valor_total_centavos: valorTotalCentavos,
      valor_dividendos_centavos: 0,
      sugestao: "[]",
      executado: "[]",
      troco_centavos: 0,
    },
  });
}

/**
 * Cria uma linha `incremento_valor_investido_pendente` diretamente via
 * Prisma (T024 é TDD sobre o CONSUMO — a geração, feita por
 * `registrarAporte`, é T025/T023, ainda não implementada; aqui simulamos o
 * estado de banco que T025 deveria produzir).
 */
async function criarPendenciaIncremento(input: {
  alvoId: string;
  aporteId: string;
  valorIncrementoCentavos: number;
  chaveExport?: string | null;
  posicaoManualId?: string | null;
  aplicado?: boolean;
  sessaoAplicacaoId?: string | null;
}) {
  return prisma.incremento_valor_investido_pendente.create({
    data: {
      alvo_id: input.alvoId,
      aporte_id: input.aporteId,
      valor_incremento_centavos: input.valorIncrementoCentavos,
      chave_export: input.chaveExport ?? null,
      posicao_manual_id: input.posicaoManualId ?? null,
      aplicado: input.aplicado ?? false,
      sessao_aplicacao_id: input.sessaoAplicacaoId ?? null,
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

  // T013 (User Story 2, FR-005/FR-009/FR-006): `criarOuAtualizarAjuste` ainda
  // NÃO existe em src/services/posicao-manual-service.ts neste ponto (T015 é
  // quem implementa) — os testes abaixo devem FALHAR agora (TDD), sem quebrar
  // os testes de criarPosicaoManual/editarPosicaoManual/encerrarPosicaoManual
  // acima (T005/T007, já implementados).
  describe("criarOuAtualizarAjuste", () => {
    async function criarAtivoMapeado(chaveExport: string, alvoId: string) {
      return prisma.ativo_mapeado.create({
        data: { chave_export: chaveExport, alvo_id: alvoId },
      });
    }

    it("cria um ajuste_valor_investido associado à sessão VIGENTE mais recente (FR-005)", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      await criarAtivoMapeado("FUNDO-XPTO", alvo.id);

      const resultado = await posicaoManualService.criarOuAtualizarAjuste({
        chaveExport: "FUNDO-XPTO",
        valorInvestidoCentavosCorrigido: 300_000,
      });

      expect(resultado.chaveExport).toBe("FUNDO-XPTO");
      expect(resultado.valorInvestidoCentavosCorrigido).toBe(300_000);

      const noBanco = await prisma.ajuste_valor_investido.findUnique({
        where: {
          chave_export_sessao_import_id: {
            chave_export: "FUNDO-XPTO",
            sessao_import_id: sessao.id,
          },
        },
      });
      expect(noBanco).not.toBeNull();
      expect(noBanco?.valor_investido_corrigido_centavos).toBe(300_000);
      expect(Number.isInteger(noBanco?.valor_investido_corrigido_centavos)).toBe(true);

      // Exatamente um snapshot criado — nenhuma linha "fantasma" gerada.
      expect(await prisma.ajuste_valor_investido.count()).toBe(1);
    });

    it("chamar de novo para o mesmo chaveExport NA MESMA sessão vigente ATUALIZA (não duplica) — @@unique([chave_export, sessao_import_id])", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      await criarAtivoMapeado("FUNDO-XPTO", alvo.id);

      await posicaoManualService.criarOuAtualizarAjuste({
        chaveExport: "FUNDO-XPTO",
        valorInvestidoCentavosCorrigido: 300_000,
      });
      const segundaChamada = await posicaoManualService.criarOuAtualizarAjuste({
        chaveExport: "FUNDO-XPTO",
        valorInvestidoCentavosCorrigido: 350_000,
      });

      expect(segundaChamada.valorInvestidoCentavosCorrigido).toBe(350_000);

      // Nenhuma duplicata — continua havendo só uma linha para este par
      // (chave_export, sessao_import_id).
      expect(
        await prisma.ajuste_valor_investido.count({
          where: { chave_export: "FUNDO-XPTO", sessao_import_id: sessao.id },
        }),
      ).toBe(1);

      const noBanco = await prisma.ajuste_valor_investido.findUnique({
        where: {
          chave_export_sessao_import_id: {
            chave_export: "FUNDO-XPTO",
            sessao_import_id: sessao.id,
          },
        },
      });
      expect(noBanco?.valor_investido_corrigido_centavos).toBe(350_000);
    });

    it("usa a sessão VIGENTE mais recente, ignorando sessões SUBSTITUIDO", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      const sessaoAntiga = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
      const sessaoAtual = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      await criarAtivoMapeado("FUNDO-XPTO", alvo.id);

      await posicaoManualService.criarOuAtualizarAjuste({
        chaveExport: "FUNDO-XPTO",
        valorInvestidoCentavosCorrigido: 300_000,
      });

      const naAtual = await prisma.ajuste_valor_investido.findUnique({
        where: {
          chave_export_sessao_import_id: {
            chave_export: "FUNDO-XPTO",
            sessao_import_id: sessaoAtual.id,
          },
        },
      });
      const naAntiga = await prisma.ajuste_valor_investido.findUnique({
        where: {
          chave_export_sessao_import_id: {
            chave_export: "FUNDO-XPTO",
            sessao_import_id: sessaoAntiga.id,
          },
        },
      });

      expect(naAtual).not.toBeNull();
      expect(naAntiga).toBeNull();
    });

    it("NUNCA toca posicao.patrimonio_hoje_centavos (valor_atual) — FR-006", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      await criarAtivoMapeado("FUNDO-XPTO", alvo.id);
      const posicaoCsv = await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "FUNDO-XPTO",
          instituicao: "XP",
          quantidade: "100",
          patrimonio_hoje_centavos: 400_000,
          tipo_grupo: "FUNDO",
        },
      });

      await posicaoManualService.criarOuAtualizarAjuste({
        chaveExport: "FUNDO-XPTO",
        valorInvestidoCentavosCorrigido: 300_000,
      });

      const posicaoDepois = await prisma.posicao.findUniqueOrThrow({
        where: { id: posicaoCsv.id },
      });
      expect(posicaoDepois.patrimonio_hoje_centavos).toBe(400_000);

      // Chamar novamente com outro valor corrigido — continua sem tocar
      // valor_atual/patrimonio_hoje_centavos.
      await posicaoManualService.criarOuAtualizarAjuste({
        chaveExport: "FUNDO-XPTO",
        valorInvestidoCentavosCorrigido: 999_999,
      });
      const posicaoDepoisDaSegunda = await prisma.posicao.findUniqueOrThrow({
        where: { id: posicaoCsv.id },
      });
      expect(posicaoDepoisDaSegunda.patrimonio_hoje_centavos).toBe(400_000);
    });

    it("primeira vez (sem chamada ainda): não existe nenhum ajuste_valor_investido para o chave_export — FR-009", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      await criarAtivoMapeado("FUNDO-XPTO", alvo.id);

      // Sem chamar criarOuAtualizarAjuste ainda — valida diretamente contra o
      // banco que "primeira vez" (FR-009) significa "nenhum registro" (o
      // conceito de valorInvestidoCorrigido: null é responsabilidade de uma
      // função de LEITURA fora do escopo desta task — T019/listarPosicoesManuaisEAjustes).
      const existente = await prisma.ajuste_valor_investido.findFirst({
        where: { chave_export: "FUNDO-XPTO" },
      });
      expect(existente).toBeNull();
    });

    it("falha alto (fail loud) sem NENHUMA sessão de import VIGENTE — mesma mensagem de criarPosicaoManual/aporte-service.ts", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      await criarAtivoMapeado("FUNDO-XPTO", alvo.id);

      await expect(
        posicaoManualService.criarOuAtualizarAjuste({
          chaveExport: "FUNDO-XPTO",
          valorInvestidoCentavosCorrigido: 300_000,
        }),
      ).rejects.toThrow(
        "Nenhuma sessão de import VIGENTE encontrada — realize um import antes de calcular o aporte.",
      );

      expect(await prisma.ajuste_valor_investido.count()).toBe(0);
    });

    it("falha alto quando só existem sessões SUBSTITUIDO (nenhuma VIGENTE)", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
      await criarAtivoMapeado("FUNDO-XPTO", alvo.id);

      await expect(
        posicaoManualService.criarOuAtualizarAjuste({
          chaveExport: "FUNDO-XPTO",
          valorInvestidoCentavosCorrigido: 300_000,
        }),
      ).rejects.toThrow(
        "Nenhuma sessão de import VIGENTE encontrada — realize um import antes de calcular o aporte.",
      );

      expect(await prisma.ajuste_valor_investido.count()).toBe(0);
    });
  });

  // T017 (User Story 2, 6.9): listarAjustesAtivos — leitura para a tela
  // dedicada, fora do fluxo de import. "Sob ajuste" = existe pelo menos um
  // ajuste_valor_investido histórico E o ativo_mapeado correspondente ainda
  // está vinculado a um alvo ativo (alvo_id != null, fora_da_carteira=false,
  // ignorar_no_import=false) — condição derivada de data-model.md.
  describe("listarAjustesAtivos", () => {
    async function criarAtivoMapeado(
      chaveExport: string,
      overrides: {
        alvoId?: string | null;
        foraDaCarteira?: boolean;
        ignorarNoImport?: boolean;
      } = {},
    ) {
      return prisma.ativo_mapeado.create({
        data: {
          chave_export: chaveExport,
          alvo_id: overrides.alvoId === undefined ? null : overrides.alvoId,
          fora_da_carteira: overrides.foraDaCarteira ?? false,
          ignorar_no_import: overrides.ignorarNoImport ?? false,
        },
      });
    }

    it("retorna [] quando não há nenhum ajuste_valor_investido", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      await criarAtivoMapeado("FUNDO-XPTO", { alvoId: alvo.id });

      const resultado = await posicaoManualService.listarAjustesAtivos();

      expect(resultado).toEqual([]);
    });

    it("agrupa por chave_export mantendo só o valor mais recente quando há múltiplos ajustes em sessões diferentes", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      const sessaoAntiga = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
      const sessaoRecente = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      await criarAtivoMapeado("FUNDO-XPTO", { alvoId: alvo.id });

      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "FUNDO-XPTO",
          sessao_import_id: sessaoAntiga.id,
          valor_investido_corrigido_centavos: 100_000,
        },
      });
      // criado_em depende da ordem de inserção (default now()); o segundo
      // registro criado é o mais recente, independentemente do status da
      // sessão a que está associado.
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "FUNDO-XPTO",
          sessao_import_id: sessaoRecente.id,
          valor_investido_corrigido_centavos: 350_000,
        },
      });

      const resultado = await posicaoManualService.listarAjustesAtivos();

      expect(resultado).toHaveLength(1);
      expect(resultado[0]).toMatchObject({
        chaveExport: "FUNDO-XPTO",
        alvoId: alvo.id,
        valorInvestidoCentavosCorrigido: 350_000,
      });
    });

    it("exclui chave_export cujo ativo_mapeado tem alvo_id IS NULL", async () => {
      await criarAtivoMapeado("FUNDO-SEM-ALVO", { alvoId: null });
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "FUNDO-SEM-ALVO",
          sessao_import_id: sessao.id,
          valor_investido_corrigido_centavos: 100_000,
        },
      });

      const resultado = await posicaoManualService.listarAjustesAtivos();

      expect(resultado).toEqual([]);
    });

    it("exclui chave_export cujo ativo_mapeado está fora_da_carteira=true", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      await criarAtivoMapeado("FUNDO-FORA", { alvoId: alvo.id, foraDaCarteira: true });
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "FUNDO-FORA",
          sessao_import_id: sessao.id,
          valor_investido_corrigido_centavos: 100_000,
        },
      });

      const resultado = await posicaoManualService.listarAjustesAtivos();

      expect(resultado).toEqual([]);
    });

    it("exclui chave_export cujo ativo_mapeado está ignorar_no_import=true", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      await criarAtivoMapeado("FUNDO-IGNORADO", { alvoId: alvo.id, ignorarNoImport: true });
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "FUNDO-IGNORADO",
          sessao_import_id: sessao.id,
          valor_investido_corrigido_centavos: 100_000,
        },
      });

      const resultado = await posicaoManualService.listarAjustesAtivos();

      expect(resultado).toEqual([]);
    });

    it("mistura chaves válidas e excluídas, retornando apenas a válida com o nome do alvo", async () => {
      const alvo = await criarAlvo("Fundos Imobiliários", 1500);
      await criarAtivoMapeado("FUNDO-VALIDO", { alvoId: alvo.id });
      await criarAtivoMapeado("FUNDO-FORA-CARTEIRA", { alvoId: alvo.id, foraDaCarteira: true });
      await criarAtivoMapeado("FUNDO-SEM-ALVO", { alvoId: null });
      const sessao = await criarSessao("2026-07", "2026-07-28", "VIGENTE");

      for (const chave of ["FUNDO-VALIDO", "FUNDO-FORA-CARTEIRA", "FUNDO-SEM-ALVO"]) {
        await prisma.ajuste_valor_investido.create({
          data: {
            chave_export: chave,
            sessao_import_id: sessao.id,
            valor_investido_corrigido_centavos: 200_000,
          },
        });
      }

      const resultado = await posicaoManualService.listarAjustesAtivos();

      expect(resultado).toHaveLength(1);
      expect(resultado[0]).toEqual({
        chaveExport: "FUNDO-VALIDO",
        alvoId: alvo.id,
        nomeAlvo: "Fundos Imobiliários",
        valorInvestidoCentavosCorrigido: 200_000,
      });
    });
  });

  // ---------------------------------------------------------------------
  // T018 (User Story 3, FR-007/FR-008/FR-009, data-model.md "Fluxo técnico
  // (carry-forward + consumo de incremento pendente)" passos 1-2,
  // research.md R6/R7, contracts/server-actions.md §import.ts campos
  // `posicoesManuaisRevisao`/`ajustesRevisao`).
  //
  // `montarRevisaoImport` ainda NÃO existe em
  // src/services/posicao-manual-service.ts neste ponto (T019 é quem
  // implementa) — os testes abaixo devem FALHAR agora (TDD), sem quebrar
  // nenhum dos testes já existentes acima (T005/T007, T013/T015, T017).
  //
  // Shape escolhido para T019 implementar EXATAMENTE isso (mesmo nome de
  // função e mesmo formato de retorno usados nestes testes):
  //
  //   async function montarRevisaoImport(): Promise<{
  //     posicoesManuaisRevisao: {
  //       posicaoManualId: string;
  //       chaveManual: string;
  //       instituicao: string;
  //       descricao: string;
  //       alvoId: string;
  //       nomeAlvo: string;
  //       valorInvestidoCentavosAnterior: number;    // 0 se não houver snapshot anterior
  //       incrementoPendenteCentavos: number;         // sempre 0 nesta fase (US4/T023-T026 ainda
  //                                                     // não implementados); campo mantido no
  //                                                     // shape só para casar com
  //                                                     // contracts/server-actions.md sem quebrar
  //                                                     // quando US4 existir
  //       valorInvestidoCentavosSugerido: number;     // = Anterior + incrementoPendente (= Anterior, por ora)
  //       valorAtualCentavosSugerido: number;         // = valor_atual do snapshot anterior; 0 se não houver
  //     }[];
  //     ajustesRevisao: {
  //       chaveExport: string;
  //       alvoId: string | null;
  //       nomeAlvo: string | null;
  //       primeiraVez: boolean;                        // true = nenhum valor preenchido ainda (FR-009)
  //       valorInvestidoCentavosAnterior: number | null; // null quando primeiraVez
  //       incrementoPendenteCentavos: number;           // sempre 0 nesta fase (mesmo racional acima)
  //       valorInvestidoCentavosSugerido: number | null; // null quando primeiraVez
  //     }[];
  //   }>
  //
  // Decisões de design tomadas para fechar detalhes que o data-model.md/
  // contracts deixam implícitos ou de leitura (sem inventar regra de negócio
  // nova — só resolvendo "qual consulta exata roda"):
  //
  // 1. SEM argumentos: a "sessão de referência" (data-model.md, Fluxo
  //    técnico, passo 1) é resolvida internamente, a cada chamada, como a
  //    sessão VIGENTE mais recente por (data_export DESC, criado_em DESC) —
  //    mesma query de obterSessaoVigenteMaisRecente() já usada neste
  //    arquivo. Não recebe "nova sessão" como parâmetro porque a sessão do
  //    import em andamento ainda NÃO existe no banco no momento em que a
  //    revisão é montada (tudo em memória até confirmarImport — mesmo
  //    padrão de previewImport da feature 001).
  // 2. Carry-forward por ENTIDADE, não estritamente pela sessão de
  //    referência: para cada posicao_manual/chave_export, usa-se o
  //    snapshot/ajuste mais recente conhecido (por criado_em), mesmo que não
  //    exista nenhum snapshot na sessão VIGENTE mais recente em si (ex.:
  //    import intermediário em que a posição não foi tocada — "mês
  //    pulado"). Consistente com o comportamento já implementado em
  //    listarPosicoesManuaisAtivas/listarAjustesAtivos neste mesmo arquivo.
  // 3. `incrementoPendenteCentavos` sempre 0 nesta fase — a elegibilidade e
  //    soma de `incremento_valor_investido_pendente` é escopo de US4
  //    (T023-T026, fora do escopo de T018/T019); o campo já existe no shape
  //    hoje só para não quebrar o contrato quando US4 for implementada
  //    (T026 passa a somar um valor != 0 aqui).
  // 4. `primeiraVez` (ajustesRevisao) reflete o estado do BANCO: `true`
  //    quando o `ajuste_valor_investido` mais recente daquele chave_export
  //    tem `valor_investido_corrigido_centavos = null` (schema permite null
  //    explicitamente para esse caso — data-model.md, FR-009). Uma
  //    chave_export sem NENHUMA linha `ajuste_valor_investido` não aparece
  //    em `ajustesRevisao` — não está "sob ajuste" (mesma condição
  //    derivada já usada por `listarAjustesAtivos`).
  // ---------------------------------------------------------------------
  describe("montarRevisaoImport", () => {
    async function criarAtivoMapeadoComAlvo(chaveExport: string, alvoId: string | null) {
      return prisma.ativo_mapeado.create({
        data: { chave_export: chaveExport, alvo_id: alvoId },
      });
    }

    async function criarPosicaoManualAtiva(alvoId: string, chaveManual: string, ativo = true) {
      return prisma.posicao_manual.create({
        data: {
          chave_manual: chaveManual,
          instituicao: "Itaú",
          descricao: `Descrição ${chaveManual}`,
          alvo_id: alvoId,
          ativo,
        },
      });
    }

    async function criarSnapshot(
      posicaoManualId: string,
      sessaoId: string,
      investidoCentavos: number,
      atualCentavos: number,
    ) {
      return prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManualId,
          sessao_import_id: sessaoId,
          valor_investido_centavos: investidoCentavos,
          valor_atual_centavos: atualCentavos,
        },
      });
    }

    async function criarAjuste(
      chaveExport: string,
      sessaoId: string,
      valorCorrigidoCentavos: number | null,
    ) {
      return prisma.ajuste_valor_investido.create({
        data: {
          chave_export: chaveExport,
          sessao_import_id: sessaoId,
          valor_investido_corrigido_centavos: valorCorrigidoCentavos,
        },
      });
    }

    it("pré-preenche posicoesManuaisRevisao a partir do snapshot da sessão VIGENTE mais recente (não a mais antiga, não uma SUBSTITUIDO)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessaoAntiga = await criarSessao("2026-05", "2026-05-28", "SUBSTITUIDO");
      const sessaoAtual = await criarSessao("2026-06", "2026-06-28", "VIGENTE");
      const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029");
      await criarSnapshot(posicaoManual.id, sessaoAntiga.id, 400_000, 410_000);
      await criarSnapshot(posicaoManual.id, sessaoAtual.id, 500_000, 520_000);

      const revisao = await posicaoManualService.montarRevisaoImport();

      expect(revisao.posicoesManuaisRevisao).toHaveLength(1);
      expect(revisao.posicoesManuaisRevisao[0]).toMatchObject({
        posicaoManualId: posicaoManual.id,
        chaveManual: "CDB-ITAU-2029",
        alvoId: alvo.id,
        nomeAlvo: "Pós-fixado",
        valorInvestidoCentavosAnterior: 500_000,
        incrementoPendenteCentavos: 0,
        valorInvestidoCentavosSugerido: 500_000,
        valorAtualCentavosSugerido: 520_000,
      });
    });

    it("pré-preenche ajustesRevisao a partir do ajuste_valor_investido mais recente, não de uma sessão SUBSTITUIDO antiga", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      const sessaoAntiga = await criarSessao("2026-05", "2026-05-28", "SUBSTITUIDO");
      const sessaoAtual = await criarSessao("2026-06", "2026-06-28", "VIGENTE");
      await criarAtivoMapeadoComAlvo("FUNDO-XPTO", alvo.id);
      await criarAjuste("FUNDO-XPTO", sessaoAntiga.id, 100_000);
      await criarAjuste("FUNDO-XPTO", sessaoAtual.id, 350_000);

      const revisao = await posicaoManualService.montarRevisaoImport();

      expect(revisao.ajustesRevisao).toHaveLength(1);
      expect(revisao.ajustesRevisao[0]).toMatchObject({
        chaveExport: "FUNDO-XPTO",
        alvoId: alvo.id,
        nomeAlvo: "Fundos",
        primeiraVez: false,
        valorInvestidoCentavosAnterior: 350_000,
        incrementoPendenteCentavos: 0,
        valorInvestidoCentavosSugerido: 350_000,
      });
    });

    it("posição manual cujo snapshot mais recente é de uma sessão anterior à VIGENTE mais recente (import pulado) ainda usa o snapshot mais recente disponível", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessaoDoisImportsAtras = await criarSessao("2026-04", "2026-04-28", "SUBSTITUIDO");
      // Sessão do "meio": a posição manual não recebeu snapshot novo nela —
      // cenário real de "mês pulado"/import em que ninguém revisou esta
      // posição.
      await criarSessao("2026-05", "2026-05-28", "SUBSTITUIDO");
      const sessaoVigenteMaisRecente = await criarSessao("2026-06", "2026-06-28", "VIGENTE");
      const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029");
      await criarSnapshot(posicaoManual.id, sessaoDoisImportsAtras.id, 300_000, 310_000);

      const revisao = await posicaoManualService.montarRevisaoImport();

      expect(revisao.posicoesManuaisRevisao).toHaveLength(1);
      expect(revisao.posicoesManuaisRevisao[0]).toMatchObject({
        valorInvestidoCentavosAnterior: 300_000,
        valorAtualCentavosSugerido: 310_000,
      });
      // A garantia testada aqui é "usa o snapshot mais recente disponível",
      // não "usa exatamente a sessão vigente mais recente" — confirma que a
      // sessão vigente mais recente é de fato distinta da sessão de origem
      // do snapshot usado.
      expect(sessaoVigenteMaisRecente.id).not.toBe(sessaoDoisImportsAtras.id);
    });

    it("ajuste cujo valor mais recente é de uma sessão anterior à VIGENTE mais recente (import pulado) ainda usa o valor mais recente disponível", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      const sessaoDoisImportsAtras = await criarSessao("2026-04", "2026-04-28", "SUBSTITUIDO");
      await criarSessao("2026-05", "2026-05-28", "SUBSTITUIDO");
      await criarSessao("2026-06", "2026-06-28", "VIGENTE");
      await criarAtivoMapeadoComAlvo("FUNDO-XPTO", alvo.id);
      await criarAjuste("FUNDO-XPTO", sessaoDoisImportsAtras.id, 275_000);

      const revisao = await posicaoManualService.montarRevisaoImport();

      expect(revisao.ajustesRevisao).toHaveLength(1);
      expect(revisao.ajustesRevisao[0]).toMatchObject({
        primeiraVez: false,
        valorInvestidoCentavosAnterior: 275_000,
        valorInvestidoCentavosSugerido: 275_000,
      });
    });

    it("primeira posição manual, sem NENHUMA sessão anterior (cadastrada fora do fluxo de import, sem posicao_manual_valor ainda) — não lança erro, valores vazios/zero", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      await criarSessao("2026-06", "2026-06-28", "VIGENTE");
      // Cadastro direto no banco, equivalente a `criarPosicaoManual` chamado
      // ANTES de existir qualquer sessão VIGENTE (Assumption do spec.md;
      // data-model.md "Fluxo técnico" passo 6): posicao_manual sem NENHUM
      // posicao_manual_valor associado ainda.
      const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-NOVO-SEM-SNAPSHOT");

      const revisao = await posicaoManualService.montarRevisaoImport();

      expect(revisao.posicoesManuaisRevisao).toHaveLength(1);
      expect(revisao.posicoesManuaisRevisao[0]).toMatchObject({
        posicaoManualId: posicaoManual.id,
        valorInvestidoCentavosAnterior: 0,
        incrementoPendenteCentavos: 0,
        valorInvestidoCentavosSugerido: 0,
        valorAtualCentavosSugerido: 0,
      });
    });

    it("primeiro ajuste, sem nenhum valor preenchido ainda (ajuste_valor_investido com valor null) — não lança erro, primeiraVez true e valores null", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      const sessao = await criarSessao("2026-06", "2026-06-28", "VIGENTE");
      await criarAtivoMapeadoComAlvo("FUNDO-NOVO", alvo.id);
      // Linha "sob ajuste" criada sem valor preenchido ainda — estado
      // suportado explicitamente pelo schema
      // (valor_investido_corrigido_centavos Int?, data-model.md/FR-009).
      // Criada direto no banco: `criarOuAtualizarAjuste` (T015) sempre exige
      // um valor numérico — este é o único jeito hoje de simular o estado
      // "primeira vez" persistido.
      await criarAjuste("FUNDO-NOVO", sessao.id, null);

      const revisao = await posicaoManualService.montarRevisaoImport();

      expect(revisao.ajustesRevisao).toHaveLength(1);
      expect(revisao.ajustesRevisao[0]).toMatchObject({
        chaveExport: "FUNDO-NOVO",
        primeiraVez: true,
        valorInvestidoCentavosAnterior: null,
        valorInvestidoCentavosSugerido: null,
      });
    });

    it("chave_export sem NENHUM ajuste_valor_investido não aparece em ajustesRevisao (não está 'sob ajuste')", async () => {
      const alvo = await criarAlvo("Fundos", 2000);
      await criarSessao("2026-06", "2026-06-28", "VIGENTE");
      await criarAtivoMapeadoComAlvo("FUNDO-SEM-AJUSTE", alvo.id);

      const revisao = await posicaoManualService.montarRevisaoImport();

      expect(revisao.ajustesRevisao).toEqual([]);
    });

    it("posição manual encerrada (ativo=false) não aparece em posicoesManuaisRevisao", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessao = await criarSessao("2026-06", "2026-06-28", "VIGENTE");
      const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-ENCERRADO", false);
      await criarSnapshot(posicaoManual.id, sessao.id, 100_000, 110_000);

      const revisao = await posicaoManualService.montarRevisaoImport();

      expect(revisao.posicoesManuaisRevisao).toEqual([]);
    });

    it("ajuste cujo ativo_mapeado foi desvinculado do alvo (alvo_id null) não aparece mais em ajustesRevisao (FR-015)", async () => {
      const sessao = await criarSessao("2026-06", "2026-06-28", "VIGENTE");
      await criarAtivoMapeadoComAlvo("FUNDO-DESVINCULADO", null);
      await criarAjuste("FUNDO-DESVINCULADO", sessao.id, 100_000);

      const revisao = await posicaoManualService.montarRevisaoImport();

      expect(revisao.ajustesRevisao).toEqual([]);
    });

    it("é puramente de leitura: nenhuma linha de sessao_import/posicao_manual/posicao_manual_valor/ajuste_valor_investido já existente sofre UPDATE, nem é criada linha nova", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessaoAntiga = await criarSessao("2026-05", "2026-05-28", "SUBSTITUIDO");
      const sessaoAtual = await criarSessao("2026-06", "2026-06-28", "VIGENTE");
      const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029");
      await criarSnapshot(posicaoManual.id, sessaoAntiga.id, 400_000, 410_000);
      await criarSnapshot(posicaoManual.id, sessaoAtual.id, 500_000, 520_000);
      await criarAtivoMapeadoComAlvo("FUNDO-XPTO", alvo.id);
      await criarAjuste("FUNDO-XPTO", sessaoAtual.id, 300_000);

      const snapshotsAntes = await prisma.posicao_manual_valor.findMany({ orderBy: { id: "asc" } });
      const ajustesAntes = await prisma.ajuste_valor_investido.findMany({ orderBy: { id: "asc" } });
      const sessoesAntes = await prisma.sessao_import.findMany({ orderBy: { id: "asc" } });
      const posicoesManuaisAntes = await prisma.posicao_manual.findMany({ orderBy: { id: "asc" } });

      await posicaoManualService.montarRevisaoImport();

      const snapshotsDepois = await prisma.posicao_manual_valor.findMany({ orderBy: { id: "asc" } });
      const ajustesDepois = await prisma.ajuste_valor_investido.findMany({ orderBy: { id: "asc" } });
      const sessoesDepois = await prisma.sessao_import.findMany({ orderBy: { id: "asc" } });
      const posicoesManuaisDepois = await prisma.posicao_manual.findMany({ orderBy: { id: "asc" } });

      expect(snapshotsDepois).toEqual(snapshotsAntes);
      expect(ajustesDepois).toEqual(ajustesAntes);
      expect(sessoesDepois).toEqual(sessoesAntes);
      expect(posicoesManuaisDepois).toEqual(posicoesManuaisAntes);
      // Nenhuma linha nova criada por uma chamada de leitura.
      expect(await prisma.sessao_import.count()).toBe(2);
      expect(await prisma.posicao_manual_valor.count()).toBe(2);
      expect(await prisma.ajuste_valor_investido.count()).toBe(1);
      expect(await prisma.posicao_manual.count()).toBe(1);
    });

    // -----------------------------------------------------------------
    // T024 (User Story 4, FR-008/FR-011/FR-013, contracts/motor-integracao.md
    // §4.1/§4.4, research.md R4/R5): consumo de
    // `incremento_valor_investido_pendente` em `montarRevisaoImport`.
    //
    // `incrementoPendenteCentavos` é, HOJE (antes de T026), sempre 0 —
    // hardcoded em src/services/posicao-manual-service.ts. Os testes abaixo
    // esperam a soma real de pendências não aplicadas e por isso devem
    // FALHAR até T026 estender `montarRevisaoImport` para consultar
    // `prisma.incremento_valor_investido_pendente`. TDD: escritos ANTES da
    // implementação — não implementar aqui (T026, fora do escopo desta task).
    //
    // Importante: `montarRevisaoImport` é função de LEITURA — nenhum destes
    // testes espera que ela marque `aplicado = true`. Essa transição é
    // escopo da função nova testada no describe
    // "marcarPendenciasComoAplicadas" logo abaixo (T026 a implementar).
    // -----------------------------------------------------------------
    describe("consumo de incremento_valor_investido_pendente (T024)", () => {
      it("soma 1 pendência não aplicada de posicao_manual ao valorInvestidoCentavosAnterior (motor-integracao.md §4.1)", async () => {
        const alvo = await criarAlvo("Pós-fixado", 3000);
        const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
        await criarSessao("2026-07", "2026-07-28", "VIGENTE");
        const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029");
        await criarSnapshot(posicaoManual.id, sessaoAnterior.id, 500_000, 520_000);
        const aporte = await criarAporteParaTeste(sessaoAnterior.id);
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporte.id,
          posicaoManualId: posicaoManual.id,
          valorIncrementoCentavos: 50_000,
        });

        const revisao = await posicaoManualService.montarRevisaoImport();

        expect(revisao.posicoesManuaisRevisao).toHaveLength(1);
        expect(revisao.posicoesManuaisRevisao[0]).toMatchObject({
          valorInvestidoCentavosAnterior: 500_000,
          incrementoPendenteCentavos: 50_000,
          valorInvestidoCentavosSugerido: 550_000,
        });
      });

      it("soma 1 pendência não aplicada de ajuste (chave_export) ao valorInvestidoCentavosAnterior (motor-integracao.md §4.1)", async () => {
        const alvo = await criarAlvo("Fundos", 2000);
        const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
        await criarSessao("2026-07", "2026-07-28", "VIGENTE");
        await criarAtivoMapeadoComAlvo("FUNDO-XPTO", alvo.id);
        await criarAjuste("FUNDO-XPTO", sessaoAnterior.id, 300_000);
        const aporte = await criarAporteParaTeste(sessaoAnterior.id);
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporte.id,
          chaveExport: "FUNDO-XPTO",
          valorIncrementoCentavos: 25_000,
        });

        const revisao = await posicaoManualService.montarRevisaoImport();

        expect(revisao.ajustesRevisao).toHaveLength(1);
        expect(revisao.ajustesRevisao[0]).toMatchObject({
          valorInvestidoCentavosAnterior: 300_000,
          incrementoPendenteCentavos: 25_000,
          valorInvestidoCentavosSugerido: 325_000,
        });
      });

      it("soma MÚLTIPLAS pendências não aplicadas da MESMA posicao_manual juntas — nenhuma é descartada (2 aportes antes do próximo import)", async () => {
        const alvo = await criarAlvo("Pós-fixado", 3000);
        const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
        await criarSessao("2026-07", "2026-07-28", "VIGENTE");
        const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029");
        await criarSnapshot(posicaoManual.id, sessaoAnterior.id, 500_000, 520_000);
        const aporte1 = await criarAporteParaTeste(sessaoAnterior.id, 30_000);
        const aporte2 = await criarAporteParaTeste(sessaoAnterior.id, 40_000);
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporte1.id,
          posicaoManualId: posicaoManual.id,
          valorIncrementoCentavos: 30_000,
        });
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporte2.id,
          posicaoManualId: posicaoManual.id,
          valorIncrementoCentavos: 40_000,
        });

        const revisao = await posicaoManualService.montarRevisaoImport();

        expect(revisao.posicoesManuaisRevisao).toHaveLength(1);
        expect(revisao.posicoesManuaisRevisao[0]).toMatchObject({
          valorInvestidoCentavosAnterior: 500_000,
          incrementoPendenteCentavos: 70_000,
          valorInvestidoCentavosSugerido: 570_000,
        });
      });

      it("soma MÚLTIPLAS pendências não aplicadas do MESMO ajuste juntas", async () => {
        const alvo = await criarAlvo("Fundos", 2000);
        const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
        await criarSessao("2026-07", "2026-07-28", "VIGENTE");
        await criarAtivoMapeadoComAlvo("FUNDO-XPTO", alvo.id);
        await criarAjuste("FUNDO-XPTO", sessaoAnterior.id, 300_000);
        const aporte1 = await criarAporteParaTeste(sessaoAnterior.id, 10_000);
        const aporte2 = await criarAporteParaTeste(sessaoAnterior.id, 15_000);
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporte1.id,
          chaveExport: "FUNDO-XPTO",
          valorIncrementoCentavos: 10_000,
        });
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporte2.id,
          chaveExport: "FUNDO-XPTO",
          valorIncrementoCentavos: 15_000,
        });

        const revisao = await posicaoManualService.montarRevisaoImport();

        expect(revisao.ajustesRevisao).toHaveLength(1);
        expect(revisao.ajustesRevisao[0]).toMatchObject({
          valorInvestidoCentavosAnterior: 300_000,
          incrementoPendenteCentavos: 25_000,
          valorInvestidoCentavosSugerido: 325_000,
        });
      });

      it("NÃO soma pendências já aplicadas (aplicado = true) — só o histórico ainda pendente entra na soma", async () => {
        const alvo = await criarAlvo("Pós-fixado", 3000);
        const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
        const sessaoQueAplicouAntes = await criarSessao("2026-05", "2026-05-28", "SUBSTITUIDO");
        await criarSessao("2026-07", "2026-07-28", "VIGENTE");
        const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029");
        await criarSnapshot(posicaoManual.id, sessaoAnterior.id, 500_000, 520_000);
        const aporteJaAplicado = await criarAporteParaTeste(sessaoAnterior.id, 99_000);
        const aportePendente = await criarAporteParaTeste(sessaoAnterior.id, 20_000);
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporteJaAplicado.id,
          posicaoManualId: posicaoManual.id,
          valorIncrementoCentavos: 99_000,
          aplicado: true,
          sessaoAplicacaoId: sessaoQueAplicouAntes.id,
        });
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aportePendente.id,
          posicaoManualId: posicaoManual.id,
          valorIncrementoCentavos: 20_000,
        });

        const revisao = await posicaoManualService.montarRevisaoImport();

        expect(revisao.posicoesManuaisRevisao[0]).toMatchObject({
          valorInvestidoCentavosAnterior: 500_000,
          incrementoPendenteCentavos: 20_000,
          valorInvestidoCentavosSugerido: 520_000,
        });
      });

      it("pendência ambígua (chave_export e posicao_manual_id ambos null) NÃO é somada a nenhuma posição/ajuste específico", async () => {
        const alvo = await criarAlvo("Pós-fixado", 3000);
        const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
        await criarSessao("2026-07", "2026-07-28", "VIGENTE");
        const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029");
        await criarSnapshot(posicaoManual.id, sessaoAnterior.id, 500_000, 520_000);
        const aporte = await criarAporteParaTeste(sessaoAnterior.id, 80_000);
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporte.id,
          valorIncrementoCentavos: 80_000,
          // chave_export e posicao_manual_id ambos ausentes = pendência
          // ambígua de alvo (motor-integracao.md §3.2, n >= 2 histórico).
        });

        const revisao = await posicaoManualService.montarRevisaoImport();

        expect(revisao.posicoesManuaisRevisao[0]).toMatchObject({
          valorInvestidoCentavosAnterior: 500_000,
          incrementoPendenteCentavos: 0,
          valorInvestidoCentavosSugerido: 500_000,
        });
      });

      it("chamar montarRevisaoImport (só pré-visualização) NUNCA marca aplicado = true — a leitura não muda o estado do banco (research.md R4)", async () => {
        const alvo = await criarAlvo("Pós-fixado", 3000);
        const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
        await criarSessao("2026-07", "2026-07-28", "VIGENTE");
        const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029");
        await criarSnapshot(posicaoManual.id, sessaoAnterior.id, 500_000, 520_000);
        const aporte = await criarAporteParaTeste(sessaoAnterior.id, 20_000);
        const pendencia = await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporte.id,
          posicaoManualId: posicaoManual.id,
          valorIncrementoCentavos: 20_000,
        });

        await posicaoManualService.montarRevisaoImport();

        const noBanco = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow({
          where: { id: pendencia.id },
        });
        expect(noBanco.aplicado).toBe(false);
        expect(noBanco.sessao_aplicacao_id).toBeNull();
      });

      it("reimport abandonado (chamar montarRevisaoImport repetidas vezes, simulando reabrir a tela de revisão) não perde nem duplica pendências — mesmo resultado sempre, idempotência de leitura (research.md R4)", async () => {
        const alvo = await criarAlvo("Pós-fixado", 3000);
        const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
        await criarSessao("2026-07", "2026-07-28", "VIGENTE");
        const posicaoManual = await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029");
        await criarSnapshot(posicaoManual.id, sessaoAnterior.id, 500_000, 520_000);
        const aporte1 = await criarAporteParaTeste(sessaoAnterior.id, 30_000);
        const aporte2 = await criarAporteParaTeste(sessaoAnterior.id, 40_000);
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporte1.id,
          posicaoManualId: posicaoManual.id,
          valorIncrementoCentavos: 30_000,
        });
        await criarPendenciaIncremento({
          alvoId: alvo.id,
          aporteId: aporte2.id,
          posicaoManualId: posicaoManual.id,
          valorIncrementoCentavos: 40_000,
        });

        // Simula: usuário abre a tela de revisão de um import (preview 1),
        // abandona sem confirmar, e reabre com um novo import (preview 2).
        const primeiraPreVisualizacao = await posicaoManualService.montarRevisaoImport();
        const segundaPreVisualizacao = await posicaoManualService.montarRevisaoImport();

        expect(primeiraPreVisualizacao).toEqual(segundaPreVisualizacao);
        expect(primeiraPreVisualizacao.posicoesManuaisRevisao[0]).toMatchObject({
          incrementoPendenteCentavos: 70_000,
          valorInvestidoCentavosSugerido: 570_000,
        });
        // Nenhuma linha de pendência foi criada/perdida por só pré-visualizar.
        expect(await prisma.incremento_valor_investido_pendente.count()).toBe(2);
        expect(
          await prisma.incremento_valor_investido_pendente.count({ where: { aplicado: false } }),
        ).toBe(2);
      });
    });
  });

  // ---------------------------------------------------------------------
  // T024 (User Story 4, FR-013, contracts/motor-integracao.md §4.3,
  // data-model.md "Fluxo técnico" passo 4, research.md R4/R5): função de
  // APLICAÇÃO/CONSUMO real das pendências, chamada pela transação de
  // `confirmarImport` (T026, escopo de `src/services/import-service.ts` +
  // extensão deste arquivo — NÃO implementada ainda).
  //
  // Shape escolhido para T026 implementar EXATAMENTE isto (nome de função e
  // formato usados nestes testes — documentado aqui para o agente de T026):
  //
  //   export interface MarcarPendenciasComoAplicadasInput {
  //     pendenciaIds: string[];
  //     sessaoAplicacaoId: string;
  //   }
  //
  //   export async function marcarPendenciasComoAplicadas(
  //     input: MarcarPendenciasComoAplicadasInput,
  //   ): Promise<{ quantidadeAtualizada: number }>
  //
  // Racional do shape: recebe a lista JÁ RESOLVIDA de ids (a mesma lista que
  // `confirmarImport` calcula ao somar `posicoesManuaisRevisao`/
  // `ajustesRevisao`/pendências ambíguas de alvo antes de persistir os
  // `posicao_manual_valor`/`ajuste_valor_investido` da nova sessão) — a
  // função não recalcula elegibilidade nem decide "quais" pendências
  // marcar, só executa o UPDATE em lote dentro da MESMA transação Prisma de
  // confirmação (data-model.md, Fluxo técnico, passo 4). Deve ser chamável
  // com `tx` (cliente de transação) em vez do client global `prisma` — mas
  // como isso é detalhe de implementação de T026 (import-service.ts passa
  // `tx.incremento_valor_investido_pendente` ou similar), os testes aqui
  // usam o client global `prisma` (mesmo padrão dos demais testes deste
  // arquivo) e não fixam a assinatura de transação.
  //
  // `marcarPendenciasComoAplicadas` ainda NÃO existe em
  // src/services/posicao-manual-service.ts neste ponto — os testes abaixo
  // devem FALHAR agora (TDD), sem quebrar nenhum teste já existente.
  // ---------------------------------------------------------------------
  describe("marcarPendenciasComoAplicadas (T024, futuro T026)", () => {
    it("marca aplicado = true e grava sessao_aplicacao_id nas pendências informadas", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
      const sessaoNova = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvo_id: alvo.id,
          ativo: true,
        },
      });
      const aporte = await criarAporteParaTeste(sessaoAnterior.id, 20_000);
      const pendencia = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte.id,
        posicaoManualId: posicaoManual.id,
        valorIncrementoCentavos: 20_000,
      });

      const resultado = await posicaoManualService.marcarPendenciasComoAplicadas({
        pendenciaIds: [pendencia.id],
        sessaoAplicacaoId: sessaoNova.id,
      });

      expect(resultado.quantidadeAtualizada).toBe(1);

      const noBanco = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow({
        where: { id: pendencia.id },
      });
      expect(noBanco.aplicado).toBe(true);
      expect(noBanco.sessao_aplicacao_id).toBe(sessaoNova.id);
    });

    it("marca APENAS as pendências informadas — outras pendências pendentes do mesmo alvo/posição permanecem aplicado = false", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
      const sessaoNova = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvo_id: alvo.id,
          ativo: true,
        },
      });
      const aporte1 = await criarAporteParaTeste(sessaoAnterior.id, 20_000);
      const aporte2 = await criarAporteParaTeste(sessaoAnterior.id, 30_000);
      const pendenciaMarcada = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte1.id,
        posicaoManualId: posicaoManual.id,
        valorIncrementoCentavos: 20_000,
      });
      const pendenciaNaoMarcada = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte2.id,
        posicaoManualId: posicaoManual.id,
        valorIncrementoCentavos: 30_000,
      });

      await posicaoManualService.marcarPendenciasComoAplicadas({
        pendenciaIds: [pendenciaMarcada.id],
        sessaoAplicacaoId: sessaoNova.id,
      });

      const marcada = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow({
        where: { id: pendenciaMarcada.id },
      });
      const naoMarcada = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow({
        where: { id: pendenciaNaoMarcada.id },
      });
      expect(marcada.aplicado).toBe(true);
      expect(naoMarcada.aplicado).toBe(false);
      expect(naoMarcada.sessao_aplicacao_id).toBeNull();
    });

    it("marca uma pendência AMBÍGUA (chave_export e posicao_manual_id ambos null) integralmente, mesmo sem nenhuma validação de distribuição/fechamento 100% (research.md R5, decisão binária)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
      const sessaoNova = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      const aporte = await criarAporteParaTeste(sessaoAnterior.id, 80_000);
      // Pendência ambígua de alvo (n >= 2 histórico, motor-integracao.md
      // §3.2) — o usuário, na tela de revisão, pode ter distribuído só
      // PARTE dos R$ 800,00 entre os campos de valor_investido do alvo (ex.:
      // só R$ 500,00 alocados manualmente). Não há campo de "valor
      // distribuído" no schema para validar — a marcação é binária e
      // integral por decisão de research.md R5.
      const pendenciaAmbigua = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte.id,
        valorIncrementoCentavos: 80_000,
      });

      const resultado = await posicaoManualService.marcarPendenciasComoAplicadas({
        pendenciaIds: [pendenciaAmbigua.id],
        sessaoAplicacaoId: sessaoNova.id,
      });

      expect(resultado.quantidadeAtualizada).toBe(1);
      const noBanco = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow({
        where: { id: pendenciaAmbigua.id },
      });
      expect(noBanco.aplicado).toBe(true);
      expect(noBanco.sessao_aplicacao_id).toBe(sessaoNova.id);
      // Nenhuma reconciliação de valor é feita/exigida — a linha some da
      // fila de pendências independentemente de "resto não alocado".
    });

    it("uma pendência marcada aplicado = true NÃO é reoferecida — chamar montarRevisaoImport depois já não soma mais essa pendência (FR-013, mesmo padrão de dividendo.aporte_id)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
      const sessaoNova = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvo_id: alvo.id,
          ativo: true,
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManual.id,
          sessao_import_id: sessaoAnterior.id,
          valor_investido_centavos: 500_000,
          valor_atual_centavos: 520_000,
        },
      });
      const aporte = await criarAporteParaTeste(sessaoAnterior.id, 20_000);
      const pendencia = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte.id,
        posicaoManualId: posicaoManual.id,
        valorIncrementoCentavos: 20_000,
      });

      await posicaoManualService.marcarPendenciasComoAplicadas({
        pendenciaIds: [pendencia.id],
        sessaoAplicacaoId: sessaoNova.id,
      });

      const revisaoAposAplicar = await posicaoManualService.montarRevisaoImport();
      // Depois de aplicada, a soma deve ser 0 outra vez (pendência
      // consumida) — este teste depende da extensão de montarRevisaoImport
      // testada acima (T026 implementa ambas juntas para este teste passar).
      expect(revisaoAposAplicar.posicoesManuaisRevisao[0]).toMatchObject({
        incrementoPendenteCentavos: 0,
      });
    });

    it("não valida FKs mutuamente exclusivos nem qualquer regra de negócio — só faz o UPDATE em lote pelos ids informados (função utilitária pura de escrita)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      const sessaoAnterior = await criarSessao("2026-06", "2026-06-28", "SUBSTITUIDO");
      const sessaoNova = await criarSessao("2026-07", "2026-07-28", "VIGENTE");
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvo_id: alvo.id,
          ativo: true,
        },
      });
      const aporte1 = await criarAporteParaTeste(sessaoAnterior.id, 20_000);
      const aporte2 = await criarAporteParaTeste(sessaoAnterior.id, 80_000);
      const pendenciaExclusiva = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte1.id,
        posicaoManualId: posicaoManual.id,
        valorIncrementoCentavos: 20_000,
      });
      const pendenciaAmbigua = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte2.id,
        valorIncrementoCentavos: 80_000,
      });

      const resultado = await posicaoManualService.marcarPendenciasComoAplicadas({
        pendenciaIds: [pendenciaExclusiva.id, pendenciaAmbigua.id],
        sessaoAplicacaoId: sessaoNova.id,
      });

      expect(resultado.quantidadeAtualizada).toBe(2);
      expect(
        await prisma.incremento_valor_investido_pendente.count({
          where: { aplicado: true, sessao_aplicacao_id: sessaoNova.id },
        }),
      ).toBe(2);
    });
  });

  describe("montarIncrementosAmbiguosPendentes (T026, motor-integracao.md §4.2)", () => {
    it("retorna [] quando não há nenhuma pendência ambígua (nenhuma linha com chave_export e posicao_manual_id ambos null)", async () => {
      const resultado = await posicaoManualService.montarIncrementosAmbiguosPendentes();
      expect(resultado).toEqual([]);
    });

    it("agrega, por alvo_id, a soma de MÚLTIPLAS pendências ambíguas ainda não aplicadas do mesmo alvo", async () => {
      const alvo = await criarAlvo("Multimercado ambíguo", 5000);
      const sessao = await criarSessao("2026-06", "2026-06-28");
      const aporte1 = await criarAporteParaTeste(sessao.id, 30_000);
      const aporte2 = await criarAporteParaTeste(sessao.id, 50_000);
      await criarPendenciaIncremento({ alvoId: alvo.id, aporteId: aporte1.id, valorIncrementoCentavos: 30_000 });
      await criarPendenciaIncremento({ alvoId: alvo.id, aporteId: aporte2.id, valorIncrementoCentavos: 50_000 });

      const resultado = await posicaoManualService.montarIncrementosAmbiguosPendentes();

      expect(resultado).toHaveLength(1);
      expect(resultado[0]).toMatchObject({
        alvoId: alvo.id,
        nomeAlvo: "Multimercado ambíguo",
        valorPendenteCentavos: 80_000,
      });
    });

    it("NÃO soma pendências não-ambíguas (com chave_export OU posicao_manual_id preenchido) à agregação", async () => {
      const alvo = await criarAlvo("Alvo misto", 5000);
      const sessao = await criarSessao("2026-06", "2026-06-28");
      const aporte = await criarAporteParaTeste(sessao.id, 100_000);
      const posicaoManual = await prisma.posicao_manual.create({
        data: { chave_manual: "CDB-X", instituicao: "Itaú", descricao: "CDB X", alvo_id: alvo.id },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvo.id, fora_da_carteira: false },
      });
      await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte.id,
        posicaoManualId: posicaoManual.id,
        valorIncrementoCentavos: 20_000,
      });
      await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte.id,
        chaveExport: "PRIO3",
        valorIncrementoCentavos: 30_000,
      });
      await criarPendenciaIncremento({ alvoId: alvo.id, aporteId: aporte.id, valorIncrementoCentavos: 40_000 });

      const resultado = await posicaoManualService.montarIncrementosAmbiguosPendentes();

      expect(resultado).toHaveLength(1);
      expect(resultado[0].valorPendenteCentavos).toBe(40_000);
    });

    it("NÃO soma pendências ambíguas já aplicadas (aplicado = true)", async () => {
      const alvo = await criarAlvo("Alvo já consumido", 5000);
      const sessao = await criarSessao("2026-06", "2026-06-28");
      const sessaoAplicacao = await criarSessao("2026-07", "2026-07-28");
      const aporte = await criarAporteParaTeste(sessao.id, 60_000);
      await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte.id,
        valorIncrementoCentavos: 60_000,
        aplicado: true,
        sessaoAplicacaoId: sessaoAplicacao.id,
      });

      const resultado = await posicaoManualService.montarIncrementosAmbiguosPendentes();
      expect(resultado).toEqual([]);
    });

    it("elegiveis inclui posicao_manual ATIVA vinculada ao alvo e EXCLUI posicao_manual encerrada (ativo=false)", async () => {
      const alvo = await criarAlvo("Alvo elegiveis", 5000);
      const sessao = await criarSessao("2026-06", "2026-06-28");
      const aporte = await criarAporteParaTeste(sessao.id, 50_000);
      await criarPendenciaIncremento({ alvoId: alvo.id, aporteId: aporte.id, valorIncrementoCentavos: 50_000 });

      const posicaoAtiva = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ATIVA",
          instituicao: "Itaú",
          descricao: "CDB Itaú Ativo",
          alvo_id: alvo.id,
          ativo: true,
        },
      });
      await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ENCERRADA",
          instituicao: "Itaú",
          descricao: "CDB Itaú Encerrado",
          alvo_id: alvo.id,
          ativo: false,
        },
      });

      const resultado = await posicaoManualService.montarIncrementosAmbiguosPendentes();

      expect(resultado).toHaveLength(1);
      expect(resultado[0].elegiveis).toEqual([
        { tipo: "posicaoManual", id: posicaoAtiva.id, rotulo: "CDB Itaú Ativo (Itaú)" },
      ]);
    });

    it("elegiveis inclui chave_export vinculada ao alvo com histórico de ajuste_valor_investido e EXCLUI chave_export sem histórico", async () => {
      const alvo = await criarAlvo("Alvo elegiveis ajuste", 5000);
      const sessao = await criarSessao("2026-06", "2026-06-28");
      const aporte = await criarAporteParaTeste(sessao.id, 50_000);
      await criarPendenciaIncremento({ alvoId: alvo.id, aporteId: aporte.id, valorIncrementoCentavos: 50_000 });

      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvo.id, fora_da_carteira: false },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "VALE3", alvo_id: alvo.id, fora_da_carteira: false },
      });
      // Só PRIO3 tem histórico de ajuste — VALE3 está vinculado ao alvo mas
      // nunca teve um ajuste_valor_investido criado.
      await prisma.ajuste_valor_investido.create({
        data: { chave_export: "PRIO3", sessao_import_id: sessao.id, valor_investido_corrigido_centavos: 90_000 },
      });

      const resultado = await posicaoManualService.montarIncrementosAmbiguosPendentes();

      expect(resultado).toHaveLength(1);
      expect(resultado[0].elegiveis).toEqual([{ tipo: "ajuste", id: "PRIO3", rotulo: "PRIO3" }]);
    });

    it("elegiveis EXCLUI chave_export fora_da_carteira ou ignorar_no_import, mesmo com histórico de ajuste", async () => {
      const alvo = await criarAlvo("Alvo elegiveis excluidos", 5000);
      const sessao = await criarSessao("2026-06", "2026-06-28");
      const aporte = await criarAporteParaTeste(sessao.id, 50_000);
      await criarPendenciaIncremento({ alvoId: alvo.id, aporteId: aporte.id, valorIncrementoCentavos: 50_000 });

      await prisma.ativo_mapeado.create({
        data: { chave_export: "FORA3", alvo_id: alvo.id, fora_da_carteira: true },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "IGNORADA3", alvo_id: alvo.id, fora_da_carteira: false, ignorar_no_import: true },
      });
      await prisma.ajuste_valor_investido.createMany({
        data: [
          { chave_export: "FORA3", sessao_import_id: sessao.id, valor_investido_corrigido_centavos: 10_000 },
          { chave_export: "IGNORADA3", sessao_import_id: sessao.id, valor_investido_corrigido_centavos: 10_000 },
        ],
      });

      const resultado = await posicaoManualService.montarIncrementosAmbiguosPendentes();

      expect(resultado).toHaveLength(1);
      expect(resultado[0].elegiveis).toEqual([]);
    });

    it("elegiveis mistos: uma posicao_manual ativa + um chave_export com histórico, ambos do mesmo alvo, aparecem juntos", async () => {
      const alvo = await criarAlvo("Alvo elegiveis mistos", 5000);
      const sessao = await criarSessao("2026-06", "2026-06-28");
      const aporte = await criarAporteParaTeste(sessao.id, 80_000);
      await criarPendenciaIncremento({ alvoId: alvo.id, aporteId: aporte.id, valorIncrementoCentavos: 80_000 });

      const posicaoManual = await prisma.posicao_manual.create({
        data: { chave_manual: "CDB-MISTO", instituicao: "Itaú", descricao: "CDB Misto", alvo_id: alvo.id, ativo: true },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvo.id, fora_da_carteira: false },
      });
      await prisma.ajuste_valor_investido.create({
        data: { chave_export: "PRIO3", sessao_import_id: sessao.id, valor_investido_corrigido_centavos: 90_000 },
      });

      const resultado = await posicaoManualService.montarIncrementosAmbiguosPendentes();

      expect(resultado).toHaveLength(1);
      expect(resultado[0].elegiveis).toEqual(
        expect.arrayContaining([
          { tipo: "posicaoManual", id: posicaoManual.id, rotulo: "CDB Misto (Itaú)" },
          { tipo: "ajuste", id: "PRIO3", rotulo: "PRIO3" },
        ]),
      );
      expect(resultado[0].elegiveis).toHaveLength(2);
    });

    it("múltiplos alvos com pendência ambígua retornam itens separados, cada um com sua própria agregação e lista de elegiveis", async () => {
      const alvo1 = await criarAlvo("Alvo 1", 3000);
      const alvo2 = await criarAlvo("Alvo 2", 3000);
      const sessao = await criarSessao("2026-06", "2026-06-28");
      const aporte = await criarAporteParaTeste(sessao.id, 100_000);
      await criarPendenciaIncremento({ alvoId: alvo1.id, aporteId: aporte.id, valorIncrementoCentavos: 25_000 });
      await criarPendenciaIncremento({ alvoId: alvo2.id, aporteId: aporte.id, valorIncrementoCentavos: 75_000 });
      const posicaoManual1 = await prisma.posicao_manual.create({
        data: { chave_manual: "CDB-1", instituicao: "Itaú", descricao: "CDB Alvo 1", alvo_id: alvo1.id, ativo: true },
      });

      const resultado = await posicaoManualService.montarIncrementosAmbiguosPendentes();

      expect(resultado).toHaveLength(2);
      const porAlvoId = new Map(resultado.map((r) => [r.alvoId, r]));
      expect(porAlvoId.get(alvo1.id)).toMatchObject({
        nomeAlvo: "Alvo 1",
        valorPendenteCentavos: 25_000,
        elegiveis: [{ tipo: "posicaoManual", id: posicaoManual1.id, rotulo: "CDB Alvo 1 (Itaú)" }],
      });
      expect(porAlvoId.get(alvo2.id)).toMatchObject({
        nomeAlvo: "Alvo 2",
        valorPendenteCentavos: 75_000,
        elegiveis: [],
      });
    });
  });
});
