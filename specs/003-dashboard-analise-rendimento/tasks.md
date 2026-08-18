# Tasks: Análise de Rendimento da Carteira

**Input**: Design documents from `/specs/003-dashboard-analise-rendimento/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (motor-nao-tocado.md, parser-patrimonio-aplicado.md, server-actions.md), quickstart.md

**Tests**: INCLUÍDOS — mesmo padrão das features 001/002 (o projeto exige cobertura de serviço/motor antes de UI). O Motor de Aporte NÃO é alterado por esta feature (research.md R1); os testes novos ficam no parser (`tests/parser/`) e na camada de serviço (`tests/services/`), nunca em `tests/motor/`.

**Organization**: agrupado por user story do spec.md (US1–US4, prioridade P1–P3). Cada task carrega o subagente da camada responsável: `[especialista-csv]`, `[calculista-aporte]`, `[arquiteto-dados]`, `[desenvolvedor-ui]`. Nesta feature, a lógica de cálculo de rendimento (`rendimento-service.ts`) é atribuída a `[arquiteto-dados]` — mesmo precedente da feature 002 (`posicao-manual-service.ts`, também leitura/agregação sobre dados persistidos, sem I/O externo nem regra do motor) — e não a `[calculista-aporte]`, cujo domínio (CLAUDE.md) é estritamente déficit/fila/divisão/transbordo/mínimo/arredondamento/dividendos (research.md R11).

## Format: `[ID] [P?] [Story] [subagente] Description`

- **[P]**: paralelizável (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1–US4, mapeando ao spec.md
- Caminhos exatos em cada descrição

---

## Phase 1: Setup

**Purpose**: segurança antes de alterar o schema de um banco que já tem dados reais (features 001/002 em produção local)

- [ ] T001 [arquiteto-dados] Backup manual de `data/app.db` (cópia datada em `backups/`, ou `npm run` do `backup-service.ts` existente) antes de qualquer migration desta feature

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: captura de "Patrimônio Aplicado" ponta a ponta (parser → schema → persistência) e dados de seed — pré-requisito de TODAS as stories, já que nenhum rendimento é calculável sem esse dado

**⚠️ CRITICAL**: nenhuma user story começa antes desta fase terminar

- [ ] T002 [arquiteto-dados] Adicionar `posicao.patrimonio_investido_centavos Int?` em `prisma/schema.prisma`, exatamente conforme `data-model.md`
- [ ] T003 [arquiteto-dados] Gerar migration (`prisma migrate dev`) — depende de T002; sem `CHECK` novo (data-model.md)
- [ ] T004 [P] [especialista-csv] Adicionar `PosicaoParseada.patrimonioAplicadoCentavos: number | null` em `src/parser/types.ts` conforme `contracts/parser-patrimonio-aplicado.md`
- [ ] T005 [especialista-csv] Implementar captura opcional de "Patrimônio Aplicado" em `src/parser/mycapital.ts`: coluna NÃO entra em `COLUNAS_OBRIGATORIAS`, `null` por linha ausente/`"null"` literal/inválida, nunca gera `ErroParse` nem invalida o arquivo (research.md R2) — depende de T004
- [ ] T006 [P] [especialista-csv] Testes em `tests/parser/mycapital.test.ts`: coluna ausente do cabeçalho (todas as linhas `null`, `ok: true`), valor `"null"` literal/vazio/inválido só naquela linha (sem `ErroParse`), valor válido convertido corretamente para centavos — depende de T005
- [ ] T007 [P] [arquiteto-dados] Persistir `patrimonio_investido_centavos` em `confirmarImport` (`src/services/import-service.ts`), mesma transação/snapshot imutável já usada para `patrimonio_hoje_centavos` — depende de T003, T005
- [ ] T008 [arquiteto-dados] Estender `prisma/seed.ts`: uma 2ª sessão VIGENTE (mês seguinte à existente) com `patrimonio_investido_centavos` preenchido na maioria das posições e `null` em pelo menos uma (caso "sem histórico suficiente", FR-010) — depende de T007

**Checkpoint**: `npx prisma migrate dev && npx prisma db seed` roda sem erro; ao menos 2 sessões VIGENTE do seed têm `patrimonio_investido_centavos` preenchido, habilitando teste de variação de período sem import manual

---

## Phase 3: User Story 1 — Ver quanto rendeu o patrimônio total num período escolhido (Priority: P1) 🎯 MVP

**Goal**: usuário seleciona um período e vê o rendimento consolidado (R$ e %) do patrimônio total nesse intervalo.

**Independent Test**: com o seed (T008), abrir `/rendimento`, selecionar o período entre as duas sessões semeadas, conferir que o rendimento em R$ é `[valorAtual(fim) − valorInvestido(fim)] − [valorAtual(início) − valorInvestido(início)]` e o percentual usa `valorInvestido(início)` como base.

### Tests for User Story 1 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [ ] T009 [US1] [arquiteto-dados] Testes em `tests/services/rendimento-service.test.ts`: rendimento de sessão única (R5), variação entre duas sessões (R$ e %, base = valor investido do início — Clarifications do spec.md), prioridade de fonte ajuste > CSV > indisponível (R4), guarda de divisão por zero (`rendimentoPct: null`, nunca `Infinity`/`NaN`/0 enganoso), resolução de período pré-definido (1M/3M/6M/12M/DESDE_INICIO) e customizado, período sem nenhuma sessão vigente no intervalo (`sessaoInicioId`/`sessaoFimId: null`)

### Implementation for User Story 1

- [ ] T010 [US1] [arquiteto-dados] Implementar `src/services/rendimento-service.ts`: `resolverValorInvestido` (R4), `calcularRendimentoPonto`/`calcularRendimentoPeriodo` (R5), `resolverPeriodo` (presets + customizado, `data-model.md`) — depende de T008, T009
- [ ] T011 [US1] [desenvolvedor-ui] Implementar `dadosRendimento` (campo `consolidado` apenas nesta story) em `src/app/actions/rendimento.ts` conforme `contracts/server-actions.md` — depende de T010
- [ ] T012 [US1] [desenvolvedor-ui] Implementar `src/app/rendimento/page.tsx`: card de rendimento consolidado (R$ e %, rótulo "ganho sobre capital investido" — nunca "rentabilidade", FR-020) + seletor de período (presets) — depende de T011
- [ ] T013 [US1] [desenvolvedor-ui] Adicionar atalho/card para `/rendimento` em `src/app/page.tsx` (tela 6.1, sem alterar a visão existente de alocação atual vs. alvo) — depende de T012

**Checkpoint**: User Story 1 funcional e testável de ponta a ponta, independente das demais

---

## Phase 4: User Story 2 — Ver rendimento por reserva de emergência, tag/carteira e ativos fora da carteira (Priority: P1)

**Goal**: quebrar o rendimento consolidado por bucket (reserva de emergência, cada tag, cada alvo, cada ativo fora da carteira).

**Independent Test**: com ao menos um ativo em cada bucket no seed, abrir `/rendimento` e conferir que os buckets aparecem separadamente e que a soma deles bate com o consolidado (SC-006).

### Tests for User Story 2 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [ ] T014 [US2] [arquiteto-dados] Testes em `tests/services/rendimento-service.test.ts`: agregação por reserva de emergência, por tag, por alvo, por ativo fora da carteira; SC-006 (soma dos buckets = consolidado); "sem histórico suficiente" quando o ativo/alvo não tem dado (FR-010, nunca 0) — depende de T009 (mesmo arquivo)

### Implementation for User Story 2

- [ ] T015 [US2] [arquiteto-dados] Estender `rendimento-service.ts`: `calcularRendimentoPorBucket` (reserva de emergência, por tag, por alvo, fora da carteira), reaproveitando a técnica de "somar antes de dividir" já usada por `dashboard-service.agruparAlocacaoPorTag` — depende de T010, T014
- [ ] T016 [US2] [desenvolvedor-ui] Estender `dadosRendimento` (`reservaEmergencia`, `porTag`, `porAlvo`, `foraDaCarteira`) em `src/app/actions/rendimento.ts` — depende de T015, T011
- [ ] T017 [US2] [desenvolvedor-ui] Estender `src/app/rendimento/page.tsx`: seções de reserva de emergência, tags/alvos e fora da carteira, com "sem histórico suficiente" quando aplicável — depende de T016, T012

**Checkpoint**: User Stories 1 e 2 funcionais e independentes entre si

---

## Phase 5: User Story 3 — Selecionar período e ver a evolução em gráfico interativo (Priority: P2)

**Goal**: gráfico interativo com um ponto por sessão vigente no período, mostrando valor investido, valor atual e rendimento; tooltip ao interagir; alternância entre períodos pré-definidos e customizado.

**Independent Test**: com três ou mais sessões vigentes, selecionar "desde o início", conferir um ponto por sessão (sessões `SUBSTITUIDO` ausentes), e que o tooltip de um ponto bate com os números textuais de US1 na mesma sessão.

### Tests for User Story 3 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [ ] T018 [US3] [arquiteto-dados] Testes em `tests/services/rendimento-service.test.ts`: `montarSerieRendimento` produz um ponto por sessão VIGENTE no período (FR-013 — sessões `SUBSTITUIDO` excluídas), ordenação cronológica, ponto com `patrimonio_investido_centavos: null` aparece com `rendimentoCentavos: null` (nunca omitido silenciosamente) — depende de T014 (mesmo arquivo)

### Implementation for User Story 3

- [ ] T019 [US3] [arquiteto-dados] Estender `rendimento-service.ts`: `montarSerieRendimento` (`SerieRendimento`, `data-model.md`) — depende de T015, T018
- [ ] T020 [US3] [desenvolvedor-ui] Estender `dadosRendimento` (`serie`, `periodosDisponiveis`) em `src/app/actions/rendimento.ts` — depende de T019, T016
- [ ] T021 [US3] [desenvolvedor-ui] Implementar componente de gráfico interativo (Recharts) em `src/components/rendimento/grafico-evolucao.tsx`: linhas de valor investido/valor atual/rendimento, tooltip com valores exatos (R$, %, data) ao interagir (hover/toque/clique) — depende de T020
- [ ] T022 [US3] [desenvolvedor-ui] Integrar o gráfico em `src/app/rendimento/page.tsx` com seletor de período completo (presets + intervalo customizado usando `periodosDisponiveis`) — depende de T021, T017

**Checkpoint**: User Stories 1–3 funcionais e independentes

---

## Phase 6: User Story 4 — Ser alertado sobre movimentação de valor investido não explicada pelo app (Priority: P3)

**Goal**: ao confirmar um novo import, sinalizar (sem bloquear) quando o valor investido de um ativo — ou a soma dos ativos de um alvo compartilhado — mudou além do que os aportes registrados no app explicam.

**Independent Test**: registrar um aporte executado num alvo com um único ativo elegível; no próximo import, se o valor investido real bater com "anterior + executado" (dentro da tolerância), nenhum alerta aparece; se divergir além de FR-018, o alerta aparece sem bloquear a confirmação. Repetir com um alvo de múltiplos ativos elegíveis e conferir que o alerta (se houver) aparece no nível do alvo, nunca apontando um ativo específico.

### Tests for User Story 4 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [ ] T023 [US4] [arquiteto-dados] Testes de elegibilidade/granularidade/tolerância em `tests/services/rendimento-service.test.ts`: `contarAtivosComValorInvestidoRastreavel` — conjunto NOVO e mais amplo que `aporte-service.gerarIncrementosPendentes` (research.md R6: inclui qualquer `chave_export` vinculado ao alvo, com ou sem ajuste ativo); n=0 → nada a validar; n=1 → validação por ativo (FR-011); n≥2 → validação por soma do alvo (FR-011a); fonte do "valor investido esperado" via soma de `aporte.executado` por `alvo_id` para aportes calculados sobre a sessão anterior (R7); tolerância FR-018 (só sinaliza quando excede 5% E R$ 20,00 simultaneamente)
- [ ] T024 [P] [US4] [arquiteto-dados] Testes de integração em `tests/services/import-service.test.ts`: `previewImport.movimentacoesNaoExplicadas` presente/ausente conforme tolerância; nunca bloqueia `previewImport` nem `confirmarImport`; valor persistido em `posicao.patrimonio_investido_centavos` é sempre o valor real recebido, nunca o "esperado" calculado para comparação (FR-019) — depende de T007

### Implementation for User Story 4

- [ ] T025 [US4] [arquiteto-dados] Implementar `contarAtivosComValorInvestidoRastreavel` e `calcularMovimentacaoNaoExplicada` em `rendimento-service.ts` (R6/R7/FR-018) — depende de T019, T023
- [ ] T026 [US4] [arquiteto-dados] Estender `previewImport` em `src/services/import-service.ts`: calcular `movimentacoesNaoExplicadas` antes de qualquer persistência, usando `rendimento-service.ts` (research.md R13 — informativo, nunca bloqueante) — depende de T025, T024
- [ ] T027 [US4] [desenvolvedor-ui] Estender `previewImport` em `src/app/actions/import.ts` para repassar `movimentacoesNaoExplicadas` (`contracts/server-actions.md`) — depende de T026
- [ ] T028 [US4] [desenvolvedor-ui] Exibir o alerta de movimentação não explicada em `src/app/import/page.tsx`, mesmo padrão visual do aviso de instituição faltante (aviso forte, não bloqueante) — depende de T027

**Checkpoint**: todas as 4 user stories funcionais e independentes

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: validação final e conformidade com o desenho da feature

- [ ] T029 [P] Confirmar via `git diff --stat src/core/motor` (vazio) que o Motor de Aporte permanece sem nenhuma alteração (research.md R1) — checagem de conformidade com `contracts/motor-nao-tocado.md`; revisar toda a UI nova para garantir que a palavra "rentabilidade" nunca aparece (FR-020)
- [ ] T030 [P] Rodar a validação manual completa de `quickstart.md` (4 user stories + tabela de comportamentos críticos + escopo negativo) e corrigir o que falhar
- [ ] T031 Fluxo pós-implementação obrigatório do CLAUDE.md: **engenheiro-testes** (suíte completa + lacunas) → **guardiao-spec** (diff vs. spec: escopo negativo/Constitution v1.1.0, FR-019/valor investido nunca no motor, camadas isoladas) → **gerente-release** (propor commits e perguntar antes de commitar)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências
- **Foundational (Phase 2)**: depende de Setup — BLOQUEIA todas as stories
- **US1 (Phase 3)**: depende de Foundational (usa o seed T008). Não depende de US2–US4
- **US2 (Phase 4)**: depende de Foundational e de T010/T011/T012 (US1), por reutilizar o mesmo arquivo de serviço/action/tela — acoplada por arquivo, mas testável isoladamente (Independent Test próprio, SC-006)
- **US3 (Phase 5)**: depende de Foundational e de T015/T016/T017 (US2, mesmos arquivos). Testável isoladamente com os dados já semeados em T008
- **US4 (Phase 6)**: depende de US1 (T010, cálculo base de rendimento) e US3 (T019, série/elegibilidade) — reaproveita `rendimento-service.ts` e é a única story que também toca o fluxo de import (`import-service.ts`, já estendido em T007)
- **Polish (Phase 7)**: depende de todas as stories completas

### Ordem sequencial recomendada

Setup → Foundational → **US1 (MVP: rendimento consolidado)** → US2 → US3 → US4 (alerta de movimentação) → Polish

### Parallel Opportunities

- Phase 2: T004 pode rodar em paralelo com T002/T003 (arquivo distinto); T006/T007 em paralelo depois de T005 (arquivos distintos)
- US4: T023/T024 (testes, arquivos distintos) em paralelo
- Entre stories: nenhuma — US2/US3/US4 reutilizam os mesmos arquivos de serviço/action/tela criados em US1, então a maior parte do trabalho é sequencial por arquivo, mesmo sendo independentemente testável por Independent Test

## Parallel Example: Foundational

```bash
# Schema e parser, arquivos distintos, em paralelo:
Task: "T002 prisma/schema.prisma"        [arquiteto-dados]
Task: "T004 src/parser/types.ts"         [especialista-csv]

# Depois de T005 (parser implementado), testes e persistência em paralelo:
Task: "T006 tests/parser/mycapital.test.ts"     [especialista-csv]
Task: "T007 src/services/import-service.ts"      [arquiteto-dados]
```

## Implementation Strategy

### MVP First (US1 apenas)

1. Phases 1–2 (Setup + Foundational, incluindo o seed com 2 sessões vigentes)
2. Phase 3 (US1): testes de fórmula/período → serviço → action → tela
3. **PARAR e VALIDAR**: no seed, conferir que `/rendimento` mostra o rendimento consolidado correto para o período entre as duas sessões semeadas
4. Demo: a pergunta central do usuário ("quanto meu dinheiro rendeu") já tem resposta

### Incremental Delivery

1. + US2 (rendimento por bucket) → responde especificamente a reserva de emergência/tag/fora-da-carteira, o exemplo citado pelo usuário
2. + US3 (gráfico interativo) → trajetória ao longo do tempo, não só o número do período
3. + US4 (movimentação não explicada) → **feature completa**, fecha o ciclo de "validar aportes/resgates" pedido pelo usuário
4. Cada incremento passa por T031 (engenheiro-testes → guardiao-spec → gerente-release) antes de commit

## Notes

- Regra inviolável em TODAS as tasks: `patrimonio_investido_centavos` NUNCA entra em `PosicaoConsolidada`/`EntradaMotor` nem em nenhuma consulta que alimente o motor (FR-019) — verificado explicitamente em T009, T029
- O Motor de Aporte (`src/core/motor/**`) não tem nenhuma task de alteração nesta feature — research.md R1 é uma decisão de design, não uma omissão
- Testes escritos antes e devem falhar; implementação só depois
- Commits apenas com aprovação explícita do usuário (fluxo gerente-release)
- Fora do escopo desta lista de tasks (fica como acompanhamento, conforme Assumptions do spec.md): atualizar `docs/app-gestao-aportes.md` §1 para refletir a exceção do Princípio I ratificada na constitution v1.1.0 — não é uma tarefa de código, pode ser feita a qualquer momento sem bloquear nenhuma user story
