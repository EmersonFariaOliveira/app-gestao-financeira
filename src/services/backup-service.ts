import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/db/client";
import { getConfig } from "@/services/config-service";

// Serviço de backup do banco (T035, research.md R8): antes de confirmar
// cada sessão de import, o app grava uma cópia datada e consistente do
// SQLite via `VACUUM INTO` (não um `fs.copyFile`, que arriscaria capturar
// estado torn com WAL/journal em uso) e aplica retenção configurável
// (data-model.md / config-service: `retencao_backups`, default 12).
// Camada de serviço com I/O — pode importar Prisma/fs/path livremente
// (só src/core/** e src/parser/** são restritos — ver eslint.config.mjs).

/** Nome de arquivo de backup: `app-YYYY-MM-DD.db` ou `app-YYYY-MM-DD-N.db`. */
const REGEX_NOME_BACKUP = /^app-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.db$/;

export interface ResultadoBackup {
  /** Caminho absoluto do arquivo `.db` recém-criado. */
  caminho: string;
  /** Nome do arquivo dentro de `backupsDir` (ex.: `app-2026-07-30-2.db`). */
  nomeArquivo: string;
}

export interface OpcoesBackup {
  /** Diretório onde os backups são gravados. Default: `<cwd>/backups`. */
  backupsDir?: string;
  /** Data de referência do nome do arquivo (injetável em testes). Default: `new Date()`. */
  data?: Date;
}

export interface OpcoesRetencao {
  /** Diretório onde os backups são gravados. Default: `<cwd>/backups`. */
  backupsDir?: string;
  /** Sobrescreve `retencao_backups` da config (útil em testes). */
  limite?: number;
}

function diretorioBackupsPadrao(): string {
  return path.join(process.cwd(), "backups");
}

/** Formata a data local (não UTC) como `YYYY-MM-DD` — o "dia" do backup é o dia local do usuário. */
function formatarDataLocal(data: Date): string {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

/**
 * Valida estritamente o formato `YYYY-MM-DD` e que a data é um calendário
 * real (rejeita `2026-02-30`, por exemplo). Defesa em profundidade (OWASP
 * Top 10 / injeção): mesmo a data sendo gerada internamente (nunca vinda de
 * input de usuário), ela é interpolada dentro de uma string SQL crua
 * (`VACUUM INTO`) — validar antes de interpolar é a prática correta.
 */
function validarDataISO(dataISO: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dataISO);
  if (!match) {
    throw new Error(`Data inválida para nome de backup: "${dataISO}" (esperado YYYY-MM-DD).`);
  }
  const ano = Number(match[1]);
  const mes = Number(match[2]);
  const dia = Number(match[3]);
  const data = new Date(ano, mes - 1, dia);
  const valida =
    data.getFullYear() === ano && data.getMonth() === mes - 1 && data.getDate() === dia;
  if (!valida) {
    throw new Error(`Data inválida para nome de backup: "${dataISO}" (não é uma data de calendário válida).`);
  }
}

/** Escapa aspas simples para uso seguro dentro de uma string SQL literal (defesa em profundidade). */
function escaparStringSql(valor: string): string {
  return valor.replace(/'/g, "''");
}

/** Primeiro nome livre em `backupsDir` para a data informada: `app-<data>.db`, depois `-2`, `-3`, ... */
function proximoNomeDisponivel(backupsDir: string, dataISO: string): string {
  validarDataISO(dataISO);

  let sufixo = 1;
  let nome = `app-${dataISO}.db`;
  while (fs.existsSync(path.join(backupsDir, nome))) {
    sufixo += 1;
    nome = `app-${dataISO}-${sufixo}.db`;
  }
  return nome;
}

/**
 * Cria um snapshot consistente e compactado do banco corrente via
 * `VACUUM INTO` (research.md R8) dentro de `backupsDir` (cria a pasta se
 * não existir). Usa `$executeRawUnsafe` porque `VACUUM INTO` é uma
 * instrução (não retorna linhas) e o caminho do arquivo não pode ser
 * parametrizado com bind (`?`) pelo SQLite nessa posição — por isso a data
 * é validada estritamente (`validarDataISO`) e o caminho final tem aspas
 * simples escapadas antes de entrar na string SQL.
 */
export async function criarBackup(opcoes: OpcoesBackup = {}): Promise<ResultadoBackup> {
  const backupsDir = opcoes.backupsDir ?? diretorioBackupsPadrao();
  const data = opcoes.data ?? new Date();

  fs.mkdirSync(backupsDir, { recursive: true });

  const dataISO = formatarDataLocal(data);
  const nomeArquivo = proximoNomeDisponivel(backupsDir, dataISO);
  const caminhoAbsoluto = path.join(backupsDir, nomeArquivo);

  // SQLite aceita '/' como separador em qualquer plataforma; normaliza para
  // evitar qualquer ambiguidade de escaping de '\' dentro da string SQL.
  const caminhoParaSql = escaparStringSql(caminhoAbsoluto.split(path.sep).join("/"));

  await prisma.$executeRawUnsafe(`VACUUM INTO '${caminhoParaSql}'`);

  return { caminho: caminhoAbsoluto, nomeArquivo };
}

interface ArquivoBackup {
  nome: string;
  caminho: string;
  mtimeMs: number;
}

/** Lista os arquivos de `backupsDir` que seguem o padrão `app-YYYY-MM-DD(-N)?.db`. */
function listarBackups(backupsDir: string): ArquivoBackup[] {
  if (!fs.existsSync(backupsDir)) return [];

  return fs
    .readdirSync(backupsDir)
    .filter((nome) => REGEX_NOME_BACKUP.test(nome))
    .map((nome) => {
      const caminho = path.join(backupsDir, nome);
      const { mtimeMs } = fs.statSync(caminho);
      return { nome, caminho, mtimeMs };
    });
}

/**
 * Apaga os backups mais antigos além do limite de retenção (config
 * `retencao_backups`, default 12 — data-model.md). Ordena por data/hora de
 * criação (mtime), mais recente primeiro, e remove o excedente. Retorna os
 * caminhos removidos (para log/auditoria do chamador, se desejado).
 */
export async function aplicarRetencao(opcoes: OpcoesRetencao = {}): Promise<string[]> {
  const backupsDir = opcoes.backupsDir ?? diretorioBackupsPadrao();
  const limite = opcoes.limite ?? (await getConfig("retencao_backups"));

  const backups = listarBackups(backupsDir).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const excedentes = backups.slice(Math.max(limite, 0));

  for (const backup of excedentes) {
    fs.rmSync(backup.caminho, { force: true });
  }

  return excedentes.map((b) => b.caminho);
}

/**
 * Função principal (T035): cria o backup datado e, em seguida, aplica a
 * retenção. É esta a função que `import-service` (T036) deve chamar
 * IMEDIATAMENTE ANTES de confirmar/persistir uma nova sessão de import —
 * nunca depois, e nunca condicionalmente ("o import é a única operação que
 * altera dados em volume", docs/app-gestao-aportes.md §7).
 */
export async function executarBackupComRetencao(
  opcoes: OpcoesBackup = {},
): Promise<{ backup: ResultadoBackup; removidos: string[] }> {
  const backup = await criarBackup(opcoes);
  const removidos = await aplicarRetencao({ backupsDir: opcoes.backupsDir });
  return { backup, removidos };
}
