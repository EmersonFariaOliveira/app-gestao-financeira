# Contrato — Server Actions (`src/app/actions/`) — Análise de Rendimento

Extensão do contrato das features 001/002 (`specs/001-gestao-aportes-v0-v1/contracts/server-actions.md`, `specs/002-posicoes-manuais-ajustes/contracts/server-actions.md`) — mesmo formato e regras de borda: actions **não contêm lógica de negócio** (validam input, chamam `src/services/`, retornam DTOs serializáveis), sem API route pública, valores monetários em centavos até a UI formatar. Retorno padrão: `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.

Referências: `spec.md` (FR-001..FR-020); `research.md`; `data-model.md`.

---

## import.ts (tela 6.2) — extensão para US4 (FR-011/FR-011a)

`previewImportService` (`src/services/import-service.ts`) ganha um novo campo no resultado `ok: true`, calculado **antes** de qualquer persistência (mesmo momento do `diff` já existente contra a sessão anterior):

```ts
export type PreviewImportResultado =
  | {
      ok: true;
      // ...campos existentes inalterados...
      /**
       * NOVO (feature 003, FR-011/FR-011a). Comparação entre o valor
       * investido esperado (sessão vigente anterior + aportes registrados
       * no app desde então, R7) e o valor investido real que este preview
       * traria, POR ATIVO (alvo exclusivo) ou POR ALVO (alvo com >1 ativo
       * elegível, R6) — só para diferenças que excedem FR-018 (5% E R$20,00
       * simultaneamente). Array vazio = nada a sinalizar. Puramente
       * informativo (R13) — NUNCA bloqueia `confirmarImport`.
       */
      movimentacoesNaoExplicadas: MovimentacaoNaoExplicada[];
    }
  | { ok: false; erros: ErroParse[] };
```

`MovimentacaoNaoExplicada` = mesmo shape de `data-model.md`. A UI (tela 6.2) exibe essa lista como aviso forte no mesmo card de preview, mesmo padrão visual de `instituicoesFaltantes`/`avisoSubstituicao` — nunca um modal bloqueante, nunca exige confirmação extra para prosseguir (diferente de `confirmouInstituicoesFaltantes`, que É obrigatório; aqui não há campo equivalente em `ConfirmarImportInput`).

`confirmarImportService` persiste `patrimonio_investido_centavos` em `posicao` junto com o resto da sessão (mesma transação atômica já existente) — nenhuma mudança na assinatura de `ConfirmarImportInput` além de os dados parseados agora carregarem o campo novo (transparente, vem de `PosicaoParseada.patrimonioAplicadoCentavos`, contracts/parser-patrimonio-aplicado.md).

---

## rendimento.ts (tela 6.10, NOVO)

Uma única action de leitura, no mesmo padrão de `dashboard.ts`:

```ts
export type PeriodoInput =
  | { tipo: "1M" | "3M" | "6M" | "12M" | "DESDE_INICIO" }
  | { tipo: "CUSTOMIZADO"; sessaoInicioId: string; sessaoFimId: string };

export interface RendimentoOutput {
  vazio: boolean; // true = nenhuma sessão vigente com dado disponível (mesmo padrão de DashboardVazio)
  periodo: PeriodoAnalise; // resolvido (sessaoInicioId/sessaoFimId concretos), data-model.md
  consolidado: RendimentoPeriodo; // patrimônio total (US1)
  reservaEmergencia: RendimentoPeriodo; // US2
  porTag: Array<{ tag: string; rendimento: RendimentoPeriodo }>; // US2
  porAlvo: Array<{ alvoId: string; nomeAlvo: string; tag: string | null; rendimento: RendimentoPeriodo }>; // US2
  foraDaCarteira: Array<{ chaveExport: string; rendimento: RendimentoPeriodo }>; // US2
  serie: SerieRendimento; // US3, um ponto por sessão vigente no período
  periodosDisponiveis: Array<{ sessaoImportId: string; mesReferencia: string; dataExport: string }>; // para popular o seletor de período customizado
}

export async function dadosRendimento(
  input: PeriodoInput,
): Promise<ActionResult<RendimentoOutput>>;
```

| Regra | Detalhe |
|---|---|
| Resolução de período pré-definido | `"1M"`/`"3M"`/`"6M"`/`"12M"` = da sessão vigente mais recente até a sessão vigente `N` meses antes por `mes_referencia` (a mais próxima disponível, nunca interpolada); `"DESDE_INICIO"` = da primeira sessão vigente até a mais recente. |
| `sessaoInicioId`/`sessaoFimId` ausentes (nenhuma sessão vigente no intervalo) | `periodo.sessaoInicioId`/`sessaoFimId` retornam `null`; `consolidado`/buckets vêm com `rendimentoCentavos: null` em vez de erro (edge case do spec.md). |
| Item sem dado suficiente (FR-010) | `RendimentoPeriodo.rendimentoCentavos: null` — a UI exibe "sem histórico suficiente", nunca 0 ou traço genérico. |
| Rótulo do percentual na UI | NUNCA "rentabilidade" (FR-020) — usar "ganho sobre capital investido" ou equivalente definido pelo `desenvolvedor-ui`. |
| `foraDaCarteira` | Um item por `chaveExport` (ou `chave_manual` de posição manual fora da carteira) — nunca agregado num único número, mesmo padrão de `dashboard-service.foraDaCarteira` hoje. |

Nenhuma nova action de escrita nesta feature — `dadosRendimento` é 100% leitura, mesmo padrão de `dashboard`/`historico`.
