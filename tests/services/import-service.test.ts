/**
 * tests/services/import-service.test.ts — testes de integração (T037) de
 * src/services/import-service.ts contra um SQLite TEMPORÁRIO, isolado do
 * `data/app.db` real, e gravando backups num diretório TEMPORÁRIO (nunca
 * `backups/` do projeto).
 *
 * Mesma estratégia de tests/services/aporte-service.test.ts e
 * tests/services/backup-service.test.ts: `process.env.DATABASE_URL` é
 * definido para um arquivo `.db` temporário ANTES de importar
 * `@/db/client`/`@/services/import-service` (imports dinâmicos dentro de
 * `beforeAll`, nunca estáticos no topo). `process.cwd()` não é alterado —
 * em vez disso, `backup-service.criarBackup`/`aplicarRetencao` são
 * chamados pelo próprio import-service SEM `backupsDir` explícito, então
 * este arquivo espiona `executarBackupComRetencao` para verificar a ordem
 * de chamadas sem gravar em `<cwd>/backups` real (mock que delega para a
 * implementação real, mas redirecionando `backupsDir` para um diretório
 * temporário).
 *
 * CSVs sintéticos: construídos em memória (Uint8Array), sem depender de
 * docs/samples/ (dados reais, gitignored).
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
let importService: typeof import("@/services/import-service");
let backupService: typeof import("@/services/backup-service");
let spyBackup: ReturnType<typeof vi.spyOn>;

const COLUNAS = ["Ação", "Quantidade", "Patrimônio Hoje", "Tipo de Grupo", "dataUltimaCotacao"];

function bytesDoArquivo(linhas: string[]): Uint8Array {
  return new TextEncoder().encode(linhas.join("\n"));
}

function header(): string {
  return COLUNAS.join(";");
}

function linha(opts?: {
  acao?: string;
  quantidade?: string;
  patrimonioHoje?: string;
  tipoGrupo?: string;
  dataUltimaCotacao?: string;
}): string {
  const {
    acao = "PRIO3",
    quantidade = "100",
    patrimonioHoje = "1234.56",
    tipoGrupo = "ACOES",
    dataUltimaCotacao = "2026-07-28T03:00:00.000Z",
  } = opts ?? {};
  return [acao, quantidade, patrimonioHoje, tipoGrupo, dataUltimaCotacao].join(";");
}

function arquivo(nomeArquivo: string, linhas: string[]): ArquivoImport {
  return { nomeArquivo, conteudo: bytesDoArquivo(linhas) };
}

/** Arquivo sintético válido de uma instituição, com 1 ativo (ou os informados). */
function arquivoInstituicao(instituicao: string, linhasDados: string[]): ArquivoImport {
  return arquivo(`Export_${instituicao}.csv`, [header(), ...linhasDados]);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-service-test-"));
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
  backupService = await import("@/services/backup-service");
  importService = await import("@/services/import-service");
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
  if (fs.existsSync(backupsDir)) fs.rmSync(backupsDir, { recursive: true, force: true });
  vi.restoreAllMocks();

  // `confirmarImport` chama `executarBackupComRetencao()` sem override de
  // `backupsDir` (a função não expõe esse parâmetro — usa o default
  // `<cwd>/backups`, que aqui seria a pasta REAL do repositório). Para
  // NUNCA gravar `.db` reais fora do diretório temporário do teste, todo
  // teste deste arquivo roda com o backup mockado por padrão (no-op, sem
  // tocar em disco); o comportamento real de `executarBackupComRetencao`
  // já é coberto integralmente por tests/services/backup-service.test.ts —
  // aqui o que importa é SE e QUANDO ele é chamado, não o que ele grava.
  spyBackup = vi.spyOn(backupService, "executarBackupComRetencao").mockResolvedValue({
    backup: { caminho: path.join(backupsDir, "mock.db"), nomeArquivo: "mock.db" },
    removidos: [],
  });
});

describe("import-service", () => {
  describe("confirmarImport — erro de parse ⇒ nada persiste", () => {
    it("um arquivo com erro invalida a operação inteira (nem sessão, nem posições, nem pendências)", async () => {
      const bom = arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]);
      const ruim = arquivoInstituicao("Nubank", [linha({ patrimonioHoje: "null" })]);

      const resultado = await importService.confirmarImport({
        arquivos: [bom, ruim],
        mesReferencia: "2026-07",
      });

      expect(resultado.ok).toBe(false);
      if (resultado.ok) return;
      expect(resultado.erros).toBeDefined();
      expect(resultado.erros!.length).toBeGreaterThan(0);

      expect(await prisma.sessao_import.count()).toBe(0);
      expect(await prisma.posicao.count()).toBe(0);
      expect(await prisma.ativo_mapeado.count()).toBe(0);
    });

    it("previewImport também retorna ok:false com os erros, sem persistir nada", async () => {
      const ruim = arquivoInstituicao("Itaú", [linha({ patrimonioHoje: "abc" })]);

      const resultado = await importService.previewImport([ruim]);

      expect(resultado.ok).toBe(false);
      if (resultado.ok) return;
      expect(resultado.erros.length).toBeGreaterThan(0);
      expect(await prisma.sessao_import.count()).toBe(0);
    });
  });

  describe("re-import do mesmo mês", () => {
    it("a sessão anterior vira SUBSTITUIDO e só uma fica VIGENTE por mês", async () => {
      const primeiro = arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]);
      const r1 = await importService.confirmarImport({
        arquivos: [primeiro],
        mesReferencia: "2026-07",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      const segundo = arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })]);
      const r2 = await importService.confirmarImport({
        arquivos: [segundo],
        mesReferencia: "2026-07",
      });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;

      expect(r2.sessaoId).not.toBe(r1.sessaoId);

      const sessaoAntiga = await prisma.sessao_import.findUniqueOrThrow({
        where: { id: r1.sessaoId },
      });
      const sessaoNova = await prisma.sessao_import.findUniqueOrThrow({
        where: { id: r2.sessaoId },
      });

      expect(sessaoAntiga.status).toBe("SUBSTITUIDO");
      expect(sessaoNova.status).toBe("VIGENTE");

      const vigentesDoMes = await prisma.sessao_import.findMany({
        where: { mes_referencia: "2026-07", status: "VIGENTE" },
      });
      expect(vigentesDoMes).toHaveLength(1);
      expect(vigentesDoMes[0].id).toBe(r2.sessaoId);

      // Posições da sessão antiga permanecem intocadas (imutabilidade).
      const posicoesAntigas = await prisma.posicao.findMany({
        where: { sessao_import_id: r1.sessaoId },
      });
      expect(posicoesAntigas).toHaveLength(1);
      expect(posicoesAntigas[0].patrimonio_hoje_centavos).toBe(123456);
    });
  });

  describe("mes_referencia editado manualmente", () => {
    it("é respeitado em confirmarImport mesmo diferindo do proposto pelo preview", async () => {
      const arq = arquivoInstituicao("Itaú", [
        linha({ acao: "PRIO3", dataUltimaCotacao: "2026-08-01T03:00:00.000Z" }),
      ]);

      const preview = await importService.previewImport([arq]);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.mesReferenciaProposto).toBe("2026-08");

      // Usuário edita para julho (ex.: export de 01/08 com posições de 31/07).
      const confirmado = await importService.confirmarImport({
        arquivos: [arq],
        mesReferencia: "2026-07",
      });
      expect(confirmado.ok).toBe(true);
      if (!confirmado.ok) return;

      const sessao = await prisma.sessao_import.findUniqueOrThrow({
        where: { id: confirmado.sessaoId },
      });
      expect(sessao.mes_referencia).toBe("2026-07");
    });
  });

  describe("instituição faltante — confirmação explícita", () => {
    it("sem confirmouInstituicoesFaltantes ⇒ recusa e nada persiste", async () => {
      const r1 = await importService.confirmarImport({
        arquivos: [
          arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]),
          arquivoInstituicao("Nubank", [linha({ acao: "WRLD11" })]),
        ],
        mesReferencia: "2026-06",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      const somenteItau = arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]);
      const r2 = await importService.confirmarImport({
        arquivos: [somenteItau],
        mesReferencia: "2026-07",
      });

      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.instituicoesFaltantes).toEqual(["Nubank"]);

      // Nada novo persistido: continua só a sessão de junho.
      expect(await prisma.sessao_import.count()).toBe(1);
    });

    it("com confirmouInstituicoesFaltantes: true ⇒ prossegue normalmente", async () => {
      await importService.confirmarImport({
        arquivos: [
          arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]),
          arquivoInstituicao("Nubank", [linha({ acao: "WRLD11" })]),
        ],
        mesReferencia: "2026-06",
      });

      const somenteItau = arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]);
      const r2 = await importService.confirmarImport({
        arquivos: [somenteItau],
        mesReferencia: "2026-07",
        confirmouInstituicoesFaltantes: true,
      });

      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(await prisma.sessao_import.count()).toBe(2);
    });

    it("previewImport expõe instituicoesFaltantes sem bloquear nada (é só leitura)", async () => {
      await importService.confirmarImport({
        arquivos: [
          arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]),
          arquivoInstituicao("Avenue", [linha({ acao: "AAPL" })]),
        ],
        mesReferencia: "2026-06",
      });

      const somenteItau = arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]);
      const preview = await importService.previewImport([somenteItau]);

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.instituicoesFaltantes).toEqual(["Avenue"]);
    });
  });

  describe("backup antes da transação", () => {
    it("executarBackupComRetencao é chamado antes de qualquer escrita de confirmarImport", async () => {
      // Reusa o spy padrão instalado no beforeEach (já um mock no-op) —
      // adiciona rastreio de ordem de chamada sem criar um segundo spy
      // sobre o mesmo método (vi.spyOn duplicado sobre um método já
      // espionado gera um novo wrapper cada vez, mas as chamadas via
      // import-service passam pelo binding vigente no momento da chamada;
      // reaproveitar a instância evita qualquer ambiguidade).
      spyBackup.mockImplementation(async () => ({
        backup: { caminho: path.join(backupsDir, "mock.db"), nomeArquivo: "mock.db" },
        removidos: [],
      }));

      // A criação da sessão acontece dentro de `prisma.$transaction(async
      // (tx) => ...)` — `tx` é um client próprio da transação, distinto do
      // `prisma.sessao_import` de nível superior, então o ponto observável
      // aqui é a chamada a `$transaction` em si (chamada exatamente uma vez
      // por confirmarImport, sempre pelo client de nível superior).
      const spyTransacao = vi.spyOn(prisma, "$transaction");

      const arq = arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]);
      const resultado = await importService.confirmarImport({
        arquivos: [arq],
        mesReferencia: "2026-07",
      });

      expect(resultado.ok).toBe(true);
      expect(spyBackup).toHaveBeenCalledTimes(1);
      expect(spyTransacao).toHaveBeenCalledTimes(1);

      const ordemBackup = spyBackup.mock.invocationCallOrder[0];
      const ordemTransacao = spyTransacao.mock.invocationCallOrder[0];
      expect(ordemBackup).toBeLessThan(ordemTransacao);
    });

    it("backup real cria um arquivo .db válido em backupsDir (comportamento herdado de backup-service, T035)", async () => {
      // Chama o backupService diretamente (sem mock, com backupsDir de
      // teste explícito) só para reforçar que a peça que import-service
      // invoca produz um arquivo válido — sem tocar em `<cwd>/backups`
      // real. O comportamento completo de criarBackup/aplicarRetencao já
      // é coberto por tests/services/backup-service.test.ts.
      vi.restoreAllMocks();
      const resultado = await backupService.criarBackup({ backupsDir });
      expect(fs.existsSync(resultado.caminho)).toBe(true);
    });
  });

  describe("consolidação por chave em instituições diferentes", () => {
    it("2 arquivos com a mesma chave_export em instituições diferentes geram 2 linhas de posicao distintas", async () => {
      const itau = arquivoInstituicao("Itaú", [linha({ acao: "WRLD11", patrimonioHoje: "1000.00" })]);
      const nubank = arquivoInstituicao("Nubank", [linha({ acao: "WRLD11", patrimonioHoje: "500.00" })]);

      const resultado = await importService.confirmarImport({
        arquivos: [itau, nubank],
        mesReferencia: "2026-07",
      });
      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;

      const posicoes = await prisma.posicao.findMany({
        where: { sessao_import_id: resultado.sessaoId },
      });
      expect(posicoes).toHaveLength(2);
      expect(posicoes.map((p) => p.instituicao).sort()).toEqual(["Itaú", "Nubank"]);
      expect(posicoes.every((p) => p.chave_export === "WRLD11")).toBe(true);

      // Só 1 ativo_mapeado pendente para a chave (não duplicado por instituição).
      const mapeamentos = await prisma.ativo_mapeado.findMany({
        where: { chave_export: "WRLD11" },
      });
      expect(mapeamentos).toHaveLength(1);
      expect(resultado.pendenciasVinculo).toEqual(["WRLD11"]);
    });

    it("diff consolida por chave_export somando instituições antes de comparar", async () => {
      const itauJunho = arquivoInstituicao("Itaú", [linha({ acao: "WRLD11", patrimonioHoje: "1000.00" })]);
      const nubankJunho = arquivoInstituicao("Nubank", [linha({ acao: "WRLD11", patrimonioHoje: "500.00" })]);
      await importService.confirmarImport({
        arquivos: [itauJunho, nubankJunho],
        mesReferencia: "2026-06",
      });
      // total junho consolidado: 1500.00

      // julho: mesma chave, mesmo total consolidado (1000 + 550 = 1550,
      // variação de ~3.3% — abaixo do limiar de 20%, não deve aparecer
      // em variacoesGrandes).
      const itauJulho = arquivoInstituicao("Itaú", [linha({ acao: "WRLD11", patrimonioHoje: "1000.00" })]);
      const nubankJulho = arquivoInstituicao("Nubank", [linha({ acao: "WRLD11", patrimonioHoje: "550.00" })]);
      const preview = await importService.previewImport([itauJulho, nubankJulho]);

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.diff?.novos).toEqual([]);
      expect(preview.diff?.sumiram).toEqual([]);
      expect(preview.diff?.variacoesGrandes).toEqual([]);
    });
  });

  describe("diff — novos, sumiram e variações grandes", () => {
    it("identifica ativo novo, ativo que sumiu e variação >= 20% contra a sessão anterior do mesmo mês", async () => {
      await importService.confirmarImport({
        arquivos: [
          arquivoInstituicao("Itaú", [
            linha({ acao: "PRIO3", patrimonioHoje: "1000.00" }),
            linha({ acao: "VALE3", patrimonioHoje: "2000.00" }),
          ]),
        ],
        mesReferencia: "2026-07",
      });

      // Reimport do mesmo mês: PRIO3 some, VALE3 varia +50% (>=20%), HGLG11 é novo.
      const preview = await importService.previewImport([
        arquivoInstituicao("Itaú", [
          linha({ acao: "VALE3", patrimonioHoje: "3000.00" }),
          linha({ acao: "HGLG11", patrimonioHoje: "800.00" }),
        ]),
      ]);

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.diff?.novos).toEqual(["HGLG11"]);
      expect(preview.diff?.sumiram).toEqual(["PRIO3"]);
      expect(preview.diff?.variacoesGrandes).toEqual([
        expect.objectContaining({
          chaveExport: "VALE3",
          valorAnteriorCentavos: 200000,
          valorNovoCentavos: 300000,
          variacaoPercentual: 50,
        }),
      ]);
    });

    it("sem sessão anterior nenhuma, diff é omitido (undefined)", async () => {
      const preview = await importService.previewImport([
        arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]),
      ]);

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.diff).toBeUndefined();
      expect(preview.instituicoesFaltantes).toBeUndefined();
      expect(preview.avisoSubstituicao).toBeUndefined();
    });
  });

  describe("avisoSubstituicao", () => {
    it("aparece quando já existe sessão VIGENTE do mesmo mês proposto, com a data anterior", async () => {
      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ dataUltimaCotacao: "2026-07-27T03:00:00.000Z" })])],
        mesReferencia: "2026-07",
      });
      expect(r1.ok).toBe(true);

      const preview = await importService.previewImport([
        arquivoInstituicao("Itaú", [linha({ dataUltimaCotacao: "2026-07-28T03:00:00.000Z" })]),
      ]);

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.mesReferenciaProposto).toBe("2026-07");
      expect(preview.avisoSubstituicao).toBeDefined();
      expect(preview.avisoSubstituicao?.mes).toBe("2026-07");
      expect(preview.avisoSubstituicao?.dataAnterior).toBe(
        new Date("2026-07-27T03:00:00.000Z").toISOString(),
      );
    });
  });

  describe("vínculo memorizado entre imports", () => {
    it("chave já com ativo_mapeado de import anterior não gera pendência de novo", async () => {
      const primeiro = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-06",
      });
      expect(primeiro.ok).toBe(true);
      if (!primeiro.ok) return;
      expect(primeiro.pendenciasVinculo).toEqual(["PRIO3"]);

      // Usuário resolve o vínculo (simulando mapeamento-service, T040, que
      // ainda não existe): vincula a um alvo criado na hora.
      const alvo = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 10000, vigencia_inicio: new Date("2026-01-01") },
      });
      await prisma.ativo_mapeado.update({
        where: { chave_export: "PRIO3" },
        data: { alvo_id: alvo.id },
      });

      const segundo = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })])],
        mesReferencia: "2026-07",
      });
      expect(segundo.ok).toBe(true);
      if (!segundo.ok) return;

      // PRIO3 já estava vinculado — não deve virar pendência de novo.
      expect(segundo.pendenciasVinculo).toEqual([]);

      // E o ativo_mapeado continua único (não duplicado, não recriado).
      const mapeamentos = await prisma.ativo_mapeado.findMany({ where: { chave_export: "PRIO3" } });
      expect(mapeamentos).toHaveLength(1);
      expect(mapeamentos[0].alvo_id).toBe(alvo.id);
    });

    it("ativo marcado fora_da_carteira também não vira pendência de novo", async () => {
      const primeiro = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "LEGADO-X" })])],
        mesReferencia: "2026-06",
      });
      expect(primeiro.ok).toBe(true);
      if (!primeiro.ok) return;

      await prisma.ativo_mapeado.update({
        where: { chave_export: "LEGADO-X" },
        data: { fora_da_carteira: true },
      });

      const segundo = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "LEGADO-X" })])],
        mesReferencia: "2026-07",
      });
      expect(segundo.ok).toBe(true);
      if (!segundo.ok) return;
      expect(segundo.pendenciasVinculo).toEqual([]);
    });
  });

  describe("import com 0 arquivos (lacuna de cobertura investigada)", () => {
    it("previewImport([]) sucede com lista de arquivos vazia, sem erro", async () => {
      const preview = await importService.previewImport([]);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.arquivos).toEqual([]);
    });

    it("confirmarImport com arquivos:[] e NENHUMA sessão anterior sucede e cria uma sessão vazia (0 posições, 0 pendências) — comportamento atual documentado, não bloqueado por nenhuma validação", async () => {
      // Não há checagem de completude aqui porque não existe sessão VIGENTE
      // anterior nenhuma (instituicoesFaltantes só compara contra uma sessão
      // de referência que ainda não existe) — este é o único caso em que um
      // import de 0 arquivos passa sem exigir confirmação explícita.
      const resultado = await importService.confirmarImport({
        arquivos: [],
        mesReferencia: "2026-07",
      });

      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;
      expect(resultado.pendenciasVinculo).toEqual([]);

      const sessao = await prisma.sessao_import.findUniqueOrThrow({
        where: { id: resultado.sessaoId },
      });
      expect(sessao.status).toBe("VIGENTE");
      expect(JSON.parse(sessao.instituicoes)).toEqual([]);

      const posicoes = await prisma.posicao.count({ where: { sessao_import_id: resultado.sessaoId } });
      expect(posicoes).toBe(0);
    });

    it("confirmarImport com arquivos:[] QUANDO já existe sessão VIGENTE do mesmo mês é bloqueado pela checagem de instituição faltante (0 arquivos = todas as instituições anteriores 'faltam')", async () => {
      const primeiro = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-07",
      });
      expect(primeiro.ok).toBe(true);

      const segundo = await importService.confirmarImport({
        arquivos: [],
        mesReferencia: "2026-07",
      });

      expect(segundo.ok).toBe(false);
      if (segundo.ok) return;
      expect(segundo.instituicoesFaltantes).toEqual(["Itaú"]);

      // A sessão populada original continua VIGENTE — nada foi substituído
      // silenciosamente pelo import vazio.
      const vigentes = await prisma.sessao_import.findMany({
        where: { mes_referencia: "2026-07", status: "VIGENTE" },
      });
      expect(vigentes).toHaveLength(1);
      expect(await prisma.posicao.count()).toBe(1);
    });
  });

  describe("arquivos de instituições duplicadas no mesmo lote", () => {
    it("2 arquivos rotulados com a MESMA instituição e ativos diferentes: ambos persistidos, instituicoes[] duplicada no JSON (sem deduplicação)", async () => {
      const itau1 = arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "1000.00" })]);
      const itau2 = arquivoInstituicao("Itaú", [linha({ acao: "VALE3", patrimonioHoje: "2000.00" })]);

      const resultado = await importService.confirmarImport({
        arquivos: [itau1, itau2],
        mesReferencia: "2026-07",
      });

      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;

      const sessao = await prisma.sessao_import.findUniqueOrThrow({ where: { id: resultado.sessaoId } });
      // Comportamento atual: nenhuma deduplicação de instituições no JSON.
      expect(JSON.parse(sessao.instituicoes)).toEqual(["Itaú", "Itaú"]);

      const posicoes = await prisma.posicao.findMany({ where: { sessao_import_id: resultado.sessaoId } });
      expect(posicoes).toHaveLength(2);
      expect(posicoes.map((p) => p.chave_export).sort()).toEqual(["PRIO3", "VALE3"]);
    });

    it("2 arquivos rotulados com a MESMA instituição e o MESMO ativo repetido: cria 2 linhas de posicao para a mesma chave_export/instituicao — a consolidação por chave (leitura) soma as duas, dobrando silenciosamente o patrimônio se for upload duplicado por engano (nenhuma checagem de duplicidade arquivo-a-arquivo)", async () => {
      const itau1 = arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "1000.00" })]);
      const itau2 = arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "1000.00" })]);

      const resultado = await importService.confirmarImport({
        arquivos: [itau1, itau2],
        mesReferencia: "2026-07",
      });

      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;

      const posicoes = await prisma.posicao.findMany({ where: { sessao_import_id: resultado.sessaoId } });
      // Documenta o comportamento atual: 2 linhas distintas para a mesma
      // chave_export + instituicao (nenhuma fusão nem aviso). Isto NÃO é
      // coberto pela regra de "somar pela chave em instituições diferentes"
      // (seção 4 da spec) — aqui é a MESMA instituição duas vezes no mesmo
      // lote, cenário que a spec não define explicitamente (arquivo por
      // instituição pressupõe 1 arquivo cada). Reportado como observação,
      // não como bug confirmado — ver relatório do engenheiro-testes.
      expect(posicoes).toHaveLength(2);
      expect(posicoes.every((p) => p.chave_export === "PRIO3" && p.instituicao === "Itaú")).toBe(true);
      const totalConsolidado = posicoes.reduce((acc, p) => acc + p.patrimonio_hoje_centavos, 0);
      expect(totalConsolidado).toBe(200_000); // 2x 1000.00 — dobrado, não deduplicado.
    });
  });
});
