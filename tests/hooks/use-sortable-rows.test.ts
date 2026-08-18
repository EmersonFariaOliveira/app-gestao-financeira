// @vitest-environment jsdom
/**
 * tests/hooks/use-sortable-rows.test.ts — cobre a ordenação client-side
 * genérica usada por ~10 tabelas do app (`src/hooks/use-sortable-rows.ts`).
 *
 * Não é um teste de domínio (não há regra da seção 5 envolvida), mas o
 * hook é reutilizado o bastante para justificar um teste dedicado: um bug
 * aqui afeta toda tabela do app, inclusive as que exibem centavos/bps.
 *
 * Só este arquivo roda em ambiente "jsdom" (via docblock acima) porque o
 * hook depende de useState/useMemo — o resto da suíte continua em "node"
 * (ver vitest.config.ts).
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSortableRows } from "@/hooks/use-sortable-rows";

interface LinhaTeste {
  id: number;
  nome: string;
  valorCentavos: number;
}

type Coluna = "nome" | "valorCentavos";

const accessors = {
  nome: (row: LinhaTeste) => row.nome,
  valorCentavos: (row: LinhaTeste) => row.valorCentavos,
};

function montarHook(rows: LinhaTeste[]) {
  return renderHook(({ rows: r }) => useSortableRows<LinhaTeste, Coluna>(r, accessors), {
    initialProps: { rows },
  });
}

describe("useSortableRows", () => {
  it("sem coluna ativa, devolve as linhas na ordem original recebida", () => {
    const rows: LinhaTeste[] = [
      { id: 1, nome: "Banco", valorCentavos: 300 },
      { id: 2, nome: "Ábaco", valorCentavos: 100 },
    ];
    const { result } = montarHook(rows);

    expect(result.current.sortKey).toBeNull();
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("ordena coluna numérica em ordem ascendente comparando o inteiro bruto", () => {
    // Valores próximos ao limite onde uma conversão via string/parseFloat
    // truncaria ou perderia precisão — a comparação deve ser aritmética
    // pura (a.valor - b.valor), nunca parseFloat/Number(string).
    const rows: LinhaTeste[] = [
      { id: 1, nome: "A", valorCentavos: 100_000_000_002 },
      { id: 2, nome: "B", valorCentavos: 100_000_000_001 },
      { id: 3, nome: "C", valorCentavos: -500 },
    ];
    const { result } = montarHook(rows);

    act(() => result.current.toggleSort("valorCentavos"));

    expect(result.current.sortKey).toBe("valorCentavos");
    expect(result.current.sortDirectionFor("valorCentavos")).toBe("asc");
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("segundo clique na mesma coluna alterna para descendente (não reseta a coluna)", () => {
    const rows: LinhaTeste[] = [
      { id: 1, nome: "A", valorCentavos: 10 },
      { id: 2, nome: "B", valorCentavos: 30 },
      { id: 3, nome: "C", valorCentavos: 20 },
    ];
    const { result } = montarHook(rows);

    act(() => result.current.toggleSort("valorCentavos"));
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([1, 3, 2]); // asc

    act(() => result.current.toggleSort("valorCentavos"));
    expect(result.current.sortKey).toBe("valorCentavos");
    expect(result.current.sortDirectionFor("valorCentavos")).toBe("desc");
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([2, 3, 1]); // desc
  });

  it("terceiro clique na mesma coluna volta para ascendente (alterna para sempre, nunca 'sem ordenação')", () => {
    const rows: LinhaTeste[] = [
      { id: 1, nome: "A", valorCentavos: 10 },
      { id: 2, nome: "B", valorCentavos: 30 },
    ];
    const { result } = montarHook(rows);

    act(() => result.current.toggleSort("valorCentavos")); // asc
    act(() => result.current.toggleSort("valorCentavos")); // desc
    act(() => result.current.toggleSort("valorCentavos")); // volta a asc

    expect(result.current.sortKey).toBe("valorCentavos");
    expect(result.current.sortDirectionFor("valorCentavos")).toBe("asc");
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("clicar em outra coluna troca a coluna ativa e reinicia a direção em ascendente", () => {
    const rows: LinhaTeste[] = [
      { id: 1, nome: "Banco", valorCentavos: 10 },
      { id: 2, nome: "Ábaco", valorCentavos: 30 },
    ];
    const { result } = montarHook(rows);

    act(() => result.current.toggleSort("valorCentavos"));
    act(() => result.current.toggleSort("valorCentavos")); // agora desc em valorCentavos

    act(() => result.current.toggleSort("nome")); // troca de coluna

    expect(result.current.sortKey).toBe("nome");
    expect(result.current.sortDirectionFor("nome")).toBe("asc");
    expect(result.current.sortDirectionFor("valorCentavos")).toBeUndefined();
  });

  it("ordena string com acentuação pt-BR (Ábaco antes de Banco)", () => {
    const rows: LinhaTeste[] = [
      { id: 1, nome: "Banco", valorCentavos: 0 },
      { id: 2, nome: "Ábaco", valorCentavos: 0 },
      { id: 3, nome: "Central", valorCentavos: 0 },
    ];
    const { result } = montarHook(rows);

    act(() => result.current.toggleSort("nome"));

    expect(result.current.sortedRows.map((r) => r.nome)).toEqual(["Ábaco", "Banco", "Central"]);
  });

  it("é estável em ascendente: linhas empatadas na coluna ordenada mantêm a ordem original", () => {
    const rows: LinhaTeste[] = [
      { id: 1, nome: "X", valorCentavos: 100 },
      { id: 2, nome: "Y", valorCentavos: 50 },
      { id: 3, nome: "Z", valorCentavos: 100 }, // empatada com id 1
      { id: 4, nome: "W", valorCentavos: 50 }, // empatada com id 2
    ];
    const { result } = montarHook(rows);

    act(() => result.current.toggleSort("valorCentavos"));

    // 50 antes de 100; dentro de cada valor empatado, ordem original preservada.
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([2, 4, 1, 3]);
  });

  it("é estável em descendente também: linhas empatadas na coluna ordenada mantêm a ordem original, independentemente da direção", () => {
    // O desempate por índice original é sempre crescente (nunca invertido
    // junto com a direção da coluna) — um "stable sort" de verdade preserva
    // a ordem original dos empates tanto em "asc" quanto em "desc".
    const rows: LinhaTeste[] = [
      { id: 1, nome: "X", valorCentavos: 100 },
      { id: 2, nome: "Y", valorCentavos: 50 },
      { id: 3, nome: "Z", valorCentavos: 100 }, // empatada com id 1
      { id: 4, nome: "W", valorCentavos: 50 }, // empatada com id 2
    ];
    const { result } = montarHook(rows);

    act(() => result.current.toggleSort("valorCentavos")); // asc
    act(() => result.current.toggleSort("valorCentavos")); // desc

    // 100 antes de 50; dentro de cada valor empatado, ordem original preservada.
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([1, 3, 2, 4]);
  });

  it("reordena quando as linhas recebidas mudam mas a coluna/direção ativas continuam as mesmas", () => {
    const { result, rerender } = montarHook([
      { id: 1, nome: "A", valorCentavos: 30 },
      { id: 2, nome: "B", valorCentavos: 10 },
    ]);

    act(() => result.current.toggleSort("valorCentavos"));
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([2, 1]);

    rerender({
      rows: [
        { id: 3, nome: "C", valorCentavos: 5 },
        { id: 4, nome: "D", valorCentavos: 40 },
      ],
    });

    expect(result.current.sortKey).toBe("valorCentavos");
    expect(result.current.sortedRows.map((r) => r.id)).toEqual([3, 4]);
  });
});
