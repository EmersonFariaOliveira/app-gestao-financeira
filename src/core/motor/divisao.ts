/**
 * src/core/motor/divisao.ts — regras 3, 5 e 6 da spec
 * (docs/app-gestao-aportes.md seção 5): cascata de preenchimento de
 * déficit, transbordo proporcional aos percentuais-alvo, aporte mínimo por
 * transação (com realocação ao topo da fila) e veto humano (ajustes do
 * usuário fixam linhas e o restante é redistribuído pelas mesmas regras).
 *
 * Decisões interpretativas adotadas (documentadas no relatório final do
 * agente calculista-aporte, compatíveis com contracts/motor.md):
 *
 * 1. "Aporte total < mínimo ⇒ tudo no topo da fila" é uma EXCEÇÃO
 *    documentada à invariante geral "nenhuma linha 0<valor<mínimo": quando
 *    o aporte INTEIRO (não uma fatia/fragmento) cai no topo da fila por ser
 *    menor que o mínimo, isso é permitido — o mínimo existe para evitar
 *    fragmentar em várias transações pequenas, não para recusar o aporte
 *    inteiro. A implementação abaixo não precisa de um caso especial: como
 *    a realocação por mínimo sempre manda o valor para o topo da fila, e o
 *    topo só pode ficar abaixo do mínimo quando ele é a ÚNICA linha com
 *    dinheiro (nada sobrou para descer a fila), a realocação vira um no-op
 *    sobre si mesmo e o valor final é preservado.
 * 2. Na regra 6 (veto humano), o transbordo do restante usa como base
 *    proporcional APENAS os `percentualBps` dos alvos NÃO fixados — o bps
 *    dos alvos fixados é totalmente excluído do denominador.
 * 3. Ajustes do usuário cuja soma excede `valorAporteCentavos`: a spec
 *    (seção 5, regra 6) não cobre esse caso — ela só descreve fixar/zerar
 *    linhas e redistribuir o RESTANTE, o que pressupõe restante >= 0.
 *    Seguindo o Princípio V da constitution ("Falhar Alto, Nunca em
 *    Silêncio") e o padrão já usado no parser (recusar e falhar claro em
 *    vez de inferir silenciosamente), esse caso é tratado como entrada
 *    inválida: `calcularDivisao` lança um erro explícito ANTES de montar a
 *    cascata, em vez de capar/truncar os valores que o usuário fixou
 *    explicitamente (o que mudaria, sem avisar, um valor que ele digitou de
 *    propósito — pior do que recusar). Soma exatamente igual ao aporte
 *    (restante = 0) é válida e não lança erro (transbordo zero).
 */
import { formatCentavosParaReais } from "@/core/money";
import type { AlvoComputado } from "./deficit";
import type { AjusteUsuario, LinhaDivisao, OrigemLinhaDivisao } from "./types";

/** Acumulador interno por alvo, separando a origem do dinheiro para decidir `origem` no final. */
interface LinhaInterna {
  alvoId: string;
  fromDeficit: number;
  fromTransbordo: number;
}

/**
 * Calcula a divisão completa do aporte (regras 3, 5 e 6): linhas fixadas
 * pelo usuário (`ajustesUsuario`) saem primeiro com origem
 * `AJUSTE_USUARIO` (inclusive valor 0 = linha zerada); o restante
 * (`valorAporteCentavos - Σ ajustes`) é distribuído em cascata sobre os
 * alvos NÃO fixados, na ordem da fila.
 */
export function calcularDivisao(
  filaOrdenada: AlvoComputado[],
  valorAporteCentavos: number,
  aporteMinimoCentavos: number,
  ajustesUsuario: AjusteUsuario[] | undefined,
): LinhaDivisao[] {
  const ajustesMap = new Map((ajustesUsuario ?? []).map((a) => [a.alvoId, a.valorCentavos]));

  const linhasFixadas: LinhaDivisao[] = [];
  const naoFixados: AlvoComputado[] = [];
  let somaFixada = 0;

  for (const alvo of filaOrdenada) {
    const valorFixado = ajustesMap.get(alvo.alvoId);
    if (valorFixado !== undefined) {
      linhasFixadas.push({ alvoId: alvo.alvoId, valorCentavos: valorFixado, origem: "AJUSTE_USUARIO" });
      somaFixada += valorFixado;
    } else {
      naoFixados.push(alvo);
    }
  }

  if (somaFixada > valorAporteCentavos) {
    throw new Error(
      `A soma dos ajustes do usuário (${formatCentavosParaReais(somaFixada)}) excede o valor do aporte (${formatCentavosParaReais(valorAporteCentavos)}).`,
    );
  }

  const restante = valorAporteCentavos - somaFixada;
  const linhasCalculadas = distribuirEmCascata(naoFixados, restante, aporteMinimoCentavos);

  return [...linhasFixadas, ...linhasCalculadas];
}

/**
 * Distribui `valorTotal` sobre `alvos` (já na ordem da fila, regra 2) em
 * três fases:
 * 1. Cascata cobrindo os déficits positivos, de cima para baixo (regra 3).
 * 2. Transbordo: excedente distribuído proporcionalmente aos
 *    `percentualBps` de TODOS os `alvos` recebidos (regra 3) — resto de
 *    centavos da divisão inteira vai para o topo da fila (SC-005).
 * 3. Mínimo por transação: qualquer linha com `0 < total < aporteMinimo`
 *    é zerada e seu valor somado ao topo da fila (regra 5).
 */
function distribuirEmCascata(
  alvos: AlvoComputado[],
  valorTotal: number,
  aporteMinimoCentavos: number,
): LinhaDivisao[] {
  if (alvos.length === 0 || valorTotal <= 0) return [];

  const linhas: LinhaInterna[] = alvos.map((a) => ({
    alvoId: a.alvoId,
    fromDeficit: 0,
    fromTransbordo: 0,
  }));
  const indicePorId = new Map(linhas.map((l, i) => [l.alvoId, i]));

  // Fase 1 (regra 3): cascata cobrindo déficits positivos, na ordem da fila.
  let restante = valorTotal;
  for (const alvo of alvos) {
    if (restante <= 0) break;
    if (alvo.deficitCentavos <= 0) continue;
    const linha = linhas[indicePorId.get(alvo.alvoId)!];
    const alocado = Math.min(alvo.deficitCentavos, restante);
    linha.fromDeficit += alocado;
    restante -= alocado;
  }

  // Fase 2 (regra 3): transbordo proporcional aos bps de TODOS os alvos recebidos.
  if (restante > 0) {
    const somaBps = alvos.reduce((acc, a) => acc + a.percentualBps, 0);
    if (somaBps > 0) {
      let distribuido = 0;
      for (const alvo of alvos) {
        const linha = linhas[indicePorId.get(alvo.alvoId)!];
        const parte = Math.trunc((restante * alvo.percentualBps) / somaBps);
        linha.fromTransbordo += parte;
        distribuido += parte;
      }
      const resto = restante - distribuido;
      if (resto > 0) {
        // Resto de centavos da divisão inteira vai para o topo da fila (SC-005).
        linhas[indicePorId.get(alvos[0].alvoId)!].fromTransbordo += resto;
      }
    } else {
      // Caso extremo sem bps definido (não coberto pelos testes): tudo pro topo.
      linhas[indicePorId.get(alvos[0].alvoId)!].fromDeficit += restante;
    }
  }

  // Fase 3 (regra 5): fatia 0<valor<mínimo não é criada; volta ao topo da fila.
  let poolRealocado = 0;
  for (const linha of linhas) {
    const total = linha.fromDeficit + linha.fromTransbordo;
    if (total > 0 && total < aporteMinimoCentavos) {
      poolRealocado += total;
      linha.fromDeficit = 0;
      linha.fromTransbordo = 0;
    }
  }
  if (poolRealocado > 0) {
    linhas[indicePorId.get(alvos[0].alvoId)!].fromDeficit += poolRealocado;
  }

  return linhas.reduce<LinhaDivisao[]>((acc, linha) => {
    const total = linha.fromDeficit + linha.fromTransbordo;
    if (total <= 0) return acc;
    const origem: OrigemLinhaDivisao = linha.fromDeficit > 0 ? "DEFICIT" : "TRANSBORDO";
    acc.push({ alvoId: linha.alvoId, valorCentavos: total, origem });
    return acc;
  }, []);
}
