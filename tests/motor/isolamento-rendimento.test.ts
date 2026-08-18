/**
 * tests/motor/isolamento-rendimento.test.ts — invariante estrutural exigida
 * pela feature 003 (Análise de Rendimento da Carteira): o novo dado
 * `patrimonio_investido_centavos`/`MovimentacaoNaoExplicada` (documentado em
 * `src/services/rendimento-service.ts`) NUNCA deve vazar para
 * `src/core/motor/**` — o motor de aporte é lógica pura (déficit, fila,
 * divisão, transbordo, mínimo, arredondamento por lote B3, dividendos da
 * seção 5.1 de docs/app-gestao-aportes.md) e não conhece rendimento nem
 * valor investido (CLAUDE.md: "motor não faz I/O"; feature 003 não deveria
 * ter alterado `src/core/motor/**` em nenhuma hipótese).
 *
 * Checagem estática (grep de texto-fonte) em vez de um teste de
 * comportamento: qualquer PR futuro que acidentalmente adicione um desses
 * termos a `EntradaMotor`/`ResultadoMotor`/qualquer arquivo do motor quebra
 * este teste imediatamente, sem depender de nenhum cenário de execução
 * específico.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MOTOR_DIR = join(__dirname, "..", "..", "src", "core", "motor");

const TERMOS_PROIBIDOS = [
  "patrimonio_investido_centavos",
  "patrimonioInvestidoCentavos",
  "valorInvestidoCentavos",
  "MovimentacaoNaoExplicada",
  "movimentacaoNaoExplicada",
  "movimentacoesNaoExplicadas",
  "rendimentoCentavos",
  "rendimentoPct",
  "RendimentoPeriodo",
  "RendimentoPonto",
];

function arquivosDoMotor(): string[] {
  return readdirSync(MOTOR_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(MOTOR_DIR, f));
}

describe("isolamento estrutural motor x rendimento (feature 003)", () => {
  it("nenhum arquivo de src/core/motor/** contém termos do domínio de rendimento/valor investido", () => {
    for (const caminho of arquivosDoMotor()) {
      const conteudo = readFileSync(caminho, "utf-8");
      for (const termo of TERMOS_PROIBIDOS) {
        expect(
          conteudo.includes(termo),
          `${caminho} não deveria conter o termo "${termo}" (domínio de rendimento, fora do motor)`,
        ).toBe(false);
      }
    }
  });

  it("src/core/motor/** não importa nada de src/services/** nem de @/services (motor é lógica pura, zero I/O)", () => {
    for (const caminho of arquivosDoMotor()) {
      const conteudo = readFileSync(caminho, "utf-8");
      expect(
        /from\s+["'](@\/services|\.\.\/\.\.\/services|prisma)/.test(conteudo),
        `${caminho} não deveria importar de services/prisma (motor é lógica pura, CLAUDE.md)`,
      ).toBe(false);
    }
  });
});
