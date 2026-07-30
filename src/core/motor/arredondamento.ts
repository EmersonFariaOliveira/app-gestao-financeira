/**
 * src/core/motor/arredondamento.ts — regra 7 da spec (v1,
 * docs/app-gestao-aportes.md seção 5): arredondamento por lote para ativos
 * B3 (ações/FIIs/ETFs). Para cada alvo presente em `cotacoes`,
 * `cotas = floor(valor / precoCentavos)` e `valorAjustado = cotas *
 * precoCentavos`; a soma das sobras vai para o alvo de renda fixa da fila
 * com maior déficit ou, na ausência de um, para `trocoCentavos`. Nunca se
 * aplica a EXTERIOR nem a renda fixa/Tesouro — essa exclusão é garantida
 * por quem monta `cotacoes` (nunca inclui esses alvos), não por este
 * módulo.
 *
 * Convenção adotada (documentada também em tests/motor/arredondamento.test.ts):
 * quando a sobra cria uma linha nova para o alvo de renda fixa (que não
 * tinha `LinhaDivisao` própria antes), a origem é `TRANSBORDO` — o
 * contrato não define uma origem específica para "troco de lote" e o tipo
 * `OrigemLinhaDivisao` só tem DEFICIT/TRANSBORDO/AJUSTE_USUARIO.
 */
import type { AlvoComputado } from "./deficit";
import type { CotacaoB3, LinhaDivisao } from "./types";

export interface ResultadoArredondamento {
  divisao: LinhaDivisao[];
  trocoCentavos: number;
}

/**
 * Aplica o arredondamento por lote (regra 7) sobre a divisão já calculada
 * pelas regras 3/5/6. Sem `cotacoes` (ausente ou vazio), retorna a divisão
 * original intacta e `trocoCentavos = 0` (sem arredondamento por lote).
 */
export function aplicarArredondamentoLote(
  divisaoOriginal: LinhaDivisao[],
  cotacoes: CotacaoB3[] | undefined,
  filaOrdenada: AlvoComputado[],
): ResultadoArredondamento {
  if (!cotacoes || cotacoes.length === 0) {
    return { divisao: divisaoOriginal, trocoCentavos: 0 };
  }

  const cotacaoPorAlvo = new Map(cotacoes.map((c) => [c.alvoId, c.precoCentavos]));
  const divisao = divisaoOriginal.map((linha) => ({ ...linha }));

  let sobraTotal = 0;
  for (const linha of divisao) {
    const preco = cotacaoPorAlvo.get(linha.alvoId);
    if (preco === undefined || linha.valorCentavos <= 0) continue;

    const cotas = Math.floor(linha.valorCentavos / preco);
    const valorAjustado = cotas * preco;
    sobraTotal += linha.valorCentavos - valorAjustado;
    linha.valorCentavos = valorAjustado;
    linha.cotas = cotas;
    linha.precoCentavos = preco;
  }

  let trocoCentavos = 0;
  if (sobraTotal > 0) {
    // Regra 7: sobra vai para o alvo de renda fixa da fila com maior
    // déficit — a fila já está ordenada por déficit desc (regra 2), então
    // o primeiro alvo com rendaFixa=true é exatamente esse.
    const alvoRendaFixa = filaOrdenada.find((a) => a.rendaFixa);

    if (alvoRendaFixa) {
      const existente = divisao.find((l) => l.alvoId === alvoRendaFixa.alvoId);
      if (existente) {
        existente.valorCentavos += sobraTotal;
      } else {
        divisao.push({ alvoId: alvoRendaFixa.alvoId, valorCentavos: sobraTotal, origem: "TRANSBORDO" });
      }
    } else {
      // Sem alvo de renda fixa na fila: a sobra fica registrada para o mês seguinte.
      trocoCentavos = sobraTotal;
    }
  }

  // Uma linha B3 cujo valor cai a zero por arredondamento (menos que 1
  // cota) não deve permanecer como LinhaDivisao "fantasma" — mesma
  // convenção usada em divisao.ts (linhas com total 0 são omitidas),
  // exceto quando o próprio usuário fixou 0 explicitamente (regra 6).
  const divisaoFiltrada = divisao.filter(
    (l) => l.valorCentavos > 0 || l.origem === "AJUSTE_USUARIO",
  );

  return { divisao: divisaoFiltrada, trocoCentavos };
}
