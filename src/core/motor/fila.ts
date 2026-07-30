/**
 * src/core/motor/fila.ts — regra 2 da spec (docs/app-gestao-aportes.md
 * seção 5): fila de prioridade por déficit, com desempate determinístico
 * (percentualBps desc, depois nome asc) para garantir que o resultado
 * nunca dependa da ordem de inserção dos arrays de entrada.
 */
import type { AlvoComputado } from "./deficit";
import type { ItemFila } from "./types";

/**
 * Ordena os alvos computados por déficit desc (regra 2). TODOS os alvos
 * vigentes permanecem na fila, inclusive os com déficit negativo (regra 1:
 * ignorados na divisão, mas nunca removidos da fila/exibição).
 */
export function construirFila(alvosComputados: AlvoComputado[]): AlvoComputado[] {
  return [...alvosComputados].sort((a, b) => {
    if (b.deficitCentavos !== a.deficitCentavos) {
      return b.deficitCentavos - a.deficitCentavos;
    }
    if (b.percentualBps !== a.percentualBps) {
      return b.percentualBps - a.percentualBps;
    }
    return a.nome.localeCompare(b.nome);
  });
}

/** Projeta um `AlvoComputado` (interno) para o formato de saída `ItemFila`. */
export function paraItemFila(alvo: AlvoComputado): ItemFila {
  return {
    alvoId: alvo.alvoId,
    valorAtualCentavos: alvo.valorAtualCentavos,
    percentualAtualBps: alvo.percentualAtualBps,
    deficitCentavos: alvo.deficitCentavos,
  };
}
