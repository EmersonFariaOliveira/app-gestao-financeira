import path from "node:path";

// src/services/db-paths.ts — fonte única de verdade para "onde estão os
// arquivos do banco no disco" (o `.db` em si e a pasta de backups
// automáticos). Usado por backup-service.ts (para saber onde gravar os
// backups por padrão) e por actions/config.ts (para exibir os caminhos na
// tela 6.8). Antes desta extração a mesma lógica estava duplicada nos dois
// lugares — e desalinhada: backup-service.ts usava `<cwd>/backups` enquanto
// config.ts só EXIBIA esse caminho, sem garantir que fosse o mesmo usado de
// fato. Centralizar aqui evita as duas fontes de verdade divergirem de novo.
//
// Camada de serviço com I/O — pode importar fs/path livremente (só
// src/core/** e src/parser/** são restritos — ver eslint.config.mjs).

/**
 * Resolve o caminho absoluto do arquivo `.db` a partir de `DATABASE_URL`
 * (`.env`). Segue a mesma convenção do Prisma: um valor relativo (ex.:
 * `file:../data/app.db`) é resolvido relativo a `prisma/schema.prisma`; um
 * valor absoluto (ex.: `file:G:/Meu Drive/.../app.db`) é usado como está —
 * `path.resolve` descarta os segmentos anteriores assim que encontra um
 * segmento absoluto, então a mesma chamada cobre os dois casos.
 */
export function resolverCaminhoDb(): string {
  const url = process.env.DATABASE_URL ?? "file:../data/app.db";
  const semPrefixo = url.replace(/^file:/, "");
  return path.resolve(process.cwd(), "prisma", semPrefixo);
}

/**
 * Diretório padrão dos backups automáticos: a subpasta `backup/` dentro do
 * MESMO diretório onde vive o arquivo `.db` (nunca `<cwd>/backups` — o app
 * pode rodar com `DATABASE_URL` apontando para fora do repositório, ex.: uma
 * pasta sincronizada na nuvem, e os backups precisam viver ao lado do
 * arquivo real que protegem, não da pasta de onde o processo foi iniciado).
 */
export function diretorioBackupsPadrao(): string {
  return path.join(path.dirname(resolverCaminhoDb()), "backup");
}
