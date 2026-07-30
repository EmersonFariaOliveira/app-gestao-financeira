/**
 * src/core/motor/deficit.ts — regras 1 e 4 da spec (docs/app-gestao-aportes.md
 * seção 5): consolidação de posições por alvo, patrimônio-base excluindo os
 * ativos "fora da carteira alvo" e déficit por alvo em aritmética inteira.
 *
 * Fórmula (regra 1, contracts/motor.md): `deficit = trunc(percentualBps *
 * patrimonioBase / 10000) - valorAtualDoAlvo`. Reaproveita `aplicarBps`
 * (src/core/money), que já implementa exatamente essa divisão inteira
 * truncada em direção a zero.
 */
import { aplicarBps } from "@/core/money";
import type { AlvoVigente, PosicaoConsolidada } from "./types";

/** Alvo com todos os valores derivados (déficit, percentual atual) já calculados. */
export interface AlvoComputado {
  alvoId: string;
  nome: string;
  percentualBps: number;
  rendaFixa: boolean;
  valorAtualCentavos: number;
  /** Percentual atual do alvo sobre o patrimonioBase, em bps (truncado). */
  percentualAtualBps: number;
  /** Regra 1; negativo = alvo acima do próprio alvo (nunca gera venda). */
  deficitCentavos: number;
}

export interface DeficitResultado {
  /** Consolidado SEM os ativos fora-da-carteira (regra 4). */
  patrimonioBaseCentavos: number;
  alvosComputados: AlvoComputado[];
}

/**
 * Consolida as posições por alvo (regra 1: múltiplas posições do mesmo
 * alvo são somadas antes da comparação) e calcula o déficit de cada alvo
 * vigente, excluindo da base de cálculo qualquer posição marcada como
 * `foraDaCarteira` (regra 4) — essas posições nunca aparecem em nenhum
 * alvo nem contribuem para `patrimonioBaseCentavos`.
 */
export function calcularDeficits(
  alvos: AlvoVigente[],
  posicoes: PosicaoConsolidada[],
): DeficitResultado {
  const valoresPorAlvo = new Map<string, number>();
  let patrimonioBaseCentavos = 0;

  for (const posicao of posicoes) {
    // Regra 4: ativos fora-da-carteira alvo nunca entram na base de cálculo.
    if (posicao.foraDaCarteira || posicao.alvoId === null) continue;

    patrimonioBaseCentavos += posicao.valorCentavos;
    valoresPorAlvo.set(
      posicao.alvoId,
      (valoresPorAlvo.get(posicao.alvoId) ?? 0) + posicao.valorCentavos,
    );
  }

  const alvosComputados: AlvoComputado[] = alvos.map((alvo) => {
    const valorAtualCentavos = valoresPorAlvo.get(alvo.alvoId) ?? 0;
    const percentualAtualBps =
      patrimonioBaseCentavos > 0
        ? Math.trunc((valorAtualCentavos * 10000) / patrimonioBaseCentavos)
        : 0;
    const targetCentavos = aplicarBps(patrimonioBaseCentavos, alvo.percentualBps);
    const deficitCentavos = targetCentavos - valorAtualCentavos;

    return {
      alvoId: alvo.alvoId,
      nome: alvo.nome,
      percentualBps: alvo.percentualBps,
      rendaFixa: alvo.rendaFixa,
      valorAtualCentavos,
      percentualAtualBps,
      deficitCentavos,
    };
  });

  return { patrimonioBaseCentavos, alvosComputados };
}
