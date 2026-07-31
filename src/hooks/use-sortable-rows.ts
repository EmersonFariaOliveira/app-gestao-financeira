"use client";

/**
 * src/hooks/use-sortable-rows.ts — ordenação client-side genérica para as
 * tabelas do app (usada junto com `SortableTableHead`,
 * src/components/ui/table.tsx).
 *
 * Regra de camada (CLAUDE.md): os dados já chegam prontos das server
 * actions/services — este hook só reordena o array em memória para
 * exibição, nunca recalcula nem reconsulta nada. Colunas de moeda
 * (centavos) e percentual (bps) devem ter um accessor que devolve o
 * inteiro bruto (nunca convertido para float); a formatação
 * (`formatCentavosParaReais`/`formatBps`) continua sendo só de exibição.
 */
import { useMemo, useState } from "react";

export type SortDirection = "asc" | "desc";

/** Um accessor por coluna ordenável: devolve o valor bruto usado na comparação (string, número, ou timestamp em ms para datas). */
export type SortAccessors<T, K extends string> = Record<K, (row: T) => string | number>;

export interface UseSortableRowsResult<T, K extends string> {
  /** Linhas ordenadas (ou as originais, na ordem recebida, enquanto nenhuma coluna estiver ativa). */
  sortedRows: T[];
  sortKey: K | null;
  direction: SortDirection;
  /** Clique no cabeçalho: primeira vez ordena asc; clique de novo na mesma coluna alterna asc/desc; clique em outra coluna reinicia em asc. */
  toggleSort: (key: K) => void;
  /** Direção ativa para uma coluna específica, ou `undefined` se ela não é a coluna ordenada no momento — usado para `aria-sort`/ícone do `SortableTableHead`. */
  sortDirectionFor: (key: K) => SortDirection | undefined;
}

export function useSortableRows<T, K extends string>(
  rows: T[],
  accessors: SortAccessors<T, K>,
): UseSortableRowsResult<T, K> {
  const [sortKey, setSortKey] = useState<K | null>(null);
  const [direction, setDirection] = useState<SortDirection>("asc");

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const accessor = accessors[sortKey];
    const decorado = rows.map((row, indiceOriginal) => ({
      row,
      valor: accessor(row),
      indiceOriginal,
    }));
    decorado.sort((a, b) => {
      let cmp: number;
      if (typeof a.valor === "number" && typeof b.valor === "number") {
        cmp = a.valor - b.valor;
      } else {
        cmp = String(a.valor).localeCompare(String(b.valor), "pt-BR", {
          numeric: true,
          sensitivity: "base",
        });
      }
      if (direction === "desc") cmp = -cmp;
      // desempate por indiceOriginal sempre crescente (nunca invertido) para ordenação estável de verdade
      return cmp === 0 ? a.indiceOriginal - b.indiceOriginal : cmp;
    });
    return decorado.map((d) => d.row);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `accessors` é recriado a cada render nos call sites; incluí-lo forçaria reordenação desnecessária a cada render sem mudar o resultado.
  }, [rows, sortKey, direction]);

  function toggleSort(key: K) {
    if (sortKey !== key) {
      setSortKey(key);
      setDirection("asc");
      return;
    }
    setDirection((d) => (d === "asc" ? "desc" : "asc"));
  }

  function sortDirectionFor(key: K): SortDirection | undefined {
    return sortKey === key ? direction : undefined;
  }

  return { sortedRows, sortKey, direction, toggleSort, sortDirectionFor };
}
