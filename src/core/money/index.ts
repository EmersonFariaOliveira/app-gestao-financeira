/**
 * src/core/money — utilitários de dinheiro (lógica pura, zero I/O).
 *
 * Regra inviolável (spec seção 3 / research.md R4, R5, R6): valores
 * monetários NUNCA passam por `parseFloat`/aritmética de ponto flutuante.
 * `parseFloat("1.15") * 100` produz `114.99999999999999` em JS — esse é
 * exatamente o bug de classe que este módulo existe para eliminar.
 *
 * Tudo aqui é feito por manipulação de string (para parse) e aritmética
 * inteira exata (para os cálculos), nunca por divisão/multiplicação de
 * números não-inteiros.
 */

/**
 * Regex de validação de um decimal simples:
 * - sinal opcional (+/-)
 * - parte inteira obrigatória (1+ dígitos)
 * - parte decimal opcional, com separador `.` OU `,` (nunca ambos, nunca
 *   mais de um separador), exigindo pelo menos 1 dígito após o separador
 *   quando ele está presente.
 *
 * Formatos como "1.234.56", "1,234,56", "1.234,56" (separador de milhar)
 * ou "1234." (separador sem dígitos) são deliberadamente inválidos: este
 * módulo não tenta adivinhar separador de milhar, só decimal puro.
 */
const REGEX_DECIMAL = /^([+-]?)(\d+)(?:[.,](\d+))?$/;

/**
 * Converte uma string decimal (aceitando `.` ou `,` como separador
 * decimal) para um inteiro em centavos, sem nunca passar por
 * ponto flutuante.
 *
 * Política de casas decimais (documentada — usada também pelo parser de
 * CSV e pela borda de UI):
 * - 0 casas decimais (ex.: "2000") → completa com "00" (R$ 2.000,00).
 * - 1 casa decimal (ex.: "1.5") → completa com "0" à direita (R$ 1,50).
 * - 2 casas decimais (ex.: "1234.56") → usa como veio.
 * - 3+ casas decimais (ex.: "1.239") → TRUNCA para 2 casas (123 centavos),
 *   nunca arredonda. Mesma política de truncamento usada no resto do
 *   sistema para lotes (regra 7 da seção 5 da spec).
 *
 * @throws {Error} se `valor` não for string ou não casar com o formato
 * decimal esperado (letras, múltiplos separadores, string vazia, etc.).
 */
export function parseDecimalParaCentavos(valor: string): number {
  if (typeof valor !== "string") {
    throw new Error(
      `parseDecimalParaCentavos: esperava string, recebeu ${typeof valor}`,
    );
  }

  const valorTrim = valor.trim();
  const match = REGEX_DECIMAL.exec(valorTrim);

  if (!match) {
    throw new Error(
      `parseDecimalParaCentavos: formato decimal inválido: "${valor}"`,
    );
  }

  const [, sinal, parteInteira, parteDecimal = ""] = match;

  // Pad com zeros à direita e depois trunca para exatamente 2 caracteres:
  // resolve pad (0/1 casa) e truncamento (2+ casas) com uma única operação.
  const centavosStr = (parteDecimal + "00").slice(0, 2);

  const centavos = Number(parteInteira) * 100 + Number(centavosStr);

  return sinal === "-" ? -centavos : centavos;
}

/**
 * Formata um inteiro em centavos para o padrão monetário brasileiro:
 * "R$ 1.234,56" (separador de milhar `.`, separador decimal `,`).
 *
 * Valores negativos são formatados com o sinal antes de "R$": "-R$ 10,00".
 *
 * @throws {Error} se `centavos` não for um número inteiro.
 */
export function formatCentavosParaReais(centavos: number): string {
  if (!Number.isInteger(centavos)) {
    throw new Error(
      `formatCentavosParaReais: esperava um inteiro em centavos, recebeu ${centavos}`,
    );
  }

  const negativo = centavos < 0;
  const centavosAbs = Math.abs(centavos);

  const reais = Math.trunc(centavosAbs / 100);
  const centavosParte = centavosAbs % 100;

  const reaisFormatado = formatMilhar(reais);
  const centavosFormatado = String(centavosParte).padStart(2, "0");

  const valorFormatado = `R$ ${reaisFormatado},${centavosFormatado}`;

  return negativo ? `-${valorFormatado}` : valorFormatado;
}

/** Insere separador de milhar `.` num inteiro não-negativo. */
function formatMilhar(inteiroNaoNegativo: number): string {
  return inteiroNaoNegativo
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * Aplica um percentual em pontos-base (bps, 1/100 de p.p. — research.md
 * R4: `10000 bps === 100%`) a um valor em centavos, em aritmética
 * inteira: `bps * valorCentavos / 10000`.
 *
 * Política de resto: divisão inteira TRUNCADA em direção a zero (ou seja,
 * para valores/bps não-negativos, equivale a `Math.floor`). O resto
 * descartado nunca é "perdido" silenciosamente no motor: é o próprio
 * mecanismo de transbordo/arredondamento da seção 5 que absorve
 * diferenças de centavo ao final da divisão do aporte — este helper só
 * calcula a fatia bruta de cada alvo.
 */
export function aplicarBps(valorCentavos: number, bps: number): number {
  return Math.trunc((bps * valorCentavos) / 10000);
}

/**
 * Formata um valor em bps como percentual no padrão brasileiro:
 * `1250` → "12,50%", `150` → "1,50%" (banda de tolerância padrão).
 */
export function formatBps(bps: number): string {
  if (!Number.isInteger(bps)) {
    throw new Error(`formatBps: esperava um inteiro em bps, recebeu ${bps}`);
  }

  const negativo = bps < 0;
  const bpsAbs = Math.abs(bps);

  const parteInteira = Math.trunc(bpsAbs / 100);
  const parteDecimal = bpsAbs % 100;

  const valorFormatado = `${parteInteira},${String(parteDecimal).padStart(2, "0")}%`;

  return negativo ? `-${valorFormatado}` : valorFormatado;
}
