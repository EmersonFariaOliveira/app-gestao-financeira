/**
 * tests/services/dividendo-service.test.ts — testes de integração (T050) de
 * src/services/dividendo-service.ts contra um SQLite TEMPORÁRIO, isolado do
 * `data/app.db` real/seed.
 *
 * Mesma estratégia de tests/services/alvo-service.test.ts /
 * mapeamento-service.test.ts / aporte-service.test.ts: `DATABASE_URL` aponta
 * para um arquivo `.db` temporário ANTES de importar `@/db/client`/
 * `@/services/dividendo-service` (imports dinâmicos dentro de `beforeAll`),
 * esquema aplicado via `prisma migrate deploy`.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let dividendoService: typeof import("@/services/dividendo-service");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dividendo-service-test-"));
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
  dividendoService = await import("@/services/dividendo-service");
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

async function criarAtivoConhecido(chaveExport: string) {
  return prisma.ativo_mapeado.create({
    data: { chave_export: chaveExport, alvo_id: null, fora_da_carteira: false },
  });
}

/** Sessão + aporte mínimos só para satisfazer a FK de um dividendo já "utilizado". */
async function criarAporteQualquer() {
  const sessao = await prisma.sessao_import.create({
    data: {
      mes_referencia: "2026-06",
      data_export: new Date("2026-06-28"),
      status: "VIGENTE",
      instituicoes: JSON.stringify(["Itaú"]),
    },
  });
  return prisma.aporte.create({
    data: {
      sessao_import_id: sessao.id,
      valor_total_centavos: 10_000,
      valor_dividendos_centavos: 10_000,
      sugestao: "[]",
      executado: "[]",
      troco_centavos: 0,
    },
  });
}

describe("dividendo-service", () => {
  describe("lancarDividendo", () => {
    it("cria um lançamento para um ativo conhecido", async () => {
      await criarAtivoConhecido("PRIO3");

      const criado = await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 5_000,
      });

      expect(criado.chaveExport).toBe("PRIO3");
      expect(criado.mesReferencia).toBe("2026-07");
      expect(criado.valorCentavos).toBe(5_000);
      expect(criado.aporteId).toBeNull();
    });

    it("recusa chaveExport desconhecida (não existe em ativo_mapeado)", async () => {
      await expect(
        dividendoService.lancarDividendo({
          chaveExport: "FANTASMA",
          mesReferencia: "2026-07",
          valorCentavos: 5_000,
        }),
      ).rejects.toThrow(/desconhecido/i);

      expect(await prisma.dividendo.count()).toBe(0);
    });

    it("recusa valorCentavos <= 0", async () => {
      await criarAtivoConhecido("PRIO3");

      await expect(
        dividendoService.lancarDividendo({
          chaveExport: "PRIO3",
          mesReferencia: "2026-07",
          valorCentavos: 0,
        }),
      ).rejects.toThrow(/valorCentavos/);

      await expect(
        dividendoService.lancarDividendo({
          chaveExport: "PRIO3",
          mesReferencia: "2026-07",
          valorCentavos: -100,
        }),
      ).rejects.toThrow(/valorCentavos/);
    });

    it("recusa mesReferencia fora do formato YYYY-MM", async () => {
      await criarAtivoConhecido("PRIO3");

      await expect(
        dividendoService.lancarDividendo({
          chaveExport: "PRIO3",
          mesReferencia: "07/2026",
          valorCentavos: 5_000,
        }),
      ).rejects.toThrow(/mesReferencia inválido/);
    });

    it("permite múltiplos lançamentos para a mesma chave/mês (não é upsert)", async () => {
      await criarAtivoConhecido("PRIO3");

      await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 1_000,
      });
      await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 2_000,
      });

      const registros = await prisma.dividendo.findMany({
        where: { chave_export: "PRIO3", mes_referencia: "2026-07" },
      });
      expect(registros).toHaveLength(2);
      expect(await dividendoService.totalDisponivelCentavos()).toBe(3_000);
    });
  });

  describe("totalDisponivelCentavos — dupla contagem impossível / disponível não expira", () => {
    it("dividendo com aporte_id preenchido NUNCA soma no total disponível", async () => {
      await criarAtivoConhecido("PRIO3");
      const aporte = await criarAporteQualquer();

      await prisma.dividendo.create({
        data: {
          chave_export: "PRIO3",
          mes_referencia: "2026-06",
          valor_centavos: 10_000,
          aporte_id: aporte.id,
        },
      });
      await prisma.dividendo.create({
        data: { chave_export: "PRIO3", mes_referencia: "2026-07", valor_centavos: 3_000 },
      });

      // Só o não-utilizado (3000) entra na soma — o utilizado (10000) nunca
      // é contado novamente, mesmo permanecendo no banco para sempre.
      expect(await dividendoService.totalDisponivelCentavos()).toBe(3_000);
    });

    it("dividendo de um mês antigo (vários meses atrás), ainda com aporte_id null, continua somando no total disponível — 'não utilizado permanece disponível'", async () => {
      await criarAtivoConhecido("PRIO3");

      await prisma.dividendo.create({
        data: { chave_export: "PRIO3", mes_referencia: "2025-01", valor_centavos: 2_500 },
      });

      expect(await dividendoService.totalDisponivelCentavos()).toBe(2_500);

      const listagem = await dividendoService.listarDividendos({ mes: "2026-07" });
      // O mês antigo não aparece na listagem filtrada por "2026-07"...
      expect(listagem.lancamentos).toEqual([]);
      // ...mas o total disponível GERAL continua incluindo o lançamento
      // antigo — é o mesmo número que a calculadora usaria.
      expect(listagem.totalDisponivelCentavos).toBe(2_500);
    });
  });

  describe("listarDividendos", () => {
    it("filtra a listagem por mes_referencia, mas o total disponível permanece global", async () => {
      await criarAtivoConhecido("PRIO3");
      await criarAtivoConhecido("VALE3");

      await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-05",
        valorCentavos: 1_000,
      });
      await dividendoService.lancarDividendo({
        chaveExport: "VALE3",
        mesReferencia: "2026-07",
        valorCentavos: 4_000,
      });

      const listagemMaio = await dividendoService.listarDividendos({ mes: "2026-05" });
      expect(listagemMaio.lancamentos).toHaveLength(1);
      expect(listagemMaio.lancamentos[0].chaveExport).toBe("PRIO3");
      expect(listagemMaio.totalDisponivelCentavos).toBe(5_000);

      const listagemJulho = await dividendoService.listarDividendos({ mes: "2026-07" });
      expect(listagemJulho.lancamentos).toHaveLength(1);
      expect(listagemJulho.lancamentos[0].chaveExport).toBe("VALE3");
      expect(listagemJulho.totalDisponivelCentavos).toBe(5_000);

      const listagemSemFiltro = await dividendoService.listarDividendos();
      expect(listagemSemFiltro.lancamentos).toHaveLength(2);
      expect(listagemSemFiltro.totalDisponivelCentavos).toBe(5_000);
    });
  });

  describe("editarDividendo / excluirDividendo — imutabilidade do utilizado", () => {
    it("edição de dividendo disponível funciona normalmente", async () => {
      await criarAtivoConhecido("PRIO3");
      const criado = await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 1_000,
      });

      const editado = await dividendoService.editarDividendo({
        id: criado.id,
        valorCentavos: 1_500,
        mesReferencia: "2026-08",
      });

      expect(editado.valorCentavos).toBe(1_500);
      expect(editado.mesReferencia).toBe("2026-08");
      expect(await dividendoService.totalDisponivelCentavos()).toBe(1_500);
    });

    it("editarDividendo recusa valorCentavos <= 0 (negativo ou zero) para dividendo disponível, sem alterar nada", async () => {
      await criarAtivoConhecido("PRIO3");
      const criado = await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 1_000,
      });

      await expect(
        dividendoService.editarDividendo({ id: criado.id, valorCentavos: 0 }),
      ).rejects.toThrow(/valorCentavos/);
      await expect(
        dividendoService.editarDividendo({ id: criado.id, valorCentavos: -500 }),
      ).rejects.toThrow(/valorCentavos/);

      const intacto = await prisma.dividendo.findUniqueOrThrow({ where: { id: criado.id } });
      expect(intacto.valor_centavos).toBe(1_000);
    });

    it("editarDividendo recusa mesReferencia fora do formato YYYY-MM para dividendo disponível, sem alterar nada", async () => {
      await criarAtivoConhecido("PRIO3");
      const criado = await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 1_000,
      });

      await expect(
        dividendoService.editarDividendo({ id: criado.id, mesReferencia: "07/2026" }),
      ).rejects.toThrow(/mesReferencia inválido/);

      const intacto = await prisma.dividendo.findUniqueOrThrow({ where: { id: criado.id } });
      expect(intacto.mes_referencia).toBe("2026-07");
    });

    it("editarDividendo recusa chaveExport desconhecida (ativo nunca visto num import) para dividendo disponível", async () => {
      await criarAtivoConhecido("PRIO3");
      const criado = await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 1_000,
      });

      await expect(
        dividendoService.editarDividendo({ id: criado.id, chaveExport: "FANTASMA" }),
      ).rejects.toThrow(/desconhecido/i);

      const intacto = await prisma.dividendo.findUniqueOrThrow({ where: { id: criado.id } });
      expect(intacto.chave_export).toBe("PRIO3");
    });

    it("editar um dividendo NÃO afeta outro lançamento independente do mesmo ativo/mês", async () => {
      await criarAtivoConhecido("PRIO3");
      const primeiro = await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 1_000,
      });
      const segundo = await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 2_000,
      });

      await dividendoService.editarDividendo({ id: primeiro.id, valorCentavos: 9_000 });

      const segundoIntacto = await prisma.dividendo.findUniqueOrThrow({ where: { id: segundo.id } });
      expect(segundoIntacto.valor_centavos).toBe(2_000);

      const primeiroAtualizado = await prisma.dividendo.findUniqueOrThrow({
        where: { id: primeiro.id },
      });
      expect(primeiroAtualizado.valor_centavos).toBe(9_000);

      // Total disponível reflete a edição de um sem duplicar/perder o outro.
      expect(await dividendoService.totalDisponivelCentavos()).toBe(9_000 + 2_000);
    });

    it("exclusão de dividendo disponível funciona normalmente", async () => {
      await criarAtivoConhecido("PRIO3");
      const criado = await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 1_000,
      });

      await dividendoService.excluirDividendo(criado.id);

      expect(await prisma.dividendo.findUnique({ where: { id: criado.id } })).toBeNull();
      expect(await dividendoService.totalDisponivelCentavos()).toBe(0);
    });

    it("edição de dividendo UTILIZADO (aporte_id preenchido) é recusada com erro claro, sem alterar nada", async () => {
      await criarAtivoConhecido("PRIO3");
      const aporte = await criarAporteQualquer();
      const utilizado = await prisma.dividendo.create({
        data: {
          chave_export: "PRIO3",
          mes_referencia: "2026-06",
          valor_centavos: 10_000,
          aporte_id: aporte.id,
        },
      });

      await expect(
        dividendoService.editarDividendo({ id: utilizado.id, valorCentavos: 1 }),
      ).rejects.toThrow(/utilizado/i);

      const intacto = await prisma.dividendo.findUniqueOrThrow({ where: { id: utilizado.id } });
      expect(intacto.valor_centavos).toBe(10_000);
      expect(intacto.aporte_id).toBe(aporte.id);
    });

    it("exclusão de dividendo UTILIZADO (aporte_id preenchido) é recusada com erro claro, sem alterar nada", async () => {
      await criarAtivoConhecido("PRIO3");
      const aporte = await criarAporteQualquer();
      const utilizado = await prisma.dividendo.create({
        data: {
          chave_export: "PRIO3",
          mes_referencia: "2026-06",
          valor_centavos: 10_000,
          aporte_id: aporte.id,
        },
      });

      await expect(dividendoService.excluirDividendo(utilizado.id)).rejects.toThrow(/utilizado/i);

      const intacto = await prisma.dividendo.findUnique({ where: { id: utilizado.id } });
      expect(intacto).not.toBeNull();
    });

    it("editarDividendo/excluirDividendo lançam erro claro para id inexistente", async () => {
      await expect(
        dividendoService.editarDividendo({ id: "id-inexistente", valorCentavos: 1_000 }),
      ).rejects.toThrow(/não encontrado/i);

      await expect(dividendoService.excluirDividendo("id-inexistente")).rejects.toThrow(
        /não encontrado/i,
      );
    });
  });

  describe("independência de re-imports", () => {
    it("import-service.ts não referencia prisma.dividendo em nenhum lugar (leitura estática)", async () => {
      const conteudo = fs.readFileSync(
        path.join(process.cwd(), "src", "services", "import-service.ts"),
        "utf-8",
      );
      expect(conteudo).not.toMatch(/dividendo/i);
    });
  });
});
