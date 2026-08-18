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

- [X] T001 [arquiteto-dados] Backup manual de `data/app.db` (cópia datada em `backups/`, ou `npm run` do `backup-service.ts` existente) antes de qualquer migration desta feature

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: captura de "Patrimônio Aplicado" ponta a ponta (parser → schema → persistência) e dados de seed — pré-requisito de TODAS as stories, já que nenhum rendimento é calculável sem esse dado

**⚠️ CRITICAL**: nenhuma user story começa antes desta fase terminar

- [X] T002 [arquiteto-dados] Adicionar `posicao.patrimonio_investido_centavos Int?` em `prisma/schema.prisma`, exatamente conforme `data-model.md`
- [X] T003 [arquiteto-dados] Gerar migration (`prisma migrate dev`) — depende de T002; sem `CHECK` novo (data-model.md)
- [X] T004 [P] [especialista-csv] Adicionar `PosicaoParseada.patrimonioAplicadoCentavos: number | null` em `src/parser/types.ts` conforme `contracts/parser-patrimonio-aplicado.md`
- [X] T005 [especialista-csv] Implementar captura opcional de "Patrimônio Aplicado" em `src/parser/mycapital.ts`: coluna NÃO entra em `COLUNAS_OBRIGATORIAS`, `null` por linha ausente/`"null"` literal/inválida, nunca gera `ErroParse` nem invalida o arquivo (research.md R2) — depende de T004
- [X] T006 [P] [especialista-csv] Testes em `tests/parser/mycapital.test.ts`: coluna ausente do cabeçalho (todas as linhas `null`, `ok: true`), valor `"null"` literal/vazio/inválido só naquela linha (sem `ErroParse`), valor válido convertido corretamente para centavos — depende de T005
- [X] T007 [P] [arquiteto-dados] Persistir `patrimonio_investido_centavos` em `confirmarImport` (`src/services/import-service.ts`), mesma transação/snapshot imutável já usada para `patrimonio_hoje_centavos` — depende de T003, T005
- [X] T008 [arquiteto-dados] Estender `prisma/seed.ts`: uma 2ª sessão VIGENTE (mês seguinte à existente) com `patrimonio_investido_centavos` preenchido na maioria das posições e `null` em pelo menos uma (caso "sem histórico suficiente", FR-010) — depende de T007

**Checkpoint**: `npx prisma migrate dev && npx prisma db seed` roda sem erro; ao menos 2 sessões VIGENTE do seed têm `patrimonio_investido_centavos` preenchido, habilitando teste de variação de período sem import manual

---

## Phase 3: User Story 1 — Ver quanto rendeu o patrimônio total num período escolhido (Priority: P1) 🎯 MVP

**Goal**: usuário seleciona um período e vê o rendimento consolidado (R$ e %) do patrimônio total nesse intervalo.

**Independent Test**: com o seed (T008), abrir `/rendimento`, selecionar o período entre as duas sessões semeadas, conferir que o rendimento em R$ é `[valorAtual(fim) − valorInvestido(fim)] − [valorAtual(início) − valorInvestido(início)]` e o percentual usa `valorInvestido(início)` como base.

### Tests for User Story 1 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [X] T009 [US1] [arquiteto-dados] Testes em `tests/services/rendimento-service.test.ts`: rendimento de sessão única (R5), variação entre duas sessões (R$ e %, base = valor investido do início — Clarifications do spec.md), prioridade de fonte ajuste > CSV > indisponível (R4), guarda de divisão por zero (`rendimentoPct: null`, nunca `Infinity`/`NaN`/0 enganoso), resolução de período pré-definido (1M/3M/6M/12M/DESDE_INICIO) e customizado, período sem nenhuma sessão vigente no intervalo (`sessaoInicioId`/`sessaoFimId: null`)

### Implementation for User Story 1

- [X] T010 [US1] [arquiteto-dados] Implementar `src/services/rendimento-service.ts`: `resolverValorInvestido` (R4), `calcularRendimentoPonto`/`calcularRendimentoPeriodo` (R5), `resolverPeriodo` (presets + customizado, `data-model.md`) — depende de T008, T009
- [X] T011 [US1] [desenvolvedor-ui] Implementar `dadosRendimento` (campo `consolidado` apenas nesta story) em `src/app/actions/rendimento.ts` conforme `contracts/server-actions.md` — depende de T010
- [X] T012 [US1] [desenvolvedor-ui] Implementar `src/app/rendimento/page.tsx`: card de rendimento consolidado (R$ e %, rótulo "ganho sobre capital investido" — nunca "rentabilidade", FR-020) + seletor de período (presets) — depende de T011
- [X] T013 [US1] [desenvolvedor-ui] Adicionar atalho/card para `/rendimento` em `src/app/page.tsx` (tela 6.1, sem alterar a visão existente de alocação atual vs. alvo) — depende de T012

**Checkpoint**: User Story 1 funcional e testável de ponta a ponta, independente das demais

---

## Phase 4: User Story 2 — Ver rendimento por reserva de emergência, tag/carteira e ativos fora da carteira (Priority: P1)

**Goal**: quebrar o rendimento consolidado por bucket (reserva de emergência, cada tag, cada alvo, cada ativo fora da carteira).

**Independent Test**: com ao menos um ativo em cada bucket no seed, abrir `/rendimento` e conferir que os buckets aparecem separadamente e que a soma deles bate com o consolidado (SC-006).

### Tests for User Story 2 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [X] T014 [US2] [arquiteto-dados] Testes em `tests/services/rendimento-service.test.ts`: agregação por reserva de emergência, por tag, por alvo, por ativo fora da carteira; SC-006 (soma dos buckets = consolidado); "sem histórico suficiente" quando o ativo/alvo não tem dado (FR-010, nunca 0) — depende de T009 (mesmo arquivo)

### Implementation for User Story 2

- [X] T015 [US2] [arquiteto-dados] Estender `rendimento-service.ts`: `calcularRendimentoPorBucket` (reserva de emergência, por tag, por alvo, fora da carteira), reaproveitando a técnica de "somar antes de dividir" já usada por `dashboard-service.agruparAlocacaoPorTag` — depende de T010, T014
- [X] T016 [US2] [desenvolvedor-ui] Estender `dadosRendimento` (`reservaEmergencia`, `porTag`, `porAlvo`, `foraDaCarteira`) em `src/app/actions/rendimento.ts` — depende de T015, T011
- [X] T017 [US2] [desenvolvedor-ui] Estender `src/app/rendimento/page.tsx`: seções de reserva de emergência, tags/alvos e fora da carteira, com "sem histórico suficiente" quando aplicável — depende de T016, T012

**Checkpoint**: User Stories 1 e 2 funcionais e independentes entre si

---

## Phase 5: User Story 3 — Selecionar período e ver a evolução em gráfico interativo (Priority: P2)

**Goal**: gráfico interativo com um ponto por sessão vigente no período, mostrando valor investido, valor atual e rendimento; tooltip ao interagir; alternância entre períodos pré-definidos e customizado.

**Independent Test**: com três ou mais sessões vigentes, selecionar "desde o início", conferir um ponto por sessão (sessões `SUBSTITUIDO` ausentes), e que o tooltip de um ponto bate com os números textuais de US1 na mesma sessão.

### Tests for User Story 3 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [X] T018 [US3] [arquiteto-dados] Testes em `tests/services/rendimento-service.test.ts`: `montarSerieRendimento` produz um ponto por sessão VIGENTE no período (FR-013 — sessões `SUBSTITUIDO` excluídas), ordenação cronológica, ponto com `patrimonio_investido_centavos: null` aparece com `rendimentoCentavos: null` (nunca omitido silenciosamente) — depende de T014 (mesmo arquivo)

### Implementation for User Story 3

- [X] T019 [US3] [arquiteto-dados] Estender `rendimento-service.ts`: `montarSerieRendimento` (`SerieRendimento`, `data-model.md`) — depende de T015, T018
- [X] T020 [US3] [desenvolvedor-ui] Estender `dadosRendimento` (`serie`, `periodosDisponiveis`) em `src/app/actions/rendimento.ts` — depende de T019, T016
- [X] T021 [US3] [desenvolvedor-ui] Implementar componente de gráfico interativo (Recharts) em `src/components/rendimento/grafico-evolucao.tsx`: linhas de valor investido/valor atual/rendimento, tooltip com valores exatos (R$, %, data) ao interagir (hover/toque/clique) — depende de T020
- [X] T022 [US3] [desenvolvedor-ui] Integrar o gráfico em `src/app/rendimento/page.tsx` com seletor de período completo (presets + intervalo customizado usando `periodosDisponiveis`) — depende de T021, T017

**Checkpoint**: User Stories 1–3 funcionais e independentes

---

## Phase 6: User Story 4 — Ser alertado sobre movimentação de valor investido não explicada pelo app (Priority: P3)

**Goal**: ao confirmar um novo import, sinalizar (sem bloquear) quando o valor investido de um ativo — ou a soma dos ativos de um alvo compartilhado — mudou além do que os aportes registrados no app explicam.

**Independent Test**: registrar um aporte executado num alvo com um único ativo elegível; no próximo import, se o valor investido real bater com "anterior + executado" (dentro da tolerância), nenhum alerta aparece; se divergir além de FR-018, o alerta aparece sem bloquear a confirmação. Repetir com um alvo de múltiplos ativos elegíveis e conferir que o alerta (se houver) aparece no nível do alvo, nunca apontando um ativo específico.

### Tests for User Story 4 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [X] T023 [US4] [arquiteto-dados] Testes de elegibilidade/granularidade/tolerância em `tests/services/rendimento-service.test.ts`: `contarAtivosComValorInvestidoRastreavel` — conjunto NOVO e mais amplo que `aporte-service.gerarIncrementosPendentes` (research.md R6: inclui qualquer `chave_export` vinculado ao alvo, com ou sem ajuste ativo); n=0 → nada a validar; n=1 → validação por ativo (FR-011); n≥2 → validação por soma do alvo (FR-011a); fonte do "valor investido esperado" via soma de `aporte.executado` por `alvo_id` para aportes calculados sobre a sessão anterior (R7); tolerância FR-018 (só sinaliza quando excede 5% E R$ 20,00 simultaneamente)
- [X] T024 [P] [US4] [arquiteto-dados] Testes de integração em `tests/services/import-service.test.ts`: `previewImport.movimentacoesNaoExplicadas` presente/ausente conforme tolerância; nunca bloqueia `previewImport` nem `confirmarImport`; valor persistido em `posicao.patrimonio_investido_centavos` é sempre o valor real recebido, nunca o "esperado" calculado para comparação (FR-019) — depende de T007

### Implementation for User Story 4

- [X] T025 [US4] [arquiteto-dados] Implementar `contarAtivosComValorInvestidoRastreavel` e `calcularMovimentacaoNaoExplicada` em `rendimento-service.ts` (R6/R7/FR-018) — depende de T019, T023
- [X] T026 [US4] [arquiteto-dados] Estender `previewImport` em `src/services/import-service.ts`: calcular `movimentacoesNaoExplicadas` antes de qualquer persistência, usando `rendimento-service.ts` (research.md R13 — informativo, nunca bloqueante) — depende de T025, T024
- [X] T027 [US4] [desenvolvedor-ui] Estender `previewImport` em `src/app/actions/import.ts` para repassar `movimentacoesNaoExplicadas` (`contracts/server-actions.md`) — depende de T026
- [X] T028 [US4] [desenvolvedor-ui] Exibir o alerta de movimentação não explicada em `src/app/import/page.tsx`, mesmo padrão visual do aviso de instituição faltante (aviso forte, não bloqueante) — depende de T027

**Checkpoint**: todas as 4 user stories funcionais e independentes

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: validação final e conformidade com o desenho da feature

- [X] T029 [P] Confirmar via `git diff --stat src/core/motor` (vazio) que o Motor de Aporte permanece sem nenhuma alteração (research.md R1) — checagem de conformidade com `contracts/motor-nao-tocado.md`; revisar toda a UI nova para garantir que a palavra "rentabilidade" nunca aparece (FR-020)
- [X] T030 [P] Rodar a validação manual completa de `quickstart.md` (4 user stories + tabela de comportamentos críticos + escopo negativo) e corrigir o que falhar
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
- **Desvio encontrado e corrigido durante T014-T017 (US2)**: `RendimentoOutput` ganhou um 5º campo, `pendentes` (ativos pendentes de vínculo, um item por chave, nunca agregado), além dos 4 previstos originalmente no texto de T015/T016/T017. Gap real de planejamento: FR-017 exige que pendentes de vínculo sejam "exibidos à parte" e FR-014 já listava "pendentes com dado disponível" na soma que deve bater com o consolidado (SC-006), mas nem `contracts/server-actions.md` nem o texto das tasks prescreviam esse campo — sem ele, pendentes ficavam ausentes de `RendimentoOutput` e SC-006 quebrava sempre que havia alguma chave pendente com dado. Corrigido em `src/services/rendimento-service.ts`/`src/app/rendimento/page.tsx`/`contracts/server-actions.md`, com teste de regressão dedicado em `tests/services/rendimento-service.test.ts`. Achado por `engenheiro-testes`, corrigido por `arquiteto-dados` + `desenvolvedor-ui`, revisado e aprovado por `guardiao-spec`.
- **Correções de bug aplicadas durante US1, antes do commit inicial**: (1) `resolverValorInvestido` inicialmente usava `findFirst` em vez de somar `patrimonio_investido_centavos` entre instituições para uma `chave_export` consolidada, subestimando o valor investido de ativos multi-instituição — corrigido para somar todas as linhas (ou tratar como indisponível se qualquer uma for `null`). (2) O cálculo consolidado inicialmente propagava `null` para o total inteiro quando QUALQUER chave elegível estivesse sem dado, contrariando FR-014 ("...+ pendentes com dado disponível") — corrigido para casar o mesmo conjunto de chaves entre início/fim do período, excluindo apenas as chaves sem dado em ambas as pontas (nunca só de uma). (3) Sessão única (Acceptance Scenario 2 de US1) calculava um delta entre dois pontos idênticos, sempre `0` — corrigido para retornar o rendimento do ponto isolado, com o sinalizador `semPeriodoAnteriorParaComparacao`. `prisma/seed.ts` também precisou de ajuste (preencher `patrimonio_investido_centavos` também na sessão `2026-07` original, não só na nova `2026-08`) para o Independent Test de US1 ser exercitável com os dados semeados.
- **Decisão de implementação em T019 (`montarSerieRendimento`)**: cada `PontoSerieRendimento` reaproveita `calcularRendimentoPeriodoDeChaves(elegiveis, elegiveis, sessao.id, sessao.id)` (passando a MESMA sessão como início e fim), em vez de uma função "ponto" nova — é exatamente o mesmo truque já usado pelo caso "apenas uma sessão VIGENTE" de `dadosRendimento` (US1). Consequência intencional herdada dessa reutilização: uma chave sem `valorInvestidoCentavos` resolvível naquela sessão fica de fora tanto do total investido QUANTO do total atual do ponto (mesma regra de `consolidarSubconjunto`, "nunca somar total cheio de uma chave sem dado completo") — não é um comportamento novo desta task, só a mesma regra já testada em US1 aplicada ponto a ponto na série. Sem outros desvios de `data-model.md`/`tasks.md`.
- **Decisões de implementação em T020–T022 (UI do gráfico, US3)**: (1) `chart-colors.ts`/`globals.css` ganharam uma 3ª cor categórica (`series3Green`, verde) para as 3 séries simultâneas do gráfico de evolução (valor investido/valor atual/rendimento) — a paleta anterior só previa `series1Blue`/`series2Orange` (2 séries, usadas por `evolucao-patrimonial-chart.tsx`/`sugerido-vs-executado-chart.tsx`); mantido deliberadamente distinto de `statusGood` (mesmo guia de uso já documentado: cor de status nunca é reaproveitada como cor de série). (2) O tooltip customizado de `grafico-evolucao.tsx` usa `content={TooltipEvolucao}` (função componente) em vez do `formatter`/`labelFormatter` genéricos usados pelos outros gráficos do projeto — necessário porque o tooltip desta tela precisa mostrar o percentual de rendimento (`rendimentoPct`) junto dos R$, um dado que só existe por ponto da série, não como série própria do `LineChart`; a tipagem de `content` do Recharts 3.x (`TooltipContentProps<ValueType, NameType>`) não compôs de forma limpa com TypeScript quando anotada explicitamente com os tipos genéricos do projeto, então a prop foi tipada com uma asserção local mínima (`payload` como `Array<{ payload: PontoGrafico }>`) em vez do tipo genérico completo da lib — isolado nesse componente, não afeta nenhuma outra tela. (3) `CardGraficoEvolucao` não renderiza o `LineChart` quando `dados.serie.length < 2` (mostra uma mensagem "escolha um período mais amplo" em vez de um gráfico de um ponto só) — mesma lógica já usada por `semPeriodoAnteriorParaComparacao` no card consolidado (US1), aplicada aqui porque um único ponto não forma uma linha de evolução. (4) Não existe componente `Select` no design system do projeto (`src/components/ui/`) — o seletor de sessões do modo customizado usa `<select>` nativo estilizado com as mesmas classes Tailwind de `Input`, em vez de introduzir uma dependência nova de UI só para esta tela.
- **Decisões de implementação em T025–T026 (movimentação não explicada, US4)**: (1) `calcularMovimentacaoNaoExplicada` retorna o objeto `MovimentacaoNaoExplicada` mesmo quando `excedeTolerancia: false` (nunca `null` nesse caso — só retorna `null` quando `n=0`), para que os testes de tolerância (T023) possam inspecionar `diferencaCentavos`/`excedeTolerancia` diretamente; é responsabilidade do CHAMADOR (`previewImport`) filtrar e só incluir no array `movimentacoesNaoExplicadas` os itens com `excedeTolerancia: true` — mantém o contrato do array ("array vazio = nada a sinalizar") sem duplicar a lógica de filtro em cada consumidor futuro do serviço (ex.: a revisão na tela de Análise de Rendimento, R13-b, ainda não implementada). (2) A base do "valor investido esperado" trata um elegível sem valor investido resolvível na sessão anterior (`resolverValorInvestido` retornando `null`, FR-010) como contribuição `0` para a soma, em vez de tornar o alvo inteiro "sem dado" — decisão deliberada: um alvo novo (primeiro ativo mapeado a ele nesta sessão) não tem "valor esperado" nenhum a não ser o que foi aportado desde então, então tratar como 0 é o comportamento correto (não um "sem histórico suficiente" — aqui há uma resposta válida: zero). (3) **Limitação documentada de `previewImport` (T026)**: `calcularMovimentacoesNaoExplicadasDoPreview` só calcula a comparação para alvos cuja elegibilidade completa (`contarAtivosComValorInvestidoRastreavel`) é formada EXCLUSIVAMENTE por `chave_export` presentes neste import específico com "Patrimônio Aplicado" não-nulo — um alvo com qualquer `posicao_manual` elegível vinculada é pulado nesta fatia (nunca comparado, nunca aparece em `movimentacoesNaoExplicadas`). Motivo: o valor investido real de uma posição manual só é conhecido depois que o usuário preenche a revisão da tela de import (`posicoesManuaisConfirmadas`, passo posterior ao preview) — calcular a comparação no momento do preview exigiria usar um valor ainda não confirmado (o carry-forward de `montarRevisaoImport`, que é só uma sugestão editável), o que poderia gerar tanto falsos alarmes quanto falsos negativos. Nenhuma task/contrato pedia explicitamente cobrir esse caso; registrado aqui como gap de escopo conhecido, não como bug — revisitável numa iteração futura se o usuário sentir falta do alerta para alvos com posição manual.
- **Decisão de implementação em T027 (`src/app/actions/import.ts`)**: nenhuma alteração de lógica foi necessária — `previewImport` já devolve `resultado` inteiro (`return { ok: true, data: resultado }`), sem reconstrução campo a campo, e `PreviewImportOutput` já é `Extract<PreviewImportResultado, { ok: true }>`. Como `movimentacoesNaoExplicadas` foi adicionado ao tipo `PreviewImportResultado` em T026, o campo já flui automaticamente por tipagem estrutural (mesmo caminho de `avisoSubstituicao`/`instituicoesFaltantes`). T027 ficou restrita a um comentário de documentação deixando esse fato explícito, mais a verificação de `npx tsc --noEmit` (sem erros) confirmando que o tipo realmente propaga.
- **Decisão de implementação em T028 (`src/app/import/page.tsx`)**: alerta renderizado no mesmo card de preview, mesmo estilo visual âmbar de `avisoSubstituicao`/`instituicoesFaltantes` (`border-amber-400/60 bg-amber-400/10`), posicionado logo antes do bloco `preview.diff` — sem checkbox de confirmação (diferente do aviso de instituições faltantes, que É bloqueante via `confirmouInstituicoesFaltantes`), condizente com o contrato ("nunca exige confirmação extra para prosseguir"). Cada item lista o nome do alvo, a granularidade (`"ativo <chave>"` quando `granularidade === "ativo"`, ou "soma do alvo — múltiplos ativos elegíveis" quando `"alvo"` — nunca aponta um ativo específico dentro de alvo compartilhado, research.md R6), valor esperado vs. real formatados com `formatCentavosParaReais`, e a diferença com sinal. Palavra "rentabilidade" não usada (FR-020). Verificado: `npx tsc --noEmit` sem erros, `npx vitest run` 622 passed/4 skipped (nenhuma regressão), `npm run dev` na porta 3050 com `/import` respondendo 200 sem erro de runtime/hidratação.
- **Correção pós-implementação em `calcularMovimentacaoNaoExplicada`/`calcularMovimentacoesNaoExplicadasDoPreview` (US4, achado por `engenheiro-testes` na revisão final)**: a guarda de divisão por zero de FR-018/R8 (`valorInvestidoEsperadoCentavos === 0 → qualquer diferença dispara o limiar percentual`) tratava indistintamente dois casos diferentes: (a) "esperado é genuinamente 0 porque a sessão anterior existia e o valor investido resolvido nela foi 0" — deve continuar disparando alerta normalmente; e (b) "não há NENHUM dado anterior rastreável para nenhum elegível do alvo (nem `posicao`/`posicao_manual_valor` resolvível na sessão anterior, nem aporte executado registrado) — primeira aparição do ativo/alvo". Sem distinguir os dois, um ativo novo mapeado hoje mas ausente da sessão anterior disparava falso alarme para qualquer valor investido real acima do piso de R$20,00, violando spec.md US4 Acceptance Scenario 3 ("ativo novo... nenhum alerta... não há base de comparação"). Corrigido introduzindo `houveValorAnteriorRastreavel` (true se `resolverValorInvestido` resolveu um valor não-nulo para ao menos 1 elegível na sessão anterior) e `houveBaseComparacao` (`houveValorAnteriorRastreavel || somaExecutadoAlvoCentavos !== 0`, cobrindo o caso de aporte executado registrado sem `posicao` remanescente); `excedeTolerancia` agora exige `houveBaseComparacao` além dos dois limiares de FR-018. O caso (a) — esperado 0 com sessão anterior existente e resolvida — permanece coberto pela guarda original, agora subordinada a `houveBaseComparacao=true`. `calcularMovimentacoesNaoExplicadasDoPreview` não precisou de alteração própria: já filtra por `movimentacao.excedeTolerancia`, então herda a correção automaticamente. 2 testes de regressão dedicados (antes `[ACHADO]`, renomeados após a correção): `tests/services/rendimento-service.test.ts` ("US4 Acceptance Scenario 3: ativo novo (primeira aparição, sem sessão anterior)...") e `tests/services/import-service.test.ts` ("US4 Acceptance Scenario 3: ativo novo (primeira aparição, mapeado ao alvo só agora...)..."). Suíte completa após a correção: 627 passed / 4 skipped (1 falha isolada de `posicao-manual-service.test.ts` por timeout de contenção SQLite ao rodar a suíte inteira, confirmada como flake pré-existente não relacionada — passa 84/84 quando rodada isoladamente). `npx tsc --noEmit` e `npm run lint` sem erros (1 warning pré-existente não relacionado em `tests/app/actions/posicoes-manuais.test.ts`). Aproveitado para remover `consolidadoDoPeriodo` de `rendimento-service.ts` (código morto confirmado por grep no projeto todo — nenhum chamador nem teste direto restante; `dadosRendimento` já usa `consolidarSubconjunto`/`chavesElegiveisDaSessao` diretamente).
- **T029/T030 (validação final)**: `git diff --stat src/core/motor` vazio tanto contra a working tree quanto contra `main...HEAD` — Motor de Aporte confirmado intacto. Toda ocorrência de "rentabilidade" em `src/` está dentro de comentário de código proibindo o termo na UI (nunca em string exibida ao usuário). T030 rodado contra o banco real de desenvolvimento do usuário (`G:/Meu Drive/Investimentos/app-gestao-financeira-db/app.db`, path de `.env`) — **somente leitura**: nenhum `prisma migrate`/`db seed`/escrita foi executado nele (já estava migrado e com 2 sessões VIGENTE de dados reais, 2026-07/2026-08). Script ad-hoc chamando `dadosRendimento`/`montarSerieRendimento` diretamente confirmou, com dado real: US1 (fórmula R5 bate byte a byte com o cálculo manual, R$150,00/0,81% entre as duas sessões), US2 (SC-006: soma de reserva+tags+fora-da-carteira+pendentes+alvos-sem-tag == consolidado, 150,00 == 150,00; 1 alvo com "sem histórico suficiente" em vez de erro), US3 (série com 2 pontos, ordenados cronologicamente, ambos de sessão VIGENTE, ponto final batendo com `pontoFim` do consolidado). `npm run dev` + `curl` em `/`, `/rendimento`, `/import` (porta 3099, isolada) → todos HTTP 200, sem erro/warning no log do servidor. US4 (alerta de movimentação) não pôde ser exercitado ponta a ponta sem confirmar um import real contra o banco de produção do usuário — coberto integralmente pelos 108 testes automatizados de T023/T024 (isolados em bancos SQLite temporários), consistente com a decisão de não escrever no banco real durante esta validação.
