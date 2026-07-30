/**
 * tests/motor/redistribuicao.test.ts — regra 6 da spec (docs/app-gestao-aportes.md
 * seção 5): "sugestão editável (veto humano)". Linhas presentes em
 * `ajustesUsuario` são fixadas (inclusive valor 0 = linha zerada); o
 * restante (`valorAporte - Σ ajustes`) é redistribuído pelas mesmas regras
 * 1-5, mas considerando apenas os alvos NÃO fixados (contracts/motor.md,
 * regra 6: "sobre os alvos não fixados"). Isso inclui recalcular a
 * proporção do transbordo usando somente os bps dos alvos não fixados —
 * o alvo fixado sai inteiramente da "disputa".
 *
 * FASE RED (T018): espera-se falha (módulo `@/core/motor` inexistente).
 */
import { describe, expect, it } from "vitest";
import { calcularAporte } from "@/core/motor";
import { cenarioBase, CENARIO_BASE_SOMA_DEFICITS_POSITIVOS } from "./fixtures";

function somaDivisao(divisao: { valorCentavos: number }[]): number {
  return divisao.reduce((acc, l) => acc + l.valorCentavos, 0);
}

describe("regra 6 — veto humano / redistribuição", () => {
  it("zera a 1ª linha da fila ⇒ redistribui o restante pelas mesmas regras entre os alvos não fixados", () => {
    const input = cenarioBase();
    input.aporteMinimoCentavos = 1;
    input.valorAporteCentavos = CENARIO_BASE_SOMA_DEFICITS_POSITIVOS + 100; // 220100
    input.ajustesUsuario = [{ alvoId: "alvo-a", valorCentavos: 0 }];

    const resultado = calcularAporte(input);

    const linhaA = resultado.divisao.find((l) => l.alvoId === "alvo-a");
    const linhaB = resultado.divisao.find((l) => l.alvoId === "alvo-b");
    const linhaC = resultado.divisao.find((l) => l.alvoId === "alvo-c");

    // alvo-a fixado em 0 pelo usuário — deve aparecer com origem AJUSTE_USUARIO.
    expect(linhaA).toEqual({ alvoId: "alvo-a", valorCentavos: 0, origem: "AJUSTE_USUARIO" });

    // Restante (220100) recalculado só sobre alvo-b (déficit 20000) e
    // alvo-c (déficit -220000, ignorado): alvo-b cobre seu déficit
    // (20000) e o transbordo dos 200100 restantes é 100% de alvo-b (já que
    // é o único com déficit não-negativo entre os não fixados, mas o
    // transbordo usa bps de TODOS os não fixados: alvo-b=3000, alvo-c=2000).
    // alvo-b: 20000 (déficit) + floor(200100*3000/5000) = 20000 + 120060 = 140060
    // alvo-c: 0 (déficit negativo, ignorado) + floor(200100*2000/5000) = 80040
    expect(linhaB?.valorCentavos).toBe(140_060);
    expect(linhaC?.valorCentavos).toBe(80_040);

    expect(somaDivisao(resultado.divisao)).toBe(input.valorAporteCentavos);
  });

  it("fixa um valor parcial numa linha ⇒ resto é redistribuído entre os alvos restantes", () => {
    const input = cenarioBase();
    input.aporteMinimoCentavos = 1;
    input.valorAporteCentavos = CENARIO_BASE_SOMA_DEFICITS_POSITIVOS + 100; // 220100
    // alvo-b naturalmente receberia 20000 (seu déficit inteiro); o usuário
    // fixa um valor PARCIAL de apenas 5000.
    input.ajustesUsuario = [{ alvoId: "alvo-b", valorCentavos: 5_000 }];

    const resultado = calcularAporte(input);

    const linhaA = resultado.divisao.find((l) => l.alvoId === "alvo-a");
    const linhaB = resultado.divisao.find((l) => l.alvoId === "alvo-b");
    const linhaC = resultado.divisao.find((l) => l.alvoId === "alvo-c");

    expect(linhaB).toEqual({ alvoId: "alvo-b", valorCentavos: 5_000, origem: "AJUSTE_USUARIO" });

    // Restante = 220100 - 5000 = 215100, redistribuído só entre alvo-a
    // (déficit 200000) e alvo-c (déficit -220000, ignorado no
    // preenchimento, mas participa do transbordo com bps 2000).
    // alvo-a: 200000 (déficit) + floor(15100*5000/7000) + resto(1) = 200000 + 10785 + 1 = 210786
    // alvo-c: 0 + floor(15100*2000/7000) = 4314
    expect(linhaA?.valorCentavos).toBe(210_786);
    expect(linhaC?.valorCentavos).toBe(4_314);

    expect(somaDivisao(resultado.divisao)).toBe(input.valorAporteCentavos);
  });

  // BUG REAL ENCONTRADO E CORRIGIDO (reportado ao calculista-aporte pelo
  // engenheiro-testes; decisão de política registrada em
  // src/core/motor/divisao.ts, nota 3 do cabeçalho):
  //
  // Cenário: cenarioBase(), valorAporteCentavos=100_000, ajustesUsuario soma
  // 130_000 (80_000 em alvo-a + 50_000 em alvo-b) — MAIOR que o próprio
  // aporte digitado. A spec (seção 5, regra 6) não cobre esse caso: ela só
  // descreve fixar/zerar linhas e redistribuir o RESTANTE, o que pressupõe
  // restante >= 0. Seguindo o Princípio V da constitution ("Falhar Alto,
  // Nunca em Silêncio"), `calcularAporte` agora lança um erro explícito em
  // vez de devolver uma `divisao` cuja soma excede `valorAporteCentavos`
  // (o que violava a invariante do contrato) ou capar silenciosamente um
  // valor que o usuário fixou de propósito.
  it("ajustesUsuario cuja soma excede valorAporteCentavos lança erro explícito (não capa nem estoura a soma)", () => {
    const input = cenarioBase();
    input.valorAporteCentavos = 100_000;
    input.aporteMinimoCentavos = 1;
    input.ajustesUsuario = [
      { alvoId: "alvo-a", valorCentavos: 80_000 },
      { alvoId: "alvo-b", valorCentavos: 50_000 }, // 80_000 + 50_000 = 130_000 > 100_000
    ];

    expect(() => calcularAporte(input)).toThrow(
      /soma dos ajustes.*excede o valor do aporte/i,
    );
  });

  // Caso-limite simétrico: soma dos ajustes EXATAMENTE igual ao aporte
  // (restante = 0) é válida — não deve lançar erro, e o transbordo sobre os
  // alvos não fixados deve ser zero (nenhuma linha calculada além das
  // fixadas).
  it("ajustesUsuario cuja soma é exatamente igual a valorAporteCentavos não lança erro (restante zero, sem transbordo)", () => {
    const input = cenarioBase();
    input.valorAporteCentavos = 130_000;
    input.aporteMinimoCentavos = 1;
    input.ajustesUsuario = [
      { alvoId: "alvo-a", valorCentavos: 80_000 },
      { alvoId: "alvo-b", valorCentavos: 50_000 }, // soma = 130_000 = valorAporteCentavos
    ];

    const resultado = calcularAporte(input);

    const linhaA = resultado.divisao.find((l) => l.alvoId === "alvo-a");
    const linhaB = resultado.divisao.find((l) => l.alvoId === "alvo-b");
    const linhaC = resultado.divisao.find((l) => l.alvoId === "alvo-c");

    expect(linhaA).toEqual({ alvoId: "alvo-a", valorCentavos: 80_000, origem: "AJUSTE_USUARIO" });
    expect(linhaB).toEqual({ alvoId: "alvo-b", valorCentavos: 50_000, origem: "AJUSTE_USUARIO" });
    expect(linhaC).toBeUndefined();
    expect(somaDivisao(resultado.divisao) + resultado.trocoCentavos).toBe(
      input.valorAporteCentavos,
    );
  });

  it("a soma final é sempre exata ao valorAporteCentavos, com ou sem ajustes", () => {
    const semAjuste = calcularAporte({ ...cenarioBase(), valorAporteCentavos: 300_000, aporteMinimoCentavos: 1 });
    expect(somaDivisao(semAjuste.divisao) + semAjuste.trocoCentavos).toBe(300_000);

    const comAjuste = calcularAporte({
      ...cenarioBase(),
      valorAporteCentavos: 300_000,
      aporteMinimoCentavos: 1,
      ajustesUsuario: [{ alvoId: "alvo-c", valorCentavos: 12_345 }],
    });
    expect(somaDivisao(comAjuste.divisao) + comAjuste.trocoCentavos).toBe(300_000);
    expect(comAjuste.divisao.find((l) => l.alvoId === "alvo-c")?.valorCentavos).toBe(12_345);
  });
});
