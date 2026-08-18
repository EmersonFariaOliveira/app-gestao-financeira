import { describe, expect, it } from "vitest";
import {
  aplicarBps,
  formatBps,
  formatCentavosParaReais,
  parseDecimalParaCentavos,
} from "@/core/money";

describe("parseDecimalParaCentavos", () => {
  it("converte decimal com ponto para centavos", () => {
    expect(parseDecimalParaCentavos("1234.56")).toBe(123456);
  });

  it("converte o caso clássico que quebra com float (1.15)", () => {
    // parseFloat("1.15") * 100 === 114.99999999999999 em JS.
    // A implementação NUNCA pode passar por essa conta.
    expect(parseDecimalParaCentavos("1.15")).toBe(115);
  });

  it("aceita vírgula decimal brasileira", () => {
    expect(parseDecimalParaCentavos("1234,56")).toBe(123456);
  });

  it("aceita inteiro sem parte decimal", () => {
    expect(parseDecimalParaCentavos("2000")).toBe(200000);
  });

  it("faz padding de uma única casa decimal (1.5 -> 150)", () => {
    expect(parseDecimalParaCentavos("1.5")).toBe(150);
  });

  it("faz padding de uma única casa decimal com vírgula (1,5 -> 150)", () => {
    expect(parseDecimalParaCentavos("1,5")).toBe(150);
  });

  it("trunca (não arredonda) quando há 3+ casas decimais", () => {
    // 1.239 deveria truncar para 1.23 (123 centavos), não arredondar para 124.
    expect(parseDecimalParaCentavos("1.239")).toBe(123);
    expect(parseDecimalParaCentavos("1.999")).toBe(199);
  });

  it("aceita sinal negativo explícito", () => {
    expect(parseDecimalParaCentavos("-10.00")).toBe(-1000);
  });

  it("aceita zero em todas as formas", () => {
    expect(parseDecimalParaCentavos("0")).toBe(0);
    expect(parseDecimalParaCentavos("0.00")).toBe(0);
    expect(parseDecimalParaCentavos("0,00")).toBe(0);
  });

  it("lança erro para string vazia", () => {
    expect(() => parseDecimalParaCentavos("")).toThrow();
  });

  it("lança erro para string só com espaços", () => {
    expect(() => parseDecimalParaCentavos("   ")).toThrow();
  });

  it("lança erro para valor com letras", () => {
    expect(() => parseDecimalParaCentavos("R$ 1234,56")).toThrow();
    expect(() => parseDecimalParaCentavos("abc")).toThrow();
    expect(() => parseDecimalParaCentavos("12ab.34")).toThrow();
  });

  it("lança erro para múltiplos separadores decimais", () => {
    expect(() => parseDecimalParaCentavos("1.234.56")).toThrow();
    expect(() => parseDecimalParaCentavos("1,234,56")).toThrow();
    expect(() => parseDecimalParaCentavos("1.234,56")).toThrow();
  });

  it("lança erro para separador sem dígitos decimais", () => {
    expect(() => parseDecimalParaCentavos("1234.")).toThrow();
    expect(() => parseDecimalParaCentavos("1234,")).toThrow();
  });

  it("lança erro para valor não-string", () => {
    // @ts-expect-error -- testando defesa em runtime contra input incorreto
    expect(() => parseDecimalParaCentavos(1234.56)).toThrow();
    // @ts-expect-error -- testando defesa em runtime contra input incorreto
    expect(() => parseDecimalParaCentavos(null)).toThrow();
    // @ts-expect-error -- testando defesa em runtime contra input incorreto
    expect(() => parseDecimalParaCentavos(undefined)).toThrow();
  });
});

describe("formatCentavosParaReais", () => {
  it("formata centavos simples", () => {
    expect(formatCentavosParaReais(123456)).toBe("R$ 1.234,56");
  });

  it("formata valores abaixo de 1 real preservando os dois dígitos", () => {
    expect(formatCentavosParaReais(115)).toBe("R$ 1,15");
    expect(formatCentavosParaReais(5)).toBe("R$ 0,05");
    expect(formatCentavosParaReais(0)).toBe("R$ 0,00");
  });

  it("formata milhar e milhão com separador de ponto", () => {
    expect(formatCentavosParaReais(100000000)).toBe("R$ 1.000.000,00");
  });

  it("formata valores negativos", () => {
    expect(formatCentavosParaReais(-1000)).toBe("-R$ 10,00");
  });

  it("lança erro se o valor não for inteiro", () => {
    expect(() => formatCentavosParaReais(123.45)).toThrow();
  });
});

describe("ida e volta parse <-> format", () => {
  const casosExatos = [
    "0.00",
    "1.15",
    "1234.56",
    "2000.00",
    "999999.99",
    "0.01",
    "1000000.00",
  ];

  it.each(casosExatos)("preserva o valor exato para %s", (valorOriginal) => {
    const centavos = parseDecimalParaCentavos(valorOriginal);
    const formatado = formatCentavosParaReais(centavos);
    const centavosDeVolta = parseDecimalParaCentavos(
      formatado.replace("R$ ", "").replace(/\./g, "").replace(",", "."),
    );
    expect(centavosDeVolta).toBe(centavos);
  });
});

describe("aplicarBps", () => {
  it("calcula bps que dividem exato", () => {
    // 12,5% de R$ 1.000,00 (100000 centavos) = R$ 125,00 (12500 centavos)
    expect(aplicarBps(100000, 1250)).toBe(12500);
  });

  it("calcula 100% (10000 bps) retornando o valor integral", () => {
    expect(aplicarBps(123456, 10000)).toBe(123456);
  });

  it("calcula 0 bps retornando zero", () => {
    expect(aplicarBps(123456, 0)).toBe(0);
  });

  it("trunca o resto da divisão inteira (não arredonda)", () => {
    // 1 bps de 99 centavos = 0.0099 centavos -> trunca para 0
    expect(aplicarBps(99, 1)).toBe(0);
    // 33,33% (3333 bps) de 100 centavos = 33.33 -> trunca para 33
    expect(aplicarBps(100, 3333)).toBe(33);
    // 3 bps de 1000000 centavos = 300.0 exato
    expect(aplicarBps(1000000, 3)).toBe(300);
    // caso com resto não-exato assimétrico
    expect(aplicarBps(1, 9999)).toBe(0);
  });
});

describe("formatBps", () => {
  it("formata bps redondos", () => {
    expect(formatBps(1250)).toBe("12,50%");
  });

  it("formata a banda de tolerância padrão (150 bps = 1,5 p.p.)", () => {
    expect(formatBps(150)).toBe("1,50%");
  });

  it("formata 100% (10000 bps)", () => {
    expect(formatBps(10000)).toBe("100,00%");
  });

  it("formata 0 bps", () => {
    expect(formatBps(0)).toBe("0,00%");
  });

  it("formata bps com um único dígito de resto (5 bps = 0,05%)", () => {
    expect(formatBps(5)).toBe("0,05%");
  });
});
