-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_posicao_manual" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chave_manual" TEXT NOT NULL,
    "instituicao" TEXT NOT NULL,
    "alvo_id" TEXT,
    "descricao" TEXT NOT NULL,
    "tipo_grupo" TEXT NOT NULL DEFAULT 'RENDA_FIXA_MANUAL',
    "chave_export_origem" TEXT,
    "fora_da_carteira" BOOLEAN NOT NULL DEFAULT false,
    "reserva_emergencia" BOOLEAN NOT NULL DEFAULT false,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "posicao_manual_alvo_id_fkey" FOREIGN KEY ("alvo_id") REFERENCES "alvo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "posicao_manual_chave_export_origem_fkey" FOREIGN KEY ("chave_export_origem") REFERENCES "ativo_mapeado" ("chave_export") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_posicao_manual" ("alvo_id", "ativo", "chave_export_origem", "chave_manual", "criado_em", "descricao", "id", "instituicao", "tipo_grupo") SELECT "alvo_id", "ativo", "chave_export_origem", "chave_manual", "criado_em", "descricao", "id", "instituicao", "tipo_grupo" FROM "posicao_manual";
DROP TABLE "posicao_manual";
ALTER TABLE "new_posicao_manual" RENAME TO "posicao_manual";
CREATE UNIQUE INDEX "posicao_manual_chave_manual_key" ON "posicao_manual"("chave_manual");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
