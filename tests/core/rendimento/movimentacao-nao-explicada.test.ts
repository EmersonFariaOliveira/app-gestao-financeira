import { describe, expect, it } from "vitest";
import {
  TOLERANCIA_MOVIMENTACAO_PCT,
  TOLERANCIA_MOVIMENTACAO_PISO_CENTAVOS,
  avaliarMovimentacaoNaoExplicada,
} from "@/core/rendimento/movimentacao-nao-explicada";

// Extração pura de rendimento-service.calcularMovimentacaoNaoExplicada
// (FR-018/R8) — mesma fórmula/limiares, zero I/O. Casos espelham
// tests/services/rendimento-service.test.ts > "calcularMovimentacaoNaoExplicada".
describe("movimentacao-nao-explicada (core, zero I/O)", () => {
  it("exporta os mesmos limiares de FR-018", () => {
    expect(TOLERANCIA_MOVIMENTACAO_PCT).toBe(5);
    expect(TOLERANCIA_MOVIMENTACAO_PISO_CENTAVOS).toBe(2000);
  });

  it("sem base de comparação → excedeTolerancia sempre false, mesmo com diferença grande", () => {
    const resultado = avaliarMovimentacaoNaoExplicada({
      valorInvestidoEsperadoCentavos: 0,
      valorInvestidoRealCentavos: 1_000_000,
      houveBaseComparacao: false,
    });
    expect(resultado.diferencaCentavos).toBe(1_000_000);
    expect(resultado.excedeTolerancia).toBe(false);
  });

  it("real bate com esperado dentro da tolerância → excedeTolerancia false", () => {
    const resultado = avaliarMovimentacaoNaoExplicada({
      valorInvestidoEsperadoCentavos: 100_000,
      valorInvestidoRealCentavos: 100_500,
      houveBaseComparacao: true,
    });
    expect(resultado.diferencaCentavos).toBe(500);
    expect(resultado.excedeTolerancia).toBe(false);
  });

  it("excede o percentual (5%) mas NÃO o piso (R$20,00) → excedeTolerancia false", () => {
    // esperado 100 centavos, diferença de 6 centavos = 6% (> 5%) mas < R$20,00 de piso.
    const resultado = avaliarMovimentacaoNaoExplicada({
      valorInvestidoEsperadoCentavos: 100,
      valorInvestidoRealCentavos: 106,
      houveBaseComparacao: true,
    });
    expect(resultado.diferencaCentavos).toBe(6);
    expect(resultado.excedeTolerancia).toBe(false);
  });

  it("excede o piso (R$20,00) mas NÃO o percentual (5%) → excedeTolerancia false", () => {
    // esperado 10_000_00 centavos (R$10.000), diferença de 2001 centavos (> piso) = 0,02% (< 5%).
    const resultado = avaliarMovimentacaoNaoExplicada({
      valorInvestidoEsperadoCentavos: 1_000_000,
      valorInvestidoRealCentavos: 1_002_001,
      houveBaseComparacao: true,
    });
    expect(resultado.diferencaCentavos).toBe(2001);
    expect(resultado.excedeTolerancia).toBe(false);
  });

  it("excede AMBOS simultaneamente → excedeTolerancia true", () => {
    const resultado = avaliarMovimentacaoNaoExplicada({
      valorInvestidoEsperadoCentavos: 100_000,
      valorInvestidoRealCentavos: 110_001,
      houveBaseComparacao: true,
    });
    expect(resultado.diferencaCentavos).toBe(10_001);
    expect(resultado.excedeTolerancia).toBe(true);
  });

  it("esperado = 0 com base de comparação e diferença não-nula → trata percentual como excedido, mas ainda exige o piso", () => {
    const semPiso = avaliarMovimentacaoNaoExplicada({
      valorInvestidoEsperadoCentavos: 0,
      valorInvestidoRealCentavos: 1_000,
      houveBaseComparacao: true,
    });
    expect(semPiso.excedeTolerancia).toBe(false); // 1000 centavos < piso de 2000

    const comPiso = avaliarMovimentacaoNaoExplicada({
      valorInvestidoEsperadoCentavos: 0,
      valorInvestidoRealCentavos: 2_001,
      houveBaseComparacao: true,
    });
    expect(comPiso.excedeTolerancia).toBe(true);
  });

  it("diferença negativa é avaliada em módulo (real menor que esperado)", () => {
    const resultado = avaliarMovimentacaoNaoExplicada({
      valorInvestidoEsperadoCentavos: 100_000,
      valorInvestidoRealCentavos: 89_999,
      houveBaseComparacao: true,
    });
    expect(resultado.diferencaCentavos).toBe(-10_001);
    expect(resultado.excedeTolerancia).toBe(true);
  });
});
