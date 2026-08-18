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

    it("chave já marcada reserva_emergencia=true (novo estado isolado) também não vira pendência de novo — estado RESOLVIDO, não bloqueia a calculadora", async () => {
      const primeiro = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "RESERVA-CDB" })])],
        mesReferencia: "2026-06",
      });
      expect(primeiro.ok).toBe(true);
      if (!primeiro.ok) return;
      expect(primeiro.pendenciasVinculo).toEqual(["RESERVA-CDB"]);

      await prisma.ativo_mapeado.update({
        where: { chave_export: "RESERVA-CDB" },
        data: { reserva_emergencia: true },
      });

      const segundo = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "RESERVA-CDB" })])],
        mesReferencia: "2026-07",
      });
      expect(segundo.ok).toBe(true);
      if (!segundo.ok) return;
      expect(segundo.pendenciasVinculo).toEqual([]);
    });

    it("chave já marcada ignorar_no_import=true (bug corrigido: era tratada como pendente em 4 lugares) também não vira pendência de novo — estado RESOLVIDO, não bloqueia a calculadora", async () => {
      const primeiro = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "TESOURO-IGNORADO" })])],
        mesReferencia: "2026-06",
      });
      expect(primeiro.ok).toBe(true);
      if (!primeiro.ok) return;
      expect(primeiro.pendenciasVinculo).toEqual(["TESOURO-IGNORADO"]);

      // Invariante (data-model.md): ignorar_no_import=true sempre com alvo_id
      // null.
      await prisma.ativo_mapeado.update({
        where: { chave_export: "TESOURO-IGNORADO" },
        data: { ignorar_no_import: true, alvo_id: null },
      });

      const segundo = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "TESOURO-IGNORADO" })])],
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

  describe("posições manuais e ajustes na revisão de import (T020, US3)", () => {
    async function criarAlvo(nome: string, percentualBps: number) {
      return prisma.alvo.create({
        data: { nome, percentual_alvo_bps: percentualBps, vigencia_inicio: new Date("2026-01-01") },
      });
    }

    it("previewImport retorna posicoesManuaisRevisao/ajustesRevisao com carry-forward da sessão VIGENTE mais recente", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-06",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      // Vincula PRIO3 a um alvo e cria um ajuste sobre ele.
      await prisma.ativo_mapeado.update({
        where: { chave_export: "PRIO3" },
        data: { alvo_id: alvo.id },
      });
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "PRIO3",
          sessao_import_id: r1.sessaoId,
          valor_investido_corrigido_centavos: 90_000,
        },
      });

      // Cria uma posição manual com snapshot na sessão de junho.
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvo_id: alvo.id,
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManual.id,
          sessao_import_id: r1.sessaoId,
          valor_investido_centavos: 500_000,
          valor_atual_centavos: 520_000,
        },
      });

      const preview = await importService.previewImport([
        arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })]),
      ]);

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      expect(preview.incrementosAmbiguosPendentes).toEqual([]);

      expect(preview.posicoesManuaisRevisao).toHaveLength(1);
      expect(preview.posicoesManuaisRevisao[0]).toMatchObject({
        posicaoManualId: posicaoManual.id,
        chaveManual: "CDB-ITAU-2029",
        alvoId: alvo.id,
        valorInvestidoCentavosAnterior: 500_000,
        incrementoPendenteCentavos: 0,
        valorInvestidoCentavosSugerido: 500_000,
        valorAtualCentavosSugerido: 520_000,
      });

      expect(preview.ajustesRevisao).toHaveLength(1);
      expect(preview.ajustesRevisao[0]).toMatchObject({
        chaveExport: "PRIO3",
        alvoId: alvo.id,
        primeiraVez: false,
        valorInvestidoCentavosAnterior: 90_000,
        valorInvestidoCentavosSugerido: 90_000,
      });
    });

    it("previewImport sem nenhuma posição manual/ajuste cadastrado retorna arrays vazios (compatibilidade)", async () => {
      const preview = await importService.previewImport([
        arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })]),
      ]);

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.posicoesManuaisRevisao).toEqual([]);
      expect(preview.ajustesRevisao).toEqual([]);
      expect(preview.incrementosAmbiguosPendentes).toEqual([]);
    });

    it("previewImport retorna incrementosAmbiguosPendentes agregado por alvo, com elegiveis, quando há pendência AMBÍGUA não aplicada (T026, motor-integracao.md §4.2)", async () => {
      const alvo = await criarAlvo("Multimercado ambíguo", 5000);

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-06",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      // 2 posições manuais ativas vinculadas ao mesmo alvo (≥2 elegíveis ⇒
      // ambíguo, mesmo cenário de aporte-service.test.ts §3.2).
      const posicaoManual1 = await prisma.posicao_manual.create({
        data: { chave_manual: "CDB-1", instituicao: "Itaú", descricao: "CDB Um", alvo_id: alvo.id },
      });
      const posicaoManual2 = await prisma.posicao_manual.create({
        data: { chave_manual: "CDB-2", instituicao: "Itaú", descricao: "CDB Dois", alvo_id: alvo.id },
      });

      const aporte = await prisma.aporte.create({
        data: {
          sessao_import_id: r1.sessaoId,
          valor_total_centavos: 80_000,
          valor_dividendos_centavos: 0,
          sugestao: "[]",
          executado: "[]",
          troco_centavos: 0,
        },
      });
      await prisma.incremento_valor_investido_pendente.create({
        data: { alvo_id: alvo.id, aporte_id: aporte.id, valor_incremento_centavos: 80_000 },
      });

      const preview = await importService.previewImport([
        arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })]),
      ]);

      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      expect(preview.incrementosAmbiguosPendentes).toHaveLength(1);
      expect(preview.incrementosAmbiguosPendentes[0]).toMatchObject({
        alvoId: alvo.id,
        nomeAlvo: "Multimercado ambíguo",
        valorPendenteCentavos: 80_000,
      });
      expect(preview.incrementosAmbiguosPendentes[0].elegiveis).toEqual(
        expect.arrayContaining([
          { tipo: "posicaoManual", id: posicaoManual1.id, rotulo: "CDB Um (Itaú)" },
          { tipo: "posicaoManual", id: posicaoManual2.id, rotulo: "CDB Dois (Itaú)" },
        ]),
      );
      expect(preview.incrementosAmbiguosPendentes[0].elegiveis).toHaveLength(2);
    });

    it("previewImport chamado múltiplas vezes seguidas sem NUNCA confirmar não persiste nada e devolve os mesmos valores sugeridos (data-model.md, 'Fluxo técnico' passo 5 — robustez a reimport antes de confirmar)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-06",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      await prisma.ativo_mapeado.update({
        where: { chave_export: "PRIO3" },
        data: { alvo_id: alvo.id },
      });
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "PRIO3",
          sessao_import_id: r1.sessaoId,
          valor_investido_corrigido_centavos: 90_000,
        },
      });
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvo_id: alvo.id,
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManual.id,
          sessao_import_id: r1.sessaoId,
          valor_investido_centavos: 500_000,
          valor_atual_centavos: 520_000,
        },
      });

      const arquivoParaPreview = arquivoInstituicao("Itaú", [
        linha({ acao: "PRIO3", patrimonioHoje: "2000.00" }),
      ]);

      const preview1 = await importService.previewImport([arquivoParaPreview]);
      const preview2 = await importService.previewImport([arquivoParaPreview]);
      const preview3 = await importService.previewImport([arquivoParaPreview]);

      expect(preview1.ok && preview2.ok && preview3.ok).toBe(true);
      if (!preview1.ok || !preview2.ok || !preview3.ok) return;

      // Mesmo carry-forward nas 3 chamadas — nada foi persistido entre elas
      // que pudesse alterar o "último valor conhecido".
      expect(preview2.posicoesManuaisRevisao).toEqual(preview1.posicoesManuaisRevisao);
      expect(preview3.posicoesManuaisRevisao).toEqual(preview1.posicoesManuaisRevisao);
      expect(preview2.ajustesRevisao).toEqual(preview1.ajustesRevisao);
      expect(preview3.ajustesRevisao).toEqual(preview1.ajustesRevisao);

      // E continua batendo com o snapshot mais recente já persistido (sessão
      // r1), não com nenhum valor "fantasma" de uma chamada anterior de preview.
      expect(preview1.posicoesManuaisRevisao[0]).toMatchObject({
        valorInvestidoCentavosSugerido: 500_000,
        valorAtualCentavosSugerido: 520_000,
      });
      expect(preview1.ajustesRevisao[0]).toMatchObject({
        valorInvestidoCentavosSugerido: 90_000,
      });

      // Nenhuma linha nova de sessão/snapshot/ajuste foi criada por causa
      // das 3 chamadas de preview — continua só a sessão/linhas de r1.
      expect(await prisma.sessao_import.count()).toBe(1);
      expect(await prisma.posicao_manual_valor.count()).toBe(1);
      expect(await prisma.ajuste_valor_investido.count()).toBe(1);
    });

    it("confirmarImport com posicoesManuaisConfirmadas/ajustesConfirmados cria as linhas vinculadas à NOVA sessão, na mesma transação", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-06",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      await prisma.ativo_mapeado.update({
        where: { chave_export: "PRIO3" },
        data: { alvo_id: alvo.id },
      });

      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvo_id: alvo.id,
        },
      });

      const r2 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })])],
        mesReferencia: "2026-07",
        posicoesManuaisConfirmadas: [
          {
            posicaoManualId: posicaoManual.id,
            valorInvestidoCentavos: 550_000,
            valorAtualCentavos: 560_000,
          },
        ],
        ajustesConfirmados: [
          { chaveExport: "PRIO3", valorInvestidoCentavosCorrigido: 95_000 },
        ],
      });

      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.incrementosAmbiguosNaoAlocadosCentavos).toBe(0);

      const snapshot = await prisma.posicao_manual_valor.findUniqueOrThrow({
        where: {
          posicao_manual_id_sessao_import_id: {
            posicao_manual_id: posicaoManual.id,
            sessao_import_id: r2.sessaoId,
          },
        },
      });
      expect(snapshot.valor_investido_centavos).toBe(550_000);
      expect(snapshot.valor_atual_centavos).toBe(560_000);
      expect(await prisma.posicao_manual_valor.count()).toBe(1);

      const ajuste = await prisma.ajuste_valor_investido.findUniqueOrThrow({
        where: {
          chave_export_sessao_import_id: {
            chave_export: "PRIO3",
            sessao_import_id: r2.sessaoId,
          },
        },
      });
      expect(ajuste.valor_investido_corrigido_centavos).toBe(95_000);
      expect(await prisma.ajuste_valor_investido.count()).toBe(1);
    });

    it("confirmarImport SEM posicoesManuaisConfirmadas/ajustesConfirmados (undefined) não quebra — comportamento atual preservado", async () => {
      const resultado = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-07",
      });

      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;
      expect(resultado.incrementosAmbiguosNaoAlocadosCentavos).toBe(0);
      expect(await prisma.posicao_manual_valor.count()).toBe(0);
      expect(await prisma.ajuste_valor_investido.count()).toBe(0);
    });

    it("ajustesConfirmados com chaveExport em branco/whitespace é tratado como 'não preenchido' (FR-009): confirmarImport resolve ok:true sem criar ajuste_valor_investido, sem PrismaClientKnownRequestError", async () => {
      // Comportamento CORRIGIDO (bug real encontrado em revisão
      // pós-implementação, ver relatório do engenheiro-testes): um item de
      // `ajustesConfirmados` com `chaveExport` vazio/whitespace não
      // corresponde a nenhum `ativo_mapeado` real — em vez de deixar isso
      // vazar como um `PrismaClientKnownRequestError` de violação de FK, o
      // serviço filtra o item (mesmo padrão "aviso, não bloqueio" já usado
      // para uma chave ausente do array inteiro).
      const resultado = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-07",
        ajustesConfirmados: [{ chaveExport: "   ", valorInvestidoCentavosCorrigido: 1_000 }],
      });

      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;

      // A sessão e as posições persistem normalmente — só o item inválido
      // de ajustesConfirmados foi ignorado.
      expect(await prisma.sessao_import.count()).toBe(1);
      expect(await prisma.posicao.count()).toBe(1);
      expect(await prisma.ajuste_valor_investido.count()).toBe(0);
    });

    it("re-import do mesmo mês com nova revisão não altera/duplica as linhas de posicao_manual_valor/ajuste_valor_investido da sessão anterior", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-07",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      await prisma.ativo_mapeado.update({
        where: { chave_export: "PRIO3" },
        data: { alvo_id: alvo.id },
      });
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvo_id: alvo.id,
        },
      });

      const r1b = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-07",
        posicoesManuaisConfirmadas: [
          { posicaoManualId: posicaoManual.id, valorInvestidoCentavos: 100_000, valorAtualCentavos: 110_000 },
        ],
        ajustesConfirmados: [{ chaveExport: "PRIO3", valorInvestidoCentavosCorrigido: 10_000 }],
      });
      expect(r1b.ok).toBe(true);
      if (!r1b.ok) return;

      const snapshotAntesCriadoEm = (
        await prisma.posicao_manual_valor.findUniqueOrThrow({
          where: {
            posicao_manual_id_sessao_import_id: {
              posicao_manual_id: posicaoManual.id,
              sessao_import_id: r1b.sessaoId,
            },
          },
        })
      ).criado_em;

      const r2 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })])],
        mesReferencia: "2026-07",
        posicoesManuaisConfirmadas: [
          { posicaoManualId: posicaoManual.id, valorInvestidoCentavos: 200_000, valorAtualCentavos: 210_000 },
        ],
        ajustesConfirmados: [{ chaveExport: "PRIO3", valorInvestidoCentavosCorrigido: 20_000 }],
      });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.sessaoId).not.toBe(r1b.sessaoId);

      // A linha da sessão anterior (r1b) permanece intocada.
      const snapshotAnteriorDepois = await prisma.posicao_manual_valor.findUniqueOrThrow({
        where: {
          posicao_manual_id_sessao_import_id: {
            posicao_manual_id: posicaoManual.id,
            sessao_import_id: r1b.sessaoId,
          },
        },
      });
      expect(snapshotAnteriorDepois.valor_investido_centavos).toBe(100_000);
      expect(snapshotAnteriorDepois.valor_atual_centavos).toBe(110_000);
      expect(snapshotAnteriorDepois.criado_em).toEqual(snapshotAntesCriadoEm);

      const ajusteAnteriorDepois = await prisma.ajuste_valor_investido.findUniqueOrThrow({
        where: {
          chave_export_sessao_import_id: { chave_export: "PRIO3", sessao_import_id: r1b.sessaoId },
        },
      });
      expect(ajusteAnteriorDepois.valor_investido_corrigido_centavos).toBe(10_000);

      // Uma nova linha foi criada para a nova sessão (r2), sem duplicar/sobrescrever a antiga.
      expect(await prisma.posicao_manual_valor.count()).toBe(2);
      expect(await prisma.ajuste_valor_investido.count()).toBe(2);

      const snapshotNovo = await prisma.posicao_manual_valor.findUniqueOrThrow({
        where: {
          posicao_manual_id_sessao_import_id: {
            posicao_manual_id: posicaoManual.id,
            sessao_import_id: r2.sessaoId,
          },
        },
      });
      expect(snapshotNovo.valor_investido_centavos).toBe(200_000);
    });
  });

  // -------------------------------------------------------------------
  // T026 (User Story 4, FR-013, contracts/motor-integracao.md §4.3/§4.4,
  // research.md R4/R5): consumo de `incremento_valor_investido_pendente`
  // dentro da MESMA transação de `confirmarImport` — marcação
  // `aplicado = true` (+ `sessao_aplicacao_id`) via
  // `posicao-manual-service.marcarPendenciasComoAplicadas`.
  // -------------------------------------------------------------------
  describe("consumo de incremento_valor_investido_pendente na confirmação (T026, US4)", () => {
    async function criarAlvo(nome: string, percentualBps: number) {
      return prisma.alvo.create({
        data: { nome, percentual_alvo_bps: percentualBps, vigencia_inicio: new Date("2026-01-01") },
      });
    }

    /** `aporte` mínimo — proveniência obrigatória (`aporte_id`, onDelete Restrict) de `incremento_valor_investido_pendente`. */
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

    async function criarPendenciaIncremento(input: {
      alvoId: string;
      aporteId: string;
      valorIncrementoCentavos: number;
      chaveExport?: string | null;
      posicaoManualId?: string | null;
    }) {
      return prisma.incremento_valor_investido_pendente.create({
        data: {
          alvo_id: input.alvoId,
          aporte_id: input.aporteId,
          valor_incremento_centavos: input.valorIncrementoCentavos,
          chave_export: input.chaveExport ?? null,
          posicao_manual_id: input.posicaoManualId ?? null,
          aplicado: false,
        },
      });
    }

    it("confirmação marca pendências ESPECÍFICAS (posicao_manual e ajuste) como aplicadas, com sessao_aplicacao_id apontando para a nova sessão", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-06",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      await prisma.ativo_mapeado.update({
        where: { chave_export: "PRIO3" },
        data: { alvo_id: alvo.id },
      });
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "PRIO3",
          sessao_import_id: r1.sessaoId,
          valor_investido_corrigido_centavos: 90_000,
        },
      });
      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
          alvo_id: alvo.id,
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManual.id,
          sessao_import_id: r1.sessaoId,
          valor_investido_centavos: 500_000,
          valor_atual_centavos: 520_000,
        },
      });

      const aporte = await criarAporteParaTeste(r1.sessaoId, 50_000);
      const pendenciaPosicaoManual = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte.id,
        posicaoManualId: posicaoManual.id,
        valorIncrementoCentavos: 20_000,
      });
      const pendenciaAjuste = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte.id,
        chaveExport: "PRIO3",
        valorIncrementoCentavos: 30_000,
      });

      const r2 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })])],
        mesReferencia: "2026-07",
        posicoesManuaisConfirmadas: [
          { posicaoManualId: posicaoManual.id, valorInvestidoCentavos: 520_000, valorAtualCentavos: 560_000 },
        ],
        ajustesConfirmados: [{ chaveExport: "PRIO3", valorInvestidoCentavosCorrigido: 120_000 }],
      });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;

      const posicaoManualPendenciaDepois = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow(
        { where: { id: pendenciaPosicaoManual.id } },
      );
      const ajustePendenciaDepois = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow({
        where: { id: pendenciaAjuste.id },
      });

      expect(posicaoManualPendenciaDepois.aplicado).toBe(true);
      expect(posicaoManualPendenciaDepois.sessao_aplicacao_id).toBe(r2.sessaoId);
      expect(ajustePendenciaDepois.aplicado).toBe(true);
      expect(ajustePendenciaDepois.sessao_aplicacao_id).toBe(r2.sessaoId);
    });

    it("confirmação marca pendência AMBÍGUA como aplicada integralmente, mesmo com distribuição parcial pelo usuário (research.md R5, decisão binária)", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-06",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      const aporte = await criarAporteParaTeste(r1.sessaoId, 80_000);
      const pendenciaAmbigua = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte.id,
        valorIncrementoCentavos: 80_000,
        // chave_export e posicao_manual_id ambos ausentes = pendência
        // ambígua de alvo (n >= 2 histórico, motor-integracao.md §3.2).
      });

      // Usuário confirma o import SEM distribuir nenhum valor específico
      // (nenhuma posicao_manual/ajuste vinculada a este alvo neste teste) —
      // "distribuição parcial" no sentido de que nada é rastreado/exigido.
      const r2 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3", patrimonioHoje: "2000.00" })])],
        mesReferencia: "2026-07",
      });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;

      const noBanco = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow({
        where: { id: pendenciaAmbigua.id },
      });
      expect(noBanco.aplicado).toBe(true);
      expect(noBanco.sessao_aplicacao_id).toBe(r2.sessaoId);
    });

    it("reimport abandonado (chamar previewImport várias vezes sem NUNCA confirmar) não marca nenhuma pendência como aplicada", async () => {
      const alvo = await criarAlvo("Pós-fixado", 3000);

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "PRIO3" })])],
        mesReferencia: "2026-06",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      await prisma.ativo_mapeado.update({
        where: { chave_export: "PRIO3" },
        data: { alvo_id: alvo.id },
      });
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "PRIO3",
          sessao_import_id: r1.sessaoId,
          valor_investido_corrigido_centavos: 90_000,
        },
      });
      const aporte = await criarAporteParaTeste(r1.sessaoId, 30_000);
      const pendencia = await criarPendenciaIncremento({
        alvoId: alvo.id,
        aporteId: aporte.id,
        chaveExport: "PRIO3",
        valorIncrementoCentavos: 30_000,
      });

      const arquivoParaPreview = arquivoInstituicao("Itaú", [
        linha({ acao: "PRIO3", patrimonioHoje: "2000.00" }),
      ]);
      await importService.previewImport([arquivoParaPreview]);
      await importService.previewImport([arquivoParaPreview]);
      await importService.previewImport([arquivoParaPreview]);

      const noBanco = await prisma.incremento_valor_investido_pendente.findUniqueOrThrow({
        where: { id: pendencia.id },
      });
      expect(noBanco.aplicado).toBe(false);
      expect(noBanco.sessao_aplicacao_id).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // T024 (User Story 4, FR-011/FR-011a/FR-018/FR-019, research.md R6/R7/R13):
  // `previewImport.movimentacoesNaoExplicadas` — informativo, nunca
  // bloqueante; `confirmarImport` sempre persiste o valor REAL do CSV em
  // `posicao.patrimonio_investido_centavos`, nunca o "esperado".
  // -------------------------------------------------------------------
  describe("movimentacoesNaoExplicadas no preview (T024, US4)", () => {
    const COLUNAS_COM_PATRIMONIO_APLICADO = [
      "Ação",
      "Quantidade",
      "Patrimônio Hoje",
      "Patrimônio Aplicado",
      "Tipo de Grupo",
      "dataUltimaCotacao",
    ];

    function headerComPatrimonioAplicado(): string {
      return COLUNAS_COM_PATRIMONIO_APLICADO.join(";");
    }

    function linhaComPatrimonioAplicado(opts: {
      acao: string;
      quantidade?: string;
      patrimonioHoje: string;
      patrimonioAplicado: string;
      tipoGrupo?: string;
      dataUltimaCotacao?: string;
    }): string {
      const {
        acao,
        quantidade = "100",
        patrimonioHoje,
        patrimonioAplicado,
        tipoGrupo = "ACOES",
        dataUltimaCotacao = "2026-08-28T03:00:00.000Z",
      } = opts;
      return [acao, quantidade, patrimonioHoje, patrimonioAplicado, tipoGrupo, dataUltimaCotacao].join(";");
    }

    function arquivoComPatrimonioAplicado(instituicao: string, linhasDados: string[]): ArquivoImport {
      return arquivo(`Export_${instituicao}.csv`, [headerComPatrimonioAplicado(), ...linhasDados]);
    }

    async function criarAlvo(nome: string) {
      return prisma.alvo.create({
        data: { nome, percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });
    }

    it("presente quando a diferença excede AMBOS os limiares de FR-018 (5% E R$20,00)", async () => {
      const alvo = await criarAlvo("Ações");

      // Sessão anterior (VIGENTE): AAA11 com valor investido = R$800,00, vinculado ao alvo (único elegível, n=1).
      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "AAA11", patrimonioHoje: "1000.00" })])],
        mesReferencia: "2026-07",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      await prisma.ativo_mapeado.update({ where: { chave_export: "AAA11" }, data: { alvo_id: alvo.id } });
      // O primeiro import (linha() default) não trouxe "Patrimônio Aplicado" — ajusta
      // manualmente a posição criada para simular um valor investido conhecido.
      await prisma.posicao.updateMany({
        where: { sessao_import_id: r1.sessaoId, chave_export: "AAA11" },
        data: { patrimonio_investido_centavos: 80_000 },
      });

      // Novo import: valor investido real = R$2.000,00 (bem acima de 80_000 + 0 esperado).
      const preview = await importService.previewImport([
        arquivoComPatrimonioAplicado("Itaú", [
          linhaComPatrimonioAplicado({
            acao: "AAA11",
            patrimonioHoje: "2500.00",
            patrimonioAplicado: "2000.00",
          }),
        ]),
      ]);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      expect(preview.movimentacoesNaoExplicadas.length).toBeGreaterThan(0);
      const item = preview.movimentacoesNaoExplicadas.find((m) => m.alvoId === alvo.id);
      expect(item).toBeDefined();
      expect(item!.granularidade).toBe("ativo");
      expect(item!.chaveExport).toBe("AAA11");
      expect(item!.excedeTolerancia).toBe(true);
      expect(item!.valorInvestidoEsperadoCentavos).toBe(80_000);
      expect(item!.valorInvestidoRealCentavos).toBe(200_000);
    });

    it("ausente/vazio quando a diferença NÃO excede a tolerância", async () => {
      const alvo = await criarAlvo("Ações");

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "BBB11", patrimonioHoje: "1000.00" })])],
        mesReferencia: "2026-07",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      await prisma.ativo_mapeado.update({ where: { chave_export: "BBB11" }, data: { alvo_id: alvo.id } });
      await prisma.posicao.updateMany({
        where: { sessao_import_id: r1.sessaoId, chave_export: "BBB11" },
        data: { patrimonio_investido_centavos: 80_000 },
      });

      // Novo import: valor investido real = R$805,00 — diferença de R$5,00, bem abaixo do piso.
      const preview = await importService.previewImport([
        arquivoComPatrimonioAplicado("Itaú", [
          linhaComPatrimonioAplicado({
            acao: "BBB11",
            patrimonioHoje: "900.00",
            patrimonioAplicado: "805.00",
          }),
        ]),
      ]);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      const item = preview.movimentacoesNaoExplicadas.find((m) => m.alvoId === alvo.id);
      expect(item).toBeUndefined();
    });

    it("NUNCA bloqueia previewImport nem confirmarImport, independente do conteúdo de movimentacoesNaoExplicadas", async () => {
      const alvo = await criarAlvo("Ações");

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "CCC11", patrimonioHoje: "1000.00" })])],
        mesReferencia: "2026-07",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      await prisma.ativo_mapeado.update({ where: { chave_export: "CCC11" }, data: { alvo_id: alvo.id } });
      await prisma.posicao.updateMany({
        where: { sessao_import_id: r1.sessaoId, chave_export: "CCC11" },
        data: { patrimonio_investido_centavos: 80_000 },
      });

      const arquivos = [
        arquivoComPatrimonioAplicado("Itaú", [
          linhaComPatrimonioAplicado({
            acao: "CCC11",
            patrimonioHoje: "5000.00",
            patrimonioAplicado: "4000.00", // bem acima da tolerância
          }),
        ]),
      ];

      const preview = await importService.previewImport(arquivos);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.movimentacoesNaoExplicadas.length).toBeGreaterThan(0);

      const confirmacao = await importService.confirmarImport({
        arquivos,
        mesReferencia: "2026-08",
      });
      expect(confirmacao.ok).toBe(true);
    });

    it("chave espalhada por 2 instituições onde UMA tem Patrimônio Aplicado ausente: alvo é pulado (nunca falso alarme sobre dado incompleto)", async () => {
      const alvo = await criarAlvo("Ações");

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "FFF11", patrimonioHoje: "1000.00" })])],
        mesReferencia: "2026-07",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      await prisma.ativo_mapeado.update({ where: { chave_export: "FFF11" }, data: { alvo_id: alvo.id } });
      await prisma.posicao.updateMany({
        where: { sessao_import_id: r1.sessaoId, chave_export: "FFF11" },
        data: { patrimonio_investido_centavos: 80_000 },
      });

      // Mesma chave FFF11 em duas instituições no novo import — Nubank sem
      // "Patrimônio Aplicado" (coluna ausente do header dessa instituição
      // específica; MyCapital exporta por instituição, cada arquivo pode ter
      // colunas diferentes) — o valor real consolidado da chave fica
      // indisponível (null), não uma soma parcial disfarçada de completa.
      const preview = await importService.previewImport([
        arquivoComPatrimonioAplicado("Itaú", [
          linhaComPatrimonioAplicado({ acao: "FFF11", patrimonioHoje: "1500.00", patrimonioAplicado: "1000.00" }),
        ]),
        arquivoInstituicao("Nubank", [linha({ acao: "FFF11", patrimonioHoje: "500.00" })]),
      ]);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      const item = preview.movimentacoesNaoExplicadas.find((m) => m.alvoId === alvo.id);
      expect(item).toBeUndefined();
    });

    it("US4 Acceptance Scenario 3: ativo novo (primeira aparição, mapeado ao alvo só agora, sem posicao na sessão anterior) não gera alerta ('não há base de comparação')", async () => {
      const alvo = await criarAlvo("Ações");

      // Sessão anterior VIGENTE existe, mas SEM NENHUMA posição de "EEE11"
      // nela — o ativo é mapeado ao alvo só agora, no import corrente
      // (spec.md US4 Acceptance Scenario 3: "ativo novo, primeira aparição,
      // sem sessão anterior" -> "nenhum alerta... não há base de comparação").
      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "OUTRO1", patrimonioHoje: "1000.00" })])],
        mesReferencia: "2026-07",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      await prisma.ativo_mapeado.create({
        data: {
          chave_export: "EEE11",
          alvo_id: alvo.id,
          fora_da_carteira: false,
          ignorar_no_import: false,
          reserva_emergencia: false,
        },
      });

      const preview = await importService.previewImport([
        arquivoComPatrimonioAplicado("Itaú", [
          linhaComPatrimonioAplicado({ acao: "OUTRO1", patrimonioHoje: "1000.00", patrimonioAplicado: "800.00" }),
          linhaComPatrimonioAplicado({ acao: "EEE11", patrimonioHoje: "500.00", patrimonioAplicado: "500.00" }),
        ]),
      ]);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      const item = preview.movimentacoesNaoExplicadas.find((m) => m.alvoId === alvo.id);
      expect(item).toBeUndefined();
    });

    it("FR-019: patrimonio_investido_centavos persistido é sempre o valor REAL do CSV, nunca o 'esperado' calculado para comparação", async () => {
      const alvo = await criarAlvo("Ações");

      const r1 = await importService.confirmarImport({
        arquivos: [arquivoInstituicao("Itaú", [linha({ acao: "DDD11", patrimonioHoje: "1000.00" })])],
        mesReferencia: "2026-07",
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      await prisma.ativo_mapeado.update({ where: { chave_export: "DDD11" }, data: { alvo_id: alvo.id } });
      await prisma.posicao.updateMany({
        where: { sessao_import_id: r1.sessaoId, chave_export: "DDD11" },
        data: { patrimonio_investido_centavos: 80_000 }, // "esperado" seria 80_000 (sem aporte executado)
      });

      const r2 = await importService.confirmarImport({
        arquivos: [
          arquivoComPatrimonioAplicado("Itaú", [
            linhaComPatrimonioAplicado({
              acao: "DDD11",
              patrimonioHoje: "5000.00",
              patrimonioAplicado: "4000.00", // valor REAL, bem diferente do "esperado" (80_000)
            }),
          ]),
        ],
        mesReferencia: "2026-08",
      });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;

      const posicaoPersistida = await prisma.posicao.findFirstOrThrow({
        where: { sessao_import_id: r2.sessaoId, chave_export: "DDD11" },
      });
      // Sempre o valor REAL do CSV (R$4.000,00) — nunca o "esperado" (R$800,00).
      expect(posicaoPersistida.patrimonio_investido_centavos).toBe(400_000);
    });
  });
});
