-- CreateTable
CREATE TABLE "posicao_manual" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chave_manual" TEXT NOT NULL,
    "instituicao" TEXT NOT NULL,
    "alvo_id" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "tipo_grupo" TEXT NOT NULL DEFAULT 'RENDA_FIXA_MANUAL',
    "chave_export_origem" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "posicao_manual_alvo_id_fkey" FOREIGN KEY ("alvo_id") REFERENCES "alvo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "posicao_manual_chave_export_origem_fkey" FOREIGN KEY ("chave_export_origem") REFERENCES "ativo_mapeado" ("chave_export") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "posicao_manual_valor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "posicao_manual_id" TEXT NOT NULL,
    "sessao_import_id" TEXT NOT NULL,
    "valor_investido_centavos" INTEGER NOT NULL,
    "valor_atual_centavos" INTEGER NOT NULL,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "posicao_manual_valor_posicao_manual_id_fkey" FOREIGN KEY ("posicao_manual_id") REFERENCES "posicao_manual" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "posicao_manual_valor_sessao_import_id_fkey" FOREIGN KEY ("sessao_import_id") REFERENCES "sessao_import" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ajuste_valor_investido" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chave_export" TEXT NOT NULL,
    "sessao_import_id" TEXT NOT NULL,
    "valor_investido_corrigido_centavos" INTEGER,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ajuste_valor_investido_chave_export_fkey" FOREIGN KEY ("chave_export") REFERENCES "ativo_mapeado" ("chave_export") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ajuste_valor_investido_sessao_import_id_fkey" FOREIGN KEY ("sessao_import_id") REFERENCES "sessao_import" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
-- CHECK constraints adicionados manualmente (data-model.md da feature 002,
-- mesmo padrão de sessao_import.status — research.md R12 da feature 001):
-- defesa em profundidade para a ausência de enum/validação de estado
-- composto no SQLite. A validação primária continua na camada de
-- aplicação (src/services/*).
--   1) chave_export e posicao_manual_id são mutuamente exclusivos: no
--      máximo um dos dois é preenchido (ambos null = alvo ambíguo).
--   2) aplicado e sessao_aplicacao_id transicionam juntos.
CREATE TABLE "incremento_valor_investido_pendente" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alvo_id" TEXT NOT NULL,
    "chave_export" TEXT,
    "posicao_manual_id" TEXT,
    "aporte_id" TEXT NOT NULL,
    "valor_incremento_centavos" INTEGER NOT NULL,
    "aplicado" BOOLEAN NOT NULL DEFAULT false,
    "sessao_aplicacao_id" TEXT,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "incremento_valor_investido_pendente_alvo_id_fkey" FOREIGN KEY ("alvo_id") REFERENCES "alvo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "incremento_valor_investido_pendente_chave_export_fkey" FOREIGN KEY ("chave_export") REFERENCES "ativo_mapeado" ("chave_export") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "incremento_valor_investido_pendente_posicao_manual_id_fkey" FOREIGN KEY ("posicao_manual_id") REFERENCES "posicao_manual" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "incremento_valor_investido_pendente_aporte_id_fkey" FOREIGN KEY ("aporte_id") REFERENCES "aporte" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "incremento_valor_investido_pendente_sessao_aplicacao_id_fkey" FOREIGN KEY ("sessao_aplicacao_id") REFERENCES "sessao_import" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CHECK (NOT ("chave_export" IS NOT NULL AND "posicao_manual_id" IS NOT NULL)),
    CHECK (("aplicado" = 0 AND "sessao_aplicacao_id" IS NULL) OR ("aplicado" = 1 AND "sessao_aplicacao_id" IS NOT NULL))
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ativo_mapeado" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chave_export" TEXT NOT NULL,
    "alvo_id" TEXT,
    "fora_da_carteira" BOOLEAN NOT NULL DEFAULT false,
    "ignorar_no_import" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ativo_mapeado_alvo_id_fkey" FOREIGN KEY ("alvo_id") REFERENCES "alvo" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ativo_mapeado" ("alvo_id", "chave_export", "criado_em", "fora_da_carteira", "id") SELECT "alvo_id", "chave_export", "criado_em", "fora_da_carteira", "id" FROM "ativo_mapeado";
DROP TABLE "ativo_mapeado";
ALTER TABLE "new_ativo_mapeado" RENAME TO "ativo_mapeado";
CREATE UNIQUE INDEX "ativo_mapeado_chave_export_key" ON "ativo_mapeado"("chave_export");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "posicao_manual_chave_manual_key" ON "posicao_manual"("chave_manual");

-- CreateIndex
CREATE UNIQUE INDEX "posicao_manual_valor_posicao_manual_id_sessao_import_id_key" ON "posicao_manual_valor"("posicao_manual_id", "sessao_import_id");

-- CreateIndex
CREATE UNIQUE INDEX "ajuste_valor_investido_chave_export_sessao_import_id_key" ON "ajuste_valor_investido"("chave_export", "sessao_import_id");
