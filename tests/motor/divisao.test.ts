/**
 * tests/motor/divisao.test.ts — regras 3 e 5 da spec (docs/app-gestao-aportes.md
 * seção 5): cascata de preenchimento por déficit, transbordo proporcional
 * aos percentuais-alvo e aporte mínimo por transação.
 *
 * Convenção adotada para `LinhaDivisao.origem` quando uma linha é composta
 * por dinheiro de MAIS de uma fase (ex.: parte veio do preenchimento do
 * déficit e parte do transbordo) — o contrato (contracts/motor.md) não
 * detalha esse caso explicitamente, então os testes abaixo:
 * - Para linhas de fase ÚNICA (só déficit OU só transbordo), fixam a origem
 *   exata.
 * - Para linhas MISTAS, verificam apenas o valor final (o `origem` fica sem
 *   asserção estrita) — ver nota também no relatório final do agente.
 *
 * FASE RED (T017): espera-se falha (módulo `@/core/motor` inexistente).
 */
import { describe, expect, it } from "vitest";
import { calcularAporte } from "@/core/motor";
import {
  cenarioBase,
  CENARIO_BASE_DEFICIT_A,
  CENARIO_BASE_SOMA_DEFICITS_POSITIVOS,
} from "./fixtures";
import type { EntradaMotor } from "@/core/motor/types";

function somaDivisao(divisao: { valorCentavos: number }[]): number {
  return divisao.reduce((acc, l) => acc + l.valorCentavos, 0);
}

describe("regra 3 — cascata e déficit", () => {
  it("aporte menor que o déficit do 1º da fila: tudo concentrado num único alvo", () => {
    const input = cenarioBase();
    input.aporteMinimoCentavos = 100;
    input.valorAporteCentavos = 100_000; // < 200000 (déficit de alvo-a)

    const resultado = calcularAporte(input);

    expect(resultado.divisao).toEqual([
      { alvoId: "alvo-a", valorCentavos: 100_000, origem: "DEFICIT" },
    ]);
    expect(somaDivisao(resultado.divisao) + resultado.trocoCentavos).toBe(100_000);
  });

  it("aporte cobre o déficit do 1º e sobra (parcialmente) para o 2º", () => {
    const input = cenarioBase();
    input.aporteMinimoCentavos = 100;
    // 200000 (cobre alvo-a) + 10000 (parcial de alvo-b, que precisa de 20000)
    input.valorAporteCentavos = CENARIO_BASE_DEFICIT_A + 10_000;

    const resultado = calcularAporte(input);

    const linhaA = resultado.divisao.find((l) => l.alvoId === "alvo-a");
    const linhaB = resultado.divisao.find((l) => l.alvoId === "alvo-b");
    expect(linhaA).toEqual({ alvoId: "alvo-a", valorCentavos: 200_000, origem: "DEFICIT" });
    expect(linhaB).toEqual({ alvoId: "alvo-b", valorCentavos: 10_000, origem: "DEFICIT" });
    expect(resultado.divisao.find((l) => l.alvoId === "alvo-c")).toBeUndefined();
    expect(somaDivisao(resultado.divisao)).toBe(input.valorAporteCentavos);
  });

  it("aporte > soma dos déficits ⇒ transbordo proporcional aos bps, com resto ao topo da fila", () => {
    const input = cenarioBase();
    input.aporteMinimoCentavos = 1;
    // 220000 cobre os dois déficits positivos; sobram 101 de transbordo.
    input.valorAporteCentavos = CENARIO_BASE_SOMA_DEFICITS_POSITIVOS + 101;

    const resultado = calcularAporte(input);

    // Transbordo bruto (bps 5000/3000/2000 sobre 101): 50 / 30 / 20 = 100,
    // resto de 1 centavo vai para o topo da fila (alvo-a).
    const linhaA = resultado.divisao.find((l) => l.alvoId === "alvo-a");
    const linhaB = resultado.divisao.find((l) => l.alvoId === "alvo-b");
    const linhaC = resultado.divisao.find((l) => l.alvoId === "alvo-c");

    expect(linhaA?.valorCentavos).toBe(200_051); // 200000 (déficit) + 51 (50 + resto de 1)
    expect(linhaB?.valorCentavos).toBe(20_030); // 20000 (déficit) + 30 (transbordo)
    expect(linhaC).toEqual({ alvoId: "alvo-c", valorCentavos: 20, origem: "TRANSBORDO" });

    expect(somaDivisao(resultado.divisao)).toBe(input.valorAporteCentavos);
  });

  it("todos os alvos no alvo (déficit zero) ⇒ 100% do aporte é transbordo proporcional aos bps", () => {
    const alvos: EntradaMotor["alvos"] = [
      { alvoId: "d", nome: "D", percentualBps: 5000, rendaFixa: false },
      { alvoId: "e", nome: "E", percentualBps: 3000, rendaFixa: false },
      { alvoId: "f", nome: "F", percentualBps: 2000, rendaFixa: false },
    ];
    const posicoes: EntradaMotor["posicoes"] = [
      { chaveExport: "D1", alvoId: "d", foraDaCarteira: false, valorCentavos: 500_000, tipoGrupo: "ACOES" },
      { chaveExport: "E1", alvoId: "e", foraDaCarteira: false, valorCentavos: 300_000, tipoGrupo: "ACOES" },
      { chaveExport: "F1", alvoId: "f", foraDaCarteira: false, valorCentavos: 200_000, tipoGrupo: "ACOES" },
    ];

    const resultado = calcularAporte({
      alvos,
      posicoes,
      valorAporteCentavos: 100_000,
      aporteMinimoCentavos: 1,
    });

    expect(resultado.fila.every((i) => i.deficitCentavos === 0)).toBe(true);
    expect(resultado.divisao).toEqual(
      expect.arrayContaining([
        { alvoId: "d", valorCentavos: 50_000, origem: "TRANSBORDO" },
        { alvoId: "e", valorCentavos: 30_000, origem: "TRANSBORDO" },
        { alvoId: "f", valorCentavos: 20_000, origem: "TRANSBORDO" },
      ]),
    );
    expect(somaDivisao(resultado.divisao)).toBe(100_000);
  });
});

describe("regra 5 — aporte mínimo por transação", () => {
  it("fatia abaixo do mínimo não é criada; valor é realocado ao topo da fila", () => {
    const input = cenarioBase();
    input.aporteMinimoCentavos = 50_000;
    // Cobre o déficit de alvo-a (200000) e sobrariam 5000 para alvo-b —
    // mas 5000 < 50000 (mínimo): a fatia de alvo-b não é criada e os
    // 5000 voltam para o topo da fila (alvo-a).
    input.valorAporteCentavos = CENARIO_BASE_DEFICIT_A + 5_000;

    const resultado = calcularAporte(input);

    expect(resultado.divisao).toEqual([
      { alvoId: "alvo-a", valorCentavos: 205_000, origem: "DEFICIT" },
    ]);
    // Garantia da regra 5: nenhuma linha 0 < valor < mínimo.
    for (const linha of resultado.divisao) {
      expect(linha.valorCentavos === 0 || linha.valorCentavos >= input.aporteMinimoCentavos).toBe(true);
    }
    expect(somaDivisao(resultado.divisao)).toBe(input.valorAporteCentavos);
  });

  it("aporte total abaixo do mínimo ⇒ tudo concentrado no topo da fila mesmo assim", () => {
    // Caso-limite explícito do contrato (contracts/motor.md, tabela de
    // casos mínimos): quando o APORTE INTEIRO é menor que o mínimo, não há
    // para onde realocar — o valor inteiro vai para o topo da fila como
    // uma única linha, mesmo ficando abaixo do mínimo configurado. Isso não
    // viola o espírito da regra 5 (evitar fragmentar em VÁRIAS transações
    // pequenas): aqui só existe uma linha possível.
    const input = cenarioBase();
    input.aporteMinimoCentavos = 50_000;
    input.valorAporteCentavos = 30_000; // < 50000 e também < déficit de alvo-a

    const resultado = calcularAporte(input);

    expect(resultado.divisao).toEqual([
      { alvoId: "alvo-a", valorCentavos: 30_000, origem: "DEFICIT" },
    ]);
    expect(somaDivisao(resultado.divisao)).toBe(30_000);
  });
});
