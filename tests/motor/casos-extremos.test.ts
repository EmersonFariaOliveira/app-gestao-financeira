/**
 * tests/motor/casos-extremos.test.ts — casos de borda do motor NÃO listados
 * na tabela "Casos de teste mínimos" de contracts/motor.md, mas relevantes
 * para robustez (levantados na revisão de cobertura do engenheiro-testes):
 * aporte de valor zero, carteira com um único alvo, mistura de déficits
 * negativos/zero (sem nenhum positivo), cotação/ajuste referenciando um
 * alvoId que não existe na entrada, e valores grandes (na casa dos bilhões
 * de centavos) para garantir que a aritmética inteira não estoura
 * `Number.MAX_SAFE_INTEGER`.
 *
 * Nenhum destes casos revelou bug — todos passam com o comportamento atual
 * do motor. Ver tests/motor/redistribuicao.test.ts para o caso que REVELA
 * um bug real (ajustesUsuario cuja soma excede valorAporteCentavos).
 */
import { describe, expect, it } from "vitest";
import { calcularAporte } from "@/core/motor";
import type { EntradaMotor } from "@/core/motor/types";
import { cenarioBase } from "./fixtures";

function somaDivisao(divisao: { valorCentavos: number }[]): number {
  return divisao.reduce((acc, l) => acc + l.valorCentavos, 0);
}

describe("caso de borda — aporte de valor zero", () => {
  it("valorAporteCentavos = 0 ⇒ divisão vazia, troco zero, fila calculada normalmente", () => {
    const input = cenarioBase();
    input.valorAporteCentavos = 0;

    const resultado = calcularAporte(input);

    expect(resultado.divisao).toEqual([]);
    expect(resultado.trocoCentavos).toBe(0);
    // A fila/déficit continuam calculados mesmo sem dinheiro para dividir.
    expect(resultado.fila).toHaveLength(3);
    expect(resultado.fila.find((i) => i.alvoId === "alvo-a")?.deficitCentavos).toBe(200_000);
    expect(somaDivisao(resultado.divisao) + resultado.trocoCentavos).toBe(0);
  });
});

describe("caso de borda — carteira com um único alvo (100% bps)", () => {
  it("todo o aporte vai para o único alvo como transbordo (déficit é sempre 0 quando há um único alvo)", () => {
    // Com um único alvo vigente e 100% dos bps, patrimonioBase é sempre
    // igual ao valorAtual desse alvo (nenhum outro alvo existe para "roubar"
    // percentual) ⇒ target = 100% * patrimonioBase = valorAtual ⇒ déficit
    // estruturalmente 0. Todo o aporte é, portanto, 100% transbordo.
    const alvos: EntradaMotor["alvos"] = [
      { alvoId: "unico", nome: "Único", percentualBps: 10_000, rendaFixa: false },
    ];
    const posicoes: EntradaMotor["posicoes"] = [
      { chaveExport: "ATIVO1", alvoId: "unico", foraDaCarteira: false, valorCentavos: 100_000, tipoGrupo: "ACOES" },
    ];

    const resultado = calcularAporte({
      alvos,
      posicoes,
      valorAporteCentavos: 50_000,
      aporteMinimoCentavos: 100,
    });

    expect(resultado.fila).toHaveLength(1);
    expect(resultado.fila[0].deficitCentavos).toBe(0);
    expect(resultado.divisao).toEqual([
      { alvoId: "unico", valorCentavos: 50_000, origem: "TRANSBORDO" },
    ]);
    expect(somaDivisao(resultado.divisao)).toBe(50_000);
  });

  it("único alvo sem nenhuma posição ainda (déficit do zero): todo o aporte cai em DEFICIT", () => {
    // Carteira nova: o único alvo ainda não tem posição vinculada
    // (valorAtual=0) ⇒ patrimonioBase=0 ⇒ target=aplicarBps(0, bps)=0 ⇒
    // déficit=0 também (0 - 0). Mesmo sem posições, o aporte inteiro deve
    // ser alocado a esse único alvo (via transbordo, já que déficit é 0).
    const alvos: EntradaMotor["alvos"] = [
      { alvoId: "unico", nome: "Único", percentualBps: 10_000, rendaFixa: false },
    ];

    const resultado = calcularAporte({
      alvos,
      posicoes: [],
      valorAporteCentavos: 30_000,
      aporteMinimoCentavos: 100,
    });

    expect(resultado.patrimonioBaseCentavos).toBe(0);
    expect(resultado.divisao).toEqual([
      { alvoId: "unico", valorCentavos: 30_000, origem: "TRANSBORDO" },
    ]);
    expect(somaDivisao(resultado.divisao)).toBe(30_000);
  });
});

describe("caso de borda — nenhum alvo com déficit positivo (mistura de zero e negativo)", () => {
  it("transbordo 100% proporcional aos bps mesmo sem nenhum déficit positivo na fila", () => {
    // bps 3333/3333/3334 sobre patrimonioBase=299 ⇒ targets truncados = 99/99/99
    // (perda de arredondamento de 2 centavos: 99+99+99=297 < 299).
    // valorAtual = [100, 99, 100] ⇒ déficits = [-1, 0, -1]: nenhum positivo,
    // mas nem todos são exatamente zero (mistura negativo/zero).
    const alvos: EntradaMotor["alvos"] = [
      { alvoId: "p", nome: "P", percentualBps: 3333, rendaFixa: false },
      { alvoId: "q", nome: "Q", percentualBps: 3333, rendaFixa: false },
      { alvoId: "r", nome: "R", percentualBps: 3334, rendaFixa: false },
    ];
    const posicoes: EntradaMotor["posicoes"] = [
      { chaveExport: "P1", alvoId: "p", foraDaCarteira: false, valorCentavos: 100, tipoGrupo: "ACOES" },
      { chaveExport: "Q1", alvoId: "q", foraDaCarteira: false, valorCentavos: 99, tipoGrupo: "ACOES" },
      { chaveExport: "R1", alvoId: "r", foraDaCarteira: false, valorCentavos: 100, tipoGrupo: "ACOES" },
    ];

    const resultado = calcularAporte({
      alvos,
      posicoes,
      valorAporteCentavos: 1000,
      aporteMinimoCentavos: 1,
    });

    expect(resultado.fila.map((i) => i.deficitCentavos)).toEqual([0, -1, -1]);
    expect(resultado.fila.every((i) => i.deficitCentavos <= 0)).toBe(true);

    // 100% do aporte é transbordo proporcional aos bps de TODOS os alvos
    // (3333/3333/3334 sobre 10000), independente do déficit ser 0 ou negativo.
    expect(resultado.divisao.every((l) => l.origem === "TRANSBORDO")).toBe(true);
    expect(somaDivisao(resultado.divisao)).toBe(1000);
  });
});

describe("caso de borda — cotação/ajuste referenciando alvoId inexistente na entrada", () => {
  it("cotacoes com um alvoId que não está em `alvos` é ignorada com segurança (sem afetar as demais linhas)", () => {
    const input = cenarioBase();
    input.valorAporteCentavos = 100_000;
    input.aporteMinimoCentavos = 100;
    input.cotacoes = [{ alvoId: "alvo-fantasma", precoCentavos: 100 }];

    const resultado = calcularAporte(input);

    // Sem alvo real casando com a cotação, nenhuma linha recebe `cotas`/`precoCentavos`.
    expect(resultado.divisao).toEqual([
      { alvoId: "alvo-a", valorCentavos: 100_000, origem: "DEFICIT" },
    ]);
    expect(resultado.trocoCentavos).toBe(0);
  });

  it("ajustesUsuario com um alvoId que não está em `alvos` é ignorado; o aporte inteiro é redistribuído normalmente", () => {
    const input = cenarioBase();
    input.valorAporteCentavos = 100_000;
    input.aporteMinimoCentavos = 100;
    input.ajustesUsuario = [{ alvoId: "alvo-fantasma", valorCentavos: 1_000 }];

    const resultado = calcularAporte(input);

    // O ajuste para um alvo inexistente não "some" com parte do aporte nem
    // aparece na divisão — o valor inteiro é distribuído pelas regras 1-5
    // como se ajustesUsuario estivesse vazio.
    expect(resultado.divisao.find((l) => l.alvoId === "alvo-fantasma")).toBeUndefined();
    expect(resultado.divisao).toEqual([
      { alvoId: "alvo-a", valorCentavos: 100_000, origem: "DEFICIT" },
    ]);
    expect(somaDivisao(resultado.divisao)).toBe(100_000);
  });
});

describe("caso de borda — valores grandes (sem estouro de Number.MAX_SAFE_INTEGER)", () => {
  it("carteira na casa de R$ 1 bilhão: soma exata e sem perda de precisão", () => {
    // 1 bilhão de reais = 100_000_000_000 centavos. bps*valor máximo
    // (10000 * 100_000_000_000 = 1e15) fica bem abaixo de
    // Number.MAX_SAFE_INTEGER (~9.007e15) — ver src/core/money#aplicarBps.
    const patrimonioAlvoA = 60_000_000_000; // R$ 600 milhões
    const patrimonioAlvoB = 40_000_000_000; // R$ 400 milhões
    const alvos: EntradaMotor["alvos"] = [
      { alvoId: "a", nome: "A", percentualBps: 7000, rendaFixa: false },
      { alvoId: "b", nome: "B", percentualBps: 3000, rendaFixa: false },
    ];
    const posicoes: EntradaMotor["posicoes"] = [
      { chaveExport: "A1", alvoId: "a", foraDaCarteira: false, valorCentavos: patrimonioAlvoA, tipoGrupo: "ACOES" },
      { chaveExport: "B1", alvoId: "b", foraDaCarteira: false, valorCentavos: patrimonioAlvoB, tipoGrupo: "ACOES" },
    ];
    const valorAporteCentavos = 10_000_000_000; // R$ 100 milhões

    const resultado = calcularAporte({
      alvos,
      posicoes,
      valorAporteCentavos,
      aporteMinimoCentavos: 100,
    });

    expect(Number.isSafeInteger(resultado.patrimonioBaseCentavos)).toBe(true);
    for (const linha of resultado.divisao) {
      expect(Number.isSafeInteger(linha.valorCentavos)).toBe(true);
    }
    expect(somaDivisao(resultado.divisao) + resultado.trocoCentavos).toBe(valorAporteCentavos);

    // patrimonioBase = 100_000_000_000; target A = 70_000_000_000 (déficit=10_000_000_000);
    // target B = 30_000_000_000 (déficit=-10_000_000_000, negativo).
    // Aporte de 10_000_000_000 cobre exatamente o déficit de A, sem transbordo.
    expect(resultado.divisao).toEqual([
      { alvoId: "a", valorCentavos: 10_000_000_000, origem: "DEFICIT" },
    ]);
  });
});

describe("caso de borda — pureza mesmo em valorAporteCentavos = 0", () => {
  it("chamar duas vezes com aporte zero produz resultado idêntico", () => {
    const input1 = { ...cenarioBase(), valorAporteCentavos: 0 };
    const input2 = { ...cenarioBase(), valorAporteCentavos: 0 };

    expect(calcularAporte(input1)).toEqual(calcularAporte(input2));
  });
});
