// @vitest-environment jsdom
/**
 * tests/app/import-page-movimentacao-ao-vivo.test.tsx — cobre o recálculo
 * REATIVO, no client, da regra "movimentação não explicada" (US4, FR-018)
 * para alvos com ajuste de fundo pendente (`preview.avaliacoesMovimentacaoAoVivo`,
 * `src/app/import/page.tsx`, useMemo `avaliacoesAoVivoQueExcedem`).
 *
 * Mesma estratégia de mock de `tests/app/rendimento-page.test.tsx`: a server
 * action `@/app/actions/import` é MOCKADA (UI não acessa banco/serviço
 * diretamente) — só a lógica de apresentação/recálculo client-side é
 * exercitada aqui. A regra pura (`avaliarMovimentacaoNaoExplicada`) já tem
 * cobertura própria em `tests/core/rendimento/movimentacao-nao-explicada.test.ts`;
 * este arquivo garante especificamente que o `useMemo` do client:
 * - cai para o valor bruto do CSV quando o campo de ajuste está vazio;
 * - cai para o mesmo fallback quando o texto digitado é inválido/incompleto
 *   (não quebra a tela nem dispara aviso incorreto);
 * - reage à digitação do usuário, mostrando/escondendo o banner conforme o
 *   valor editado cruza a tolerância.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewImportOutput } from "@/app/actions/import";

const previewImportMock = vi.fn();
const confirmarImportMock = vi.fn();

vi.mock("@/app/actions/import", () => ({
  previewImport: (...args: unknown[]) => previewImportMock(...args),
  confirmarImport: (...args: unknown[]) => confirmarImportMock(...args),
}));

const { default: ImportPage } = await import("@/app/import/page");

afterEach(() => {
  cleanup();
  previewImportMock.mockReset();
  confirmarImportMock.mockReset();
});

/** Preview mínimo, com um único alvo "Fundos" (n=1, granularidade "ativo") sob ajuste pendente. */
function previewComAlvoAoVivo(): PreviewImportOutput {
  return {
    ok: true,
    arquivos: [{ instituicao: "XP", totalCentavos: 500_000, qtdAtivos: 1, dataMaisRecente: null }],
    mesReferenciaProposto: "2026-08",
    dataExport: "2026-08-18T00:00:00.000Z",
    posicoesManuaisRevisao: [],
    ajustesRevisao: [
      {
        chaveExport: "FUNDO1",
        alvoId: "alvo-1",
        nomeAlvo: "Fundos",
        primeiraVez: false,
        valorInvestidoCentavosAnterior: 500_000,
        incrementoPendenteCentavos: 0,
        valorInvestidoCentavosSugerido: 500_000,
      },
    ],
    incrementosAmbiguosPendentes: [],
    movimentacoesNaoExplicadas: [],
    avaliacoesMovimentacaoAoVivo: [
      {
        alvoId: "alvo-1",
        nomeAlvo: "Fundos",
        granularidade: "ativo",
        chaveExport: "FUNDO1",
        valorInvestidoEsperadoCentavos: 500_000, // R$5.000,00
        houveBaseComparacao: true,
        valorRealBaseCentavos: 0, // única chave elegível, ela mesma é a ajustável
        ajustesDoAlvo: [{ chaveExport: "FUNDO1", valorCsvCentavos: 577_033 }], // R$5.770,33 (excede: >5% e >R$20)
      },
    ],
  } as PreviewImportOutput;
}

async function abrirPreview(): Promise<void> {
  previewImportMock.mockResolvedValue({ ok: true, data: previewComAlvoAoVivo() });
  render(<ImportPage />);

  const arquivo = new File(["conteudo"], "Extrato_XP.csv", { type: "text/csv" });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [arquivo] } });

  const botaoAnalisar = screen.getByRole("button", { name: "Analisar arquivos" });
  fireEvent.click(botaoAnalisar);

  await waitFor(() => {
    expect(screen.getByLabelText("Valor investido corrigido de FUNDO1")).toBeTruthy();
  });
}

describe("import/page — recálculo ao vivo de movimentação não explicada (US4)", () => {
  it("com o valor bruto pré-preenchido do CSV (excede tolerância), o banner de aviso aparece", async () => {
    await abrirPreview();
    // Pré-preenchimento inicial usa `valorInvestidoCentavosSugerido` do
    // ajustesRevisao (R$5.000,00) — NÃO excede a tolerância sozinho, então
    // simulamos o usuário limpando o campo para cair no fallback do CSV.
    const campo = screen.getByLabelText(
      "Valor investido corrigido de FUNDO1",
    ) as HTMLInputElement;
    fireEvent.change(campo, { target: { value: "" } });

    await waitFor(() => {
      expect(screen.getByText(/movimentação de valor investido não explicada/i)).toBeTruthy();
    });
    // Valor real usado no aviso é o fallback do CSV (R$5.770,33), não 0.
    expect(screen.getByText(/R\$\s?5\.770,33/)).toBeTruthy();
  });

  it("texto inválido/incompleto digitado ('12,') não quebra a tela e cai no mesmo fallback do campo vazio", async () => {
    await abrirPreview();
    const campo = screen.getByLabelText(
      "Valor investido corrigido de FUNDO1",
    ) as HTMLInputElement;

    fireEvent.change(campo, { target: { value: "12," } });

    // Não lança/quebra — a tela continua renderizando o campo normalmente,
    // com o mesmo comportamento do campo vazio (fallback pro bruto do CSV,
    // que excede a tolerância).
    await waitFor(() => {
      expect(screen.getByText(/movimentação de valor investido não explicada/i)).toBeTruthy();
    });
    expect(campo.value).toBe("12,"); // o texto digitado não é descartado da UI, só não usado no cálculo.
  });

  it("texto totalmente inválido ('abc') também cai no fallback, sem quebrar nem gerar NaN visível", async () => {
    await abrirPreview();
    const campo = screen.getByLabelText(
      "Valor investido corrigido de FUNDO1",
    ) as HTMLInputElement;

    fireEvent.change(campo, { target: { value: "abc" } });

    await waitFor(() => {
      expect(screen.getByText(/movimentação de valor investido não explicada/i)).toBeTruthy();
    });
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("usuário corrige o valor para dentro da tolerância: o banner desaparece reativamente", async () => {
    await abrirPreview();
    const campo = screen.getByLabelText(
      "Valor investido corrigido de FUNDO1",
    ) as HTMLInputElement;

    // Corrige para o valor esperado (R$5.000,00) — dentro da tolerância.
    fireEvent.change(campo, { target: { value: "5000,00" } });

    await waitFor(() => {
      expect(screen.queryByText(/movimentação de valor investido não explicada/i)).toBeNull();
    });
  });
});
