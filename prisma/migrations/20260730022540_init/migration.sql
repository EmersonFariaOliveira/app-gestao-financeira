-- CreateTable
CREATE TABLE "alvo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nome" TEXT NOT NULL,
    "percentual_alvo_bps" INTEGER NOT NULL,
    "vigencia_inicio" DATETIME NOT NULL,
    "vigencia_fim" DATETIME,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ativo_mapeado" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chave_export" TEXT NOT NULL,
    "alvo_id" TEXT,
    "fora_da_carteira" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ativo_mapeado_alvo_id_fkey" FOREIGN KEY ("alvo_id") REFERENCES "alvo" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
-- CHECK (status IN ('VIGENTE','SUBSTITUIDO')) adicionado manualmente
-- (research.md R12): defesa em profundidade para a ausência de enum no
-- SQLite. A validação primária continua na camada de aplicação.
CREATE TABLE "sessao_import" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mes_referencia" TEXT NOT NULL,
    "data_export" DATETIME NOT NULL,
    "status" TEXT NOT NULL CHECK ("status" IN ('VIGENTE', 'SUBSTITUIDO')),
    "instituicoes" TEXT NOT NULL,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "posicao" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessao_import_id" TEXT NOT NULL,
    "chave_export" TEXT NOT NULL,
    "instituicao" TEXT NOT NULL,
    "quantidade" TEXT NOT NULL,
    "patrimonio_hoje_centavos" INTEGER NOT NULL,
    "tipo_grupo" TEXT NOT NULL,
    "tipo_ativo_internacional" TEXT,
    "data_ultima_cotacao" DATETIME,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "posicao_sessao_import_id_fkey" FOREIGN KEY ("sessao_import_id") REFERENCES "sessao_import" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "aporte" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessao_import_id" TEXT NOT NULL,
    "valor_total_centavos" INTEGER NOT NULL,
    "valor_dividendos_centavos" INTEGER NOT NULL,
    "sugestao" TEXT NOT NULL,
    "executado" TEXT NOT NULL,
    "troco_centavos" INTEGER NOT NULL,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aporte_sessao_import_id_fkey" FOREIGN KEY ("sessao_import_id") REFERENCES "sessao_import" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "dividendo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chave_export" TEXT NOT NULL,
    "mes_referencia" TEXT NOT NULL,
    "valor_centavos" INTEGER NOT NULL,
    "aporte_id" TEXT,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dividendo_chave_export_fkey" FOREIGN KEY ("chave_export") REFERENCES "ativo_mapeado" ("chave_export") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dividendo_aporte_id_fkey" FOREIGN KEY ("aporte_id") REFERENCES "aporte" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "config" (
    "chave" TEXT NOT NULL PRIMARY KEY,
    "valor" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ativo_mapeado_chave_export_key" ON "ativo_mapeado"("chave_export");

-- CreateIndex
CREATE INDEX "sessao_import_mes_referencia_status_idx" ON "sessao_import"("mes_referencia", "status");
