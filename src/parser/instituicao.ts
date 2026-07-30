/**
 * src/parser/instituicao.ts — extração da instituição a partir do nome
 * do arquivo de export (contracts/parser.md #7).
 *
 * Implementada isoladamente e antes de `mycapital.ts` (T034) por
 * decisão documentada no relatório da tarefa: é uma função pura,
 * autocontida, sem dependência do parse de colunas do CSV — nada
 * impede que nasça já verde enquanto `parseArquivoMyCapital` (que
 * depende dela) ainda não existe.
 */

import type { ErroParse } from "./types";

/**
 * Erro lançado por `extrairInstituicao` quando o nome do arquivo não
 * permite identificar a instituição (vazio ou só a extensão `.csv`).
 *
 * Implementa a forma de `ErroParse` (linha/coluna) para que
 * `parseArquivoMyCapital` (T034) possa capturar e incluir este erro,
 * sem tradução, no array `erros` de um `ResultadoParse` com `ok: false`.
 */
export class ErroExtrairInstituicao extends Error implements ErroParse {
  readonly arquivo: string;
  readonly linha: number;
  readonly coluna: string;
  readonly mensagem: string;

  constructor(arquivo: string, mensagem: string) {
    super(mensagem);
    this.name = "ErroExtrairInstituicao";
    this.arquivo = arquivo;
    this.linha = 1;
    this.coluna = "<arquivo>";
    this.mensagem = mensagem;
  }
}

/** Remove a extensão `.csv` (case-insensitive) do final do nome, se presente. */
function removerExtensaoCsv(nome: string): string {
  return nome.replace(/\.csv$/i, "");
}

/**
 * Extrai o nome da instituição a partir do nome do arquivo.
 *
 * - Último segmento antes de `.csv`, após `_` quando houver:
 *   `"MyCapital_export_Itaú.csv"` → `"Itaú"`.
 * - Sem `_`: o nome inteiro antes de `.csv` é a instituição:
 *   `"Nubank.csv"` → `"Nubank"`.
 * - Nome vazio, só `.csv`, ou sem nada após o último `_` ⇒ lança
 *   `ErroExtrairInstituicao` (`coluna: '<arquivo>'`).
 *
 * @throws {ErroExtrairInstituicao}
 */
export function extrairInstituicao(nomeArquivoRaw: string): string {
  const nomeArquivo = typeof nomeArquivoRaw === "string" ? nomeArquivoRaw : "";
  const semExtensao = removerExtensaoCsv(nomeArquivo.trim());

  if (semExtensao.length === 0) {
    throw new ErroExtrairInstituicao(
      nomeArquivoRaw,
      `Não foi possível identificar a instituição a partir do nome do arquivo: "${nomeArquivoRaw}".`,
    );
  }

  const partes = semExtensao.split("_");
  const instituicao = partes[partes.length - 1].trim();

  if (instituicao.length === 0) {
    throw new ErroExtrairInstituicao(
      nomeArquivoRaw,
      `Não foi possível identificar a instituição a partir do nome do arquivo: "${nomeArquivoRaw}".`,
    );
  }

  return instituicao;
}
