import { describe, expect, it } from "vitest";

import { parseArquivoMyCapital } from "@/parser/mycapital";
import type { ArquivoImport } from "@/parser/types";

/**
 * T006 (feature 003) — captura opcional da coluna "Patrimônio Aplicado".
 *
 * Contrato: specs/003-dashboard-analise-rendimento/contracts/parser-patrimonio-aplicado.md
 * Decisão: specs/003-dashboard-analise-rendimento/research.md (R2).
 *
 * Diferente de "Patrimônio Hoje", esta coluna é opcional: ausência,
 * "null" literal, vazio ou valor não-numérico NUNCA geram `ErroParse` nem
 * invalidam o arquivo — apenas produzem `patrimonioAplicadoCentavos: null`
 * para a(s) linha(s) afetada(s).
 */

const COLUNAS_BASE = [
  "Ação",
  "Quantidade",
  "Patrimônio Hoje",
  "Tipo de Grupo",
  "dataUltimaCotacao",
] as const;

function bytesDoArquivo(linhas: string[]): Uint8Array {
  return new TextEncoder().encode(linhas.join("\n"));
}

function arquivo(nomeArquivo: string, linhas: string[]): ArquivoImport {
  return { nomeArquivo, conteudo: bytesDoArquivo(linhas) };
}

/** Header com todas as colunas obrigatórias + "Patrimônio Aplicado". */
function headerComPatrimonioAplicado(): string {
  return [...COLUNAS_BASE, "Patrimônio Aplicado"].join(";");
}

/** Header apenas com as colunas obrigatórias (sem "Patrimônio Aplicado"). */
function headerSemPatrimonioAplicado(): string {
  return COLUNAS_BASE.join(";");
}

function linhaComPatrimonioAplicado(opts?: {
  acao?: string;
  quantidade?: string;
  patrimonioHoje?: string;
  tipoGrupo?: string;
  dataUltimaCotacao?: string;
  patrimonioAplicado?: string;
}): string {
  const {
    acao = "PRIO3",
    quantidade = "100",
    patrimonioHoje = "1234.56",
    tipoGrupo = "ACOES",
    dataUltimaCotacao = "2026-07-28T03:00:00.000Z",
    patrimonioAplicado = "1000.00",
  } = opts ?? {};
  return [
    acao,
    quantidade,
    patrimonioHoje,
    tipoGrupo,
    dataUltimaCotacao,
    patrimonioAplicado,
  ].join(";");
}

function linhaSemColunaPatrimonioAplicado(opts?: {
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

describe("parseArquivoMyCapital — Patrimônio Aplicado (feature 003)", () => {
  it("coluna presente e válida em todas as linhas -> patrimonioAplicadoCentavos preenchido", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [
        headerComPatrimonioAplicado(),
        linhaComPatrimonioAplicado({
          acao: "PRIO3",
          patrimonioAplicado: "1000.00",
        }),
        linhaComPatrimonioAplicado({
          acao: "VALE3",
          patrimonioAplicado: "555.5",
        }),
      ]),
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const [prio3, vale3] = resultado.arquivo.linhas;
    expect(prio3.patrimonioAplicadoCentavos).toBe(100000);
    expect(vale3.patrimonioAplicadoCentavos).toBe(55550);
  });

  it("coluna ausente do cabeçalho -> ok:true, todas as linhas com null, nenhum ErroParse novo", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [
        headerSemPatrimonioAplicado(),
        linhaSemColunaPatrimonioAplicado({ acao: "PRIO3" }),
        linhaSemColunaPatrimonioAplicado({ acao: "VALE3" }),
      ]),
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resultado.arquivo.linhas).toHaveLength(2);
    for (const linha of resultado.arquivo.linhas) {
      expect(linha.patrimonioAplicadoCentavos).toBeNull();
    }
  });

  it("valor 'null' literal ou vazio -> null só naquela linha, resto do arquivo processado normalmente", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [
        headerComPatrimonioAplicado(),
        linhaComPatrimonioAplicado({
          acao: "PRIO3",
          patrimonioAplicado: "null",
        }),
        linhaComPatrimonioAplicado({ acao: "VALE3", patrimonioAplicado: "" }),
        linhaComPatrimonioAplicado({
          acao: "ITSA4",
          patrimonioAplicado: "800.00",
        }),
      ]),
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const [prio3, vale3, itsa4] = resultado.arquivo.linhas;
    expect(prio3.patrimonioAplicadoCentavos).toBeNull();
    expect(vale3.patrimonioAplicadoCentavos).toBeNull();
    expect(itsa4.patrimonioAplicadoCentavos).toBe(80000);

    // Outros campos da linha continuam intactos (não afetados pelo campo opcional).
    expect(prio3.chaveExport).toBe("PRIO3");
    expect(prio3.patrimonioHojeCentavos).toBe(123456);
  });

  it("valor inválido (texto não numérico) -> null só naquela linha, SEM ErroParse (diferente de Patrimônio Hoje)", () => {
    const resultado = parseArquivoMyCapital(
      arquivo("Itaú.csv", [
        headerComPatrimonioAplicado(),
        linhaComPatrimonioAplicado({
          acao: "PRIO3",
          patrimonioAplicado: "abc",
        }),
        linhaComPatrimonioAplicado({
          acao: "VALE3",
          patrimonioAplicado: "1.2.3",
        }),
      ]),
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const [prio3, vale3] = resultado.arquivo.linhas;
    expect(prio3.patrimonioAplicadoCentavos).toBeNull();
    expect(vale3.patrimonioAplicadoCentavos).toBeNull();
  });
});
