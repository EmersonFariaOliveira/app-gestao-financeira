/**
 * tests/motor/fixtures.ts — cenários sintéticos reutilizados por vários
 * arquivos de teste do motor (não é um arquivo *.test.ts; o vitest não o
 * coleta como suíte).
 *
 * Cada função retorna uma cópia NOVA (objetos literais frescos) para que
 * testes de pureza (chamar calcularAporte duas vezes) nunca compartilhem
 * referências mutáveis entre chamadas.
 *
 * Todos os números abaixo foram derivados à mão e conferidos por aritmética
 * inteira exata (nunca float) — ver comentário de cada cenário para a
 * conta completa.
 */
import type { AlvoVigente, EntradaMotor, PosicaoConsolidada } from "@/core/motor/types";

/**
 * Cenário-base: 3 alvos vigentes, bps 5000/3000/2000 (soma 10000).
 *
 * Posições (consolidação por chave + exclusão de fora-da-carteira, regras
 * 1 e 4, em uma única fixture):
 * - alvo-a ("Ações BR", bps 5000): DUAS posições (100000 + 200000) = 300000
 * - alvo-b ("FIIs", bps 3000): 280000
 * - alvo-c ("Multimercado", bps 2000): 420000
 * - fora-da-carteira (alvoId null): 999999 — EXCLUÍDO da base
 *
 * patrimonioBase = 300000 + 280000 + 420000 = 1.000.000 (999999 nunca entra)
 *
 * Déficits (regra 1: deficit = trunc(bps * patrimonioBase / 10000) - valorAtual):
 * - alvo-a: trunc(5000 * 1000000 / 10000) - 300000 = 500000 - 300000 =  200000
 * - alvo-b: trunc(3000 * 1000000 / 10000) - 280000 = 300000 - 280000 =   20000
 * - alvo-c: trunc(2000 * 1000000 / 10000) - 420000 = 200000 - 420000 = -220000 (negativo, ignorado na divisão)
 *
 * Soma dos déficits POSITIVOS = 200000 + 20000 = 220000.
 * Fila esperada (déficit desc): alvo-a (200000), alvo-b (20000), alvo-c (-220000).
 */
export function cenarioBase(): EntradaMotor {
  const alvos: AlvoVigente[] = [
    { alvoId: "alvo-a", nome: "Ações BR", percentualBps: 5000, rendaFixa: false },
    { alvoId: "alvo-b", nome: "FIIs", percentualBps: 3000, rendaFixa: false },
    { alvoId: "alvo-c", nome: "Multimercado", percentualBps: 2000, rendaFixa: false },
  ];

  const posicoes: PosicaoConsolidada[] = [
    { chaveExport: "ITSA4", alvoId: "alvo-a", foraDaCarteira: false, valorCentavos: 100000, tipoGrupo: "ACOES" },
    { chaveExport: "BBAS3", alvoId: "alvo-a", foraDaCarteira: false, valorCentavos: 200000, tipoGrupo: "ACOES" },
    { chaveExport: "XPML11", alvoId: "alvo-b", foraDaCarteira: false, valorCentavos: 280000, tipoGrupo: "FII_FIAGRO" },
    { chaveExport: "Kinea Atlas Multimercado", alvoId: "alvo-c", foraDaCarteira: false, valorCentavos: 420000, tipoGrupo: "FUNDOS_INVESTIMENTO" },
    { chaveExport: "ATIVO-LEGADO", alvoId: null, foraDaCarteira: true, valorCentavos: 999999, tipoGrupo: "OUTROS_FUNDOS" },
  ];

  return {
    alvos,
    posicoes,
    valorAporteCentavos: 0,
    aporteMinimoCentavos: 100,
  };
}

export const CENARIO_BASE_PATRIMONIO = 1_000_000;
export const CENARIO_BASE_DEFICIT_A = 200_000;
export const CENARIO_BASE_DEFICIT_B = 20_000;
export const CENARIO_BASE_DEFICIT_C = -220_000;
export const CENARIO_BASE_SOMA_DEFICITS_POSITIVOS = 220_000;

/**
 * Cenário de lote B3 COM alvo de renda fixa (regra 7).
 *
 * alvo-lote (B3, bps 6000), alvo-rf (renda fixa, bps 4000).
 * valorAtual: alvo-lote=200000, alvo-rf=200000 ⇒ patrimonioBase=400000.
 * targets: lote=6000*400000/10000=240000 (déficit=40000); rf=4000*400000/10000=160000 (déficit=-40000, negativo).
 * aporte=40000 (cobre exatamente o déficit de alvo-lote; sem transbordo).
 * cotacao alvo-lote: precoCentavos=3000 ⇒ cotas=floor(40000/3000)=13, valorAjustado=39000, sobra=1000.
 * alvo-rf é o único alvo de renda fixa da fila ⇒ recebe a sobra: 0 + 1000 = 1000.
 */
export function cenarioLoteComRendaFixa(): EntradaMotor {
  const alvos: AlvoVigente[] = [
    { alvoId: "alvo-lote", nome: "PRIO3", percentualBps: 6000, rendaFixa: false },
    { alvoId: "alvo-rf", nome: "Pós-fixado", percentualBps: 4000, rendaFixa: true },
  ];

  const posicoes: PosicaoConsolidada[] = [
    { chaveExport: "PRIO3", alvoId: "alvo-lote", foraDaCarteira: false, valorCentavos: 200000, tipoGrupo: "ACOES" },
    { chaveExport: "Tesouro Selic 2027", alvoId: "alvo-rf", foraDaCarteira: false, valorCentavos: 200000, tipoGrupo: "TESOURO_DIRETO" },
  ];

  return {
    alvos,
    posicoes,
    valorAporteCentavos: 40_000,
    aporteMinimoCentavos: 100,
    cotacoes: [{ alvoId: "alvo-lote", precoCentavos: 3000 }],
  };
}

/**
 * Cenário de lote B3 SEM nenhum alvo de renda fixa (regra 7) — a sobra vai
 * para trocoCentavos em vez de ser redirecionada.
 *
 * alvo-lote (B3, bps 6000), alvo-ext (EXTERIOR, bps 4000, rendaFixa=false).
 * Mesmos números do cenário anterior, mas sem alvo-rf.
 * valorAtual: alvo-lote=200000, alvo-ext=200000 ⇒ patrimonioBase=400000.
 * déficit alvo-lote=40000; déficit alvo-ext=-40000 (negativo).
 * aporte=40000 ⇒ cobre exatamente o déficit de alvo-lote.
 * cotas=floor(40000/3000)=13, valorAjustado=39000, sobra=1000 ⇒ trocoCentavos=1000 (nenhum alvo de renda fixa).
 */
export function cenarioLoteSemRendaFixa(): EntradaMotor {
  const alvos: AlvoVigente[] = [
    { alvoId: "alvo-lote", nome: "PRIO3", percentualBps: 6000, rendaFixa: false },
    { alvoId: "alvo-ext", nome: "AAPL", percentualBps: 4000, rendaFixa: false },
  ];

  const posicoes: PosicaoConsolidada[] = [
    { chaveExport: "PRIO3", alvoId: "alvo-lote", foraDaCarteira: false, valorCentavos: 200000, tipoGrupo: "ACOES" },
    { chaveExport: "AAPL", alvoId: "alvo-ext", foraDaCarteira: false, valorCentavos: 200000, tipoGrupo: "EXTERIOR" },
  ];

  return {
    alvos,
    posicoes,
    valorAporteCentavos: 40_000,
    aporteMinimoCentavos: 100,
    cotacoes: [{ alvoId: "alvo-lote", precoCentavos: 3000 }],
  };
}

/**
 * Cenário EXTERIOR isento de lote (regra 7): apenas o alvo B3 tem cotação;
 * o alvo EXTERIOR nunca aparece em `cotacoes` e deve receber valor livre
 * (fracionado), sem `cotas`.
 *
 * alvo-ext (EXTERIOR, bps 7000), alvo-lote (B3, bps 3000, com cotação, mas
 * SEM déficit — não deve receber nada neste cenário, então não entra na
 * divisão e a ausência de `cotas` só pode ser observada no alvo-ext).
 * valorAtual: alvo-ext=100, alvo-lote=100 ⇒ patrimonioBase=200.
 * targets: ext=7000*200/10000=140 (déficit=40); lote=3000*200/10000=60 (déficit=-40, negativo).
 * aporte=40 (cobre exatamente o déficit de alvo-ext; sem transbordo).
 */
export function cenarioExteriorIgnoraLote(): EntradaMotor {
  const alvos: AlvoVigente[] = [
    { alvoId: "alvo-ext", nome: "AAPL", percentualBps: 7000, rendaFixa: false },
    { alvoId: "alvo-lote", nome: "PRIO3", percentualBps: 3000, rendaFixa: false },
  ];

  const posicoes: PosicaoConsolidada[] = [
    { chaveExport: "AAPL", alvoId: "alvo-ext", foraDaCarteira: false, valorCentavos: 100, tipoGrupo: "EXTERIOR" },
    { chaveExport: "PRIO3", alvoId: "alvo-lote", foraDaCarteira: false, valorCentavos: 100, tipoGrupo: "ACOES" },
  ];

  return {
    alvos,
    posicoes,
    valorAporteCentavos: 40,
    aporteMinimoCentavos: 1,
    cotacoes: [{ alvoId: "alvo-lote", precoCentavos: 3000 }],
  };
}
