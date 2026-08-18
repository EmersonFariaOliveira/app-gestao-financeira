/**
 * src/core/motor/index.ts — Motor de Aporte (lógica pura, zero I/O).
 *
 * Fonte da verdade: docs/app-gestao-aportes.md (seção 5 "Regras de negócio
 * do Motor de Aporte" + seção 5.1 "Dividendos") e
 * specs/001-gestao-aportes-v0-v1/contracts/motor.md. Compõe as regras
 * 1-9 implementadas em deficit.ts, fila.ts, divisao.ts, arredondamento.ts
 * e simulacao.ts numa única função pura e determinística.
 *
 * Regra arquitetural inviolável (CLAUDE.md / contrato): sem I/O, sem
 * imports de Prisma/Next/fs/services/parser/app — apenas dados em memória
 * entram e saem.
 */
import { calcularDeficits } from "./deficit";
import { construirFila, paraItemFila } from "./fila";
import { calcularDivisao } from "./divisao";
import { aplicarArredondamentoLote } from "./arredondamento";
import { calcularSimulacaoDepois } from "./simulacao";
import type { EntradaMotor, ResultadoMotor } from "./types";

export function calcularAporte(input: EntradaMotor): ResultadoMotor {
  // Regras 1 e 4: consolidação por alvo + patrimonioBase sem fora-da-carteira.
  const { patrimonioBaseCentavos, alvosComputados } = calcularDeficits(
    input.alvos,
    input.posicoes,
  );

  // Regra 2: fila de prioridade, ordenação determinística.
  const filaOrdenada = construirFila(alvosComputados);

  // Regras 3, 5 e 6: cascata + transbordo + mínimo por transação + veto humano.
  const divisaoBase = calcularDivisao(
    filaOrdenada,
    input.valorAporteCentavos,
    input.aporteMinimoCentavos,
    input.ajustesUsuario,
  );

  // Regra 7 (v1): arredondamento por lote B3, com destino do troco.
  const { divisao, trocoCentavos } = aplicarArredondamentoLote(
    divisaoBase,
    input.cotacoes,
    filaOrdenada,
  );

  // Regra 8 (números apenas — a banda visual é responsabilidade da UI).
  const simulacaoDepois = calcularSimulacaoDepois(filaOrdenada, divisao, patrimonioBaseCentavos);

  return {
    patrimonioBaseCentavos,
    fila: filaOrdenada.map(paraItemFila),
    divisao,
    trocoCentavos,
    simulacaoDepois,
  };
}

export type {
  AjusteUsuario,
  AlocacaoSimulada,
  AlvoVigente,
  CalcularAporte,
  CotacaoB3,
  EntradaMotor,
  ItemFila,
  LinhaDivisao,
  OrigemLinhaDivisao,
  PosicaoConsolidada,
  ResultadoMotor,
} from "./types";
