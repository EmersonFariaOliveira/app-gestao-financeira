-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ativo_mapeado" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chave_export" TEXT NOT NULL,
    "alvo_id" TEXT,
    "fora_da_carteira" BOOLEAN NOT NULL DEFAULT false,
    "ignorar_no_import" BOOLEAN NOT NULL DEFAULT false,
    "reserva_emergencia" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ativo_mapeado_alvo_id_fkey" FOREIGN KEY ("alvo_id") REFERENCES "alvo" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ativo_mapeado" ("alvo_id", "chave_export", "criado_em", "fora_da_carteira", "id", "ignorar_no_import") SELECT "alvo_id", "chave_export", "criado_em", "fora_da_carteira", "id", "ignorar_no_import" FROM "ativo_mapeado";
DROP TABLE "ativo_mapeado";
ALTER TABLE "new_ativo_mapeado" RENAME TO "ativo_mapeado";
CREATE UNIQUE INDEX "ativo_mapeado_chave_export_key" ON "ativo_mapeado"("chave_export");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
