import { describe, expect, it } from "vitest";

import {
  ErroExtrairInstituicao,
  extrairInstituicao,
} from "@/parser/instituicao";

/**
 * T033 — contracts/parser.md #7: instituição extraída do nome do
 * arquivo (último segmento antes de `.csv`, após `_` quando houver).
 *
 * Diferente de erros.test.ts/samples.test.ts (que dependem de
 * `parseArquivoMyCapital`, ainda não implementado), `extrairInstituicao`
 * já está implementada isoladamente (ver src/parser/instituicao.ts) —
 * esta suíte já roda verde.
 */
describe("extrairInstituicao", () => {
  it("extrai o último segmento após '_' quando houver underscore no nome", () => {
    expect(extrairInstituicao("MyCapital_export_Itaú.csv")).toBe("Itaú");
    expect(extrairInstituicao("2026-07_XPTO_Itaú.csv")).toBe("Itaú");
  });

  it("usa o nome inteiro antes de '.csv' quando não há underscore", () => {
    expect(extrairInstituicao("Nubank.csv")).toBe("Nubank");
    expect(extrairInstituicao("Avenue.csv")).toBe("Avenue");
  });

  it("é case-insensitive quanto à extensão .csv", () => {
    expect(extrairInstituicao("Nubank.CSV")).toBe("Nubank");
  });

  it("lança ErroExtrairInstituicao para nome de arquivo vazio", () => {
    expect(() => extrairInstituicao("")).toThrow(ErroExtrairInstituicao);

    try {
      extrairInstituicao("");
      expect.unreachable("deveria ter lançado ErroExtrairInstituicao");
    } catch (erro) {
      expect(erro).toBeInstanceOf(ErroExtrairInstituicao);
      const erroParse = erro as ErroExtrairInstituicao;
      expect(erroParse.coluna).toBe("<arquivo>");
      expect(erroParse.mensagem).toBeTruthy();
    }
  });

  it("lança ErroExtrairInstituicao para nome de arquivo só com a extensão '.csv'", () => {
    expect(() => extrairInstituicao(".csv")).toThrow(ErroExtrairInstituicao);

    try {
      extrairInstituicao(".csv");
      expect.unreachable("deveria ter lançado ErroExtrairInstituicao");
    } catch (erro) {
      expect(erro).toBeInstanceOf(ErroExtrairInstituicao);
      expect((erro as ErroExtrairInstituicao).coluna).toBe("<arquivo>");
    }
  });

  it("lança ErroExtrairInstituicao quando não sobra nada após o último '_'", () => {
    expect(() => extrairInstituicao("MyCapital_.csv")).toThrow(
      ErroExtrairInstituicao,
    );
  });
});
