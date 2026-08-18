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
  await prisma.posicao_manual_valor.deleteMany();
  await prisma.ativo_mapeado.deleteMany();
  await prisma.posicao_manual.deleteMany();
  await prisma.sessao_import.deleteMany();
  await prisma.alvo.deleteMany();
  await prisma.config.deleteMany();
}

/**
 * Cria uma posicao_manual ATIVA vinculada a um alvo. `chaveExportOrigem`
 * (opcional) é o campo usado pelo match EXATO de `posicaoManualPendente`
 * (mapeamento-service.ts, `existePosicaoManualSubstituta`) — sem ele, a
 * posicao_manual não substitui nenhuma chave_export ignorada, mesmo que
 * aponte para o mesmo alvo.
 */
async function criarPosicaoManualAtiva(
  alvoId: string,
  chaveManual: string,
  ativo = true,
  chaveExportOrigem?: string,
) {
  return prisma.posicao_manual.create({
    data: {
      chave_manual: chaveManual,
      instituicao: "Itaú",
      alvo_id: alvoId,
      descricao: "CDB Itaú 120% CDI 2029",
      ativo,
      chave_export_origem: chaveExportOrigem ?? null,
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

async function criarAlvo(nome: string, percentualBps: number) {
  return prisma.alvo.create({
    data: { nome, percentual_alvo_bps: percentualBps, vigencia_inicio: new Date("2026-01-01") },
  });
}

/** Cria uma sessao_import VIGENTE (mesmo padrão de tests/services/dashboard-service.test.ts). */
async function criarSessaoVigente(mesReferencia: string, dataExport: string, status = "VIGENTE") {
  return prisma.sessao_import.create({
    data: {
      mes_referencia: mesReferencia,
      data_export: new Date(dataExport),
      status,
      instituicoes: JSON.stringify(["Itaú"]),
    },
  });
}

async function criarPosicao(
  sessaoId: string,
  chaveExport: string,
  patrimonioHojeCentavos: number,
  instituicao = "Itaú",
) {
  return prisma.posicao.create({
    data: {
      sessao_import_id: sessaoId,
      chave_export: chaveExport,
      instituicao,
      quantidade: "1",
      patrimonio_hoje_centavos: patrimonioHojeCentavos,
      tipo_grupo: "ACOES",
    },
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

      expect(vinculos.pendentes).toEqual([{ chaveExport: "WRLD11", valorAtualCentavos: 0 }]);
      expect(vinculos.vinculados).toEqual([
        { chaveExport: "PRIO3", alvoId: alvo.id, nomeAlvo: "Ações BR", valorAtualCentavos: 0 },
      ]);
      expect(vinculos.foraDaCarteira).toEqual([{ chaveExport: "LEGADO-X", valorAtualCentavos: 0 }]);

      expect(await mapeamentoService.contarPendencias()).toBe(1);
    });

    it("contarPendencias não conta um ativo_mapeado com ignorar_no_import=true como pendência (bug corrigido: era contado em 4 lugares que duplicavam a classificação sem excluir esse estado)", async () => {
      await prisma.ativo_mapeado.create({
        data: { chave_export: "TESOURO-IGNORADO", alvo_id: null, ignorar_no_import: true },
      });
      await prisma.ativo_mapeado.create({ data: { chave_export: "WRLD11" } });

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
        { chaveExport: "PRIO3", alvoId: alvo.id, nomeAlvo: "Ações BR", valorAtualCentavos: 0 },
      ]);
      expect(await prisma.ativo_mapeado.count({ where: { chave_export: "PRIO3" } })).toBe(1);
    });

    it("chave já marcada fora-da-carteira não vira pendência de novo mesmo reaparecendo num import novo", async () => {
      await prisma.ativo_mapeado.create({ data: { chave_export: "LEGADO-X", fora_da_carteira: true } });

      const chavesNovas = await simularImportCriaPendenteSeNovo(["LEGADO-X"]);
      expect(chavesNovas).toEqual([]);

      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.pendentes).toEqual([]);
      expect(vinculos.foraDaCarteira).toEqual([{ chaveExport: "LEGADO-X", valorAtualCentavos: 0 }]);
    });

    it("mudança de grafia no export gera uma chave_export diferente ⇒ nova pendência (comportamento esperado)", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "PRIO3", alvo_id: alvo.id } });

      // "PRIO 3" (grafia diferente) chega num import novo: chave nunca vista.
      const chavesNovas = await simularImportCriaPendenteSeNovo(["PRIO3", "PRIO 3"]);
      expect(chavesNovas).toEqual(["PRIO 3"]);

      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.pendentes).toEqual([{ chaveExport: "PRIO 3", valorAtualCentavos: 0 }]);
      expect(vinculos.vinculados).toEqual([
        { chaveExport: "PRIO3", alvoId: alvo.id, nomeAlvo: "Ações BR", valorAtualCentavos: 0 },
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
        reservaEmergencia: false,
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
        reservaEmergencia: false,
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
        reservaEmergencia: false,
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
        reservaEmergencia: false,
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

  describe("listarVinculos / valorAtualCentavos", () => {
    it("cada balde traz o patrimônio consolidado da sessão VIGENTE mais recente por chave_export", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "PRIO3", alvo_id: alvo.id } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "LEGADO-X", fora_da_carteira: true } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "WRLD11" } });

      const sessao = await criarSessaoVigente("2026-07", "2026-07-28");
      // PRIO3 consolidado em 2 instituições: 300_000 + 100_000 = 400_000.
      await criarPosicao(sessao.id, "PRIO3", 300_000, "Itaú");
      await criarPosicao(sessao.id, "PRIO3", 100_000, "Nubank");
      await criarPosicao(sessao.id, "LEGADO-X", 50_000);
      await criarPosicao(sessao.id, "WRLD11", 20_000);

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.vinculados).toEqual([
        { chaveExport: "PRIO3", alvoId: alvo.id, nomeAlvo: "Ações BR", valorAtualCentavos: 400_000 },
      ]);
      expect(vinculos.foraDaCarteira).toEqual([
        { chaveExport: "LEGADO-X", valorAtualCentavos: 50_000 },
      ]);
      expect(vinculos.pendentes).toEqual([{ chaveExport: "WRLD11", valorAtualCentavos: 20_000 }]);
    });

    it("chave_export sem posição na sessão VIGENTE mais recente recebe valorAtualCentavos = 0", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "PRIO3", alvo_id: alvo.id } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "ZERADO", alvo_id: alvo.id } });

      const sessao = await criarSessaoVigente("2026-07", "2026-07-28");
      await criarPosicao(sessao.id, "PRIO3", 100_000);
      // ZERADO nunca teve posição na sessão vigente (ativo vendido/liquidado).

      const vinculos = await mapeamentoService.listarVinculos();

      const zerado = vinculos.vinculados.find((v) => v.chaveExport === "ZERADO");
      expect(zerado?.valorAtualCentavos).toBe(0);
    });

    it("considera apenas a sessão VIGENTE mais recente, ignorando sessões SUBSTITUIDO", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "PRIO3", alvo_id: alvo.id } });

      const sessaoAntiga = await criarSessaoVigente("2026-06", "2026-06-28", "SUBSTITUIDO");
      await criarPosicao(sessaoAntiga.id, "PRIO3", 999_999);

      const sessaoAtual = await criarSessaoVigente("2026-07", "2026-07-28", "VIGENTE");
      await criarPosicao(sessaoAtual.id, "PRIO3", 111_000);

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.vinculados).toEqual([
        { chaveExport: "PRIO3", alvoId: alvo.id, nomeAlvo: "Ações BR", valorAtualCentavos: 111_000 },
      ]);
    });

    it("sem nenhuma sessão VIGENTE (app recém-instalado), todos os valores são 0 e nenhum erro é lançado", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "PRIO3", alvo_id: alvo.id } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "LEGADO-X", fora_da_carteira: true } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "WRLD11" } });

      // Só existe sessão SUBSTITUIDO — nenhuma VIGENTE.
      const sessaoSubstituida = await criarSessaoVigente("2026-06", "2026-06-28", "SUBSTITUIDO");
      await criarPosicao(sessaoSubstituida.id, "PRIO3", 500_000);

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.vinculados).toEqual([
        { chaveExport: "PRIO3", alvoId: alvo.id, nomeAlvo: "Ações BR", valorAtualCentavos: 0 },
      ]);
      expect(vinculos.foraDaCarteira).toEqual([{ chaveExport: "LEGADO-X", valorAtualCentavos: 0 }]);
      expect(vinculos.pendentes).toEqual([{ chaveExport: "WRLD11", valorAtualCentavos: 0 }]);
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

  describe("balde ignorados (feature 002, FR-001, contracts/server-actions.md §vinculos.ts)", () => {
    it("chave_export com ignorar_no_import=true vai para o balde ignorados, nunca para vinculados; sem posicao_manual substituta, alvoId/nomeAlvo são null", async () => {
      // Invariante (data-model.md): ignorar_no_import=true sempre com alvo_id
      // null — não é mais o registro `ativo_mapeado` que carrega o alvo do
      // balde ignorados.
      await prisma.ativo_mapeado.create({
        data: {
          chave_export: "TESOURO-IGNORADO",
          alvo_id: null,
          fora_da_carteira: false,
          ignorar_no_import: true,
        },
      });

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.vinculados).toEqual([]);
      expect(vinculos.pendentes).toEqual([]);
      expect(vinculos.ignorados).toEqual([
        {
          chaveExport: "TESOURO-IGNORADO",
          alvoId: null,
          nomeAlvo: null,
          valorAtualCentavos: 0,
          posicaoManualPendente: true,
        },
      ]);
    });

    it("valorAtualCentavos do balde ignorados é o valor bruto consolidado do CSV (só referência — motor usa a posicao_manual, não este campo)", async () => {
      await prisma.ativo_mapeado.create({
        data: { chave_export: "TESOURO-IGNORADO", alvo_id: null, ignorar_no_import: true },
      });
      const sessao = await criarSessaoVigente("2026-07", "2026-07-28");
      await criarPosicao(sessao.id, "TESOURO-IGNORADO", 999_000);

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.ignorados[0].valorAtualCentavos).toBe(999_000);
    });

    it("posicaoManualPendente=false e alvoId/nomeAlvo preenchidos quando existe posicao_manual ATIVA com chave_export_origem = chaveExport ignorada (match exato)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      await prisma.ativo_mapeado.create({
        data: { chave_export: "TESOURO-IGNORADO", alvo_id: null, ignorar_no_import: true },
      });
      await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029", true, "TESOURO-IGNORADO");

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.ignorados[0].posicaoManualPendente).toBe(false);
      expect(vinculos.ignorados[0].alvoId).toBe(alvo.id);
      expect(vinculos.ignorados[0].nomeAlvo).toBe("Pós-fixado");
    });

    it("posicaoManualPendente volta a true (e alvoId/nomeAlvo voltam a null) quando a posicao_manual substituta está ENCERRADA (ativo=false)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      await prisma.ativo_mapeado.create({
        data: { chave_export: "TESOURO-IGNORADO", alvo_id: null, ignorar_no_import: true },
      });
      await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029", false, "TESOURO-IGNORADO");

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.ignorados[0].posicaoManualPendente).toBe(true);
      expect(vinculos.ignorados[0].alvoId).toBeNull();
      expect(vinculos.ignorados[0].nomeAlvo).toBeNull();
    });

    it("posicaoManualPendente é calculado por match EXATO de chave_export_origem — posicao_manual ativa com chave_export_origem de OUTRA chave não conta", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      await prisma.ativo_mapeado.create({
        data: { chave_export: "TESOURO-IGNORADO", alvo_id: null, ignorar_no_import: true },
      });
      // `chave_export_origem` é FK para `ativo_mapeado.chave_export` — a
      // "outra chave" precisa existir para a posicao_manual referenciá-la.
      await prisma.ativo_mapeado.create({
        data: { chave_export: "OUTRA-CHAVE-IGNORADA", alvo_id: null, ignorar_no_import: true },
      });
      // Substituta existe, mas aponta para outra chave_export_origem.
      await criarPosicaoManualAtiva(alvo.id, "CDB-OUTRO", true, "OUTRA-CHAVE-IGNORADA");

      const vinculos = await mapeamentoService.listarVinculos();
      const tesouroIgnorado = vinculos.ignorados.find((i) => i.chaveExport === "TESOURO-IGNORADO")!;

      expect(tesouroIgnorado.posicaoManualPendente).toBe(true);
      expect(tesouroIgnorado.alvoId).toBeNull();
    });

    it("posicao_manual ativa SEM chave_export_origem (nunca vinculada a nenhum ignorado) não conta como substituta de ninguém", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      await prisma.ativo_mapeado.create({
        data: { chave_export: "TESOURO-IGNORADO", alvo_id: null, ignorar_no_import: true },
      });
      await criarPosicaoManualAtiva(alvo.id, "CDB-AVULSO"); // chaveExportOrigem omitida -> null

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.ignorados[0].posicaoManualPendente).toBe(true);
      expect(vinculos.ignorados[0].alvoId).toBeNull();
    });
  });

  describe("vincularAtivo — forma ignorarNoImport (feature 002, FR-001, revertido: sem sub-modo de alvo)", () => {
    it("{chaveExport, ignorarNoImport:true} marca ignorar_no_import=true, alvo_id=null e fora_da_carteira=false — funciona mesmo sem NENHUM alvo pré-existente no banco", async () => {
      // Nenhum alvo criado propositalmente: a forma "Ignorar" não recebe
      // (nem exige) alvo algum — ação de um clique.
      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "TESOURO-IGNORADO",
        ignorarNoImport: true,
      });

      expect(resultado).toEqual({
        chaveExport: "TESOURO-IGNORADO",
        alvoId: null,
        nomeAlvo: null,
        foraDaCarteira: false,
        reservaEmergencia: false,
        ignorarNoImport: true,
        posicaoManualPendente: true,
      });

      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "TESOURO-IGNORADO" },
      });
      expect(registro.ignorar_no_import).toBe(true);
      expect(registro.alvo_id).toBeNull();
      expect(registro.fora_da_carteira).toBe(false);

      // Some do balde pendentes/vinculados; aparece só em ignorados.
      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.pendentes).toEqual([]);
      expect(vinculos.vinculados).toEqual([]);
      expect(vinculos.ignorados.map((i) => i.chaveExport)).toEqual(["TESOURO-IGNORADO"]);
    });

    it("posicaoManualPendente=false na resposta de vincularAtivo quando já existe posicao_manual ativa com chave_export_origem = chaveExport ignorada (match exato, não por alvo)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      // `chave_export_origem` é FK para `ativo_mapeado.chave_export` — precisa
      // existir (mesmo que ainda pendente) antes da posicao_manual referenciá-la.
      await prisma.ativo_mapeado.create({ data: { chave_export: "TESOURO-IGNORADO" } });
      await criarPosicaoManualAtiva(alvo.id, "CDB-ITAU-2029", true, "TESOURO-IGNORADO");

      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "TESOURO-IGNORADO",
        ignorarNoImport: true,
      });

      expect(resultado.posicaoManualPendente).toBe(false);
      expect(resultado.alvoId).toBe(alvo.id);
      expect(resultado.nomeAlvo).toBe("Pós-fixado");
    });

    it("as 3 formas pré-existentes de vincularAtivo continuam sem os campos ignorarNoImport/posicaoManualPendente na resposta (shape preservado)", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);

      const vinculado = await mapeamentoService.vincularAtivo({ chaveExport: "PRIO3", alvoId: alvo.id });
      expect(vinculado.ignorarNoImport).toBeUndefined();
      expect(vinculado.posicaoManualPendente).toBeUndefined();

      const foraDaCarteira = await mapeamentoService.vincularAtivo({
        chaveExport: "LEGADO-X",
        foraDaCarteira: true,
      });
      expect(foraDaCarteira.ignorarNoImport).toBeUndefined();
      expect(foraDaCarteira.posicaoManualPendente).toBeUndefined();

      const novoAlvo = await mapeamentoService.vincularAtivo({
        chaveExport: "HGLG11",
        novoAlvo: { nome: "FIIs", percentualBps: 3000 },
      });
      expect(novoAlvo.ignorarNoImport).toBeUndefined();
      expect(novoAlvo.posicaoManualPendente).toBeUndefined();
    });

    it("ignorar um ativo já marcado fora-da-carteira (não só vinculado) também funciona — troca fora_da_carteira por ignorar_no_import, alvo_id continua null (UI: botão Ignorar na seção 'Fora da carteira alvo')", async () => {
      await mapeamentoService.vincularAtivo({ chaveExport: "CDB-LEGADO", foraDaCarteira: true });

      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "CDB-LEGADO",
        ignorarNoImport: true,
      });

      expect(resultado).toEqual({
        chaveExport: "CDB-LEGADO",
        alvoId: null,
        nomeAlvo: null,
        foraDaCarteira: false,
        reservaEmergencia: false,
        ignorarNoImport: true,
        posicaoManualPendente: true,
      });

      expect(await prisma.ativo_mapeado.count({ where: { chave_export: "CDB-LEGADO" } })).toBe(1);
      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "CDB-LEGADO" },
      });
      expect(registro.fora_da_carteira).toBe(false);
      expect(registro.ignorar_no_import).toBe(true);
      expect(registro.alvo_id).toBeNull();

      // Some do balde fora-da-carteira; aparece só em ignorados.
      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.foraDaCarteira).toEqual([]);
      expect(vinculos.ignorados.map((i) => i.chaveExport)).toEqual(["CDB-LEGADO"]);
    });

    it("marcar ignorado (reverter) uma chave já vinculada a um alvo zera o alvo_id (upsert, sem duplicar ativo_mapeado)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);
      await mapeamentoService.vincularAtivo({ chaveExport: "TESOURO-IGNORADO", alvoId: alvo.id });

      await mapeamentoService.vincularAtivo({
        chaveExport: "TESOURO-IGNORADO",
        ignorarNoImport: true,
      });

      expect(await prisma.ativo_mapeado.count({ where: { chave_export: "TESOURO-IGNORADO" } })).toBe(1);
      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "TESOURO-IGNORADO" },
      });
      expect(registro.alvo_id).toBeNull();
      expect(registro.ignorar_no_import).toBe(true);
    });
  });

  describe("balde reserva de emergência (novo estado isolado, mutuamente exclusivo com alvo_id/fora_da_carteira/ignorar_no_import)", () => {
    it("{chaveExport, reservaEmergencia: true} marca reserva_emergencia=true, zerando alvo_id/fora_da_carteira/ignorar_no_import", async () => {
      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "RESERVA-CDB",
        reservaEmergencia: true,
      });

      expect(resultado).toEqual({
        chaveExport: "RESERVA-CDB",
        alvoId: null,
        nomeAlvo: null,
        foraDaCarteira: false,
        reservaEmergencia: true,
      });

      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "RESERVA-CDB" },
      });
      expect(registro.reserva_emergencia).toBe(true);
      expect(registro.alvo_id).toBeNull();
      expect(registro.fora_da_carteira).toBe(false);
      expect(registro.ignorar_no_import).toBe(false);
    });

    it("listarVinculos classifica reserva_emergencia=true no balde reservaEmergencia, nunca em pendentes/vinculados/foraDaCarteira", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await prisma.ativo_mapeado.create({ data: { chave_export: "PRIO3", alvo_id: alvo.id } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "LEGADO-X", fora_da_carteira: true } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "WRLD11" } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "RESERVA-CDB", reserva_emergencia: true } });

      const vinculos = await mapeamentoService.listarVinculos();

      expect(vinculos.reservaEmergencia).toEqual([
        { chaveExport: "RESERVA-CDB", valorAtualCentavos: 0 },
      ]);
      expect(vinculos.pendentes.map((p) => p.chaveExport)).not.toContain("RESERVA-CDB");
      expect(vinculos.vinculados.map((v) => v.chaveExport)).not.toContain("RESERVA-CDB");
      expect(vinculos.foraDaCarteira.map((f) => f.chaveExport)).not.toContain("RESERVA-CDB");
      // Os demais baldes continuam intactos.
      expect(vinculos.pendentes).toEqual([{ chaveExport: "WRLD11", valorAtualCentavos: 0 }]);
      expect(vinculos.vinculados).toEqual([
        { chaveExport: "PRIO3", alvoId: alvo.id, nomeAlvo: "Ações BR", valorAtualCentavos: 0 },
      ]);
      expect(vinculos.foraDaCarteira).toEqual([{ chaveExport: "LEGADO-X", valorAtualCentavos: 0 }]);
    });

    it("contarPendencias não conta um ativo em reserva de emergência como pendência", async () => {
      await prisma.ativo_mapeado.create({ data: { chave_export: "RESERVA-CDB", reserva_emergencia: true } });
      await prisma.ativo_mapeado.create({ data: { chave_export: "WRLD11" } });

      expect(await mapeamentoService.contarPendencias()).toBe(1);
    });

    it("marcar reserva de emergência depois de já estar ignorado (ignorar_no_import=true) zera ignorar_no_import e alvo_id (exclusão mútua)", async () => {
      await mapeamentoService.vincularAtivo({
        chaveExport: "CDB-ITAU",
        ignorarNoImport: true,
      });

      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "CDB-ITAU",
        reservaEmergencia: true,
      });

      expect(resultado).toEqual({
        chaveExport: "CDB-ITAU",
        alvoId: null,
        nomeAlvo: null,
        foraDaCarteira: false,
        reservaEmergencia: true,
      });

      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "CDB-ITAU" },
      });
      expect(registro.reserva_emergencia).toBe(true);
      expect(registro.ignorar_no_import).toBe(false);
      expect(registro.alvo_id).toBeNull();

      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.ignorados).toEqual([]);
      expect(vinculos.reservaEmergencia.map((r) => r.chaveExport)).toEqual(["CDB-ITAU"]);
    });

    it("marcar ignorado (ignorarNoImport:true) depois de já estar em reserva de emergência zera reserva_emergencia (exclusão mútua no outro sentido); alvo_id continua null", async () => {
      await mapeamentoService.vincularAtivo({ chaveExport: "CDB-ITAU", reservaEmergencia: true });

      const resultado = await mapeamentoService.vincularAtivo({
        chaveExport: "CDB-ITAU",
        ignorarNoImport: true,
      });

      expect(resultado).toEqual({
        chaveExport: "CDB-ITAU",
        alvoId: null,
        nomeAlvo: null,
        foraDaCarteira: false,
        reservaEmergencia: false,
        ignorarNoImport: true,
        posicaoManualPendente: true,
      });

      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "CDB-ITAU" },
      });
      expect(registro.reserva_emergencia).toBe(false);
      expect(registro.ignorar_no_import).toBe(true);
      expect(registro.alvo_id).toBeNull();

      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.reservaEmergencia).toEqual([]);
      expect(vinculos.ignorados.map((i) => i.chaveExport)).toEqual(["CDB-ITAU"]);
    });

    it("marcar reserva de emergência depois de já vinculado a um alvo zera alvo_id; marcar fora-da-carteira depois de já em reserva zera reserva_emergencia (ambos os sentidos com alvoId/foraDaCarteira)", async () => {
      const alvo = await criarAlvo("Ações BR", 10000);
      await mapeamentoService.vincularAtivo({ chaveExport: "PRIO3", alvoId: alvo.id });

      const paraReserva = await mapeamentoService.vincularAtivo({
        chaveExport: "PRIO3",
        reservaEmergencia: true,
      });
      expect(paraReserva.reservaEmergencia).toBe(true);
      expect(paraReserva.alvoId).toBeNull();

      const paraForaDaCarteira = await mapeamentoService.vincularAtivo({
        chaveExport: "PRIO3",
        foraDaCarteira: true,
      });
      expect(paraForaDaCarteira.foraDaCarteira).toBe(true);
      expect(paraForaDaCarteira.reservaEmergencia).toBe(false);

      const registro = await prisma.ativo_mapeado.findUniqueOrThrow({ where: { chave_export: "PRIO3" } });
      expect(registro.reserva_emergencia).toBe(false);
      expect(registro.fora_da_carteira).toBe(true);
      expect(registro.alvo_id).toBeNull();
    });

    it("chave_export já marcada reserva_emergencia=true não vira pendência de novo mesmo reaparecendo num import novo", async () => {
      await prisma.ativo_mapeado.create({ data: { chave_export: "RESERVA-CDB", reserva_emergencia: true } });

      const chavesNovas = await simularImportCriaPendenteSeNovo(["RESERVA-CDB"]);
      expect(chavesNovas).toEqual([]);

      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.pendentes).toEqual([]);
      expect(vinculos.reservaEmergencia).toEqual([
        { chaveExport: "RESERVA-CDB", valorAtualCentavos: 0 },
      ]);
      expect(await mapeamentoService.contarPendencias()).toBe(0);
    });

    it("chave_export já marcada ignorar_no_import=true não vira pendência de novo mesmo reaparecendo num import novo", async () => {
      await prisma.ativo_mapeado.create({
        data: { chave_export: "TESOURO-IGNORADO", alvo_id: null, ignorar_no_import: true },
      });

      const chavesNovas = await simularImportCriaPendenteSeNovo(["TESOURO-IGNORADO"]);
      expect(chavesNovas).toEqual([]);

      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.pendentes).toEqual([]);
      expect(vinculos.ignorados.map((i) => i.chaveExport)).toEqual(["TESOURO-IGNORADO"]);
      expect(await mapeamentoService.contarPendencias()).toBe(0);
    });
  });
});
