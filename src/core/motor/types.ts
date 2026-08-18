/**
 * src/core/motor/types.ts — tipos do Motor de Aporte (lógica pura, zero I/O).
 *
 * Fonte da verdade: docs/app-gestao-aportes.md (seção 5 "Regras de negócio
 * do Motor de Aporte" + seção 5.1 "Dividendos") e
 * specs/001-gestao-aportes-v0-v1/contracts/motor.md ("Contrato — Motor de
 * Aporte"). Este arquivo apenas declara a FORMA dos dados exatamente como
 * definida no contrato — a semântica de cada regra (1-9) é implementada em
 * T021-T025 e testada em tests/motor/ (T015-T020). Não alterar os nomes ou
 * a forma dos campos sem atualizar o contrato primeiro.
 *
 * Regra arquitetural inviolável (CLAUDE.md / contrato, linha 3): "sem I/O,
 * sem imports de Prisma/Next/fs/services/parser". Este módulo não importa
 * absolutamente nada — só declara tipos.
 */

/** Entrada completa do motor — tudo já resolvido/consolidado pela camada de serviços. */
export interface EntradaMotor {
  /** Vigência ativa dos alvos; soma dos percentualBps = 10000 (pré-validado fora do motor). */
  alvos: AlvoVigente[];
  /** Posições já consolidadas por chave e mapeadas a um alvo (nunca pendentes). */
  posicoes: PosicaoConsolidada[];
  /** Valor digitado + dividendos incluídos + troco do mês anterior, em centavos. */
  valorAporteCentavos: number;
  /** Aporte mínimo por transação (regra 5), vindo da config. */
  aporteMinimoCentavos: number;
  /** Veto humano (regra 6); ausente = sugestão original do motor, sem ajustes. */
  ajustesUsuario?: AjusteUsuario[];
  /** Cotações B3 para arredondamento por lote (regra 7, v1); ausente = sem lote. */
  cotacoes?: CotacaoB3[];
}

export interface AlvoVigente {
  alvoId: string;
  nome: string;
  /** Percentual-alvo em pontos-base (10000 bps = 100%). */
  percentualBps: number;
  /**
   * Alvo que aceita valor quebrado — destino preferencial do troco de lote
   * (regra 7). Derivado fora do motor a partir do tipo_grupo dos ativos
   * vinculados (TESOURO_DIRETO/fundos ⇒ true).
   */
  rendaFixa: boolean;
}

export interface PosicaoConsolidada {
  chaveExport: string;
  /** null ⇒ foraDaCarteira obrigatoriamente true. */
  alvoId: string | null;
  /** Regra 4: excluída da base de cálculo e nunca recebe aporte. */
  foraDaCarteira: boolean;
  valorCentavos: number;
  tipoGrupo: string;
}

/** Ajuste manual do usuário (regra 6 — veto humano). `valorCentavos: 0` = linha zerada. */
export interface AjusteUsuario {
  alvoId: string;
  valorCentavos: number;
}

/**
 * Cotação B3 para arredondamento por lote (regra 7).
 * Apenas alvos B3 (ações/FIIs/ETFs). EXTERIOR e renda fixa NUNCA entram aqui
 * — essa exclusão é garantida por quem monta a entrada, não pelo motor.
 */
export interface CotacaoB3 {
  alvoId: string;
  precoCentavos: number;
}

export interface ResultadoMotor {
  /** Patrimônio consolidado SEM os ativos fora-da-carteira (regra 4). */
  patrimonioBaseCentavos: number;
  /** Regra 2: TODOS os alvos vigentes, ordenados por déficit desc. */
  fila: ItemFila[];
  /** Regras 3, 5, 6 e 7 já aplicadas. */
  divisao: LinhaDivisao[];
  /** Sobra de arredondamento por lote sem alvo de renda fixa para receber (regra 7). */
  trocoCentavos: number;
  /** "Como fica a alocação se o aporte for executado como sugerido". */
  simulacaoDepois: AlocacaoSimulada[];
}

export interface ItemFila {
  alvoId: string;
  valorAtualCentavos: number;
  /** Percentual atual do alvo sobre o patrimonioBase, em bps — apenas para exibição. */
  percentualAtualBps: number;
  /** Regra 1; negativo = alvo acima do próprio alvo (ignorado na divisão, nunca gera venda). */
  deficitCentavos: number;
}

/**
 * Origem do valor de uma LinhaDivisao:
 * - 'DEFICIT': veio (total ou parcialmente) do preenchimento em cascata da fila.
 * - 'TRANSBORDO': recebeu (total ou parcialmente) excedente proporcional aos bps.
 * - 'AJUSTE_USUARIO': valor fixado pelo veto humano (regra 6), inclusive zero.
 */
export type OrigemLinhaDivisao = "DEFICIT" | "TRANSBORDO" | "AJUSTE_USUARIO";

export interface LinhaDivisao {
  alvoId: string;
  /** Valor final, já após mínimo/ajustes/arredondamento. */
  valorCentavos: number;
  origem: OrigemLinhaDivisao;
  /** Só presente quando houve arredondamento por lote (regra 7). */
  cotas?: number;
  precoCentavos?: number;
}

export interface AlocacaoSimulada {
  alvoId: string;
  percentualAntesBps: number;
  percentualDepoisBps: number;
  deficitDepoisCentavos: number;
}

/**
 * Assinatura do motor — a implementação real vive em src/core/motor/index.ts
 * (tasks T021-T025). Declarada aqui apenas como referência de tipo para os
 * testes; NÃO implementar calcularAporte neste arquivo.
 */
export type CalcularAporte = (input: EntradaMotor) => ResultadoMotor;
