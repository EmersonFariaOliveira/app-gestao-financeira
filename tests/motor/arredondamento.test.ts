/**
 * tests/motor/arredondamento.test.ts — regra 7 da spec (v1,
 * docs/app-gestao-aportes.md seção 5): arredondamento por lote para ativos
 * B3 (ações/FIIs/ETFs). `cotas = floor(valor / precoCentavos)`,
 * `valorAjustado = cotas * precoCentavos`; a sobra vai para o alvo de
 * renda fixa da fila com maior déficit ou, na ausência de um, para
 * `trocoCentavos`. NÃO se aplica a EXTERIOR nem a renda fixa/Tesouro
 * (valor livre, sem `cotas`).
 *
 * Convenção adotada para `origem` da linha que recebe a sobra de lote
 * quando ela não tinha linha própria antes (ex.: alvo de renda fixa que
 * não participava da divisão original): tratada como 'TRANSBORDO' — o
 * contrato não define um `origem` específico para "troco de lote" (o tipo
 * `OrigemLinhaDivisao` só tem DEFICIT/TRANSBORDO/AJUSTE_USUARIO). Ver nota
 * no relatório final do agente.
 *
 * FASE RED (T019): espera-se falha (módulo `@/core/motor` inexistente).
 */
import { describe, expect, it } from "vitest";
import { calcularAporte } from "@/core/motor";
import {
  cenarioExteriorIgnoraLote,
  cenarioLoteComRendaFixa,
  cenarioLoteSemRendaFixa,
} from "./fixtures";

describe("regra 7 — arredondamento por lote B3", () => {
  it("arredonda para cotas inteiras e manda o troco para o alvo de renda fixa com maior déficit", () => {
    const resultado = calcularAporte(cenarioLoteComRendaFixa());

    const linhaLote = resultado.divisao.find((l) => l.alvoId === "alvo-lote");
    const linhaRf = resultado.divisao.find((l) => l.alvoId === "alvo-rf");

    // cotas = floor(40000/3000) = 13; valorAjustado = 13*3000 = 39000; sobra = 1000.
    expect(linhaLote).toEqual({
      alvoId: "alvo-lote",
      valorCentavos: 39_000,
      origem: "DEFICIT",
      cotas: 13,
      precoCentavos: 3000,
    });

    // alvo-rf é o único alvo de renda fixa da fila: recebe a sobra de 1000
    // mesmo não tendo déficit positivo próprio (déficit era -40000).
    expect(linhaRf?.valorCentavos).toBe(1_000);
    expect(linhaRf?.cotas).toBeUndefined();

    // Nenhum valor "sobra" sem destino: tudo os 40000 do aporte estão
    // contabilizados (39000 + 1000), trocoCentavos = 0.
    const soma = resultado.divisao.reduce((acc, l) => acc + l.valorCentavos, 0);
    expect(soma + resultado.trocoCentavos).toBe(40_000);
    expect(resultado.trocoCentavos).toBe(0);
  });

  it("sem alvo de renda fixa na entrada, a sobra do lote fica em trocoCentavos", () => {
    const resultado = calcularAporte(cenarioLoteSemRendaFixa());

    const linhaLote = resultado.divisao.find((l) => l.alvoId === "alvo-lote");
    expect(linhaLote).toEqual({
      alvoId: "alvo-lote",
      valorCentavos: 39_000,
      origem: "DEFICIT",
      cotas: 13,
      precoCentavos: 3000,
    });

    // alvo-ext (EXTERIOR) não recebeu nada nesta divisão (déficit negativo)
    // e, mesmo que recebesse, não é renda fixa — não é destino de troco.
    expect(resultado.divisao.find((l) => l.alvoId === "alvo-ext")).toBeUndefined();

    expect(resultado.trocoCentavos).toBe(1_000);

    const soma = resultado.divisao.reduce((acc, l) => acc + l.valorCentavos, 0);
    expect(soma + resultado.trocoCentavos).toBe(40_000);
  });

  it("EXTERIOR nunca entra no arredondamento por lote (valor livre, sem cotas)", () => {
    const resultado = calcularAporte(cenarioExteriorIgnoraLote());

    const linhaExt = resultado.divisao.find((l) => l.alvoId === "alvo-ext");

    // alvo-ext recebe o valor cheio do seu déficit (40), sem qualquer
    // arredondamento por lote, mesmo havendo `cotacoes` no input (só para
    // alvo-lote, que aqui não recebe nada por ter déficit negativo).
    expect(linhaExt).toEqual({ alvoId: "alvo-ext", valorCentavos: 40, origem: "DEFICIT" });
    expect(linhaExt?.cotas).toBeUndefined();
    expect(linhaExt?.precoCentavos).toBeUndefined();

    expect(resultado.divisao.find((l) => l.alvoId === "alvo-lote")).toBeUndefined();
  });

  it("sem `cotacoes` no input, nenhuma linha da divisão tem `cotas` (sem arredondamento por lote)", () => {
    const input = cenarioLoteComRendaFixa();
    delete input.cotacoes;

    const resultado = calcularAporte(input);

    for (const linha of resultado.divisao) {
      expect(linha.cotas).toBeUndefined();
      expect(linha.precoCentavos).toBeUndefined();
    }
    // Sem lote, o déficit de alvo-lote (40000) é atendido em cheio.
    expect(resultado.divisao.find((l) => l.alvoId === "alvo-lote")?.valorCentavos).toBe(40_000);
  });

  it("cotação de preço maior que o valor alocado ao alvo ⇒ 0 cotas, e o valor inteiro vira sobra para a renda fixa", () => {
    // Mesma base de cenarioLoteComRendaFixa (déficit de alvo-lote = 40000),
    // mas com precoCentavos MAIOR que o próprio valor alocado: não dá para
    // comprar nem 1 cota inteira.
    const input = cenarioLoteComRendaFixa();
    input.cotacoes = [{ alvoId: "alvo-lote", precoCentavos: 50_000 }];

    const resultado = calcularAporte(input);

    // cotas = floor(40000/50000) = 0; valorAjustado = 0 ⇒ a linha de
    // alvo-lote não aparece na divisão final (mesma convenção de valores
    // zerados sem AJUSTE_USUARIO em divisao.ts/arredondamento.ts).
    expect(resultado.divisao.find((l) => l.alvoId === "alvo-lote")).toBeUndefined();

    // Toda a sobra (40000, o valor inteiro) vai para o único alvo de renda
    // fixa da fila.
    const linhaRf = resultado.divisao.find((l) => l.alvoId === "alvo-rf");
    expect(linhaRf?.valorCentavos).toBe(40_000);
    expect(linhaRf?.cotas).toBeUndefined();

    const soma = resultado.divisao.reduce((acc, l) => acc + l.valorCentavos, 0);
    expect(soma + resultado.trocoCentavos).toBe(40_000);
    expect(resultado.trocoCentavos).toBe(0);
  });

  it("cotação com precoCentavos = 0 lança erro explícito (entrada inválida, nunca gera NaN/Infinity em silêncio)", () => {
    const input = cenarioLoteComRendaFixa();
    input.cotacoes = [{ alvoId: "alvo-lote", precoCentavos: 0 }];

    expect(() => calcularAporte(input)).toThrow(/precoCentavos.*inv[aá]lido/i);
  });

  it("cotação com precoCentavos negativo lança erro explícito (entrada inválida)", () => {
    const input = cenarioLoteComRendaFixa();
    input.cotacoes = [{ alvoId: "alvo-lote", precoCentavos: -3000 }];

    expect(() => calcularAporte(input)).toThrow(/precoCentavos.*inv[aá]lido/i);
  });

  it("cotação com precoCentavos = NaN lança erro explícito (não propaga NaN em silêncio pela soma)", () => {
    const input = cenarioLoteComRendaFixa();
    input.cotacoes = [{ alvoId: "alvo-lote", precoCentavos: Number.NaN }];

    expect(() => calcularAporte(input)).toThrow(/precoCentavos.*inv[aá]lido/i);
  });

  it("cotação com precoCentavos fracionário (não-inteiro) lança erro explícito — centavos são sempre inteiros", () => {
    const input = cenarioLoteComRendaFixa();
    input.cotacoes = [{ alvoId: "alvo-lote", precoCentavos: 3000.5 }];

    expect(() => calcularAporte(input)).toThrow(/precoCentavos.*inv[aá]lido/i);
  });

  it("cotação com precoCentavos undefined (entrada não tipada, ex.: vindo de JSON externo) lança erro explícito", () => {
    const input = cenarioLoteComRendaFixa();
    // `as unknown as number` simula um valor que escapa da checagem estática
    // do TypeScript (ex.: JSON.parse de um payload externo malformado) —
    // o motor precisa se defender em runtime, não só confiar no tipo.
    input.cotacoes = [
      { alvoId: "alvo-lote", precoCentavos: undefined as unknown as number },
    ];

    expect(() => calcularAporte(input)).toThrow(/precoCentavos.*inv[aá]lido/i);
  });
});
