// @vitest-environment jsdom
/**
 * tests/app/rendimento-page.test.tsx — cobre as interações novas introduzidas
 * pelo redesenho de UX de `src/app/rendimento/page.tsx` (tela "Análise de
 * rendimento"): expandir/recolher uma linha de tag, o botão "Expandir
 * tudo"/"Recolher tudo", a ordenação por coluna das tabelas planas, e o
 * isolamento entre os buckets "Ativos fora da carteira alvo" e "Pendentes de
 * vínculo" (nunca somados, nunca misturados — FR-007/FR-009/FR-017).
 *
 * Nenhuma regra de cálculo é exercitada aqui: `src/services/rendimento-service.ts`
 * é MOCKADO por trás de `@/app/actions/rendimento` (mesma regra de camadas do
 * resto da suíte — "UI não acessa banco nem calcula", CLAUDE.md). Este
 * arquivo só garante que a apresentação reage certo a um `RendimentoOutput`
 * já pronto.
 *
 * Ambiente jsdom (docblock acima) só para este arquivo — o resto da suíte
 * roda em "node" (ver vitest.config.ts, mesmo padrão de
 * tests/hooks/use-sortable-rows.test.ts). `dados.serie` é mantida com menos
 * de 2 pontos de propósito, para nunca acionar o Recharts (que depende de
 * ResizeObserver/layout, ausente em jsdom) — o gráfico em si é
 * responsabilidade de `grafico-evolucao.tsx`, fora de escopo aqui.
 *
 * Sem `@testing-library/jest-dom` no projeto (não é dependência instalada) —
 * asserções usam Chai puro (`getBy*`/`queryBy*` já lançam/retornam null
 * sozinhos, então não precisamos de `toBeInTheDocument`). Cleanup do DOM
 * entre testes é manual (`afterEach(cleanup)`) porque `vitest.config.ts` não
 * habilita `test.globals`, então o auto-registro de cleanup do
 * `@testing-library/react` não é acionado.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RendimentoAtivoForaDaCarteira,
  RendimentoPeriodo,
  RendimentoPorAlvo,
  RendimentoPorTag,
} from "@/services/rendimento-service";

const dadosRendimentoMock = vi.fn();

vi.mock("@/app/actions/rendimento", () => ({
  dadosRendimento: dadosRendimentoMock,
}));

const { default: RendimentoPage } = await import("@/app/rendimento/page");

function periodo(rendimentoCentavos: number | null, rendimentoPct: number | null): RendimentoPeriodo {
  return {
    sessaoInicioId: "sessao-inicio",
    sessaoFimId: "sessao-fim",
    rendimentoCentavos,
    rendimentoPct,
    pontoInicio: {
      rendimentoCentavos: null,
      rendimentoPct: null,
      valorAtualCentavos: 0,
      valorInvestidoCentavos: null,
    },
    pontoFim: {
      rendimentoCentavos,
      rendimentoPct,
      valorAtualCentavos: 0,
      valorInvestidoCentavos: null,
    },
  };
}

const PORTAG: RendimentoPorTag[] = [
  { tag: "A-AÇÕES", rendimento: periodo(30_00, 3) },
  { tag: "F-FIIS", rendimento: periodo(-10_00, -1) },
];

const PORALVO: RendimentoPorAlvo[] = [
  { alvoId: "alvo-acoes-1", nomeAlvo: "Ação 1", tag: "A-AÇÕES", rendimento: periodo(30_00, 3) },
  { alvoId: "alvo-sem-tag", nomeAlvo: "Alvo sem tag", tag: null, rendimento: periodo(5_00, 1) },
];

const FORA_DA_CARTEIRA: RendimentoAtivoForaDaCarteira[] = [
  { chaveExport: "FORA-MENOR", rendimento: periodo(10_00, 2) },
  { chaveExport: "FORA-MAIOR", rendimento: periodo(90_00, 9) },
];

const PENDENTES: RendimentoAtivoForaDaCarteira[] = [
  { chaveExport: "PEND-1", rendimento: periodo(-5_00, -1) },
];

const RESERVA_ITENS: RendimentoAtivoForaDaCarteira[] = [
  { chaveExport: "RESERVA-CDB", rendimento: periodo(2_00, 1) },
  { chaveExport: "RESERVA-TESOURO", rendimento: periodo(8_00, 4) },
];

// Dados dedicados ao teste de ordenação "tags + alvos aninhados juntos":
// valores escolhidos de propósito para que a ordem "de serviço" (como
// recebida, sem nenhuma coluna clicada) seja DIFERENTE da ordem por
// rendimento em R$/percentual — só assim um teste consegue distinguir "não
// reordenou" de "reordenou certo".
const PORTAG_ORDENACAO: RendimentoPorTag[] = [
  { tag: "A-AÇÕES", rendimento: periodo(50_00, 5) },
  { tag: "F-FIIS", rendimento: periodo(10_00, 1) },
];

const PORALVO_ORDENACAO: RendimentoPorAlvo[] = [
  { alvoId: "a1", nomeAlvo: "A1", tag: "A-AÇÕES", rendimento: periodo(5_00, 1) },
  { alvoId: "a2", nomeAlvo: "A2", tag: "A-AÇÕES", rendimento: periodo(40_00, 4) },
  { alvoId: "f1", nomeAlvo: "F1", tag: "F-FIIS", rendimento: periodo(10_00, 1) },
];

const DADOS_BASE = {
  vazio: false,
  periodo: { tipo: "3M" as const, sessaoInicioId: "sessao-inicio", sessaoFimId: "sessao-fim" },
  consolidado: periodo(20_00, 2),
  reservaEmergencia: periodo(1_00, 1),
  reservaEmergenciaItens: [] as RendimentoAtivoForaDaCarteira[],
  porTag: PORTAG,
  porAlvo: PORALVO,
  foraDaCarteira: FORA_DA_CARTEIRA,
  pendentes: PENDENTES,
  // Menos de 2 pontos = card "escolha um período mais amplo", nunca renderiza o Recharts.
  serie: [],
  periodosDisponiveis: [],
  semPeriodoAnteriorParaComparacao: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  dadosRendimentoMock.mockResolvedValue({ ok: true, data: DADOS_BASE });
});

afterEach(() => {
  cleanup();
});

async function renderPagina() {
  render(<RendimentoPage />);
  await screen.findByText("Rendimento por tag e por alvo");
}

describe("RendimentoPage — seção 'por tag e por alvo'", () => {
  it("por padrão carrega tudo expandido: os alvos de cada tag já estão visíveis sem clicar em nada", async () => {
    await renderPagina();

    expect(screen.getByText("Ação 1")).toBeTruthy();
    expect(screen.getByText("Alvo sem tag")).toBeTruthy();
  });

  it("clicar na linha de uma tag recolhe só aquela tag (aria-expanded muda, alvo some) — as outras continuam expandidas", async () => {
    await renderPagina();

    const botaoTagAcoes = screen.getByRole("button", { name: /A-AÇÕES/i });
    expect(botaoTagAcoes.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(botaoTagAcoes);

    expect(botaoTagAcoes.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Ação 1")).toBeNull();
    // O grupo "Sem tag" não é afetado pelo recolhimento de A-AÇÕES.
    expect(screen.getByText("Alvo sem tag")).toBeTruthy();

    // Clicar de novo expande de volta.
    fireEvent.click(botaoTagAcoes);
    expect(botaoTagAcoes.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Ação 1")).toBeTruthy();
  });

  it("'Recolher tudo' recolhe todos os grupos (tags + 'Sem tag') e vira 'Expandir tudo'; clicar de novo expande tudo", async () => {
    await renderPagina();

    const botaoRecolherTudo = screen.getByRole("button", { name: "Recolher tudo" });
    fireEvent.click(botaoRecolherTudo);

    expect(screen.queryByText("Ação 1")).toBeNull();
    expect(screen.queryByText("Alvo sem tag")).toBeNull();
    expect(
      screen.getByRole("button", { name: /A-AÇÕES/i }).getAttribute("aria-expanded"),
    ).toBe("false");

    const botaoExpandirTudo = screen.getByRole("button", { name: "Expandir tudo" });
    fireEvent.click(botaoExpandirTudo);

    expect(screen.getByText("Ação 1")).toBeTruthy();
    expect(screen.getByText("Alvo sem tag")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recolher tudo" })).toBeTruthy();
  });
});

describe("RendimentoPage — 'Ativos fora da carteira alvo' e 'Pendentes de vínculo' (isolamento e ordenação)", () => {
  it("os dois buckets aparecem em tabelas SEPARADAS, cada um só com seus próprios itens — nunca somados nem misturados", async () => {
    await renderPagina();

    const tabelaForaDaCarteira = within(screen.getByText("FORA-MAIOR").closest("table")!);
    expect(tabelaForaDaCarteira.getByText("FORA-MENOR")).toBeTruthy();
    expect(tabelaForaDaCarteira.queryByText("PEND-1")).toBeNull();

    const tabelaPendentes = within(screen.getByText("PEND-1").closest("table")!);
    expect(tabelaPendentes.queryByText("FORA-MAIOR")).toBeNull();
    expect(tabelaPendentes.queryByText("FORA-MENOR")).toBeNull();
  });

  it("ordem inicial de 'Ativos fora da carteira alvo' é por rendimento em R$ decrescente (maior ganho primeiro)", async () => {
    await renderPagina();

    const tabela = screen.getByText("FORA-MAIOR").closest("table")!;
    const linhas = within(tabela).getAllByRole("row").slice(1); // pula o cabeçalho
    expect(within(linhas[0]).getByText("FORA-MAIOR")).toBeTruthy();
    expect(within(linhas[1]).getByText("FORA-MENOR")).toBeTruthy();
  });

  it("clicar no cabeçalho 'Rendimento em R$' inverte a ordem (ascendente: menor ganho primeiro)", async () => {
    await renderPagina();

    const tabela = screen.getByText("FORA-MAIOR").closest("table")!;
    const cabecalho = within(tabela).getByText("Rendimento em R$");
    fireEvent.click(cabecalho);

    const linhasAsc = within(tabela).getAllByRole("row").slice(1);
    expect(within(linhasAsc[0]).getByText("FORA-MENOR")).toBeTruthy();
    expect(within(linhasAsc[1]).getByText("FORA-MAIOR")).toBeTruthy();

    // Segundo clique na mesma coluna volta a descendente (maior ganho primeiro).
    fireEvent.click(cabecalho);
    const linhasDesc = within(tabela).getAllByRole("row").slice(1);
    expect(within(linhasDesc[0]).getByText("FORA-MAIOR")).toBeTruthy();
  });
});

describe("RendimentoPage — 'Reserva de emergência' (expandir/recolher 'Ver ativos')", () => {
  it("com itens: botão mostra a contagem, tabela some por padrão, expande mostrando os itens certos e recolhe de volta", async () => {
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, reservaEmergenciaItens: RESERVA_ITENS },
    });
    await renderPagina();

    // Não expandido por padrão: os itens não aparecem no DOM.
    expect(screen.queryByText("RESERVA-CDB")).toBeNull();
    expect(screen.queryByText("RESERVA-TESOURO")).toBeNull();

    const botao = screen.getByRole("button", { name: /Ver ativos \(2\)/ });
    expect(botao.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(botao);

    expect(botao.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Ocultar ativos (2)")).toBeTruthy();
    expect(screen.getByText("RESERVA-CDB")).toBeTruthy();
    expect(screen.getByText("RESERVA-TESOURO")).toBeTruthy();

    // Recolher de novo esconde a tabela sem quebrar nada.
    fireEvent.click(botao);
    expect(botao.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("RESERVA-CDB")).toBeNull();
    expect(screen.queryByText("RESERVA-TESOURO")).toBeNull();
  });

  it("sem itens (reservaEmergenciaItens: []): botão mostra '(0)', continua clicável e mostra mensagem de vazio sem quebrar", async () => {
    // DADOS_BASE já tem reservaEmergenciaItens: [] — cobre o caso default.
    await renderPagina();

    const botao = screen.getByRole("button", { name: /Ver ativos \(0\)/ });
    expect(botao).toBeTruthy();

    fireEvent.click(botao);

    expect(botao.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Nenhum ativo marcado como reserva de emergência.")).toBeTruthy();
  });
});

describe("RendimentoPage — ordenação da tabela de tags reordena os alvos aninhados junto", () => {
  async function renderComDadosDeOrdenacao() {
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, porTag: PORTAG_ORDENACAO, porAlvo: PORALVO_ORDENACAO },
    });
    render(<RendimentoPage />);
    await screen.findByText("Rendimento por tag e por alvo");
  }

  function tabelaDeTags(): HTMLElement {
    // A tabela de tags é a única com a coluna "Tag / alvo" — as outras
    // tabelas planas ("fora da carteira"/"pendentes") usam "Ativo".
    return screen.getByText("Tag / alvo").closest("table")!;
  }

  function linhasDaTabelaTags() {
    return within(tabelaDeTags()).getAllByRole("row");
  }

  it("por padrão (nenhuma coluna clicada): tags na ordem recebida, mas os alvos dentro de cada tag já vêm ordenados por rendimento em R$ decrescente", async () => {
    await renderComDadosDeOrdenacao();

    const linhas = linhasDaTabelaTags().slice(1); // pula cabeçalho
    const textos = linhas.map((l) => l.textContent ?? "");

    const idxTagAcoes = textos.findIndex((t) => t.includes("A-AÇÕES"));
    const idxTagFiis = textos.findIndex((t) => t.includes("F-FIIS"));
    const idxA1 = textos.findIndex((t) => t.includes("A1"));
    const idxA2 = textos.findIndex((t) => t.includes("A2"));

    // Ordem de serviço preservada no nível de tag (nenhuma coluna ativa ainda).
    expect(idxTagAcoes).toBeLessThan(idxTagFiis);
    // Dentro de A-AÇÕES, os alvos já vêm por rendimento decrescente por
    // padrão (A2 = R$ 40 antes de A1 = R$ 5), independente do estado de
    // ordenação da tabela pai.
    expect(idxA2).toBeLessThan(idxA1);
  });

  it("clicar em 'Rendimento em R$' reordena as tags E os alvos dentro do grupo expandido pelo mesmo critério (ascendente); clicar de novo volta a descendente", async () => {
    await renderComDadosDeOrdenacao();

    const cabecalho = within(tabelaDeTags()).getByText("Rendimento em R$");
    fireEvent.click(cabecalho);

    let textos = linhasDaTabelaTags()
      .slice(1)
      .map((l) => l.textContent ?? "");
    let idxTagAcoes = textos.findIndex((t) => t.includes("A-AÇÕES"));
    let idxTagFiis = textos.findIndex((t) => t.includes("F-FIIS"));
    let idxA1 = textos.findIndex((t) => t.includes("A1"));
    let idxA2 = textos.findIndex((t) => t.includes("A2"));

    // Ascendente: F-FIIS (R$ 10) antes de A-AÇÕES (R$ 50) no nível de tag;
    // dentro de A-AÇÕES, A1 (R$ 5) antes de A2 (R$ 40) — MESMO critério e
    // MESMA direção aplicados aos dois níveis.
    expect(idxTagFiis).toBeLessThan(idxTagAcoes);
    expect(idxA1).toBeLessThan(idxA2);

    // Segundo clique: volta a descendente nos dois níveis.
    fireEvent.click(cabecalho);

    textos = linhasDaTabelaTags()
      .slice(1)
      .map((l) => l.textContent ?? "");
    idxTagAcoes = textos.findIndex((t) => t.includes("A-AÇÕES"));
    idxTagFiis = textos.findIndex((t) => t.includes("F-FIIS"));
    idxA1 = textos.findIndex((t) => t.includes("A1"));
    idxA2 = textos.findIndex((t) => t.includes("A2"));

    expect(idxTagAcoes).toBeLessThan(idxTagFiis);
    expect(idxA2).toBeLessThan(idxA1);
  });

  it("clicar em 'Ganho sobre capital investido' também reordena tags e alvos aninhados pelo mesmo critério (percentual)", async () => {
    await renderComDadosDeOrdenacao();

    const cabecalho = within(tabelaDeTags()).getByText("Ganho sobre capital investido");
    fireEvent.click(cabecalho);

    const textos = linhasDaTabelaTags()
      .slice(1)
      .map((l) => l.textContent ?? "");
    const idxTagAcoes = textos.findIndex((t) => t.includes("A-AÇÕES"));
    const idxTagFiis = textos.findIndex((t) => t.includes("F-FIIS"));
    const idxA1 = textos.findIndex((t) => t.includes("A1"));
    const idxA2 = textos.findIndex((t) => t.includes("A2"));

    // Ascendente por percentual: F-FIIS (1%) antes de A-AÇÕES (5%); dentro
    // de A-AÇÕES, A1 (1%) antes de A2 (4%).
    expect(idxTagFiis).toBeLessThan(idxTagAcoes);
    expect(idxA1).toBeLessThan(idxA2);
  });
});
