/**
 * tests/app/actions/rendimento.test.ts — testes unitários da camada de
 * server action de src/app/actions/rendimento.ts (feature 003-dashboard-
 * analise-rendimento, tela 6.10, contracts/server-actions.md).
 *
 * Mesma estratégia de tests/app/actions/posicoes-manuais.test.ts: o serviço
 * (src/services/rendimento-service.ts) é MOCKADO — por regra de camadas
 * (CLAUDE.md — "UI não acessa banco nem calcula"), a action não tem lógica de
 * negócio própria, só (a) validação de shape do input `PeriodoInput` e (b)
 * tradução do resultado/erro do serviço para `{ok:true,data}|{ok:false,erro}`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dadosRendimentoMock = vi.fn();

vi.mock("@/services/rendimento-service", () => ({
  dadosRendimento: dadosRendimentoMock,
}));

const { dadosRendimento } = await import("@/app/actions/rendimento");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("actions/rendimento", () => {
  describe("validação de input (shape, sem lógica de negócio)", () => {
    it("input undefined/null retorna erro sem chamar o serviço", async () => {
      const resultado = await dadosRendimento(
        undefined as unknown as Parameters<typeof dadosRendimento>[0],
      );

      expect(resultado).toEqual({ ok: false, erro: "Período inválido." });
      expect(dadosRendimentoMock).not.toHaveBeenCalled();
    });

    it("input sem campo 'tipo' retorna erro sem chamar o serviço", async () => {
      const resultado = await dadosRendimento({} as unknown as Parameters<typeof dadosRendimento>[0]);

      expect(resultado).toEqual({ ok: false, erro: "Período inválido." });
      expect(dadosRendimentoMock).not.toHaveBeenCalled();
    });

    it("'tipo' com preset desconhecido retorna erro sem chamar o serviço", async () => {
      const resultado = await dadosRendimento({
        tipo: "2Y",
      } as unknown as Parameters<typeof dadosRendimento>[0]);

      expect(resultado).toEqual({ ok: false, erro: "Período inválido." });
      expect(dadosRendimentoMock).not.toHaveBeenCalled();
    });

    it("'tipo: CUSTOMIZADO' sem sessaoInicioId nem sessaoFimId retorna erro sem chamar o serviço", async () => {
      const resultado = await dadosRendimento({
        tipo: "CUSTOMIZADO",
      } as unknown as Parameters<typeof dadosRendimento>[0]);

      expect(resultado).toEqual({
        ok: false,
        erro: "Selecione as duas sessões do período customizado.",
      });
      expect(dadosRendimentoMock).not.toHaveBeenCalled();
    });

    it("'tipo: CUSTOMIZADO' com apenas sessaoInicioId (sessaoFimId ausente) retorna erro sem chamar o serviço", async () => {
      const resultado = await dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoInicioId: "sessao-1",
      } as unknown as Parameters<typeof dadosRendimento>[0]);

      expect(resultado).toEqual({
        ok: false,
        erro: "Selecione as duas sessões do período customizado.",
      });
      expect(dadosRendimentoMock).not.toHaveBeenCalled();
    });

    it("'tipo: CUSTOMIZADO' com apenas sessaoFimId (sessaoInicioId ausente) retorna erro sem chamar o serviço", async () => {
      const resultado = await dadosRendimento({
        tipo: "CUSTOMIZADO",
        sessaoFimId: "sessao-2",
      } as unknown as Parameters<typeof dadosRendimento>[0]);

      expect(resultado).toEqual({
        ok: false,
        erro: "Selecione as duas sessões do período customizado.",
      });
      expect(dadosRendimentoMock).not.toHaveBeenCalled();
    });

    it.each(["1M", "3M", "6M", "12M", "DESDE_INICIO"])(
      "aceita preset válido '%s' e delega ao serviço",
      async (preset) => {
        dadosRendimentoMock.mockResolvedValue({
          vazio: false,
          periodo: { tipo: preset, sessaoInicioId: "s1", sessaoFimId: "s2" },
          consolidado: {
            sessaoInicioId: "s1",
            sessaoFimId: "s2",
            rendimentoCentavos: 1_000,
            rendimentoPct: 10,
            pontoInicio: {
              rendimentoCentavos: 0,
              rendimentoPct: 0,
              valorAtualCentavos: 10_000,
              valorInvestidoCentavos: 10_000,
            },
            pontoFim: {
              rendimentoCentavos: 1_000,
              rendimentoPct: 10,
              valorAtualCentavos: 11_000,
              valorInvestidoCentavos: 10_000,
            },
          },
          periodosDisponiveis: [],
        });

        const resultado = await dadosRendimento({
          tipo: preset,
        } as unknown as Parameters<typeof dadosRendimento>[0]);

        expect(dadosRendimentoMock).toHaveBeenCalledWith({ tipo: preset });
        expect(resultado.ok).toBe(true);
      },
    );

    it("'tipo: CUSTOMIZADO' com ambas as sessões preenchidas passa a validação e delega ao serviço", async () => {
      dadosRendimentoMock.mockResolvedValue({
        vazio: false,
        periodo: { tipo: "CUSTOMIZADO", sessaoInicioId: "s1", sessaoFimId: "s2" },
        consolidado: {
          sessaoInicioId: "s1",
          sessaoFimId: "s2",
          rendimentoCentavos: 500,
          rendimentoPct: 5,
          pontoInicio: {
            rendimentoCentavos: 0,
            rendimentoPct: 0,
            valorAtualCentavos: 10_000,
            valorInvestidoCentavos: 10_000,
          },
          pontoFim: {
            rendimentoCentavos: 500,
            rendimentoPct: 5,
            valorAtualCentavos: 10_500,
            valorInvestidoCentavos: 10_000,
          },
        },
        periodosDisponiveis: [],
      });

      const input = { tipo: "CUSTOMIZADO", sessaoInicioId: "sessao-1", sessaoFimId: "sessao-2" } as const;
      const resultado = await dadosRendimento(input);

      expect(dadosRendimentoMock).toHaveBeenCalledWith(input);
      expect(resultado).toEqual({
        ok: true,
        data: expect.objectContaining({ vazio: false }),
      });
    });
  });

  describe("caminho feliz e tratamento de exceção do serviço", () => {
    it("delega ao serviço e repassa os 4 campos de segmentação por bucket (US2) sem alteração de shape", async () => {
      const rendimentoPeriodoBase = {
        sessaoInicioId: "s1",
        sessaoFimId: "s2",
        rendimentoCentavos: 300,
        rendimentoPct: 3,
        pontoInicio: {
          rendimentoCentavos: 0,
          rendimentoPct: 0,
          valorAtualCentavos: 10_000,
          valorInvestidoCentavos: 10_000,
        },
        pontoFim: {
          rendimentoCentavos: 300,
          rendimentoPct: 3,
          valorAtualCentavos: 10_300,
          valorInvestidoCentavos: 10_000,
        },
      };
      const output = {
        vazio: false,
        periodo: { tipo: "1M" as const, sessaoInicioId: "s1", sessaoFimId: "s2" },
        consolidado: rendimentoPeriodoBase,
        reservaEmergencia: rendimentoPeriodoBase,
        porTag: [{ tag: "RENDA-VARIAVEL", rendimento: rendimentoPeriodoBase }],
        porAlvo: [
          { alvoId: "alvo-1", nomeAlvo: "Ação 1", tag: "RENDA-VARIAVEL", rendimento: rendimentoPeriodoBase },
        ],
        foraDaCarteira: [{ chaveExport: "FORA1", rendimento: rendimentoPeriodoBase }],
        periodosDisponiveis: [],
        semPeriodoAnteriorParaComparacao: false,
      };
      dadosRendimentoMock.mockResolvedValue(output);

      const resultado = await dadosRendimento({ tipo: "1M" });

      expect(resultado).toEqual({ ok: true, data: output });
      expect(resultado.ok && resultado.data.reservaEmergencia).toEqual(rendimentoPeriodoBase);
      expect(resultado.ok && resultado.data.porTag).toHaveLength(1);
      expect(resultado.ok && resultado.data.porAlvo).toHaveLength(1);
      expect(resultado.ok && resultado.data.foraDaCarteira).toHaveLength(1);
    });

    it("delega ao serviço e retorna {ok:true, data} com o RendimentoOutput retornado", async () => {
      const output = {
        vazio: false,
        periodo: { tipo: "1M" as const, sessaoInicioId: "s1", sessaoFimId: "s2" },
        consolidado: {
          sessaoInicioId: "s1",
          sessaoFimId: "s2",
          rendimentoCentavos: 2_000,
          rendimentoPct: 20,
          pontoInicio: {
            rendimentoCentavos: 0,
            rendimentoPct: 0,
            valorAtualCentavos: 10_000,
            valorInvestidoCentavos: 10_000,
          },
          pontoFim: {
            rendimentoCentavos: 2_000,
            rendimentoPct: 20,
            valorAtualCentavos: 12_000,
            valorInvestidoCentavos: 10_000,
          },
        },
        periodosDisponiveis: [
          { sessaoImportId: "s1", mesReferencia: "2026-07", dataExport: "2026-07-28T00:00:00.000Z" },
          { sessaoImportId: "s2", mesReferencia: "2026-08", dataExport: "2026-08-28T00:00:00.000Z" },
        ],
      };
      dadosRendimentoMock.mockResolvedValue(output);

      const resultado = await dadosRendimento({ tipo: "1M" });

      expect(resultado).toEqual({ ok: true, data: output });
    });

    it("vazio:true (nenhuma sessão VIGENTE) ainda é {ok:true, data} — 'vazio' não é um erro de camada", async () => {
      const output = {
        vazio: true,
        periodo: { tipo: "DESDE_INICIO" as const, sessaoInicioId: null, sessaoFimId: null },
        consolidado: {
          sessaoInicioId: "",
          sessaoFimId: "",
          rendimentoCentavos: null,
          rendimentoPct: null,
          pontoInicio: {
            rendimentoCentavos: null,
            rendimentoPct: null,
            valorAtualCentavos: 0,
            valorInvestidoCentavos: null,
          },
          pontoFim: {
            rendimentoCentavos: null,
            rendimentoPct: null,
            valorAtualCentavos: 0,
            valorInvestidoCentavos: null,
          },
        },
        periodosDisponiveis: [],
      };
      dadosRendimentoMock.mockResolvedValue(output);

      const resultado = await dadosRendimento({ tipo: "DESDE_INICIO" });

      expect(resultado).toEqual({ ok: true, data: output });
    });

    it("exceção inesperada do serviço vira {ok:false, erro: message} sem lançar (nunca 500 na tela)", async () => {
      dadosRendimentoMock.mockRejectedValue(new Error("Falha ao consultar o banco de dados."));

      const resultado = await dadosRendimento({ tipo: "12M" });

      expect(resultado).toEqual({ ok: false, erro: "Falha ao consultar o banco de dados." });
    });

    it("exceção não-Error do serviço vira mensagem genérica sem vazar detalhes internos", async () => {
      dadosRendimentoMock.mockRejectedValue("algo obscuro");

      const resultado = await dadosRendimento({ tipo: "3M" });

      expect(resultado).toEqual({
        ok: false,
        erro: "Erro inesperado ao processar a solicitação.",
      });
    });
  });
});
