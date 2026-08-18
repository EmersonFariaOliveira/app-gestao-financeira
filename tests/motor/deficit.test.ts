/**
 * tests/motor/deficit.test.ts — regras 1 e 4 da spec (docs/app-gestao-aportes.md
 * seção 5): déficit por alvo em centavos e exclusão dos ativos "fora da
 * carteira alvo" da base de cálculo.
 *
 * Fórmula (regra 1, contracts/motor.md): deficit = trunc(percentualBps *
 * patrimonioBase / 10000) - valorAtualDoAlvo. Divisão inteira TRUNCADA
 * (nunca arredondada) — mesma convenção de src/core/money#aplicarBps.
 *
 * FASE RED (T015): `calcularAporte` ainda não existe em src/core/motor —
 * espera-se que este arquivo FALHE (módulo não encontrado) até a
 * implementação (T021-T025).
 */
import { describe, expect, it } from "vitest";
import { calcularAporte } from "@/core/motor";
import { cenarioBase, CENARIO_BASE_PATRIMONIO } from "./fixtures";
import type { EntradaMotor } from "@/core/motor/types";

describe("regra 1 — déficit por alvo", () => {
  it("consolida múltiplas posições do mesmo alvo antes de calcular o déficit", () => {
    // alvo-a tem DUAS posições (ITSA4=100000 + BBAS3=200000) na fixture —
    // o motor deve somá-las (valor_atual_do_grupo) antes de comparar ao alvo.
    const input = cenarioBase();
    input.valorAporteCentavos = 0;

    const resultado = calcularAporte(input);

    const itemA = resultado.fila.find((i) => i.alvoId === "alvo-a");
    expect(itemA?.valorAtualCentavos).toBe(300_000);
  });

  it("calcula o patrimonioBase excluindo ativos fora-da-carteira (regra 4)", () => {
    const input = cenarioBase();

    const resultado = calcularAporte(input);

    // 300000 (alvo-a) + 280000 (alvo-b) + 420000 (alvo-c) = 1.000.000;
    // os 999999 do ativo fora-da-carteira NUNCA entram na base.
    expect(resultado.patrimonioBaseCentavos).toBe(CENARIO_BASE_PATRIMONIO);
  });

  it("calcula déficit positivo quando o alvo está abaixo do percentual-alvo", () => {
    const input = cenarioBase();

    const resultado = calcularAporte(input);

    const itemA = resultado.fila.find((i) => i.alvoId === "alvo-a");
    // trunc(5000 * 1_000_000 / 10000) - 300000 = 500000 - 300000 = 200000
    expect(itemA?.deficitCentavos).toBe(200_000);

    const itemB = resultado.fila.find((i) => i.alvoId === "alvo-b");
    // trunc(3000 * 1_000_000 / 10000) - 280000 = 300000 - 280000 = 20000
    expect(itemB?.deficitCentavos).toBe(20_000);
  });

  it("calcula déficit negativo quando o alvo está acima do percentual-alvo, e não gera venda", () => {
    const input = cenarioBase();

    const resultado = calcularAporte(input);

    const itemC = resultado.fila.find((i) => i.alvoId === "alvo-c");
    // trunc(2000 * 1_000_000 / 10000) - 420000 = 200000 - 420000 = -220000
    expect(itemC?.deficitCentavos).toBe(-220_000);

    // Déficit negativo é ignorado na divisão: alvo-c não deve receber nada
    // quando o aporte não excede a soma dos déficits positivos (220000).
    const semTransbordo = calcularAporte({ ...input, valorAporteCentavos: 100_000 });
    const linhaC = semTransbordo.divisao.find((l) => l.alvoId === "alvo-c");
    expect(linhaC).toBeUndefined();
  });

  it("nunca cria uma LinhaDivisao para o alvo/posição fora-da-carteira", () => {
    const input = cenarioBase();
    const resultado = calcularAporte({ ...input, valorAporteCentavos: 1_000_000 });

    // A posição fora-da-carteira não tem alvoId (null) — não pode aparecer
    // nem na fila nem na divisão sob nenhuma chave.
    expect(resultado.fila.some((i) => i.valorAtualCentavos === 999_999)).toBe(false);
    expect(resultado.divisao.every((l) => l.alvoId !== null)).toBe(true);
  });

  it("trunca (não arredonda) a divisão inteira do déficit", () => {
    const alvos: EntradaMotor["alvos"] = [
      { alvoId: "x", nome: "X", percentualBps: 3333, rendaFixa: false },
      { alvoId: "y", nome: "Y", percentualBps: 6667, rendaFixa: false },
    ];
    const posicoes: EntradaMotor["posicoes"] = [
      { chaveExport: "X1", alvoId: "x", foraDaCarteira: false, valorCentavos: 0, tipoGrupo: "ACOES" },
      { chaveExport: "Y1", alvoId: "y", foraDaCarteira: false, valorCentavos: 100, tipoGrupo: "ACOES" },
    ];

    const resultado = calcularAporte({
      alvos,
      posicoes,
      valorAporteCentavos: 0,
      aporteMinimoCentavos: 1,
    });

    // patrimonioBase = 100. trunc(3333*100/10000) = trunc(33.33) = 33.
    const itemX = resultado.fila.find((i) => i.alvoId === "x");
    expect(itemX?.deficitCentavos).toBe(33);

    // trunc(6667*100/10000) = trunc(66.67) = 66; déficit = 66 - 100 = -34.
    const itemY = resultado.fila.find((i) => i.alvoId === "y");
    expect(itemY?.deficitCentavos).toBe(-34);
  });
});
