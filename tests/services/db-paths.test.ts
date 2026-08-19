/**
 * tests/services/db-paths.test.ts — testa a resolução de caminhos em
 * src/services/db-paths.ts, fonte única de verdade de "onde está o .db" e
 * "onde vão os backups automáticos" (usada por backup-service.ts e
 * actions/config.ts). Cobre os dois formatos de `DATABASE_URL` aceitos pelo
 * Prisma: relativo (resolvido a partir de `prisma/`) e absoluto.
 *
 * Import dinâmico dentro de cada `it` (não estático no topo): o módulo lê
 * `process.env.DATABASE_URL` em tempo de CHAMADA de função (não no import),
 * então não há singleton para se preocupar aqui — mas mantemos o padrão de
 * isolar `process.env` por teste com `beforeEach`/`afterEach`.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let originalDatabaseUrl: string | undefined;

beforeEach(() => {
  originalDatabaseUrl = process.env.DATABASE_URL;
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("db-paths", () => {
  describe("resolverCaminhoDb", () => {
    it("resolve caminho relativo (ex.: file:../data/app.db) relativo a prisma/", async () => {
      process.env.DATABASE_URL = "file:../data/app.db";
      const { resolverCaminhoDb } = await import("@/services/db-paths");

      expect(resolverCaminhoDb()).toBe(path.resolve(process.cwd(), "data", "app.db"));
    });

    it("resolve caminho absoluto (ex.: file:G:/Meu Drive/.../app.db) tal como está", async () => {
      process.env.DATABASE_URL = "file:G:/Meu Drive/Investimentos/app-gestao-financeira-db/app.db";
      const { resolverCaminhoDb } = await import("@/services/db-paths");

      expect(resolverCaminhoDb()).toBe(
        path.resolve("G:/Meu Drive/Investimentos/app-gestao-financeira-db/app.db"),
      );
    });

    it("resolve caminho absoluto com barras invertidas (Windows) tal como está", async () => {
      process.env.DATABASE_URL =
        "file:G:\\Meu Drive\\Investimentos\\app-gestao-financeira-db\\app.db";
      const { resolverCaminhoDb } = await import("@/services/db-paths");

      expect(resolverCaminhoDb()).toBe(
        path.resolve("G:\\Meu Drive\\Investimentos\\app-gestao-financeira-db\\app.db"),
      );
    });

    it("usa o default file:../data/app.db quando DATABASE_URL não está definida", async () => {
      delete process.env.DATABASE_URL;
      const { resolverCaminhoDb } = await import("@/services/db-paths");

      expect(resolverCaminhoDb()).toBe(path.resolve(process.cwd(), "data", "app.db"));
    });
  });

  describe("diretorioBackupsPadrao", () => {
    it("é a subpasta backup/ ao lado do arquivo .db (caminho relativo)", async () => {
      process.env.DATABASE_URL = "file:../data/app.db";
      const { diretorioBackupsPadrao } = await import("@/services/db-paths");

      expect(diretorioBackupsPadrao()).toBe(path.resolve(process.cwd(), "data", "backup"));
    });

    it("é a subpasta backup/ ao lado do arquivo .db (caminho absoluto fora do repo)", async () => {
      process.env.DATABASE_URL = "file:G:/Meu Drive/Investimentos/app-gestao-financeira-db/app.db";
      const { diretorioBackupsPadrao } = await import("@/services/db-paths");

      expect(diretorioBackupsPadrao()).toBe(
        path.resolve("G:/Meu Drive/Investimentos/app-gestao-financeira-db/backup"),
      );
    });
  });
});
