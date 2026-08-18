/**
 * tests/app/actions/import.test.ts — testes unitários da camada de server
 * actions de src/app/actions/import.ts (tela 6.2, contracts/server-actions.md
 * "import.ts"; extensão US3 — feature 002-posicoes-manuais-ajustes).
 *
 * Mesmo padrão de tests/app/actions/posicoes-manuais.test.ts: serviço
 * MOCKADO (vi.mock("@/services/import-service")) — por regra de camadas
 * (CLAUDE.md — "UI não acessa banco nem calcula"), esta action não tem
 * lógica de negócio própria, só (a) extração/validação de shape do
 * `FormData` (arquivos, mesReferencia, os dois campos JSON novos da US3:
 * `posicoesManuaisConfirmadas`/`ajustesConfirmados`) e (b) tradução do
 * resultado/erro do serviço para `{ok:true,data}|{ok:false,erro}`.
 *
 * Este é o primeiro arquivo de teste dedicado a src/app/actions/import.ts
 * (não existia nenhum antes desta US3) — cobre também
 * `extrairJsonDoFormData`, o único helper novo introduzido por ela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const previewImportServiceMock = vi.fn();
const confirmarImportServiceMock = vi.fn();

vi.mock("@/services/import-service", () => ({
  previewImport: previewImportServiceMock,
  confirmarImport: confirmarImportServiceMock,
}));

const { previewImport, confirmarImport } = await import("@/app/actions/import");

beforeEach(() => {
  vi.clearAllMocks();
});

/** Um `File` mínimo com nome de instituição válido (mesmo padrão dos CSVs MyCapital). */
function arquivoCsv(nome = "Extrato_Itau.csv", conteudo = "Ação;Quantidade\nPRIO3;100"): File {
  return new File([conteudo], nome, { type: "text/csv" });
}

function formDataComArquivos(arquivos: File[], extra?: Record<string, string>): FormData {
  const fd = new FormData();
  for (const arquivo of arquivos) fd.append("arquivos", arquivo);
  if (extra) {
    for (const [chave, valor] of Object.entries(extra)) fd.append(chave, valor);
  }
  return fd;
}

describe("actions/import", () => {
  describe("previewImport", () => {
    it("rejeita FormData sem nenhum arquivo, sem chamar o serviço", async () => {
      const resultado = await previewImport(new FormData());

      expect(resultado.ok).toBe(false);
      if (!resultado.ok) expect(resultado.erro).toMatch(/arquivo/i);
      expect(previewImportServiceMock).not.toHaveBeenCalled();
    });

    it("delega ao serviço com os bytes dos arquivos e retorna {ok:true, data}", async () => {
      previewImportServiceMock.mockResolvedValue({
        ok: true,
        arquivos: [],
        mesReferenciaProposto: "2026-07",
        dataExport: "2026-07-28T00:00:00.000Z",
        posicoesManuaisRevisao: [],
        ajustesRevisao: [],
        incrementosAmbiguosPendentes: [],
      });

      const resultado = await previewImport(formDataComArquivos([arquivoCsv()]));

      expect(previewImportServiceMock).toHaveBeenCalledTimes(1);
      const [arquivosRecebidos] = previewImportServiceMock.mock.calls[0];
      expect(arquivosRecebidos).toHaveLength(1);
      expect(arquivosRecebidos[0].nomeArquivo).toBe("Extrato_Itau.csv");
      expect(arquivosRecebidos[0].conteudo).toBeInstanceOf(Uint8Array);

      expect(resultado).toEqual({
        ok: true,
        data: expect.objectContaining({ mesReferenciaProposto: "2026-07" }),
      });
    });

    it("repassa movimentacoesNaoExplicadas (US4, feature 003) do serviço para {ok:true, data} sem alterar o shape", async () => {
      const movimentacoesNaoExplicadas = [
        {
          granularidade: "ativo" as const,
          chaveExport: "AAA11",
          alvoId: "alvo-1",
          nomeAlvo: "Ações",
          valorInvestidoEsperadoCentavos: 80_000,
          valorInvestidoRealCentavos: 200_000,
          diferencaCentavos: 120_000,
          excedeTolerancia: true,
        },
      ];
      previewImportServiceMock.mockResolvedValue({
        ok: true,
        arquivos: [],
        mesReferenciaProposto: "2026-07",
        dataExport: "2026-07-28T00:00:00.000Z",
        posicoesManuaisRevisao: [],
        ajustesRevisao: [],
        incrementosAmbiguosPendentes: [],
        movimentacoesNaoExplicadas,
      });

      const resultado = await previewImport(formDataComArquivos([arquivoCsv()]));

      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;
      expect(resultado.data.movimentacoesNaoExplicadas).toEqual(movimentacoesNaoExplicadas);
    });

    it("traduz resultado ok:false (erro de parse) do serviço em {ok:false, erro, detalhes}", async () => {
      previewImportServiceMock.mockResolvedValue({
        ok: false,
        erros: [{ arquivo: "Extrato_Itau.csv", linha: 2, coluna: "Patrimônio Hoje", mensagem: "valor inválido" }],
      });

      const resultado = await previewImport(formDataComArquivos([arquivoCsv()]));

      expect(resultado.ok).toBe(false);
      if (resultado.ok) return;
      expect(resultado.erro).toMatch(/nada foi persistido/i);
      expect(resultado.detalhes).toEqual([
        { arquivo: "Extrato_Itau.csv", linha: 2, coluna: "Patrimônio Hoje", mensagem: "valor inválido" },
      ]);
    });

    it("traduz exceção do serviço em {ok:false, erro} com a mesma mensagem, sem vazar stack", async () => {
      previewImportServiceMock.mockRejectedValue(new Error("falha ao consultar sessão vigente"));

      const resultado = await previewImport(formDataComArquivos([arquivoCsv()]));

      expect(resultado).toEqual({ ok: false, erro: "falha ao consultar sessão vigente" });
    });

    it("erro não-Error do serviço vira mensagem genérica amigável, sem vazar o valor bruto", async () => {
      previewImportServiceMock.mockRejectedValue("boom");

      const resultado = await previewImport(formDataComArquivos([arquivoCsv()]));

      expect(resultado).toEqual({
        ok: false,
        erro: "Erro inesperado ao processar a solicitação.",
      });
    });
  });

  describe("confirmarImport", () => {
    function formDataValido(extra?: Record<string, string>): FormData {
      return formDataComArquivos([arquivoCsv()], { mesReferencia: "2026-07", ...extra });
    }

    it("rejeita FormData sem nenhum arquivo, sem chamar o serviço", async () => {
      const fd = new FormData();
      fd.append("mesReferencia", "2026-07");

      const resultado = await confirmarImport(fd);

      expect(resultado.ok).toBe(false);
      expect(confirmarImportServiceMock).not.toHaveBeenCalled();
    });

    it("rejeita mesReferencia ausente/vazio, sem chamar o serviço", async () => {
      const resultado = await confirmarImport(formDataComArquivos([arquivoCsv()], { mesReferencia: "   " }));

      expect(resultado.ok).toBe(false);
      if (!resultado.ok) expect(resultado.erro).toMatch(/mês de referência/i);
      expect(confirmarImportServiceMock).not.toHaveBeenCalled();
    });

    it("delega ao serviço com confirmouInstituicoesFaltantes derivado do FormData (\"true\" ⇒ true)", async () => {
      confirmarImportServiceMock.mockResolvedValue({
        ok: true,
        sessaoId: "sessao-1",
        pendenciasVinculo: [],
        incrementosAmbiguosNaoAlocadosCentavos: 0,
      });

      await confirmarImport(formDataValido({ confirmouInstituicoesFaltantes: "true" }));

      expect(confirmarImportServiceMock).toHaveBeenCalledWith(
        expect.objectContaining({ confirmouInstituicoesFaltantes: true, mesReferencia: "2026-07" }),
      );
    });

    it("confirmouInstituicoesFaltantes ausente do FormData ⇒ delega false ao serviço (não quebra imports sem instituição faltante)", async () => {
      confirmarImportServiceMock.mockResolvedValue({
        ok: true,
        sessaoId: "sessao-1",
        pendenciasVinculo: [],
        incrementosAmbiguosNaoAlocadosCentavos: 0,
      });

      await confirmarImport(formDataValido());

      expect(confirmarImportServiceMock).toHaveBeenCalledWith(
        expect.objectContaining({ confirmouInstituicoesFaltantes: false }),
      );
    });

    describe("extração de posicoesManuaisConfirmadas/ajustesConfirmados (US3)", () => {
      beforeEach(() => {
        confirmarImportServiceMock.mockResolvedValue({
          ok: true,
          sessaoId: "sessao-1",
          pendenciasVinculo: [],
          incrementosAmbiguosNaoAlocadosCentavos: 0,
        });
      });

      it("campos ausentes do FormData ⇒ delega undefined ao serviço (compatível com import sem posição manual/ajuste)", async () => {
        await confirmarImport(formDataValido());

        const [inputRecebido] = confirmarImportServiceMock.mock.calls[0];
        expect(inputRecebido.posicoesManuaisConfirmadas).toBeUndefined();
        expect(inputRecebido.ajustesConfirmados).toBeUndefined();
      });

      it("array vazio ('[]') explícito ⇒ delega [] ao serviço (diferente de ausente, mas mesmo efeito prático)", async () => {
        await confirmarImport(
          formDataValido({ posicoesManuaisConfirmadas: "[]", ajustesConfirmados: "[]" }),
        );

        const [inputRecebido] = confirmarImportServiceMock.mock.calls[0];
        expect(inputRecebido.posicoesManuaisConfirmadas).toEqual([]);
        expect(inputRecebido.ajustesConfirmados).toEqual([]);
      });

      it("JSON bem formado ⇒ parseia e delega os objetos ao serviço", async () => {
        await confirmarImport(
          formDataValido({
            posicoesManuaisConfirmadas: JSON.stringify([
              { posicaoManualId: "pm-1", valorInvestidoCentavos: 500_000, valorAtualCentavos: 520_000 },
            ]),
            ajustesConfirmados: JSON.stringify([
              { chaveExport: "PRIO3", valorInvestidoCentavosCorrigido: 90_000 },
            ]),
          }),
        );

        expect(confirmarImportServiceMock).toHaveBeenCalledWith(
          expect.objectContaining({
            posicoesManuaisConfirmadas: [
              { posicaoManualId: "pm-1", valorInvestidoCentavos: 500_000, valorAtualCentavos: 520_000 },
            ],
            ajustesConfirmados: [{ chaveExport: "PRIO3", valorInvestidoCentavosCorrigido: 90_000 }],
          }),
        );
      });

      it("posicoesManuaisConfirmadas com JSON malformado ⇒ ok:false, sem chamar o serviço", async () => {
        const resultado = await confirmarImport(
          formDataValido({ posicoesManuaisConfirmadas: "{isso não é JSON" }),
        );

        expect(resultado.ok).toBe(false);
        if (!resultado.ok) expect(resultado.erro).toMatch(/posicoesManuaisConfirmadas/);
        expect(confirmarImportServiceMock).not.toHaveBeenCalled();
      });

      it("ajustesConfirmados com JSON malformado ⇒ ok:false, sem chamar o serviço", async () => {
        const resultado = await confirmarImport(
          formDataValido({ ajustesConfirmados: "não é json nenhum" }),
        );

        expect(resultado.ok).toBe(false);
        if (!resultado.ok) expect(resultado.erro).toMatch(/ajustesConfirmados/);
        expect(confirmarImportServiceMock).not.toHaveBeenCalled();
      });

      it("campo presente mas vazio/whitespace ('', '   ') ⇒ tratado como ausente (undefined), não como erro de JSON", async () => {
        await confirmarImport(
          formDataValido({ posicoesManuaisConfirmadas: "", ajustesConfirmados: "   " }),
        );

        const [inputRecebido] = confirmarImportServiceMock.mock.calls[0];
        expect(inputRecebido.posicoesManuaisConfirmadas).toBeUndefined();
        expect(inputRecebido.ajustesConfirmados).toBeUndefined();
      });

      // Defesa em profundidade (bug real corrigido — ver relatório do
      // engenheiro-testes): mesmo padrão de `criarOuAtualizarAjuste`
      // (src/app/actions/posicoes-manuais.ts), que rejeita `chaveExport`
      // vazio/whitespace ANTES de chamar o serviço. `confirmarImport` agora
      // valida o conteúdo de cada item de `ajustesConfirmados`/
      // `posicoesManuaisConfirmadas` — um item com `chaveExport: "   "`
      // é rejeitado com `{ok:false, erro}` amigável, sem sequer chamar o
      // serviço (o serviço também trata o caso de forma independente,
      // filtrando-o como "não preenchido" — FR-009, defesa em profundidade).
      it("item com chaveExport whitespace-only em ajustesConfirmados é rejeitado com ok:false ANTES de delegar ao serviço", async () => {
        const resultado = await confirmarImport(
          formDataValido({
            ajustesConfirmados: JSON.stringify([
              { chaveExport: "   ", valorInvestidoCentavosCorrigido: 1_000 },
            ]),
          }),
        );

        expect(resultado.ok).toBe(false);
        if (!resultado.ok) expect(resultado.erro).toMatch(/chaveExport/);
        expect(confirmarImportServiceMock).not.toHaveBeenCalled();
      });

      it("item com posicaoManualId whitespace-only em posicoesManuaisConfirmadas é rejeitado com ok:false ANTES de delegar ao serviço", async () => {
        const resultado = await confirmarImport(
          formDataValido({
            posicoesManuaisConfirmadas: JSON.stringify([
              { posicaoManualId: "   ", valorInvestidoCentavos: 500_000, valorAtualCentavos: 520_000 },
            ]),
          }),
        );

        expect(resultado.ok).toBe(false);
        if (!resultado.ok) expect(resultado.erro).toMatch(/posicaoManualId/);
        expect(confirmarImportServiceMock).not.toHaveBeenCalled();
      });
    });

    it("traduz resultado ok:false do serviço (ex.: instituição faltante) em {ok:false, erro, detalhes}", async () => {
      confirmarImportServiceMock.mockResolvedValue({
        ok: false,
        erro: "Instituições presentes no import anterior e ausentes deste import: Nubank.",
        instituicoesFaltantes: ["Nubank"],
      });

      const resultado = await confirmarImport(formDataValido());

      expect(resultado).toEqual({
        ok: false,
        erro: "Instituições presentes no import anterior e ausentes deste import: Nubank.",
        detalhes: { erros: undefined, instituicoesFaltantes: ["Nubank"] },
      });
    });

    it("traduz exceção do serviço em {ok:false, erro}, sem vazar stack", async () => {
      confirmarImportServiceMock.mockRejectedValue(new Error("falha ao gravar backup"));

      const resultado = await confirmarImport(formDataValido());

      expect(resultado).toEqual({ ok: false, erro: "falha ao gravar backup" });
    });

    it("erro não-Error do serviço vira mensagem genérica amigável, sem vazar o valor bruto", async () => {
      confirmarImportServiceMock.mockRejectedValue("boom");

      const resultado = await confirmarImport(formDataValido());

      expect(resultado).toEqual({
        ok: false,
        erro: "Erro inesperado ao processar a solicitação.",
      });
    });
  });
});
