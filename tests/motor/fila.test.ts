/**
 * tests/motor/fila.test.ts — regra 2 da spec (docs/app-gestao-aportes.md
 * seção 5): fila de prioridade ordenada por déficit desc, com desempate
 * determinístico por percentualBps desc e depois por nome (ordem
 * alfabética). O resultado NUNCA deve depender da ordem de inserção dos
 * arrays de entrada (`alvos`/`posicoes`).
 *
 * Nota: `ItemFila` (contracts/motor.md) não expõe `nome` — o desempate por
 * nome usa o `nome` de `AlvoVigente` (entrada) internamente; o teste
 * verifica a ordem resultante via `alvoId`.
 *
 * FASE RED (T016): espera-se falha (módulo `@/core/motor` inexistente).
 */
import { describe, expect, it } from "vitest";
import { calcularAporte } from "@/core/motor";
import { cenarioBase } from "./fixtures";
import type { EntradaMotor } from "@/core/motor/types";

describe("regra 2 — fila de prioridade", () => {
  it("ordena por déficit desc no cenário-base (200000, 20000, -220000)", () => {
    const resultado = calcularAporte(cenarioBase());

    expect(resultado.fila.map((i) => i.alvoId)).toEqual(["alvo-a", "alvo-b", "alvo-c"]);
  });

  it("inclui TODOS os alvos vigentes na fila, mesmo com déficit negativo", () => {
    const resultado = calcularAporte(cenarioBase());

    expect(resultado.fila).toHaveLength(3);
  });

  it("desempata déficits iguais por percentualBps desc", () => {
    // patrimonioBase = 1_000_000 (Vx+Vy+Vz), bps somam 10000.
    // X: bps 2000, target=200000, valor=199000 -> déficit=1000
    // Y: bps 5000, target=500000, valor=499000 -> déficit=1000 (empate com X)
    // Z: bps 3000, target=300000, valor=302000 -> déficit=-2000
    const alvos: EntradaMotor["alvos"] = [
      { alvoId: "x", nome: "X", percentualBps: 2000, rendaFixa: false },
      { alvoId: "y", nome: "Y", percentualBps: 5000, rendaFixa: false },
      { alvoId: "z", nome: "Z", percentualBps: 3000, rendaFixa: false },
    ];
    const posicoes: EntradaMotor["posicoes"] = [
      { chaveExport: "X1", alvoId: "x", foraDaCarteira: false, valorCentavos: 199_000, tipoGrupo: "ACOES" },
      { chaveExport: "Y1", alvoId: "y", foraDaCarteira: false, valorCentavos: 499_000, tipoGrupo: "ACOES" },
      { chaveExport: "Z1", alvoId: "z", foraDaCarteira: false, valorCentavos: 302_000, tipoGrupo: "ACOES" },
    ];

    const resultado = calcularAporte({
      alvos,
      posicoes,
      valorAporteCentavos: 0,
      aporteMinimoCentavos: 1,
    });

    const itemX = resultado.fila.find((i) => i.alvoId === "x");
    const itemY = resultado.fila.find((i) => i.alvoId === "y");
    expect(itemX?.deficitCentavos).toBe(1000);
    expect(itemY?.deficitCentavos).toBe(1000);

    // Empate em 1000: Y (bps 5000) vem antes de X (bps 2000); Z (-2000) por último.
    expect(resultado.fila.map((i) => i.alvoId)).toEqual(["y", "x", "z"]);
  });

  it("desempata déficit E percentualBps iguais por nome (ordem alfabética)", () => {
    // Dois alvos com mesmo bps (5000 cada) e ambos exatamente no alvo
    // (déficit = 0): patrimonioBase = 200000, target = 100000 cada.
    const alvos: EntradaMotor["alvos"] = [
      { alvoId: "id-zeta", nome: "Zeta", percentualBps: 5000, rendaFixa: false },
      { alvoId: "id-alfa", nome: "Alfa", percentualBps: 5000, rendaFixa: false },
    ];
    const posicoes: EntradaMotor["posicoes"] = [
      { chaveExport: "Z1", alvoId: "id-zeta", foraDaCarteira: false, valorCentavos: 100_000, tipoGrupo: "ACOES" },
      { chaveExport: "A1", alvoId: "id-alfa", foraDaCarteira: false, valorCentavos: 100_000, tipoGrupo: "ACOES" },
    ];

    const resultado = calcularAporte({
      alvos,
      posicoes,
      valorAporteCentavos: 0,
      aporteMinimoCentavos: 1,
    });

    expect(resultado.fila.every((i) => i.deficitCentavos === 0)).toBe(true);
    // "Alfa" vem antes de "Zeta" alfabeticamente.
    expect(resultado.fila.map((i) => i.alvoId)).toEqual(["id-alfa", "id-zeta"]);
  });

  it("a ordem da fila não depende da ordem de inserção dos arrays de entrada", () => {
    const base = cenarioBase();

    const alvosEmbaralhados = [...base.alvos].reverse();
    const posicoesEmbaralhadas = [...base.posicoes].reverse();

    const resultado = calcularAporte({
      ...base,
      alvos: alvosEmbaralhados,
      posicoes: posicoesEmbaralhadas,
    });

    expect(resultado.fila.map((i) => i.alvoId)).toEqual(["alvo-a", "alvo-b", "alvo-c"]);
  });
});
