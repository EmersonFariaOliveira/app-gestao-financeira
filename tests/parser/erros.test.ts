import { describe, expect, it } from "vitest";

import { parseArquivoMyCapital } from "@/parser/mycapital";
import type { ArquivoImport, ErroParse } from "@/parser/types";

/**
 * T031 — casos sintéticos de erro do parser (contracts/parser.md).
 *
 * Todos os arquivos aqui são construídos à mão (bytes/conteúdo
 * sintéticos), sem depender de docs/samples/ — devem rodar em qualquer
 * máquina, com ou sem os dados reais.
 *
 * Fase RED (T030-T031): `@/parser/mycapital` ainda não existe
 * (implementação real é T034) — esta suíte inteira deve FALHAR agora
 * por erro de resolução de módulo. Isso é esperado.
 */

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

const COLUNAS_OBRIGATORIAS = [
  "Ação",
  "Quantidade",
  "Patrimônio Hoje",
  "Tipo de Grupo",
  "dataUltimaCotacao",
] as const;

/** Monta os bytes de um "arquivo" a partir de linhas de texto (uma por elemento), unidas por "\n". */
function bytesDoArquivo(linhas: string[], comBOM: boolean): Uint8Array {
  const texto = linhas.join("\n");
  const corpo = new TextEncoder().encode(texto);
  if (!comBOM) return corpo;
  const combinado = new Uint8Array(BOM.length + corpo.length);
  combinado.set(BOM, 0);
  combinado.set(corpo, BOM.length);
  return combinado;
}

/** Header válido mínimo (só as colunas-chave exigidas pelo contrato). */
function headerValido(): string {
  return COLUNAS_OBRIGATORIAS.join(";");
}

/** Uma linha de dados válida, na ordem de `headerValido()`. */
function linhaValida(opts?: {
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
  return [acao, quantidade, patrimonioHoje, tipoGrupo, dataUltimaCotacao].join(
    ";",
  );
}

function arquivo(nomeArquivo: string, linhas: string[], comBOM = true): ArquivoImport {
  return { nomeArquivo, conteudo: bytesDoArquivo(linhas, comBOM) };
}

describe("parseArquivoMyCapital — erros sintéticos", () => {
  it.each(COLUNAS_OBRIGATORIAS)(
    "erro em linha 1 quando a coluna-chave '%s' está ausente do cabeçalho",
    (colunaFaltante) => {
      const colunasRestantes = COLUNAS_OBRIGATORIAS.filter(
        (c) => c !== colunaFaltante,
      );
      const header = colunasRestantes.join(";");
      const linha = colunasRestantes
        .map((c) => (c === "Quantidade" ? "100" : c === "Patrimônio Hoje" ? "1234.56" : "valor"))
        .join(";");

      const resultado = parseArquivoMyCapital(
        arquivo("Itaú.csv", [header, linha]),
      );

      expect(resultado.ok).toBe(false);
      if (resultado.ok) return;
      expect(resultado.erros).toContainEqual(
        expect.objectContaining({
          arquivo: "Itaú.csv",
          linha: 1,
          coluna: colunaFaltante,
        }),
      );
    },
  );

  it("Patrimônio Hoje literal 'null' é tratado como ausente ⇒ erro", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [
        headerValido(),
        linhaValida({ patrimonioHoje: "null" }),
      ]),
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.erros).toContainEqual(
      expect.objectContaining({
        arquivo: "Itaú.csv",
        linha: 2,
        coluna: "Patrimônio Hoje",
      }),
    );
  });

  it("Patrimônio Hoje não-numérico ⇒ erro", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [
        headerValido(),
        linhaValida({ patrimonioHoje: "abc" }),
      ]),
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.erros).toContainEqual(
      expect.objectContaining({
        arquivo: "Itaú.csv",
        linha: 2,
        coluna: "Patrimônio Hoje",
      }),
    );
  });

  it("Patrimônio Hoje negativo ⇒ erro", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [
        headerValido(),
        linhaValida({ patrimonioHoje: "-100.00" }),
      ]),
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.erros).toContainEqual(
      expect.objectContaining({
        arquivo: "Itaú.csv",
        linha: 2,
        coluna: "Patrimônio Hoje",
      }),
    );
  });

  it("arquivo vazio (0 bytes) ⇒ erro '<arquivo>': arquivo sem posições", () => {
    const resultado = parseArquivoMyCapital({
      nomeArquivo: "Itaú.csv",
      conteudo: new Uint8Array(0),
    });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.erros).toContainEqual(
      expect.objectContaining({
        arquivo: "Itaú.csv",
        coluna: "<arquivo>",
        mensagem: expect.stringContaining("arquivo sem posições"),
      }),
    );
  });

  it("arquivo só com cabeçalho (sem linhas de dados) ⇒ mesmo erro de arquivo sem posições", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [headerValido()]),
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.erros).toContainEqual(
      expect.objectContaining({
        arquivo: "Itaú.csv",
        coluna: "<arquivo>",
        mensagem: expect.stringContaining("arquivo sem posições"),
      }),
    );
  });

  it("com BOM UTF-8 (EF BB BF) ⇒ aceito normalmente (BOM ignorado)", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [headerValido(), linhaValida()], true),
    );

    expect(resultado.ok).toBe(true);
  });

  it("sem BOM ⇒ aceito normalmente", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [headerValido(), linhaValida()], false),
    );

    expect(resultado.ok).toBe(true);
  });

  it("separador errado (vírgula em vez de ';') ⇒ vira erro de coluna faltante, sem inferência", () => {
    const headerComVirgula = COLUNAS_OBRIGATORIAS.join(",");
    const linhaComVirgula = "PRIO3,100,1234.56,ACOES,2026-07-28T03:00:00.000Z";

    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [headerComVirgula, linhaComVirgula]),
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    // O parser não deve inferir o separador: como o header inteiro vira
    // uma única "coluna" (sem ';'), NENHUMA das colunas-chave é
    // encontrada pelo nome exato — todas viram erro de coluna faltante.
    for (const coluna of COLUNAS_OBRIGATORIAS) {
      expect(resultado.erros).toContainEqual(
        expect.objectContaining({ arquivo: "Itaú.csv", linha: 1, coluna }),
      );
    }
  });

  it("coleta TODOS os erros de um arquivo de uma vez (nunca resultado parcial)", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [
        headerValido(),
        linhaValida(), // linha 2: válida
        linhaValida({ patrimonioHoje: "null" }), // linha 3: erro
        linhaValida({ patrimonioHoje: "-50.00" }), // linha 4: erro
        linhaValida({ patrimonioHoje: "abc" }), // linha 5: erro
      ]),
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.erros).toHaveLength(3);
    expect(
      resultado.erros.map((e: ErroParse) => e.linha).sort(),
    ).toEqual([3, 4, 5]);
    for (const erro of resultado.erros) {
      expect(erro.coluna).toBe("Patrimônio Hoje");
    }
  });

  it("nome de arquivo inválido (instituição não identificável) também vira erro coletado", () => {
    const resultado = parseArquivoMyCapital(
      arquivo(".csv", [headerValido(), linhaValida()]),
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.erros).toContainEqual(
      expect.objectContaining({ coluna: "<arquivo>" }),
    );
  });
});
