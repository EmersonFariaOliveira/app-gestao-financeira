/**
 * src/core/rendimento/movimentacao-nao-explicada.ts — aritmética pura da
 * regra "movimentação não explicada" do import mensal (FR-018,
 * specs/003-dashboard-analise-rendimento, research.md R8).
 *
 * Extraído de `src/services/rendimento-service.ts` ->
 * `calcularMovimentacaoNaoExplicada` (mesma fórmula/limiares, sem mudança de
 * comportamento). Camada de LÓGICA PURA no mesmo princípio de
 * `src/core/motor` (ver `src/core/motor/index.ts`): zero I/O, sem imports de
 * Prisma/Next/fs/services — apenas dados em memória entram e saem. Este
 * arquivo é irmão do motor de aporte, não faz parte dele (motor de aporte =
 * seção 5/5.1 de docs/app-gestao-aportes.md; esta regra é da feature 003,
 * dashboard de rendimento).
 *
 * Por ser puro, pode ser importado tanto pelo services (server-side) quanto
 * diretamente por um Client Component no navegador, para recalcular a mesma
 * regra reativamente sem round-trip ao servidor.
 */

// Constantes de aplicação (R8) — tolerância de "movimentação não explicada"
// (FR-018). Reexportadas por `rendimento-service.ts` para compatibilidade.
export const TOLERANCIA_MOVIMENTACAO_PCT = 5;
export const TOLERANCIA_MOVIMENTACAO_PISO_CENTAVOS = 2000; // R$ 20,00

export interface EntradaAvaliacaoMovimentacao {
  valorInvestidoEsperadoCentavos: number;
  valorInvestidoRealCentavos: number;
  /**
   * true quando existe uma base de comparação rastreável para o alvo/ativo
   * (ao menos um elegível com valor investido resolvível na sessão anterior,
   * OU houve aporte executado registrado para o alvo naquela sessão). Sem
   * nenhuma das duas, o alvo/ativo é genuinamente novo (primeira aparição) e
   * NUNCA dispara alerta, por maior que seja o valor real.
   */
  houveBaseComparacao: boolean;
}

export interface ResultadoAvaliacaoMovimentacao {
  diferencaCentavos: number;
  /** true apenas quando |diferencaCentavos| excede AMBOS os limiares (percentual E piso) simultaneamente, e há base de comparação. */
  excedeTolerancia: boolean;
}

/**
 * Avalia se a diferença entre o valor investido esperado (posição anterior +
 * aportes executados registrados) e o valor real trazido pelo import excede
 * a tolerância de "movimentação não explicada" (FR-018/R8).
 *
 * `excedeTolerancia` só é `true` quando `houveBaseComparacao` é `true` E a
 * diferença absoluta excede SIMULTANEAMENTE `TOLERANCIA_MOVIMENTACAO_PCT`
 * (relativo ao esperado) e `TOLERANCIA_MOVIMENTACAO_PISO_CENTAVOS`
 * (absoluto). Quando `valorInvestidoEsperadoCentavos` é 0, o percentual
 * seria indefinido/infinito: qualquer diferença não-nula é tratada como
 * excedendo o limiar percentual, mas o limiar de piso em R$ ainda se aplica
 * normalmente.
 */
export function avaliarMovimentacaoNaoExplicada(
  entrada: EntradaAvaliacaoMovimentacao,
): ResultadoAvaliacaoMovimentacao {
  const { valorInvestidoEsperadoCentavos, valorInvestidoRealCentavos, houveBaseComparacao } =
    entrada;

  const diferencaCentavos = valorInvestidoRealCentavos - valorInvestidoEsperadoCentavos;
  const diferencaAbsoluta = Math.abs(diferencaCentavos);

  const excedePct =
    valorInvestidoEsperadoCentavos === 0
      ? diferencaAbsoluta > 0
      : (diferencaAbsoluta / Math.abs(valorInvestidoEsperadoCentavos)) * 100 >
        TOLERANCIA_MOVIMENTACAO_PCT;
  const excedePiso = diferencaAbsoluta > TOLERANCIA_MOVIMENTACAO_PISO_CENTAVOS;
  const excedeTolerancia = houveBaseComparacao && excedePct && excedePiso;

  return { diferencaCentavos, excedeTolerancia };
}
