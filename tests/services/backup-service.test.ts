/**
 * tests/services/backup-service.test.ts — testes de integração (T035) de
 * src/services/backup-service.ts contra um SQLite TEMPORÁRIO, isolado do
 * `data/app.db` real, e gravando em um diretório de backups TEMPORÁRIO
 * (nunca `backups/` do projeto).
 *
 * Mesma estratégia de tests/services/aporte-service.test.ts: o singleton
 * `@/db/client` lê `DATABASE_URL` do ambiente na hora em que é instanciado,
 * então `process.env.DATABASE_URL` é definido para um arquivo `.db`
 * temporário ANTES de importar `@/db/client`/`@/services/backup-service`
 * (imports dinâmicos dentro de `beforeAll`, nunca estáticos no topo).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let backupsDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let backupService: typeof import("@/services/backup-service");
let configService: typeof import("@/services/config-service");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-service-test-"));
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
  configService = await import("@/services/config-service");
}, 30_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  if (backupsDir && fs.existsSync(backupsDir)) {
    fs.rmSync(backupsDir, { recursive: true, force: true });
  }
  await prisma.config.deleteMany();
});

/** Cabeçalho fixo de todo arquivo SQLite válido (magic string dos 16 primeiros bytes). */
function ehArquivoSqliteValido(caminho: string): boolean {
  const buffer = Buffer.alloc(16);
  const fd = fs.openSync(caminho, "r");
  fs.readSync(fd, buffer, 0, 16, 0);
  fs.closeSync(fd);
  return buffer.toString("utf8", 0, 15) === "SQLite format 3";
}

describe("backup-service", () => {
  describe("criarBackup (research.md R8)", () => {
    it("cria um arquivo .db válido via VACUUM INTO dentro de backupsDir", async () => {
      backupsDir = path.join(tmpDir, "backups-1");

      const resultado = await backupService.criarBackup({ backupsDir });

      expect(fs.existsSync(resultado.caminho)).toBe(true);
      expect(resultado.nomeArquivo).toMatch(/^app-\d{4}-\d{2}-\d{2}\.db$/);
      expect(ehArquivoSqliteValido(resultado.caminho)).toBe(true);
    });

    it("usa sufixo -2, -3... quando já existe um backup no mesmo dia", async () => {
      backupsDir = path.join(tmpDir, "backups-2");
      const dataFixa = new Date(2026, 6, 30); // 30/07/2026 local

      const primeiro = await backupService.criarBackup({ backupsDir, data: dataFixa });
      const segundo = await backupService.criarBackup({ backupsDir, data: dataFixa });
      const terceiro = await backupService.criarBackup({ backupsDir, data: dataFixa });

      expect(primeiro.nomeArquivo).toBe("app-2026-07-30.db");
      expect(segundo.nomeArquivo).toBe("app-2026-07-30-2.db");
      expect(terceiro.nomeArquivo).toBe("app-2026-07-30-3.db");

      expect(fs.existsSync(primeiro.caminho)).toBe(true);
      expect(fs.existsSync(segundo.caminho)).toBe(true);
      expect(fs.existsSync(terceiro.caminho)).toBe(true);
    });

    it("cria backupsDir automaticamente quando ainda não existe", async () => {
      backupsDir = path.join(tmpDir, "backups-inexistente", "aninhado");
      expect(fs.existsSync(backupsDir)).toBe(false);

      const resultado = await backupService.criarBackup({ backupsDir });

      expect(fs.existsSync(resultado.caminho)).toBe(true);
    });
  });

  describe("aplicarRetencao", () => {
    it("mantém apenas os N mais recentes (limite explícito), removendo os mais antigos", async () => {
      backupsDir = path.join(tmpDir, "backups-retencao-1");
      fs.mkdirSync(backupsDir, { recursive: true });

      // 5 arquivos de backup "falsos" (só precisam existir/ter mtime para o
      // teste de retenção — não precisam ser SQLite válido).
      const nomes = [
        "app-2026-07-01.db",
        "app-2026-07-02.db",
        "app-2026-07-03.db",
        "app-2026-07-04.db",
        "app-2026-07-05.db",
      ];
      const agora = Date.now();
      nomes.forEach((nome, indice) => {
        const caminho = path.join(backupsDir, nome);
        fs.writeFileSync(caminho, "conteudo-fake");
        // mtime crescente: o último da lista é o mais recente.
        const mtime = new Date(agora + indice * 1000);
        fs.utimesSync(caminho, mtime, mtime);
      });

      const removidos = await backupService.aplicarRetencao({ backupsDir, limite: 2 });

      expect(removidos).toHaveLength(3);
      const restantes = fs.readdirSync(backupsDir).sort();
      // Mantém os 2 mais recentes: 07-04 e 07-05.
      expect(restantes).toEqual(["app-2026-07-04.db", "app-2026-07-05.db"]);
    });

    it("usa retencao_backups da config (default 12) quando limite não é informado", async () => {
      backupsDir = path.join(tmpDir, "backups-retencao-2");
      fs.mkdirSync(backupsDir, { recursive: true });

      await configService.setConfig("retencao_backups", 1);

      const nomes = ["app-2026-01-01.db", "app-2026-01-02.db", "app-2026-01-03.db"];
      const agora = Date.now();
      nomes.forEach((nome, indice) => {
        const caminho = path.join(backupsDir, nome);
        fs.writeFileSync(caminho, "conteudo-fake");
        const mtime = new Date(agora + indice * 1000);
        fs.utimesSync(caminho, mtime, mtime);
      });

      const removidos = await backupService.aplicarRetencao({ backupsDir });

      expect(removidos).toHaveLength(2);
      const restantes = fs.readdirSync(backupsDir);
      expect(restantes).toEqual(["app-2026-01-03.db"]);
    });

    it("ignora arquivos que não seguem o padrão app-YYYY-MM-DD(-N)?.db", async () => {
      backupsDir = path.join(tmpDir, "backups-retencao-3");
      fs.mkdirSync(backupsDir, { recursive: true });

      fs.writeFileSync(path.join(backupsDir, "app-2026-01-01.db"), "x");
      fs.writeFileSync(path.join(backupsDir, "leia-me.txt"), "x");
      fs.writeFileSync(path.join(backupsDir, "outro-arquivo.db"), "x");

      const removidos = await backupService.aplicarRetencao({ backupsDir, limite: 0 });

      // Só o arquivo que casa com o padrão é considerado backup e removido.
      expect(removidos).toEqual([path.join(backupsDir, "app-2026-01-01.db")]);
      expect(fs.existsSync(path.join(backupsDir, "leia-me.txt"))).toBe(true);
      expect(fs.existsSync(path.join(backupsDir, "outro-arquivo.db"))).toBe(true);
    });
  });

  describe("executarBackupComRetencao (fluxo usado pelo import-service, T036)", () => {
    it("cria o backup do dia e aplica a retenção em seguida", async () => {
      backupsDir = path.join(tmpDir, "backups-fluxo-completo");
      await configService.setConfig("retencao_backups", 2);

      // 2 backups antigos pré-existentes (mtime no passado).
      fs.mkdirSync(backupsDir, { recursive: true });
      const antigo1 = path.join(backupsDir, "app-2020-01-01.db");
      const antigo2 = path.join(backupsDir, "app-2020-01-02.db");
      fs.writeFileSync(antigo1, "x");
      fs.writeFileSync(antigo2, "x");
      const passado = new Date(2020, 0, 1);
      fs.utimesSync(antigo1, passado, passado);
      fs.utimesSync(antigo2, new Date(2020, 0, 2), new Date(2020, 0, 2));

      const { backup, removidos } = await backupService.executarBackupComRetencao({ backupsDir });

      expect(fs.existsSync(backup.caminho)).toBe(true);
      expect(ehArquivoSqliteValido(backup.caminho)).toBe(true);
      // Limite 2: com o novo backup, 3 arquivos existiam ⇒ 1 removido (o mais antigo).
      expect(removidos).toEqual([antigo1]);
      expect(fs.existsSync(antigo1)).toBe(false);
      expect(fs.existsSync(antigo2)).toBe(true);
    });
  });
});
