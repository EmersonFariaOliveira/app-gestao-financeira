/**
 * tests/services/mapeamento-service.test.ts — testes de integração (T041)
 * de src/services/mapeamento-service.ts contra um SQLite TEMPORÁRIO, isolado
 * do `data/app.db` real.
 *
 * Mesma estratégia de tests/services/aporte-service.test.ts e
 * tests/services/import-service.test.ts: `DATABASE_URL` aponta para um
 * arquivo `.db` temporário ANTES de importar `@/db/client`/
 * `@/services/mapeamento-service` (imports dinâmicos dentro de `beforeAll`),
 * esquema aplicado via `prisma migrate deploy`.
 *
 * Os cenários de "memorização entre imports" são simulados diretamente no
 * banco (criando/consultando `ativo_mapeado` como o import-service faria),
 * sem depender de src/services/import-service.ts — conforme instrução da
 * task (T041 é sobre o comportamento de mapeamento-service, não sobre
 * import-service).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let mapeamentoService: typeof import("@/services/mapeamento-service");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapeamento-service-test-"));
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
  mapeamentoService = await import("@/services/mapeamento-service");
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

async function criarAlvo(nome: string, percentualBps: number) {
  return prisma.alvo.create({
    data: { nome, percentual_alvo_bps: percentualBps, vigencia_inicio: new Date("2026-01-01") },
  });
}

/** Simula o que import-service faz para chaves novas: só cria pendente se NENHUM registro existir. */
async function simularImportCriaPendenteSeNovo(chaves: string[]) {
  const existentes = await prisma.ativo_mapeado.findMany({
    where: { chave_export: { in: chaves } },
    select: { chave_export: true },
  });
  const chavesExistentes = new Set(existentes.map((e) => e.chave_export));
  const chavesNovas = chaves.filter((c) => !chavesExistentes.has(c));
  if (chavesNovas.length > 0) {
    await prisma.ativo_mapeado.createMany({
      data: chavesNovas.map((chave) => ({ chave_export: chave, alvo_id: null, fora_da_carteira: false })),
    });
  }
  return chavesNovas;
}

describe("mapeamento-service", () => {
  describe("listarVinculos / contarPendencias", () => {
    it("separa pendentes, vinculados e fora-da-carteira nos três baldes", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "PRIO3", alvo_id: alvo.id } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "LEGADO-X", fora_da_carteira: true } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "WRLD11" } });

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.pendentes).toEqual([{ chaveExport: "WRLD11" }]);
      expect(vinculos.vinculados).toEqual([
        { chaveExport: "PRIO3", alvoId: alvo.id, nomeAlvo: "Ações BR" },
      ]);
      expect(vinculos.foraDaCarteira).toEqual([{ chaveExport: "LEGADO-X" }]);

      expect(await mapeamentoService.contarPendencias()).toBe(1);
    });
  });

  describe("memorização entre imports", () => {
    it("chave já vinculada não vira pendência de novo mesmo reaparecendo num import novo", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "PRIO3", alvo_id: alvo.id } });

      // "Reimport": a chave reaparece, mas já tem registro — import-service
      // não criaria pendente para ela (simulado aqui sem o serviço real).
      const chavesNovas = await simularImportCriaPendenteSeNovo(["PRIO3"]);
      expect(chavesNovas).toEqual([]);

      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.pendentes).toEqual([]);
      expect(vinculos.vinculados).toEqual([
        { chaveExport: "PRIO3", alvoId: alvo.id, nomeAlvo: "Ações BR" },
      ]);
      expect(await prisma.ativo_mapeado.count({ where: { chave_export: "PRIO3" } })).toBe(1);
    });

    it("chave já marcada fora-da-carteira não vira pendência de novo mesmo reaparecendo num import novo", async () => {
      await prisma.ativo_mapeado.create({ data: { chave_export: "LEGADO-X", fora_da_carteira: true } });

      const chavesNovas = await simularImportCriaPendenteSeNovo(["LEGADO-X"]);
      expect(chavesNovas).toEqual([]);

      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.pendentes).toEqual([]);
      expect(vinculos.foraDaCarteira).toEqual([{ chaveExport: "LEGADO-X" }]);
    });

    it("mudança de grafia no export gera uma chave_export diferente ⇒ nova pendência (comportamento esperado)", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "PRIO3", alvo_id: alvo.id } });

      // "PRIO 3" (grafia diferente) chega num import novo: chave nunca vista.
      const chavesNovas = await simularImportCriaPendenteSeNovo(["PRIO3", "PRIO 3"]);
      expect(chavesNovas).toEqual(["PRIO 3"]);

      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.pendentes).toEqual([{ chaveExport: "PRIO 3" }]);
      expect(vinculos.vinculados).toEqual([
        { chaveExport: "PRIO3", alvoId: alvo.id, nomeAlvo: "Ações BR" },
      ]);
      expect(await mapeamentoService.contarPendencias()).toBe(1);
    });
  });

  describe("invariante alvo_id ⊕ fora_da_carteira", () => {
    it("vincular a um alvo um ativo já fora-da-carteira zera fora_da_carteira", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "LEGADO-X", fora_da_carteira: true } });

      const resultado = await mapeamentoService.vincularAtivo({ chaveExport: "LEGADO-X", alvoId: alvo.id });

      expect(resultado).toEqual({
        chaveExport: "LEGADO-X",
        alvoId: alvo.id,
        nomeAlvo: "Ações BR",
        foraDaCarteira: false,
      });

      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "LEGADO-X" },
      });
      expect(registro.alvo_id).toBe(alvo.id);
      expect(registro.fora_da_carteira).toBe(false);
    });

    it("marcar fora-da-carteira um ativo já vinculado zera alvo_id", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "PRIO3", alvo_id: alvo.id } });

      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "PRIO3",
        foraDaCarteira: true,
      });

      expect(resultado).toEqual({
        chaveExport: "PRIO3",
        alvoId: null,
        nomeAlvo: null,
        foraDaCarteira: true,
      });

      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "PRIO3" },
      });
      expect(registro.alvo_id).toBeNull();
      expect(registro.fora_da_carteira).toBe(true);
    });

    it("nunca deixa alvo_id setado e fora_da_carteira=true simultaneamente após qualquer operação", async () => {
      const alvoA = await criarAlvo("Ações BR", 5000);
      const alvoB = await criarAlvo("Pós-fixado", 5000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "WRLD11" } });

      await mapeamentoService.vincularAtivo({ chaveExport: "WRLD11", alvoId: alvoA.id });
      await mapeamentoService.vincularAtivo({ chaveExport: "WRLD11", foraDaCarteira: true });
      await mapeamentoService.vincularAtivo({ chaveExport: "WRLD11", alvoId: alvoB.id });

      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "WRLD11" },
      });
      expect(registro.alvo_id).toBe(alvoB.id);
      expect(registro.fora_da_carteira).toBe(false);
    });
  });

  describe("N-para-1: vários chave_export apontando para o mesmo alvo", () => {
    it("ambos aparecem em vinculados, agrupáveis pelo mesmo alvoId", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await mapeamentoService.vincularAtivo({ chaveExport: "PRIO3", alvoId: alvo.id });
      await mapeamentoService.vincularAtivo({ chaveExport: "VALE3", alvoId: alvo.id });

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.vinculados).toHaveLength(2);
      expect(vinculos.vinculados.every((v) => v.alvoId === alvo.id)).toBe(true);
      expect(vinculos.vinculados.map((v) => v.chaveExport).sort()).toEqual(["PRIO3", "VALE3"]);
      expect(await mapeamentoService.contarPendencias()).toBe(0);
    });
  });

  describe("criar alvo na hora (novoAlvo)", () => {
    it("cria o alvo na vigência aberta e vincula a ele imediatamente, na mesma operação", async () => {
      const antesCount = await prisma.alvo.count();

      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "HGLG11",
        novoAlvo: { nome: "FIIs", percentualBps: 3000 },
      });

      expect(await prisma.alvo.count()).toBe(antesCount + 1);

      const alvoCriado = await prisma.alvo.findUniqueOrThrow({ where: { id: resultado.alvoId! } });
      expect(alvoCriado.nome).toBe("FIIs");
      expect(alvoCriado.percentual_alvo_bps).toBe(3000);
      expect(alvoCriado.vigencia_fim).toBeNull();

      expect(resultado).toEqual({
        chaveExport: "HGLG11",
        alvoId: alvoCriado.id,
        nomeAlvo: "FIIs",
        foraDaCarteira: false,
      });

      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "HGLG11" },
      });
      expect(registro.alvo_id).toBe(alvoCriado.id);
      expect(registro.fora_da_carteira).toBe(false);
    });

    it("chave já pendente (sem registro prévio) também funciona — upsert cria o ativo_mapeado", async () => {
      // Sem create() prévio: HGLG11 nunca foi visto por nenhum import.
      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "NUNCA-VISTO",
        novoAlvo: { nome: "Tesouro", percentualBps: 2000 },
      });

      expect(resultado.foraDaCarteira).toBe(false);
      expect(resultado.alvoId).not.toBeNull();
      expect(await mapeamentoService.contarPendencias()).toBe(0);
    });
  });

  describe("vincularAtivo com chaveExport que não existe em NENHUMA posicao (mapeamento-service é decoupled de posicao)", () => {
    it("vincular a alvo existente funciona mesmo sem nenhuma linha de posicao com essa chave", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      expect(await prisma.posicao.count({ where: { chave_export: "FANTASMA" } })).toBe(0);

      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "FANTASMA",
        alvoId: alvo.id,
      });

      expect(resultado).toEqual({
        chaveExport: "FANTASMA",
        alvoId: alvo.id,
        nomeAlvo: "Ações BR",
        foraDaCarteira: false,
      });
    });

    it("marcar fora-da-carteira funciona mesmo sem nenhuma linha de posicao com essa chave", async () => {
      expect(await prisma.posicao.count({ where: { chave_export: "FANTASMA-2" } })).toBe(0);

      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "FANTASMA-2",
        foraDaCarteira: true,
      });

      expect(resultado.foraDaCarteira).toBe(true);
      expect(resultado.alvoId).toBeNull();
    });
  });

  describe("vincularAtivo com alvoId inexistente/fechado", () => {
    it("lança erro se o alvo não existir na vigência aberta", async () => {
      await expect(
        mapeamentoService.vincularAtivo({ chaveExport: "PRIO3", alvoId: "id-inexistente" }),
      ).rejects.toThrow();
    });

    it("lança erro se o alvo existir mas a vigência já estiver fechada", async () => {
      const alvo = await prisma.alvo.create({
        data: {
          nome: "Antigo",
          percentual_alvo_bps: 10000,
          vigencia_inicio: new Date("2025-01-01"),
          vigencia_fim: new Date("2025-12-31"),
        },
      });

      await expect(
        mapeamentoService.vincularAtivo({ chaveExport: "PRIO3", alvoId: alvo.id }),
      ).rejects.toThrow();
    });
  });
});
