/**
 * tests/app/actions/posicoes-manuais.test.ts — testes unitários da camada de
 * server actions de src/app/actions/posicoes-manuais.ts (feature
 * 002-posicoes-manuais-ajustes, tela 6.9, contracts/server-actions.md).
 *
 * Diferente de tests/services/*.test.ts (integração contra SQLite
 * temporário): esta camada é testada com o serviço MOCKADO
 * (vi.mock("@/services/posicao-manual-service")) porque, por regra de
 * camadas (CLAUDE.md — "UI não acessa banco nem calcula"), as actions não
 * têm lógica de negócio própria — só (a) validação de shape do input vindo
 * do formulário e (b) tradução do resultado/erro do serviço para o formato
 * padrão `{ok:true,data}|{ok:false,erro}` (contracts/server-actions.md).
 *
 * Nota: não há precedente de teste dedicado para outras actions do projeto
 * (vinculos.ts, aporte.ts, import.ts etc. não têm testes próprios — a
 * cobertura delas vem indiretamente dos testes de serviço). Este arquivo é
 * o primeiro da camada de actions, criado porque src/app/actions/posicoes-
 * -manuais.ts introduz validação de input nova (ehCentavosValido, campos
 * obrigatórios, trim) que hoje não tinha NENHUM teste, nem indireto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const criarPosicaoManualMock = vi.fn();
const editarPosicaoManualMock = vi.fn();
const encerrarPosicaoManualMock = vi.fn();
const listarPosicoesManuaisAtivasMock = vi.fn();
const criarOuAtualizarAjusteMock = vi.fn();
const listarAjustesAtivosMock = vi.fn();

vi.mock("@/services/posicao-manual-service", () => ({
  criarPosicaoManual: criarPosicaoManualMock,
  editarPosicaoManual: editarPosicaoManualMock,
  encerrarPosicaoManual: encerrarPosicaoManualMock,
  listarPosicoesManuaisAtivas: listarPosicoesManuaisAtivasMock,
  criarOuAtualizarAjuste: criarOuAtualizarAjusteMock,
  listarAjustesAtivos: listarAjustesAtivosMock,
}));

const {
  criarPosicaoManual,
  editarPosicaoManual,
  encerrarPosicaoManual,
  listarPosicoesManuaisAtivas,
  criarOuAtualizarAjuste,
  listarAjustesAtivos,
} = await import("@/app/actions/posicoes-manuais");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("actions/posicoes-manuais", () => {
  describe("criarPosicaoManual", () => {
    const inputValido = {
      chaveManual: "CDB-ITAU-2029",
      instituicao: "Itaú",
      descricao: "CDB Itaú 120% CDI 2029",
      alvoId: "alvo-1",
      valorInvestidoCentavos: 500_000,
      valorAtualCentavos: 520_000,
    };

    it("delega ao serviço e retorna {ok:true, data} com input válido", async () => {
      criarPosicaoManualMock.mockResolvedValue({
        id: "pm-1",
        ...inputValido,
        ativo: true,
        tipoGrupo: "RENDA_FIXA_MANUAL",
      });

      const resultado = await criarPosicaoManual(inputValido);

      expect(criarPosicaoManualMock).toHaveBeenCalledWith(inputValido);
      expect(resultado).toEqual({
        ok: true,
        data: expect.objectContaining({ id: "pm-1" }),
      });
    });

    it("rejeita chaveManual vazia/whitespace sem chamar o serviço", async () => {
      const resultado = await criarPosicaoManual({ ...inputValido, chaveManual: "   " });

      expect(resultado.ok).toBe(false);
      if (!resultado.ok) expect(resultado.erro).toMatch(/chaveManual/);
      expect(criarPosicaoManualMock).not.toHaveBeenCalled();
    });

    it("rejeita valorInvestidoCentavos não-inteiro (float) — regra de centavos inteiros (CLAUDE.md)", async () => {
      const resultado = await criarPosicaoManual({
        ...inputValido,
        valorInvestidoCentavos: 500_000.5,
      });

      expect(resultado.ok).toBe(false);
      if (!resultado.ok) expect(resultado.erro).toMatch(/valorInvestidoCentavos/);
      expect(criarPosicaoManualMock).not.toHaveBeenCalled();
    });

    it("rejeita valorAtualCentavos negativo", async () => {
      const resultado = await criarPosicaoManual({ ...inputValido, valorAtualCentavos: -1 });

      expect(resultado.ok).toBe(false);
      expect(criarPosicaoManualMock).not.toHaveBeenCalled();
    });

    it.each([
      ["instituicao", { ...inputValido, instituicao: undefined }],
      ["descricao", { ...inputValido, descricao: undefined }],
      ["alvoId", { ...inputValido, alvoId: undefined }],
    ])("rejeita quando %s está ausente, sem chamar o serviço", async (_campo, inputInvalido) => {
      const resultado = await criarPosicaoManual(
        inputInvalido as unknown as typeof inputValido,
      );

      expect(resultado.ok).toBe(false);
      expect(criarPosicaoManualMock).not.toHaveBeenCalled();
    });

    it("traduz exceção do serviço (ex.: sem sessão VIGENTE) em {ok:false, erro} com a mesma mensagem, sem vazar stack", async () => {
      criarPosicaoManualMock.mockRejectedValue(
        new Error(
          "Nenhuma sessão de import VIGENTE encontrada — realize um import antes de calcular o aporte.",
        ),
      );

      const resultado = await criarPosicaoManual(inputValido);

      expect(resultado).toEqual({
        ok: false,
        erro: "Nenhuma sessão de import VIGENTE encontrada — realize um import antes de calcular o aporte.",
      });
    });

    it("erro não-Error do serviço vira mensagem genérica amigável, sem vazar o valor bruto", async () => {
      criarPosicaoManualMock.mockRejectedValue("boom");

      const resultado = await criarPosicaoManual(inputValido);

      expect(resultado).toEqual({
        ok: false,
        erro: "Erro inesperado ao processar a solicitação.",
      });
    });

    it("faz trim() dos campos de texto antes de delegar ao serviço", async () => {
      criarPosicaoManualMock.mockResolvedValue({ id: "pm-1" });

      await criarPosicaoManual({
        ...inputValido,
        chaveManual: "  CDB-ITAU-2029  ",
        instituicao: " Itaú ",
        descricao: "  CDB Itaú 120% CDI 2029  ",
      });

      expect(criarPosicaoManualMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chaveManual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          descricao: "CDB Itaú 120% CDI 2029",
        }),
      );
    });
  });

  describe("editarPosicaoManual", () => {
    it("rejeita posicaoManualId ausente/vazio sem chamar o serviço", async () => {
      const resultado = await editarPosicaoManual({ posicaoManualId: "" });

      expect(resultado.ok).toBe(false);
      expect(editarPosicaoManualMock).not.toHaveBeenCalled();
    });

    it("permite payload parcial (só um campo) e delega ao serviço tal como recebido", async () => {
      editarPosicaoManualMock.mockResolvedValue({ id: "pm-1", descricao: "Nova descrição" });

      const resultado = await editarPosicaoManual({
        posicaoManualId: "pm-1",
        descricao: "Nova descrição",
      });

      expect(editarPosicaoManualMock).toHaveBeenCalledWith({
        posicaoManualId: "pm-1",
        descricao: "Nova descrição",
      });
      expect(resultado.ok).toBe(true);
    });

    it("rejeita descricao vazia/whitespace quando informada — string em branco não é 'campo ausente'", async () => {
      const resultado = await editarPosicaoManual({ posicaoManualId: "pm-1", descricao: "   " });

      expect(resultado.ok).toBe(false);
      expect(editarPosicaoManualMock).not.toHaveBeenCalled();
    });

    it("rejeita instituicao vazia/whitespace quando informada", async () => {
      const resultado = await editarPosicaoManual({ posicaoManualId: "pm-1", instituicao: "" });

      expect(resultado.ok).toBe(false);
      expect(editarPosicaoManualMock).not.toHaveBeenCalled();
    });

    it("rejeita alvoId vazio/whitespace quando informado", async () => {
      const resultado = await editarPosicaoManual({ posicaoManualId: "pm-1", alvoId: "  " });

      expect(resultado.ok).toBe(false);
      expect(editarPosicaoManualMock).not.toHaveBeenCalled();
    });

    it("traduz exceção do serviço em {ok:false, erro}", async () => {
      editarPosicaoManualMock.mockRejectedValue(new Error("registro não encontrado"));

      const resultado = await editarPosicaoManual({ posicaoManualId: "pm-inexistente" });

      expect(resultado).toEqual({ ok: false, erro: "registro não encontrado" });
    });
  });

  describe("encerrarPosicaoManual", () => {
    it("rejeita posicaoManualId ausente/vazio sem chamar o serviço", async () => {
      const resultado = await encerrarPosicaoManual({ posicaoManualId: "" });

      expect(resultado.ok).toBe(false);
      expect(encerrarPosicaoManualMock).not.toHaveBeenCalled();
    });

    it("delega ao serviço e retorna {ok:true, data} com ativo:false", async () => {
      encerrarPosicaoManualMock.mockResolvedValue({ id: "pm-1", ativo: false });

      const resultado = await encerrarPosicaoManual({ posicaoManualId: "pm-1" });

      expect(encerrarPosicaoManualMock).toHaveBeenCalledWith({ posicaoManualId: "pm-1" });
      expect(resultado).toEqual({ ok: true, data: { id: "pm-1", ativo: false } });
    });

    it("traduz exceção do serviço em {ok:false, erro}", async () => {
      encerrarPosicaoManualMock.mockRejectedValue(new Error("registro não encontrado"));

      const resultado = await encerrarPosicaoManual({ posicaoManualId: "pm-inexistente" });

      expect(resultado).toEqual({ ok: false, erro: "registro não encontrado" });
    });
  });

  describe("listarPosicoesManuaisAtivas", () => {
    it("delega ao serviço e retorna {ok:true, data} com a lista", async () => {
      listarPosicoesManuaisAtivasMock.mockResolvedValue([{ id: "pm-1", ativo: true }]);

      const resultado = await listarPosicoesManuaisAtivas();

      expect(resultado).toEqual({ ok: true, data: [{ id: "pm-1", ativo: true }] });
    });

    it("traduz exceção do serviço em {ok:false, erro}", async () => {
      listarPosicoesManuaisAtivasMock.mockRejectedValue(new Error("falha ao consultar"));

      const resultado = await listarPosicoesManuaisAtivas();

      expect(resultado).toEqual({ ok: false, erro: "falha ao consultar" });
    });
  });

  // T016 (User Story 2, FR-005): criarOuAtualizarAjuste — action fina que
  // valida shape e delega ao serviço (upsert), sem regra de negócio própria.
  describe("criarOuAtualizarAjuste", () => {
    const inputValido = {
      chaveExport: "FUNDO-XPTO",
      valorInvestidoCentavosCorrigido: 300_000,
    };

    it("delega ao serviço e retorna {ok:true, data} com input válido", async () => {
      criarOuAtualizarAjusteMock.mockResolvedValue({
        chaveExport: "FUNDO-XPTO",
        valorInvestidoCentavosCorrigido: 300_000,
      });

      const resultado = await criarOuAtualizarAjuste(inputValido);

      expect(criarOuAtualizarAjusteMock).toHaveBeenCalledWith(inputValido);
      expect(resultado).toEqual({
        ok: true,
        data: { chaveExport: "FUNDO-XPTO", valorInvestidoCentavosCorrigido: 300_000 },
      });
    });

    it("rejeita chaveExport vazia/whitespace sem chamar o serviço", async () => {
      const resultado = await criarOuAtualizarAjuste({ ...inputValido, chaveExport: "   " });

      expect(resultado.ok).toBe(false);
      if (!resultado.ok) expect(resultado.erro).toMatch(/chaveExport/);
      expect(criarOuAtualizarAjusteMock).not.toHaveBeenCalled();
    });

    it("rejeita valorInvestidoCentavosCorrigido não-inteiro (float) — regra de centavos inteiros (CLAUDE.md)", async () => {
      const resultado = await criarOuAtualizarAjuste({
        ...inputValido,
        valorInvestidoCentavosCorrigido: 300_000.5,
      });

      expect(resultado.ok).toBe(false);
      if (!resultado.ok) expect(resultado.erro).toMatch(/valorInvestidoCentavosCorrigido/);
      expect(criarOuAtualizarAjusteMock).not.toHaveBeenCalled();
    });

    it("rejeita valorInvestidoCentavosCorrigido negativo", async () => {
      const resultado = await criarOuAtualizarAjuste({
        ...inputValido,
        valorInvestidoCentavosCorrigido: -1,
      });

      expect(resultado.ok).toBe(false);
      expect(criarOuAtualizarAjusteMock).not.toHaveBeenCalled();
    });

    it("faz trim() do chaveExport antes de delegar ao serviço", async () => {
      criarOuAtualizarAjusteMock.mockResolvedValue({
        chaveExport: "FUNDO-XPTO",
        valorInvestidoCentavosCorrigido: 300_000,
      });

      await criarOuAtualizarAjuste({ ...inputValido, chaveExport: "  FUNDO-XPTO  " });

      expect(criarOuAtualizarAjusteMock).toHaveBeenCalledWith(
        expect.objectContaining({ chaveExport: "FUNDO-XPTO" }),
      );
    });

    it("traduz exceção do serviço (ex.: sem sessão VIGENTE) em {ok:false, erro}, sem vazar stack", async () => {
      criarOuAtualizarAjusteMock.mockRejectedValue(
        new Error(
          "Nenhuma sessão de import VIGENTE encontrada — realize um import antes de calcular o aporte.",
        ),
      );

      const resultado = await criarOuAtualizarAjuste(inputValido);

      expect(resultado).toEqual({
        ok: false,
        erro:
          "Nenhuma sessão de import VIGENTE encontrada — realize um import antes de calcular o aporte.",
      });
    });

    it("erro não-Error do serviço vira mensagem genérica amigável, sem vazar o valor bruto", async () => {
      criarOuAtualizarAjusteMock.mockRejectedValue("boom");

      const resultado = await criarOuAtualizarAjuste(inputValido);

      expect(resultado).toEqual({
        ok: false,
        erro: "Erro inesperado ao processar a solicitação.",
      });
    });
  });

  // T016/T017 (User Story 2): listarAjustesAtivos — action de leitura fina,
  // sem validação de input.
  describe("listarAjustesAtivos", () => {
    it("delega ao serviço e retorna {ok:true, data} com a lista", async () => {
      listarAjustesAtivosMock.mockResolvedValue([
        {
          chaveExport: "FUNDO-XPTO",
          alvoId: "alvo-1",
          nomeAlvo: "Fundos",
          valorInvestidoCentavosCorrigido: 300_000,
        },
      ]);

      const resultado = await listarAjustesAtivos();

      expect(resultado).toEqual({
        ok: true,
        data: [
          {
            chaveExport: "FUNDO-XPTO",
            alvoId: "alvo-1",
            nomeAlvo: "Fundos",
            valorInvestidoCentavosCorrigido: 300_000,
          },
        ],
      });
    });

    it("traduz exceção do serviço em {ok:false, erro}", async () => {
      listarAjustesAtivosMock.mockRejectedValue(new Error("falha ao consultar"));

      const resultado = await listarAjustesAtivos();

      expect(resultado).toEqual({ ok: false, erro: "falha ao consultar" });
    });
  });
});
