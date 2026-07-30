/**
 * src/core/motor/simulacao.ts — regra 8 da spec (docs/app-gestao-aportes.md
 * seção 5): apenas os NÚMEROS da alocação "antes/depois" caso o aporte seja
 * executado como sugerido. A banda de tolerância em si é responsabilidade
 * visual da UI/dashboard — o motor nunca aplica banda, apenas fornece os
 * percentuais e déficits para quem for colorir/exibir.
 */
import { aplicarBps } from "@/core/money";
import type { AlvoComputado } from "./deficit";
import type { AlocacaoSimulada, LinhaDivisao } from "./types";

/**
 * Calcula, para cada alvo da fila, como fica o percentual sobre o
 * patrimônio total se a divisão final for executada como sugerida. O
 * patrimônio "depois" soma apenas o dinheiro efetivamente alocado em
 * `divisaoFinal` (troco de lote/aporte abaixo do mínimo sem destino não é
 * investido neste mês, então não entra no patrimônio simulado).
 */
export function calcularSimulacaoDepois(
  filaComputada: AlvoComputado[],
  divisaoFinal: LinhaDivisao[],
  patrimonioBaseCentavos: number,
): AlocacaoSimulada[] {
  const valorAlocadoPorAlvo = new Map(divisaoFinal.map((l) => [l.alvoId, l.valorCentavos]));
  const somaAlocada = divisaoFinal.reduce((acc, l) => acc + l.valorCentavos, 0);
  const patrimonioDepoisCentavos = patrimonioBaseCentavos + somaAlocada;

  return filaComputada.map((alvo) => {
    const valorDepoisCentavos = alvo.valorAtualCentavos + (valorAlocadoPorAlvo.get(alvo.alvoId) ?? 0);
    const percentualDepoisBps =
      patrimonioDepoisCentavos > 0
        ? Math.trunc((valorDepoisCentavos * 10000) / patrimonioDepoisCentavos)
        : 0;
    const targetDepoisCentavos = aplicarBps(patrimonioDepoisCentavos, alvo.percentualBps);

    return {
      alvoId: alvo.alvoId,
      percentualAntesBps: alvo.percentualAtualBps,
      percentualDepoisBps,
      deficitDepoisCentavos: targetDepoisCentavos - valorDepoisCentavos,
    };
  });
}
