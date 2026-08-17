# Tasks: Posições Manuais e Ajustes de Valor Investido

**Input**: Design documents from `/specs/002-posicoes-manuais-ajustes/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (motor-integracao.md, server-actions.md), quickstart.md

**Tests**: INCLUÍDOS — mesmo padrão da feature 001 (o projeto exige cobertura de serviço/motor antes de UI). O Motor de Aporte NÃO é alterado por esta feature (research.md R1); os testes novos ficam na camada de serviço (`tests/services/`), não em `tests/motor/`.

**Organization**: agrupado por user story do spec.md (US1–US4, prioridade P1–P4). Cada task carrega o subagente da camada responsável: `[especialista-csv]`, `[calculista-aporte]`, `[arquiteto-dados]`, `[desenvolvedor-ui]`.

## Format: `[ID] [P?] [Story] [subagente] Description`

- **[P]**: paralelizável (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1–US4, mapeando ao spec.md
- Caminhos exatos em cada descrição

---

## Phase 1: Setup

**Purpose**: segurança antes de alterar o schema de um banco que já tem dados reais (feature 001 em produção local)

- [X] T001 [arquiteto-dados] Backup manual de `data/app.db` (cópia datada em `backups/`, ou `npm run` do `backup-service.ts` existente) antes de qualquer migration desta feature

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: schema Prisma, migration e dados de seed — pré-requisitos de TODAS as stories

**⚠️ CRITICAL**: nenhuma user story começa antes desta fase terminar

- [X] T002 [arquiteto-dados] Adicionar `ativo_mapeado.ignorar_no_import Boolean @default(false)` e as 4 entidades novas (`posicao_manual`, `posicao_manual_valor`, `ajuste_valor_investido`, `incremento_valor_investido_pendente`) em `prisma/schema.prisma`, exatamente conforme `data-model.md` (campos, FKs, `@@unique`)
- [X] T003 [arquiteto-dados] Gerar migration (`prisma migrate dev`) e editar o SQL manualmente para adicionar os 2 `CHECK` constraints de `incremento_valor_investido_pendente` (exclusividade mútua `chave_export`/`posicao_manual_id`; consistência `aplicado`/`sessao_aplicacao_id` — data-model.md) — depende de T002
- [X] T004 [P] [arquiteto-dados] Estender `prisma/seed.ts`: 1 `ativo_mapeado` existente marcado `ignorar_no_import = true`, 1 `posicao_manual` ativa com `posicao_manual_valor` na sessão VIGENTE do seed, 1 `ajuste_valor_investido` para um `chave_export` já vinculado — habilita teste independente das stories sem depender de cadastro manual prévio — depende de T003

**Checkpoint**: `npx prisma migrate dev && npx prisma db seed` roda sem erro; `prisma studio` mostra as 4 tabelas novas e o campo novo em `ativo_mapeado`

---

## Phase 3: User Story 1 — Registrar posição manual no lugar de um ativo mal importado (Priority: P1) 🎯 MVP

**Goal**: marcar um ativo do CSV como "Ignorar (substituído por posição manual)" e cadastrar a posição manual correspondente, que passa a compor o déficit do alvo exatamente como uma posição do CSV.

**Independent Test**: com o seed (T004), abrir `/vinculos`, confirmar que o ativo semeado aparece no balde "ignorados"; abrir `/aporte` e confirmar que o déficit do alvo correspondente já reflete `valor_atual` da posição manual semeada.

### Tests for User Story 1 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [X] T005 [P] [US1] [arquiteto-dados] Testes de CRUD em `tests/services/posicao-manual-service.test.ts`: `criarPosicaoManual` anexa `posicao_manual_valor` à sessão VIGENTE existente, falha alto sem sessão vigente (research.md R7), `editarPosicaoManual`, `encerrarPosicaoManual` (irreversível, some do carry-forward)
- [X] T006 [P] [US1] [calculista-aporte] Testes em `tests/services/aporte-service.test.ts` (estende arquivo existente): posição manual ativa entra em `PosicaoConsolidada[]` com `valorCentavos = valor_atual` (nunca `valor_investido`); `chave_export` com `ignorar_no_import = true` é excluída da consolidação do CSV; colisão `chave_manual` × `chave_export` lança erro explícito (research.md R8, motor-integracao.md §2.2)

### Implementation for User Story 1

- [X] T007 [P] [US1] [arquiteto-dados] Implementar `src/services/posicao-manual-service.ts`: `criarPosicaoManual` (cria `posicao_manual` + `posicao_manual_valor` inicial na sessão vigente, se existir), `editarPosicaoManual`, `encerrarPosicaoManual` (`ativo: true → false`, irreversível)
- [X] T008 [P] [US1] [calculista-aporte] Estender `montarContextoEntradaMotor` em `src/services/aporte-service.ts`: excluir `chave_export` com `ignorar_no_import = true` do `consolidadoPorChave`; incluir `posicao_manual` ativas com snapshot na sessão vigente (`chaveExport: chave_manual`, `tipoGrupo: "RENDA_FIXA_MANUAL"`, `valorCentavos: valor_atual_centavos`); guarda de colisão de identidade (motor-integracao.md §2.2)
- [X] T009 [US1] [desenvolvedor-ui] Estender `vincularAtivo`/`listarVinculos` em `src/services/mapeamento-service.ts` e `src/app/actions/vinculos.ts` com a forma `ignorarNoImport` (união discriminada) e o balde `ignorados` (`posicaoManualPendente` heurístico), conforme `contracts/server-actions.md` — depende de T002
- [X] T010 [US1] [desenvolvedor-ui] Atualizar `src/app/vinculos/page.tsx`: opção "Ignorar (substituído por posição manual)", balde "ignorados", CTA "+ Cadastrar posição manual" com querystring quando `posicaoManualPendente` — depende de T009
- [X] T011 [US1] [desenvolvedor-ui] Implementar `criarPosicaoManual`/`editarPosicaoManual`/`encerrarPosicaoManual` em `src/app/actions/posicoes-manuais.ts` conforme `contracts/server-actions.md` — depende de T007
- [X] T012 [US1] [desenvolvedor-ui] Implementar `src/app/posicoes-manuais/page.tsx`: lista de posições manuais ativas, "+ Nova posição manual" (lendo `alvoId`/`descricaoSugerida` da querystring do CTA de T010), ação "Encerrar" — depende de T011

**Checkpoint**: User Story 1 funcional e testável de ponta a ponta, independente das demais

---

## Phase 4: User Story 2 — Corrigir o valor investido de um fundo sem alterar o valor atual (Priority: P2)

**Goal**: corrigir `valor_investido` de um `chave_export` (fundo) mantendo `valor_atual` vindo do CSV, sem qualquer efeito no cálculo de déficit.

**Independent Test**: criar um ajuste para o `chave_export` do seed (T004); conferir que `valor_atual` exibido continua igual ao do CSV e que o resultado da calculadora não muda antes/depois do ajuste (SC-004).

### Tests for User Story 2 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [X] T013 [P] [US2] [arquiteto-dados] Testes de `criarOuAtualizarAjuste` em `tests/services/posicao-manual-service.test.ts`: cria/atualiza `ajuste_valor_investido` associado à sessão vigente; `valor_atual` nunca é tocado por esta função; primeira vez retorna `valorInvestidoCorrigido: null` (FR-009)
- [X] T014 [P] [US2] [calculista-aporte] Teste em `tests/services/aporte-service.test.ts`: resultado de `calcular()` idêntico antes e depois de aplicar um `ajuste_valor_investido` sobre a mesma posição (SC-004) — `valor_investido_corrigido` nunca lido por `montarContextoEntradaMotor`

### Implementation for User Story 2

- [X] T015 [US2] [arquiteto-dados] Implementar `criarOuAtualizarAjuste` em `src/services/posicao-manual-service.ts`: grava `ajuste_valor_investido` associado à sessão VIGENTE mais recente, sem tocar `posicao.patrimonio_hoje_centavos` — depende de T007 (mesmo arquivo)
- [X] T016 [US2] [desenvolvedor-ui] Implementar `criarOuAtualizarAjuste` em `src/app/actions/posicoes-manuais.ts` conforme `contracts/server-actions.md` — depende de T015, T011 (mesmo arquivo)
- [X] T017 [US2] [desenvolvedor-ui] Adicionar seção "Ajustes de fundos" em `src/app/posicoes-manuais/page.tsx`: lista de `chave_export` sob ajuste, criação/edição do valor corrigido, aviso visual de "primeira vez" quando vazio (FR-009) — depende de T016, T012 (mesmo arquivo)

**Checkpoint**: User Stories 1 e 2 funcionais e independentes entre si

---

## Phase 5: User Story 3 — Revisar posições manuais e ajustes antes de confirmar o import (Priority: P3)

**Goal**: seção de revisão dentro do fluxo de import (6.9), pré-preenchida por carry-forward da sessão vigente anterior, editável antes da confirmação.

**Independent Test**: com posição manual e ajuste já cadastrados (US1/US2), iniciar um novo import com os mesmos CSVs; a seção de revisão chega pré-preenchida com os valores da sessão anterior; editar só o `valor_atual` da posição manual e confirmar; reabrir a revisão no import seguinte e conferir que o valor editado (não o original) é a base do novo carry-forward.

### Tests for User Story 3 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [X] T018 [P] [US3] [arquiteto-dados] Testes de carry-forward em `tests/services/posicao-manual-service.test.ts`: pré-preenchimento a partir da sessão VIGENTE imediatamente anterior; primeira posição manual/ajuste sem sessão anterior não quebra (valores vazios/iniciais); nenhuma linha de sessão confirmada sofre `UPDATE`

### Implementation for User Story 3

- [X] T019 [US3] [arquiteto-dados] Implementar `listarPosicoesManuaisEAjustes` (leitura fora do import) e a função de montagem de `posicoesManuaisRevisao`/`ajustesRevisao` (carry-forward, sem incremento ainda — Phase 6) em `src/services/posicao-manual-service.ts` — depende de T015 (mesmo arquivo)
- [X] T020 [US3] [arquiteto-dados] Estender `src/services/import-service.ts`: `previewImport` ganha `posicoesManuaisRevisao`/`ajustesRevisao` (leitura, em memória); `confirmarImport` grava `posicao_manual_valor[]`/`ajuste_valor_investido[]` da revisão na MESMA transação de confirmação (data-model.md, "Fluxo técnico" passo 4) — depende de T019
- [X] T021 [US3] [desenvolvedor-ui] Estender `previewImport`/`confirmarImport` em `src/app/actions/import.ts` conforme `contracts/server-actions.md` — depende de T020
- [X] T022 [US3] [desenvolvedor-ui] Adicionar seção de revisão (6.9) ao final do card de preview em `src/app/import/page.tsx`: lista pré-preenchida de posições manuais/ajustes, campos editáveis de `valor_investido`/`valor_atual`, antes do botão "Confirmar import" (research.md R6) — depende de T021

**Checkpoint**: User Stories 1–3 funcionais; o ritual mensal já cobre carry-forward de posições manuais/ajustes

---

## Phase 6: User Story 4 — Incrementar valor investido automaticamente a partir do aporte executado (Priority: P4)

**Goal**: ao registrar um aporte executado, gerar incremento pendente para alvos com mapeamento exclusivo a um único ativo elegível; casos ambíguos ficam destacados para distribuição manual na próxima revisão de import.

**Independent Test**: registrar um aporte executado num alvo com um único ativo elegível; abrir o próximo import e confirmar que a revisão chega com o valor investido já somado. Repetir com um alvo de dois ativos elegíveis e confirmar o destaque de pendência ambígua, sem atribuição automática.

### Tests for User Story 4 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [ ] T023 [P] [US4] [calculista-aporte] Testes do algoritmo de elegibilidade em `tests/services/aporte-service.test.ts`: 0 elegíveis ⇒ nenhum incremento; 1 elegível (posição manual OU ajuste) ⇒ incremento atribuído com o FK correto; ≥2 elegíveis ⇒ incremento ambíguo (`alvo_id` só); toda a operação na mesma transação de `registrarAporte` (motor-integracao.md §3)
- [ ] T024 [P] [US4] [arquiteto-dados] Testes de consumo em `tests/services/posicao-manual-service.test.ts`: soma de múltiplas pendências não aplicadas no carry-forward; `aplicado = true` só na confirmação (nunca ao só pré-visualizar); reimport abandonado não perde nem duplica pendências; pendência ambígua marcada `aplicado = true` integralmente na confirmação, mesmo com distribuição parcial (research.md R5)

### Implementation for User Story 4

- [ ] T025 [US4] [calculista-aporte] Implementar geração de `incremento_valor_investido_pendente` dentro de `registrarAporte` em `src/services/aporte-service.ts`, na mesma transação Prisma, conforme algoritmo de `contracts/motor-integracao.md` §3 — depende de T008 (mesmo arquivo)
- [ ] T026 [US4] [arquiteto-dados] Implementar consumo de pendências (soma em `posicoesManuaisRevisao`/`ajustesRevisao`, agregação `incrementosAmbiguosPendentes` por alvo) em `src/services/posicao-manual-service.ts` + marcação `aplicado = true` na transação de `confirmarImport` em `src/services/import-service.ts` (motor-integracao.md §4) — depende de T019, T020, T025
- [ ] T027 [US4] [desenvolvedor-ui] Exibir `incrementosAmbiguosPendentes` em destaque na seção de revisão de `src/app/import/page.tsx` ("R$ X aportados em '<alvo>' sem fundo específico — distribua abaixo") e o campo opcional `distribuicoesIncrementosAmbiguos` só para conferência visual da soma — depende de T022, T026

**Checkpoint**: todas as 4 user stories funcionais e independentes

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: validação final e conformidade com o desenho da feature 001

- [ ] T028 [P] Rodar a validação manual completa de `quickstart.md` (4 user stories + tabela de comportamentos críticos) e corrigir o que falhar
- [ ] T029 [P] Confirmar via `git diff --stat src/core/motor` (vazio) que o Motor de Aporte permanece sem nenhuma alteração (research.md R1) — checagem de conformidade com `contracts/motor-integracao.md` §1
- [ ] T030 Fluxo pós-implementação obrigatório do CLAUDE.md: **engenheiro-testes** (suíte completa + lacunas) → **guardiao-spec** (diff vs. spec: escopo negativo, FR-006/valor_investido nunca no motor, camadas isoladas) → **gerente-release** (propor commits e perguntar antes de commitar)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências
- **Foundational (Phase 2)**: depende de Setup — BLOQUEIA todas as stories
- **US1 (Phase 3)**: depende de Foundational (usa o seed T004). Não depende de US2–US4
- **US2 (Phase 4)**: depende de Foundational e de T007/T011/T012 (US1) por reutilizar o mesmo arquivo de serviço/action/tela — tecnicamente acoplada por arquivo, mas testável isoladamente (Independent Test próprio)
- **US3 (Phase 5)**: depende de Foundational e de T015 (US2, mesmo arquivo de serviço). Testável isoladamente com o carry-forward de dados já semeados
- **US4 (Phase 6)**: depende de US1 (T008, geração de `PosicaoConsolidada`) e de US3 (T019/T020, ponto de consumo no import) — é a única story que integra as três anteriores, por natureza (o doc-fonte já a descreve como o fechamento do ciclo)
- **Polish (Phase 7)**: depende de todas as stories completas

### Ordem sequencial recomendada

Setup → Foundational → **US1 (MVP: posição manual básica)** → US2 → US3 → US4 (fecha o ciclo automático) → Polish

### Parallel Opportunities

- Phase 2: T004 pode rodar assim que T003 terminar (arquivo distinto de schema/migration)
- US1: T005/T006 (testes) em paralelo; T007/T008 (implementação, arquivos distintos) em paralelo
- US2: T013/T014 (testes) em paralelo
- US4: T023/T024 (testes, arquivos distintos) em paralelo
- Entre stories: nenhuma — US2/US3/US4 reutilizam os mesmos arquivos de serviço/action/tela criados em US1, então a maior parte do trabalho é sequencial por arquivo, mesmo sendo independentemente testável por Independent Test

## Parallel Example: User Story 1

```bash
# Testes primeiro, em paralelo (devem falhar):
Task: "T005 tests/services/posicao-manual-service.test.ts" [arquiteto-dados]
Task: "T006 tests/services/aporte-service.test.ts"          [calculista-aporte]

# Implementação, arquivos distintos, em paralelo:
Task: "T007 src/services/posicao-manual-service.ts" [arquiteto-dados]
Task: "T008 src/services/aporte-service.ts"          [calculista-aporte]
```

## Implementation Strategy

### MVP First (US1 apenas)

1. Phases 1–2 (Setup + Foundational, incluindo o seed estendido)
2. Phase 3 (US1): testes de posição manual → serviço → vínculo → tela dedicada
3. **PARAR e VALIDAR**: cadastrar uma posição manual sobre o seed e conferir o déficit refletido em `/aporte`, sem esperar import
4. Demo: o problema central (CDB não vem certo no CSV) já está resolvido

### Incremental Delivery

1. + US2 (ajuste de fundo) → dashboard/histórico deixam de mostrar rentabilidade zero para fundos
2. + US3 (revisão no import) → o ritual mensal passa a incluir carry-forward sem redigitação
3. + US4 (incremento automático) → **feature completa**, ciclo aporte→incremento→próximo import fechado
4. Cada incremento passa por T030 (engenheiro-testes → guardiao-spec → gerente-release) antes de commit

## Notes

- Regra inviolável em TODAS as tasks: `valor_investido`/`valor_investido_corrigido` NUNCA entram em `PosicaoConsolidada` nem em nenhuma consulta que alimente o motor (FR-006/SC-004) — verificado explicitamente em T006, T014, T029
- O Motor de Aporte (`src/core/motor/**`) não tem nenhuma task de alteração nesta feature — research.md R1 é uma decisão de design, não uma omissão
- Testes escritos antes e devem falhar; implementação só depois
- Commits apenas com aprovação explícita do usuário (fluxo gerente-release)
