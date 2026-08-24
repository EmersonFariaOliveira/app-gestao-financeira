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

/**
 * Variante de `periodo()` que também controla `pontoInicio.valorInvestidoCentavos`
 * e `pontoFim.valorAtualCentavos` — usada pelos testes das colunas "Valor
 * investido"/"Valor atual" (que `periodo()` sempre zera/nula de propósito, já
 * que os outros testes deste arquivo não olham para essas colunas).
 */
function periodoComValores({
  rendimentoCentavos,
  rendimentoPct,
  valorInvestidoCentavos,
  valorAtualCentavos,
}: {
  rendimentoCentavos: number | null;
  rendimentoPct: number | null;
  valorInvestidoCentavos: number | null;
  valorAtualCentavos: number;
}): RendimentoPeriodo {
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
      valorAtualCentavos,
      valorInvestidoCentavos,
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
  foraDaCarteiraTotal: periodo(100_00, 11),
  pendentesTotal: periodo(-5_00, -1),
  carteiraAlvoTotal: periodo(35_00, 4),
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

  it("clicar no cabeçalho 'Rendimento no período' inverte a ordem (ascendente: menor ganho primeiro)", async () => {
    await renderPagina();

    const tabela = screen.getByText("FORA-MAIOR").closest("table")!;
    const cabecalho = within(tabela).getByText("Rendimento no período");
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

describe("RendimentoPage — 'Reserva de emergência' (tabela sempre visível, mesmo padrão das demais seções)", () => {
  it("com itens: a tabela já aparece sem precisar clicar em nada", async () => {
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, reservaEmergenciaItens: RESERVA_ITENS },
    });
    await renderPagina();

    expect(screen.getByText("RESERVA-CDB")).toBeTruthy();
    expect(screen.getByText("RESERVA-TESOURO")).toBeTruthy();
  });

  it("sem itens (reservaEmergenciaItens: []): mostra mensagem de vazio sem quebrar", async () => {
    // DADOS_BASE já tem reservaEmergenciaItens: [] — cobre o caso default.
    await renderPagina();

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

  it("clicar em 'Rendimento no período' reordena as tags E os alvos dentro do grupo expandido pelo mesmo critério (ascendente); clicar de novo volta a descendente", async () => {
    await renderComDadosDeOrdenacao();

    const cabecalho = within(tabelaDeTags()).getByText("Rendimento no período");
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

});

/**
 * `BarraResumoBucket` (faixa de resumo full-width dentro do `CardContent`,
 * entre a descrição e a tabela/conteúdo seguinte) do card cujo título é o
 * informado — usada por TODOS os cards de resumo da tela, incluindo o
 * consolidado do topo (que não tem mais nada no `CardAction`, mesmo padrão
 * dos outros 4 buckets).
 */
function barraResumoDaSecao(titulo: string): HTMLElement {
  const card = screen.getByText(titulo).closest('[data-slot="card"]');
  if (!card) throw new Error(`Card da seção "${titulo}" não encontrado`);
  const barra = (card as HTMLElement).querySelector('[data-slot="barra-resumo-bucket"]');
  if (!barra) throw new Error(`BarraResumoBucket da seção "${titulo}" não encontrado`);
  return barra as HTMLElement;
}

describe("RendimentoPage — BarraResumoBucket de cada seção usa o campo agregado certo (não confunde bucket)", () => {
  // DADOS_BASE já usa um valor DISTINTO por bucket de propósito (1_00,
  // 35_00, 100_00, -5_00) — só assim um teste pega, por exemplo, o cabeçalho
  // de "fora da carteira" mostrando por engano `pendentesTotal`. Cada
  // cabeçalho agora tem DOIS selos ("Rendimento total" + "No período"), e
  // `periodo()` iguala `pontoFim.rendimentoCentavos` ao valor do período —
  // por isso o valor pode aparecer duas vezes no mesmo `CardAction`
  // (`getAllByText` em vez de `getByText`).
  it("'Reserva de emergência' mostra o total de dados.reservaEmergencia (R$ 1,00)", async () => {
    await renderPagina();
    const barra = barraResumoDaSecao("Reserva de emergência");
    expect(within(barra).getAllByText("R$ 1,00").length).toBeGreaterThan(0);
  });

  it("'Rendimento por tag e por alvo' mostra o total de dados.carteiraAlvoTotal (R$ 35,00)", async () => {
    await renderPagina();
    const barra = barraResumoDaSecao("Rendimento por tag e por alvo");
    expect(within(barra).getAllByText("R$ 35,00").length).toBeGreaterThan(0);
  });

  it("'Ativos fora da carteira alvo' mostra o total de dados.foraDaCarteiraTotal (R$ 100,00)", async () => {
    await renderPagina();
    const barra = barraResumoDaSecao("Ativos fora da carteira alvo");
    expect(within(barra).getAllByText("R$ 100,00").length).toBeGreaterThan(0);
  });

  it("'Pendentes de vínculo' mostra o total de dados.pendentesTotal (-R$ 5,00)", async () => {
    await renderPagina();
    const barra = barraResumoDaSecao("Pendentes de vínculo");
    expect(within(barra).getAllByText("-R$ 5,00").length).toBeGreaterThan(0);
  });
});

describe("RendimentoPage — CardConsolidado (topo da página)", () => {
  // Rendimento acumulado (pontoFim.rendimentoCentavos) DIFERENTE do
  // rendimento do período selecionado (delta pontoInicio -> pontoFim) —
  // mesmo cenário real das outras seções: o patrimônio total já tinha ganho
  // acumulado antes do início do período, então os dois números da
  // `BarraResumoBucket` ("Rendimento total" e "No período selecionado") não
  // podem coincidir por acaso no teste.
  const CONSOLIDADO_TOTAL_DIFERENTE = periodo(20_00, 2);
  CONSOLIDADO_TOTAL_DIFERENTE.pontoFim.rendimentoCentavos = 999_00;
  CONSOLIDADO_TOTAL_DIFERENTE.pontoFim.rendimentoPct = 99;

  it("com período anterior disponível: usa a mesma BarraResumoBucket dos outros buckets, com 'Rendimento total' (pontoFim) diferente de 'No período selecionado'", async () => {
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: {
        ...DADOS_BASE,
        consolidado: CONSOLIDADO_TOTAL_DIFERENTE,
        semPeriodoAnteriorParaComparacao: false,
      },
    });
    await renderPagina();

    const barra = barraResumoDaSecao("Rendimento do patrimônio total");
    expect(within(barra).getByText("Rendimento total")).toBeTruthy();
    expect(within(barra).getByText("No período selecionado")).toBeTruthy();
    // "Rendimento total" (acumulado, pontoFim.rendimentoCentavos = 999_00).
    expect(within(barra).getByText("R$ 999,00")).toBeTruthy();
    // "No período selecionado" (consolidado.rendimentoCentavos = 20_00) — diferente do total.
    expect(within(barra).getByText("R$ 20,00")).toBeTruthy();

    // O card consolidado não tem mais nada no CardAction — mesmo padrão dos outros 4 buckets.
    const card = screen.getByText("Rendimento do patrimônio total").closest('[data-slot="card"]') as HTMLElement;
    expect(card.querySelector('[data-slot="card-action"]')).toBeNull();
  });

  it("sem período anterior para comparação: os dois números da BarraResumoBucket coincidem e a nota explicativa aparece", async () => {
    const CONSOLIDADO_UNICA_SESSAO = periodo(20_00, 2);
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: {
        ...DADOS_BASE,
        consolidado: CONSOLIDADO_UNICA_SESSAO,
        semPeriodoAnteriorParaComparacao: true,
      },
    });
    await renderPagina();

    const barra = barraResumoDaSecao("Rendimento do patrimônio total");
    expect(within(barra).getByText("Rendimento total")).toBeTruthy();
    expect(within(barra).getByText("No período selecionado")).toBeTruthy();
    // Os dois grupos mostram o MESMO valor (única sessão disponível).
    expect(within(barra).getAllByText("R$ 20,00").length).toBe(2);

    expect(
      screen.getByText(
        /ainda não há período anterior para comparação — os dois números acima\s*coincidem/,
      ),
    ).toBeTruthy();
  });

  it("mostra os novos textos: título e descrição explicando os dois números do resumo", async () => {
    await renderPagina();

    expect(screen.getByText("Rendimento do patrimônio total")).toBeTruthy();
    expect(
      screen.getByText(/o resumo abaixo mostra o rendimento total acumulado/),
    ).toBeTruthy();
  });
});

describe("RendimentoPage — colunas 'Valor investido'/'Valor atual'", () => {
  const ITEM_COM_HISTORICO: RendimentoAtivoForaDaCarteira = {
    chaveExport: "VAL-COM-HISTORICO",
    rendimento: periodoComValores({
      rendimentoCentavos: 10_000_00,
      rendimentoPct: 20,
      valorInvestidoCentavos: 50_000_00,
      valorAtualCentavos: 60_000_00,
    }),
  };

  const ITEM_SEM_HISTORICO: RendimentoAtivoForaDaCarteira = {
    chaveExport: "VAL-SEM-HISTORICO",
    rendimento: periodoComValores({
      rendimentoCentavos: 1_00,
      rendimentoPct: 1,
      valorInvestidoCentavos: null,
      valorAtualCentavos: 123_45,
    }),
  };

  async function renderComItensDeValor() {
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, foraDaCarteira: [ITEM_COM_HISTORICO, ITEM_SEM_HISTORICO] },
    });
    render(<RendimentoPage />);
    await screen.findByText("Rendimento por tag e por alvo");
  }

  it("mostra 'Valor investido' e 'Valor atual' com os valores certos de pontoInicio/pontoFim", async () => {
    await renderComItensDeValor();

    const linha = screen.getByText("VAL-COM-HISTORICO").closest("tr")!;
    expect(within(linha).getByText("R$ 50.000,00")).toBeTruthy();
    expect(within(linha).getByText("R$ 60.000,00")).toBeTruthy();
  });

  it("valorInvestidoCentavos: null mostra 'sem histórico' na coluna 'Valor investido' em vez de um número", async () => {
    await renderComItensDeValor();

    const linha = screen.getByText("VAL-SEM-HISTORICO").closest("tr")!;
    expect(within(linha).getByText("sem histórico")).toBeTruthy();
    // A coluna "Valor atual" continua mostrando o número normalmente — só
    // "Valor investido" fica nulo neste fixture.
    expect(within(linha).getByText("R$ 123,45")).toBeTruthy();
  });
});

describe("RendimentoPage — coluna 'Rendimento total' (pontoFim.rendimentoCentavos, acumulado, independente do período)", () => {
  // Rendimento total (acumulado, pontoFim.rendimentoCentavos) DIFERENTE do
  // rendimento no período (delta pontoInicio -> pontoFim) — cenário real que
  // motivou a mudança: um ativo já tinha ganho acumulado antes do início do
  // período selecionado, então os dois números não podem ser iguais.
  const ITEM_TOTAL_DIFERENTE_DO_PERIODO: RendimentoAtivoForaDaCarteira = {
    chaveExport: "TOTAL-DIFERENTE",
    rendimento: periodoComValores({
      rendimentoCentavos: 20_00, // rendimento NO PERÍODO (delta início->fim)
      rendimentoPct: 2,
      valorInvestidoCentavos: 100_00,
      valorAtualCentavos: 150_00,
    }),
  };
  // `periodoComValores` sempre iguala `pontoFim.rendimentoCentavos` ao
  // rendimento do período recebido — sobrescrevemos aqui para simular o
  // caso real (rendimento acumulado maior que o delta do período).
  ITEM_TOTAL_DIFERENTE_DO_PERIODO.rendimento.pontoFim.rendimentoCentavos = 999_00;

  const ITEM_TOTAL_NULO: RendimentoAtivoForaDaCarteira = {
    chaveExport: "TOTAL-NULO",
    rendimento: periodoComValores({
      rendimentoCentavos: 5_00,
      rendimentoPct: 1,
      valorInvestidoCentavos: 10_00,
      valorAtualCentavos: 15_00,
    }),
  };
  ITEM_TOTAL_NULO.rendimento.pontoFim.rendimentoCentavos = null;

  it("tabela reutilizada (fora da carteira/pendentes/reserva de emergência): 'Rendimento total' mostra pontoFim.rendimentoCentavos, diferente de 'Rendimento no período'", async () => {
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, foraDaCarteira: [ITEM_TOTAL_DIFERENTE_DO_PERIODO] },
    });
    render(<RendimentoPage />);
    await screen.findByText("Rendimento por tag e por alvo");

    const linha = screen.getByText("TOTAL-DIFERENTE").closest("tr")!;
    // Rendimento total (acumulado) = R$ 999,00.
    expect(within(linha).getByText("R$ 999,00")).toBeTruthy();
    // Rendimento no período (delta) = R$ 20,00 — número diferente, mesma linha.
    expect(within(linha).getByText("R$ 20,00")).toBeTruthy();
  });

  it("tabela reutilizada: pontoFim.rendimentoCentavos null mostra 'sem histórico' na coluna 'Rendimento total', mesmo com 'Rendimento no período' preenchido", async () => {
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, foraDaCarteira: [ITEM_TOTAL_NULO] },
    });
    render(<RendimentoPage />);
    await screen.findByText("Rendimento por tag e por alvo");

    const linha = screen.getByText("TOTAL-NULO").closest("tr")!;
    expect(within(linha).getByText("sem histórico")).toBeTruthy();
    // "Rendimento no período" continua mostrando o número normalmente.
    expect(within(linha).getByText("R$ 5,00")).toBeTruthy();
  });

  it("tabela 'por tag e por alvo': linha de tag mostra 'Rendimento total' (pontoFim.rendimentoCentavos) diferente de 'Rendimento no período', e a coluna aparece mesmo sem interação (sempre visível)", async () => {
    const PORTAG_TOTAL: RendimentoPorTag[] = [
      { tag: "A-AÇÕES", rendimento: periodoComValores({
        rendimentoCentavos: 30_00,
        rendimentoPct: 3,
        valorInvestidoCentavos: 100_00,
        valorAtualCentavos: 130_00,
      }) },
    ];
    PORTAG_TOTAL[0].rendimento.pontoFim.rendimentoCentavos = 777_00;

    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, porTag: PORTAG_TOTAL, porAlvo: [] },
    });
    render(<RendimentoPage />);
    await screen.findByText("Rendimento por tag e por alvo");

    const linhaTag = screen.getByRole("button", { name: /A-AÇÕES/i }).closest("tr")!;
    expect(within(linhaTag).getByText("R$ 777,00")).toBeTruthy();
    expect(within(linhaTag).getByText("R$ 30,00")).toBeTruthy();
  });

  it("tabela 'por tag e por alvo': sub-linha de alvo mostra 'Rendimento total' (pontoFim.rendimentoCentavos) do alvo, independente do período selecionado", async () => {
    const PORALVO_TOTAL: RendimentoPorAlvo[] = [
      {
        alvoId: "alvo-total",
        nomeAlvo: "Alvo Total",
        tag: "A-AÇÕES",
        rendimento: periodoComValores({
          rendimentoCentavos: 15_00,
          rendimentoPct: 1,
          valorInvestidoCentavos: 500_00,
          valorAtualCentavos: 515_00,
        }),
      },
    ];
    PORALVO_TOTAL[0].rendimento.pontoFim.rendimentoCentavos = 300_00;

    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: {
        ...DADOS_BASE,
        porTag: [{ tag: "A-AÇÕES", rendimento: periodo(50_00, 5) }],
        porAlvo: PORALVO_TOTAL,
      },
    });
    render(<RendimentoPage />);
    await screen.findByText("Rendimento por tag e por alvo");

    const linhaAlvo = screen.getByText("Alvo Total").closest("tr")!;
    expect(within(linhaAlvo).getByText("R$ 300,00")).toBeTruthy();
    expect(within(linhaAlvo).getByText("R$ 15,00")).toBeTruthy();
  });
});

describe("RendimentoPage — 'Reserva de emergência' não tem mais o toggle 'Ver ativos' (substituído pela tabela sempre visível)", () => {
  it("não existe nenhum botão 'Ver ativos' na tela, mesmo com itens na reserva", async () => {
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, reservaEmergenciaItens: RESERVA_ITENS },
    });
    await renderPagina();

    expect(screen.queryByRole("button", { name: /ver ativos/i })).toBeNull();
  });
});

describe("RendimentoPage — BarraResumoBucket: colapso da mensagem 'sem histórico suficiente' quando os DOIS grupos são null", () => {
  it("bucket totalmente vazio (Pendentes de vínculo com totalCentavos E periodoCentavos null): a mensagem aparece exatamente UMA vez na barra, não duas", async () => {
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, pendentesTotal: periodo(null, null) },
    });
    await renderPagina();

    const barra = barraResumoDaSecao("Pendentes de vínculo");
    expect(within(barra).getAllByText("sem histórico suficiente")).toHaveLength(1);
    // Os rótulos individuais de cada grupo não aparecem — a mensagem colapsada os substitui.
    expect(within(barra).queryByText("Rendimento total")).toBeNull();
    expect(within(barra).queryByText("No período selecionado")).toBeNull();
  });

  it("apenas um dos dois é null (periodoCentavos null, totalCentavos preenchido): cada grupo mantém comportamento individual — sem a mensagem colapsada, só o grupo 'No período selecionado' mostra 'sem histórico'", async () => {
    const totalMisto = periodo(50_00, 5);
    totalMisto.rendimentoCentavos = null;
    totalMisto.rendimentoPct = null;
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, pendentesTotal: totalMisto },
    });
    await renderPagina();

    const barra = barraResumoDaSecao("Pendentes de vínculo");
    // Grupo "Rendimento total" (pontoFim) preenchido normalmente.
    expect(within(barra).getByText("Rendimento total")).toBeTruthy();
    expect(within(barra).getByText("R$ 50,00")).toBeTruthy();
    // Grupo "No período selecionado" individualmente mostra sua própria nota — sem duplicar/colapsar a barra inteira.
    expect(within(barra).getByText("No período selecionado")).toBeTruthy();
    expect(within(barra).getByText("sem histórico")).toBeTruthy();
    expect(within(barra).queryByText("sem histórico suficiente")).toBeNull();
  });

  it("cenário normal (nenhum dos dois é null): os dois grupos aparecem com seus próprios valores, sem a mensagem 'sem histórico suficiente'", async () => {
    await renderPagina();

    const barra = barraResumoDaSecao("Pendentes de vínculo");
    expect(within(barra).queryByText("sem histórico suficiente")).toBeNull();
    expect(within(barra).getByText("Rendimento total")).toBeTruthy();
    expect(within(barra).getByText("No período selecionado")).toBeTruthy();
    // DADOS_BASE.pendentesTotal = periodo(-5_00, -1) — mesmo valor usado nos dois grupos (pontoFim == período).
    expect(within(barra).getAllByText("-R$ 5,00").length).toBeGreaterThan(0);
  });
});

describe("RendimentoPage — coluna 'Rendimento total': percentual (pontoFim.rendimentoPct) exibido ao lado do valor, independente do percentual do período", () => {
  // pontoFim.rendimentoPct (45%) DIFERENTE de rendimentoPct do período (2%) —
  // só assim o teste comprova que os dois badges de percentual são
  // independentes (mesmo padrão de "cenário real" já usado para os centavos).
  function itemComPctDiferente(chaveExport: string): RendimentoAtivoForaDaCarteira {
    const rendimento = periodoComValores({
      rendimentoCentavos: 20_00,
      rendimentoPct: 2,
      valorInvestidoCentavos: 100_00,
      valorAtualCentavos: 150_00,
    });
    rendimento.pontoFim.rendimentoCentavos = 999_00;
    rendimento.pontoFim.rendimentoPct = 45;
    return { chaveExport, rendimento };
  }

  it("tabela reutilizada (fora da carteira/pendentes/reserva de emergência): 'Rendimento total' mostra o percentual de pontoFim (45,00%), diferente do percentual de 'Rendimento no período' (2,00%)", async () => {
    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, foraDaCarteira: [itemComPctDiferente("PCT-DIFERENTE")] },
    });
    render(<RendimentoPage />);
    await screen.findByText("Rendimento por tag e por alvo");

    const linha = screen.getByText("PCT-DIFERENTE").closest("tr")!;
    expect(within(linha).getByText("R$ 999,00")).toBeTruthy();
    expect(within(linha).getByText("45,00%")).toBeTruthy();
    expect(within(linha).getByText("R$ 20,00")).toBeTruthy();
    expect(within(linha).getByText("2,00%")).toBeTruthy();
  });

  it("tabela 'por tag e por alvo': linha de tag mostra o percentual de 'Rendimento total' (pontoFim.rendimentoPct) ao lado do valor, diferente do percentual de 'Rendimento no período'", async () => {
    const rendimentoTag = periodoComValores({
      rendimentoCentavos: 20_00,
      rendimentoPct: 2,
      valorInvestidoCentavos: 100_00,
      valorAtualCentavos: 150_00,
    });
    rendimentoTag.pontoFim.rendimentoCentavos = 999_00;
    rendimentoTag.pontoFim.rendimentoPct = 45;

    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: { ...DADOS_BASE, porTag: [{ tag: "A-AÇÕES", rendimento: rendimentoTag }], porAlvo: [] },
    });
    render(<RendimentoPage />);
    await screen.findByText("Rendimento por tag e por alvo");

    const linhaTag = screen.getByRole("button", { name: /A-AÇÕES/i }).closest("tr")!;
    expect(within(linhaTag).getByText("R$ 999,00")).toBeTruthy();
    expect(within(linhaTag).getByText("45,00%")).toBeTruthy();
    expect(within(linhaTag).getByText("R$ 20,00")).toBeTruthy();
    expect(within(linhaTag).getByText("2,00%")).toBeTruthy();
  });

  it("tabela 'por tag e por alvo': sub-linha de alvo mostra o percentual de 'Rendimento total' (pontoFim.rendimentoPct) do alvo, independente do percentual do período selecionado", async () => {
    const rendimentoAlvo = periodoComValores({
      rendimentoCentavos: 20_00,
      rendimentoPct: 2,
      valorInvestidoCentavos: 100_00,
      valorAtualCentavos: 150_00,
    });
    rendimentoAlvo.pontoFim.rendimentoCentavos = 999_00;
    rendimentoAlvo.pontoFim.rendimentoPct = 45;

    dadosRendimentoMock.mockResolvedValue({
      ok: true,
      data: {
        ...DADOS_BASE,
        porTag: [{ tag: "A-AÇÕES", rendimento: periodo(50_00, 5) }],
        porAlvo: [{ alvoId: "alvo-pct", nomeAlvo: "Alvo Pct", tag: "A-AÇÕES", rendimento: rendimentoAlvo }],
      },
    });
    render(<RendimentoPage />);
    await screen.findByText("Rendimento por tag e por alvo");

    const linhaAlvo = screen.getByText("Alvo Pct").closest("tr")!;
    expect(within(linhaAlvo).getByText("R$ 999,00")).toBeTruthy();
    expect(within(linhaAlvo).getByText("45,00%")).toBeTruthy();
    expect(within(linhaAlvo).getByText("R$ 20,00")).toBeTruthy();
    expect(within(linhaAlvo).getByText("2,00%")).toBeTruthy();
  });
});

describe("RendimentoPage — rótulos de resumo (label acima do valor R$+%): mesma BarraResumoBucket no consolidado (topo) e nos 4 buckets", () => {
  // DADOS_BASE já traz `semPeriodoAnteriorParaComparacao: false`. Todos os 5
  // cards de resumo da tela (consolidado + os 4 buckets) usam a MESMA
  // `BarraResumoBucket` dentro do `CardContent` — nenhum tem nada no
  // `CardAction`.
  it("nenhum dos 5 cards de resumo (consolidado + os 4 buckets) tem nada no CardAction — os selos vivem todos na BarraResumoBucket", async () => {
    await renderPagina();

    for (const titulo of [
      "Rendimento do patrimônio total",
      "Reserva de emergência",
      "Ativos fora da carteira alvo",
      "Pendentes de vínculo",
    ]) {
      const card = screen.getByText(titulo).closest('[data-slot="card"]') as HTMLElement;
      expect(card.querySelector('[data-slot="card-action"]')).toBeNull();
    }
  });

  it("a BarraResumoBucket do consolidado (topo) e dos 4 buckets de período mostra os dois rótulos 'Rendimento total' e 'No período selecionado'", async () => {
    await renderPagina();

    for (const titulo of [
      "Rendimento do patrimônio total",
      "Reserva de emergência",
      "Rendimento por tag e por alvo",
      "Ativos fora da carteira alvo",
      "Pendentes de vínculo",
    ]) {
      const barra = barraResumoDaSecao(titulo);
      expect(within(barra).getByText("Rendimento total")).toBeTruthy();
      expect(within(barra).getByText("No período selecionado")).toBeTruthy();
    }
  });
});

describe("RendimentoPage — larguras de coluna consistentes entre 'por tag e por alvo' (LinhaGrupoTag) e as tabelas reutilizadas (TabelaRendimentoPorAtivo)", () => {
  // A primeira coluna de `LinhaGrupoTag` ("Tag / alvo") carrega um ícone de
  // expandir + rótulo/bolinha de cor que a coluna "Ativo" das tabelas planas
  // não tem — sem uma largura fixa e IDÊNTICA nas duas tabelas, essa
  // decoração extra empurraria as colunas numéricas mais para a direita só
  // na tabela de tags, desalinhando "Valor investido"/"Valor atual"/
  // "Rendimento total"/"Rendimento no período" entre os cards da página.
  // Este teste não valida pixels — só que a MESMA classe utilitária de
  // largura (`className` do `TableHead`) é aplicada nos dois lugares, o que
  // já garante a largura computada idêntica (Tailwind = mesma classe = mesmo
  // CSS).
  it("cabeçalhos das colunas numéricas têm a MESMA className na tabela de tags e na tabela reutilizada (Pendentes de vínculo)", async () => {
    await renderPagina();

    const tabelaTags = screen.getByText("Tag / alvo").closest("table")!;
    const tabelaPendentes = screen.getByText("PEND-1").closest("table")!;

    // `SortableTableHead` (rótulo/"Rendimento no período") envolve o texto
    // num `<button>` interno — sempre subimos até o `<th>` real para pegar a
    // className de largura, nunca a do texto/botão clicável.
    const colunasTags = {
      rotulo: within(tabelaTags).getByText("Tag / alvo").closest("th")!,
      valorInvestido: within(tabelaTags).getByText("Valor investido").closest("th")!,
      valorAtual: within(tabelaTags).getByText("Valor atual").closest("th")!,
      rendimentoTotal: within(tabelaTags).getByText("Rendimento total").closest("th")!,
      rendimentoPeriodo: within(tabelaTags).getByText("Rendimento no período").closest("th")!,
    };
    const colunasPendentes = {
      rotulo: within(tabelaPendentes).getByText("Ativo").closest("th")!,
      valorInvestido: within(tabelaPendentes).getByText("Valor investido").closest("th")!,
      valorAtual: within(tabelaPendentes).getByText("Valor atual").closest("th")!,
      rendimentoTotal: within(tabelaPendentes).getByText("Rendimento total").closest("th")!,
      rendimentoPeriodo: within(tabelaPendentes).getByText("Rendimento no período").closest("th")!,
    };

    for (const chave of Object.keys(colunasTags) as Array<keyof typeof colunasTags>) {
      expect(colunasPendentes[chave].className).toBe(colunasTags[chave].className);
    }
  });

  it("a sub-linha de alvo (indentada, dentro de uma tag expandida) usa a MESMA className de largura da primeira coluna que a linha de tag e a coluna 'Ativo' das tabelas reutilizadas", async () => {
    await renderPagina();

    const tabelaTags = screen.getByText("Tag / alvo").closest("table")!;
    const linhaTag = within(tabelaTags).getByRole("button", { name: /A-AÇÕES/i }).closest("td")!;
    // Sub-linha de alvo: célula de rótulo (texto puro, sem botão) do primeiro alvo visível.
    const linhaAlvo = screen.getByText("Ação 1").closest("td")!;

    const tabelaPendentes = screen.getByText("PEND-1").closest("table")!;
    const colunaAtivo = within(tabelaPendentes).getByText("Ativo").closest("th")!;

    // Todas as três compartilham a mesma classe base de largura (`w-64
    // min-w-64`, `COL_ROTULO`) — cada uma pode ter classes extras próprias
    // (padding, indentação, etc.), então checamos que a largura fixa está
    // presente nas três, não que as classNames inteiras são idênticas.
    for (const celula of [linhaTag, linhaAlvo, colunaAtivo]) {
      expect(celula.className).toContain("w-64");
      expect(celula.className).toContain("min-w-64");
    }
  });
});
