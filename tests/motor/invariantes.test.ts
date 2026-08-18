/**
 * tests/motor/invariantes.test.ts — invariantes que valem para QUALQUER
 * entrada válida do motor (contracts/motor.md, seção "Invariantes
 * verificados em todos os testes"):
 *
 * 1. Σ divisao.valorCentavos + trocoCentavos === valorAporteCentavos (exato).
 * 2. Nenhuma LinhaDivisao com 0 < valor < aporteMinimoCentavos — EXCETO o
 *    caso-limite documentado em divisao.test.ts ("aporte total abaixo do
 *    mínimo"), onde não há para onde realocar. Esse caso é testado
 *    separadamente lá e propositalmente EXCLUÍDO da lista de cenários
 *    genéricos abaixo para não conflitar com esta invariante.
 * 3. Pureza: mesma entrada (por valor, não por referência) ⇒ mesmo
 *    resultado (deep equal), em qualquer número de chamadas.
 * 4. simulacaoDepois coerente: quando um alvo recebe aporte cobrindo
 *    déficit positivo, o percentual depois deve estar mais próximo (ou
 *    igual) do percentual-alvo do que o percentual antes.
 *
 * FASE RED (T020): espera-se falha (módulo `@/core/motor` inexistente).
 */
import { describe, expect, it } from "vitest";
import { calcularAporte } from "@/core/motor";
import type { EntradaMotor } from "@/core/motor/types";
import {
  cenarioBase,
  cenarioExteriorIgnoraLote,
  cenarioLoteComRendaFixa,
  cenarioLoteSemRendaFixa,
} from "./fixtures";

/**
 * Cenários genéricos reutilizados pelas checagens de invariante — cobrem
 * déficit simples, cascata parcial, transbordo com resto, 100% transbordo,
 * mínimo por transação, veto humano (zerado e parcial) e lote B3 (com e
 * sem renda fixa, e EXTERIOR isento). Deliberadamente NÃO inclui o
 * caso-limite "aporte total < mínimo" (ver comentário acima).
 */
function cenariosGenericos(): { nome: string; input: EntradaMotor }[] {
  return [
    { nome: "déficit simples, aporte parcial", input: { ...cenarioBase(), valorAporteCentavos: 100_000, aporteMinimoCentavos: 100 } },
    { nome: "cascata cobrindo 1º e parcial do 2º", input: { ...cenarioBase(), valorAporteCentavos: 210_000, aporteMinimoCentavos: 100 } },
    { nome: "transbordo com resto de centavos", input: { ...cenarioBase(), valorAporteCentavos: 220_101, aporteMinimoCentavos: 1 } },
    { nome: "mínimo por transação realocado ao topo", input: { ...cenarioBase(), valorAporteCentavos: 205_000, aporteMinimoCentavos: 50_000 } },
    {
      nome: "veto humano — linha zerada",
      input: {
        ...cenarioBase(),
        valorAporteCentavos: 220_100,
        aporteMinimoCentavos: 1,
        ajustesUsuario: [{ alvoId: "alvo-a", valorCentavos: 0 }],
      },
    },
    {
      nome: "veto humano — valor parcial fixado",
      input: {
        ...cenarioBase(),
        valorAporteCentavos: 220_100,
        aporteMinimoCentavos: 1,
        ajustesUsuario: [{ alvoId: "alvo-b", valorCentavos: 5_000 }],
      },
    },
    { nome: "lote B3 com renda fixa", input: cenarioLoteComRendaFixa() },
    { nome: "lote B3 sem renda fixa", input: cenarioLoteSemRendaFixa() },
    { nome: "EXTERIOR isento de lote", input: cenarioExteriorIgnoraLote() },
  ];
}

describe("invariantes do motor", () => {
  it.each(cenariosGenericos())(
    "soma exata: Σ divisao + troco = valorAporteCentavos ($nome)",
    ({ input }) => {
      const resultado = calcularAporte(input);
      const soma = resultado.divisao.reduce((acc, l) => acc + l.valorCentavos, 0);
      expect(soma + resultado.trocoCentavos).toBe(input.valorAporteCentavos);
    },
  );

  it.each(cenariosGenericos())(
    "nenhuma LinhaDivisao com 0 < valor < aporteMinimoCentavos ($nome)",
    ({ input }) => {
      const resultado = calcularAporte(input);
      for (const linha of resultado.divisao) {
        const violaMinimo = linha.valorCentavos > 0 && linha.valorCentavos < input.aporteMinimoCentavos;
        expect(violaMinimo).toBe(false);
      }
    },
  );

  it.each(cenariosGenericos())("nenhum valor negativo em nenhuma linha ($nome)", ({ input }) => {
    const resultado = calcularAporte(input);
    for (const linha of resultado.divisao) {
      expect(linha.valorCentavos).toBeGreaterThanOrEqual(0);
    }
    expect(resultado.trocoCentavos).toBeGreaterThanOrEqual(0);
  });

  it.each(cenariosGenericos())("sem `cotacoes`, nenhuma linha tem `cotas` ($nome)", ({ nome, input }) => {
    if (input.cotacoes) return; // caso já coberto especificamente em arredondamento.test.ts
    const resultado = calcularAporte(input);
    for (const linha of resultado.divisao) {
      expect(linha.cotas).toBeUndefined();
    }
    // nome usado apenas para o título do teste (it.each) — evita lint de variável não usada
    expect(typeof nome).toBe("string");
  });

  it.each(cenariosGenericos())("pureza: chamar calcularAporte duas vezes com a mesma entrada dá resultado idêntico ($nome)", ({ input }) => {
    // Clones por valor (nunca a mesma referência) para garantir que o
    // motor realmente não depende de mutação/identidade de objetos.
    const entradaClone1 = structuredClone(input);
    const entradaClone2 = structuredClone(input);

    const resultado1 = calcularAporte(entradaClone1);
    const resultado2 = calcularAporte(entradaClone2);

    expect(resultado1).toEqual(resultado2);
  });

  it("pureza: calcularAporte não muta o objeto de entrada", () => {
    const input = cenarioBase();
    input.valorAporteCentavos = 220_100;
    const copiaAntes = structuredClone(input);

    calcularAporte(input);

    expect(input).toEqual(copiaAntes);
  });

  it("simulacaoDepois cobre todos os alvos da fila", () => {
    const resultado = calcularAporte({ ...cenarioBase(), valorAporteCentavos: 100_000, aporteMinimoCentavos: 100 });

    const idsFila = resultado.fila.map((i) => i.alvoId).sort();
    const idsSimulacao = resultado.simulacaoDepois.map((s) => s.alvoId).sort();
    expect(idsSimulacao).toEqual(idsFila);
  });

  it("simulacaoDepois: alvo que recebe aporte cobrindo déficit fica mais próximo (ou igual) ao alvo-alvo do que antes", () => {
    const input: EntradaMotor = { ...cenarioBase(), valorAporteCentavos: 100_000, aporteMinimoCentavos: 100 };
    const resultado = calcularAporte(input);

    const targetBpsPorAlvo = new Map(input.alvos.map((a) => [a.alvoId, a.percentualBps]));

    for (const linha of resultado.divisao) {
      if (linha.valorCentavos <= 0) continue;

      const simulacao = resultado.simulacaoDepois.find((s) => s.alvoId === linha.alvoId);
      const targetBps = targetBpsPorAlvo.get(linha.alvoId)!;

      expect(simulacao).toBeDefined();
      const distanciaAntes = Math.abs(targetBps - simulacao!.percentualAntesBps);
      const distanciaDepois = Math.abs(targetBps - simulacao!.percentualDepoisBps);

      expect(distanciaDepois).toBeLessThanOrEqual(distanciaAntes);
    }
  });

  it("simulacaoDepois: percentualAntesBps é consistente com o percentualAtualBps da fila", () => {
    const resultado = calcularAporte({ ...cenarioBase(), valorAporteCentavos: 100_000, aporteMinimoCentavos: 100 });

    for (const item of resultado.fila) {
      const simulacao = resultado.simulacaoDepois.find((s) => s.alvoId === item.alvoId);
      expect(simulacao?.percentualAntesBps).toBe(item.percentualAtualBps);
    }
  });
});
