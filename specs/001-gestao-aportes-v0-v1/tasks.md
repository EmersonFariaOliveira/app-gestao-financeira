# Tasks: Gestão de Aportes Mensais (v0 + v1)

**Input**: Design documents from `/specs/001-gestao-aportes-v0-v1/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (parser.md, motor.md, server-actions.md), quickstart.md

**Tests**: INCLUÍDOS — o documento-fonte e a constitution exigem que motor e parser nasçam testados ("o motor deve nascer testado antes de existir qualquer tela"). Testes de motor/parser são escritos ANTES da implementação e devem falhar primeiro. Testes de UI não são gerados (prioridade mínima declarada).

**Organization**: agrupado por user story do spec.md. Cada task carrega o subagente da camada responsável (regra do projeto): `[especialista-csv]`, `[calculista-aporte]`, `[arquiteto-dados]`, `[desenvolvedor-ui]`.

## Format: `[ID] [P?] [Story] [subagente] Description`

- **[P]**: paralelizável (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1–US6, mapeando ao spec.md
- Caminhos exatos em cada descrição

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: projeto Next.js inicializado com as fronteiras de camadas prontas

- [ ] T001 [desenvolvedor-ui] Inicializar projeto Next.js 15 + TypeScript strict + Tailwind CSS 4 (App Router) na raiz do repo, preservando docs/, specs/, .specify/, .claude/ e o .gitignore existente (conferir que data/, backups/ e docs/samples/ seguem ignorados)
- [ ] T002 [P] [arquiteto-dados] Instalar e configurar Prisma com provider sqlite: prisma/schema.prisma inicial vazio, .env com DATABASE_URL="file:./data/app.db", script "prisma" no package.json
- [ ] T003 [P] [calculista-aporte] Configurar Vitest (vitest.config.ts com alias @/, cobertura v8) e scripts "test"/"test:watch" no package.json
- [ ] T004 [P] [desenvolvedor-ui] Configurar regras ESLint no-restricted-imports do isolamento de camadas (research.md R7): src/core/** proíbe @prisma/*, next/*, fs, path, src/db, src/services, src/parser, src/app; src/parser/** proíbe @prisma/*, next/*, src/db, src/services; src/app/** proíbe src/db direto
- [ ] T005 [desenvolvedor-ui] Criar esqueleto de pastas do plan.md: src/core/motor/, src/core/money/, src/parser/, src/services/, src/db/, src/app/actions/, src/components/, tests/motor/, tests/parser/, tests/services/

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: schema, cliente de banco, aritmética de centavos/bps e shell do app — pré-requisitos de TODAS as stories

**⚠️ CRITICAL**: nenhuma user story começa antes desta fase terminar

- [ ] T006 [arquiteto-dados] Escrever prisma/schema.prisma completo por data-model.md: alvo, ativo_mapeado, sessao_import, posicao, aporte, dividendo, config — sem enums, sem listas escalares, dinheiro em *_centavos Int, percentuais em *_bps Int, índice (mes_referencia, status)
- [ ] T007 [arquiteto-dados] Gerar migration inicial (prisma migrate dev) e editar o SQL para adicionar CHECK (status IN ('VIGENTE','SUBSTITUIDO')) em sessao_import (research.md R12)
- [ ] T008 [P] [arquiteto-dados] Criar singleton do Prisma Client em src/db/client.ts
- [ ] T009 [P] [calculista-aporte] Implementar src/core/money/index.ts: parse string decimal→centavos sem float (aceitando ponto e vírgula decimal), format centavos→"R$ 1.234,56", helpers de bps (research.md R4/R5) — módulo puro
- [ ] T010 [P] [calculista-aporte] Testes de src/core/money em tests/core/money.test.ts: "1234.56"→123456, "1.15"→115, vírgula brasileira, truncamento/pad de casas, formato inválido ⇒ erro, ida-e-volta exata
- [ ] T011 [arquiteto-dados] Implementar src/services/config-service.ts: get/set chave-valor JSON com defaults (banda_tolerancia_bps=150, aporte_minimo_centavos=50000, retencao_backups=12)
- [ ] T012 [P] [desenvolvedor-ui] Criar shell do app: src/app/layout.tsx com navegação para as 8 telas (Dashboard, Import, Vínculos, Alvos, Aporte, Dividendos, Histórico, Configurações) e componentes shadcn/ui base copiados para src/components/
- [ ] T013 [arquiteto-dados] Criar prisma/seed.ts com dados sintéticos (alvos vigentes somando 10000 bps, sessão de import VIGENTE com posições consolidáveis, vínculos completos, 1 ativo fora-da-carteira) — habilita teste independente de US1 sem US2–US4 prontas

**Checkpoint**: `npx prisma migrate dev && npx prisma db seed` funciona; `npm test` roda money verde; app abre com navegação

---

## Phase 3: User Story 1 — Calculadora de aporte com registro sugerido vs. executado (Priority: P1) 🎯 MVP

**Goal**: dado um valor de aporte, devolver fila de déficits + divisão sugerida editável (regras 1–9), simulação do "depois" e registro de sugerido vs. executado amarrado à sessão vigente.

**Independent Test**: com o seed (T013), abrir /aporte, digitar R$ 2.000,00 e verificar as regras do motor; testes de tests/motor/ passam sem banco existir (pureza).

### Tests for User Story 1 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [ ] T014 [P] [US1] [calculista-aporte] Definir tipos do motor em src/core/motor/types.ts exatamente como contracts/motor.md (EntradaMotor, ResultadoMotor, ItemFila, LinhaDivisao, etc.)
- [ ] T015 [P] [US1] [calculista-aporte] Testes regra 1+4 (déficit; exclusão fora-da-carteira da base) em tests/motor/deficit.test.ts — inclui déficit negativo ignorado e patrimonioBase sem fora-da-carteira
- [ ] T016 [P] [US1] [calculista-aporte] Testes regra 2 (fila por déficit desc, desempate por bps desc e nome — determinismo) em tests/motor/fila.test.ts
- [ ] T017 [P] [US1] [calculista-aporte] Testes regras 3+5 (cascata, transbordo proporcional com resto ao topo, mínimo por transação realocado, aporte < mínimo ⇒ tudo no topo, 100% transbordo quando sem déficits) em tests/motor/divisao.test.ts
- [ ] T018 [P] [US1] [calculista-aporte] Testes regra 6 (veto: linha zerada, valor fixado parcial, redistribuição pelas mesmas regras, soma exata) em tests/motor/redistribuicao.test.ts
- [ ] T019 [P] [US1] [calculista-aporte] Testes regra 7 (lote B3: cotas inteiras, troco para renda fixa com maior déficit, troco registrado sem renda fixa, EXTERIOR/renda fixa isentos) em tests/motor/arredondamento.test.ts
- [ ] T020 [P] [US1] [calculista-aporte] Testes de invariantes (Σ divisão + troco = valor exato ao centavo em TODOS os cenários; nenhuma linha 0<v<mínimo; pureza/determinismo; simulação "depois" coerente) em tests/motor/invariantes.test.ts

### Implementation for User Story 1

- [ ] T021 [US1] [calculista-aporte] Implementar src/core/motor/deficit.ts (regras 1 e 4: consolidação por alvo, patrimonioBase, déficit em aritmética inteira bps)
- [ ] T022 [US1] [calculista-aporte] Implementar src/core/motor/fila.ts (regra 2 com desempate determinístico)
- [ ] T023 [US1] [calculista-aporte] Implementar src/core/motor/divisao.ts (regras 3, 5 e 6: cascata, transbordo proporcional, mínimo, ajustesUsuario com redistribuição)
- [ ] T024 [US1] [calculista-aporte] Implementar src/core/motor/arredondamento.ts (regra 7 com exceções) e src/core/motor/simulacao.ts (alocação antes/depois em bps)
- [ ] T025 [US1] [calculista-aporte] Compor calcularAporte(input) em src/core/motor/index.ts e deixar TODOS os testes de tests/motor/ verdes
- [ ] T026 [US1] [arquiteto-dados] Implementar src/services/aporte-service.ts: montar EntradaMotor da sessão VIGENTE (consolidar posições por chave, mapear vínculos, excluir fora-da-carteira, derivar rendaFixa e cotações B3 por tipo_grupo/quantidade — research.md R6), bloquear com pendências, ofertar dividendos disponíveis + troco anterior (R10); registrarAporte em transação (cria aporte + seta aporte_id nos dividendos incluídos; NUNCA escreve em posicao — regra 9)
- [ ] T027 [US1] [arquiteto-dados] Testes de integração de aporte-service com SQLite temporário em tests/services/aporte-service.test.ts: bloqueio por pendência, amarração permanente à sessão do cálculo após substituição, posições inalteradas após registro, aporte_minimo lembrado na config
- [ ] T028 [US1] [desenvolvedor-ui] Implementar server actions em src/app/actions/aporte.ts (prepararCalculadora, calcular, registrarAporte) conforme contracts/server-actions.md — sem lógica de negócio
- [ ] T029 [US1] [desenvolvedor-ui] Implementar a tela /aporte em src/app/aporte/page.tsx + componentes: input do valor + mínimo lembrado, opção de incluir dividendos/troco, fila com déficits, linhas editáveis com redistribuição, cotas + destino do troco visíveis, simulação do "depois", botão "registrar como executado", estado bloqueado com link para /vinculos

**Checkpoint**: MVP — com seed, o ritual "digitar valor → ajustar → registrar" funciona de ponta a ponta; suíte do motor verde e independente de banco

---

## Phase 4: User Story 2 — Import mensal em sessões (Priority: P2)

**Goal**: upload multi-CSV → sessão imutável com preview, aviso de substituição, checagem de completude, diff e backup automático antes de confirmar.

**Independent Test**: arrastar os CSVs reais de docs/samples/ (locais, gitignored); preview com totais corretos; segundo import do mês avisa e marca a anterior como SUBSTITUIDO sem deletar.

### Tests for User Story 2 (escrever PRIMEIRO — devem FALHAR antes da implementação)

- [ ] T030 [P] [US2] [especialista-csv] Definir tipos do parser em src/parser/types.ts exatamente como contracts/parser.md (ArquivoImport, ResultadoParse, PosicaoParseada, ErroParse com linha/coluna)
- [ ] T031 [P] [US2] [especialista-csv] Testes sintéticos de erro em tests/parser/erros.test.ts: coluna-chave faltante (erro em linha 1 com nome da coluna), "Patrimônio Hoje" null/não-numérico/negativo, arquivo vazio, só cabeçalho, com e sem BOM, todos os erros coletados (nunca parcial)
- [ ] T032 [P] [US2] [especialista-csv] Testes com fixtures reais em tests/parser/samples.test.ts: docs/samples/Itaú.csv, Nubank.csv, Avenue.csv com golden values (totais em centavos, contagem de ativos, EXTERIOR fracionado com tipoAtivoInternacional) — **skip com aviso se os arquivos não existirem** (são dados reais gitignored)
- [ ] T033 [P] [US2] [especialista-csv] Testes de extrairInstituicao em tests/parser/instituicao.test.ts: "..._Itaú.csv"→"Itaú", "Nubank.csv"→"Nubank", nome vazio ⇒ erro

### Implementation for User Story 2

- [ ] T034 [US2] [especialista-csv] Implementar src/parser/mycapital.ts e src/parser/instituicao.ts: BOM, separador ';', cabeçalho estrito, null literal, conversão a centavos via src/core/money, string opaca em tipoGrupo/tipoAtivoInternacional, dataMaisRecente — deixar tests/parser/ verde
- [ ] T035 [P] [US2] [arquiteto-dados] Implementar src/services/backup-service.ts: VACUUM INTO 'backups/app-YYYY-MM-DD.db' (sufixo -2, -3… no mesmo dia) + retenção configurável (research.md R8)
- [ ] T036 [US2] [arquiteto-dados] Implementar src/services/import-service.ts: previewImport (parse em memória, mes_referencia proposto por data_export — R9, aviso de substituição, instituições faltantes vs. sessão anterior, diff novos/sumidos/variações grandes) e confirmarImport (backup ANTES → transação: sessão VIGENTE + posições + ativo_mapeado pendentes para chaves novas + anterior do mês → SUBSTITUIDO; exige confirmação explícita se faltou instituição)
- [ ] T037 [US2] [arquiteto-dados] Testes de integração de import-service em tests/services/import-service.test.ts: re-import mesmo mês (anterior preservada como SUBSTITUIDO, uma VIGENTE por mês), mes_referencia editado no preview respeitado, instituição faltante sem confirmação ⇒ recusa, backup criado antes, consolidação por chave em instituições diferentes, erro de parse ⇒ nada persiste
- [ ] T038 [US2] [desenvolvedor-ui] Implementar server actions em src/app/actions/import.ts (previewImport com FormData/File[], confirmarImport) conforme contracts/server-actions.md
- [ ] T039 [US2] [desenvolvedor-ui] Implementar a tela /import em src/app/import/page.tsx: drag-and-drop multi-arquivo, preview (totais, qtd ativos, data das cotações, mês editável), aviso de substituição, aviso forte + confirmação explícita de instituição faltante, diff, erros de parse com linha/coluna

**Checkpoint**: import real de ponta a ponta; com US1, o ritual completo já roda com dados reais (vínculos ainda via seed/manual)

---

## Phase 5: User Story 3 — Vínculo de ativos ao alvo (Priority: P3)

**Goal**: todo ativo novo do export é resolvido (alvo existente, alvo novo, ou fora-da-carteira), com memorização e bloqueio da calculadora enquanto houver pendência.

**Independent Test**: importar CSV com ativo inédito ⇒ pendência sinalizada, três opções oferecidas, escolha memorizada, calculadora desbloqueia só ao zerar pendências.

- [ ] T040 [US3] [arquiteto-dados] Implementar src/services/mapeamento-service.ts: listar (pendentes/vinculados/fora-da-carteira), vincular a alvo existente, criar alvo na hora na vigência aberta, marcar fora-da-carteira (exclusão mútua com alvo_id), contarPendencias
- [ ] T041 [P] [US3] [arquiteto-dados] Testes de mapeamento em tests/services/mapeamento-service.test.ts: memorização entre imports (mesma chave não vira pendência de novo), mudança de grafia ⇒ nova pendência, invariante alvo_id ⊕ fora_da_carteira, N-para-1
- [ ] T042 [US3] [desenvolvedor-ui] Implementar server actions em src/app/actions/vinculos.ts (listarVinculos, vincularAtivo nas três formas)
- [ ] T043 [US3] [desenvolvedor-ui] Implementar a tela /vinculos em src/app/vinculos/page.tsx: lista chave do export → dropdown de alvos + criar alvo + fora-da-carteira; acessível também para revisão/correção
- [ ] T044 [US3] [desenvolvedor-ui] Integrar o bloqueio ponta a ponta: /aporte exibe estado bloqueado com as pendências e link para /vinculos; após resolver, desbloqueia sem passo extra (SC-008)

**Checkpoint**: primeiro import real guia o usuário pelos vínculos e libera a calculadora

---

## Phase 6: User Story 4 — Gestão da carteira alvo (Priority: P4)

**Goal**: CRUD de alvos com validação da soma em 100% e versionamento por vigência preservando o histórico.

**Independent Test**: cadastrar alvos, ver a validação de soma, acionar "a carteira mudou" e verificar vigência anterior intacta + nova aberta.

- [ ] T045 [US4] [arquiteto-dados] Implementar src/services/alvo-service.ts: CRUD na vigência aberta, validação soma = 10000 bps (±1), novaVigencia (fecha vigencia_fim de todos os abertos, clona alvos, re-aponta ativo_mapeado para os clones na mesma transação), ativos por alvo (FR-019)
- [ ] T046 [P] [US4] [arquiteto-dados] Testes de alvo-service em tests/services/alvo-service.test.ts: soma inválida sinalizada, vigência fechada é somente-leitura, clone + re-aponte de vínculos, histórico preservado
- [ ] T047 [US4] [desenvolvedor-ui] Implementar server actions em src/app/actions/alvos.ts (listarAlvos, salvarAlvo, removerAlvo, novaVigencia)
- [ ] T048 [US4] [desenvolvedor-ui] Implementar a tela /alvos em src/app/alvos/page.tsx: CRUD nome + percentual, indicador da soma (verde em 100%), botão "a carteira de referência mudou", ativos apontando para cada alvo

**Checkpoint**: v0 completo — parser, alvos, vínculo e calculadora funcionando de ponta a ponta com dados reais (seed dispensável)

---

## Phase 7: User Story 5 — Lançamento e utilização de dividendos (Priority: P5)

**Goal**: lançamento manual (ativo + mês + valor em R$), edição/exclusão enquanto disponível, inclusão no aporte com marcação definitiva (nunca oferecido duas vezes).

**Independent Test**: lançar dividendos, incluir num aporte registrado e confirmar que somem da oferta; não utilizados permanecem nos meses seguintes; re-import não os afeta.

- [ ] T049 [US5] [arquiteto-dados] Implementar src/services/dividendo-service.ts: lançar (só ativos conhecidos; múltiplos por ativo/mês), listar por mês + total disponível, editar/excluir apenas com aporte_id null, totalDisponivel compartilhado com a calculadora
- [ ] T050 [P] [US5] [arquiteto-dados] Testes de dividendo-service em tests/services/dividendo-service.test.ts: dupla contagem impossível (aporte_id definitivo), disponível não expira, edição de utilizado recusada, independência de re-imports
- [ ] T051 [US5] [desenvolvedor-ui] Implementar server actions em src/app/actions/dividendos.ts (listar, lançar, editar, excluir)
- [ ] T052 [US5] [desenvolvedor-ui] Implementar a tela /dividendos em src/app/dividendos/page.tsx: lançamento rápido (dropdown de conhecidos + mês + valor), lista do mês corrente + total acumulado, edição/exclusão
- [ ] T053 [US5] [desenvolvedor-ui] Ativar na calculadora a oferta real "incluir R$ X de dividendos ainda não utilizados" em src/app/aporte/ (o serviço T026 já suporta; ligar UI + exibir a parcela de dividendos no resumo do registro)

**Checkpoint**: dividendos alimentam o aporte sem dupla contagem

---

## Phase 8: User Story 6 — Dashboard e histórico (Priority: P6)

**Goal**: visão de 10 segundos (alocação atual vs. alvo com banda) e histórico (evolução patrimonial 1 ponto/mês, sugerido vs. executado, auditoria de substituídas).

**Independent Test**: com ≥2 sessões de meses distintos e 1 aporte registrado, dashboard mostra desvios com banda verde/vermelho e histórico mostra série mensal + comparativo.

- [ ] T054 [US6] [arquiteto-dados] Implementar leituras em src/services/dashboard-service.ts: dadosDashboard (patrimônio consolidado + data das posições, alocação atual vs. alvo em bps com banda da config — visual, regra 8; fora-da-carteira à parte; pendências) e dadosHistorico (série só de sessões VIGENTES — 1 ponto/mês, sugerido vs. executado por mês, acesso de auditoria às SUBSTITUIDAS)
- [ ] T055 [US6] [desenvolvedor-ui] Implementar o dashboard em src/app/page.tsx: patrimônio + "posições de DD/MM", barras atual vs. alvo (verde dentro da banda, vermelho fora — dataviz), fora-da-carteira à parte, atalhos "Novo import"/"Calcular aporte", alerta de pendências
- [ ] T056 [US6] [desenvolvedor-ui] Implementar o histórico em src/app/historico/page.tsx: evolução patrimonial mensal, linha do tempo sugerido vs. executado, visão de auditoria das sessões substituídas

**Checkpoint**: todas as user stories funcionais e independentes

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: configurações, backup portável e validação final do quickstart

- [ ] T057 [desenvolvedor-ui] Implementar a tela /configuracoes em src/app/configuracoes/page.tsx + src/app/actions/config.ts: banda de tolerância, aporte mínimo, retenção de backups; exibir caminhos do .db e da pasta backups/ com lembrete de backup completo
- [ ] T058 [P] [arquiteto-dados] Implementar export/import de configuração JSON (alvos + vínculos + settings) em src/services/config-service.ts — nunca toca sessões/aportes/dividendos (FR-044)
- [ ] T059 [P] [calculista-aporte] Revisar cobertura do motor contra a tabela de casos mínimos de contracts/motor.md e completar lacunas em tests/motor/
- [ ] T060 Rodar a validação manual completa de quickstart.md (ritual cronometrado com os CSVs reais locais + tabela de comportamentos críticos da seção 7) e corrigir o que falhar
- [ ] T061 Fluxo pós-implementação obrigatório do CLAUDE.md: engenheiro-testes (suíte completa + lacunas) → guardiao-spec (diff vs. spec: escopo negativo, regras intencionais, camadas) → gerente-release (propor commits e perguntar antes de commitar)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências
- **Foundational (Phase 2)**: depende de Setup — BLOQUEIA todas as stories
- **US1 (Phase 3)**: depende de Foundational (usa o seed T013 para dados). Não depende de US2–US6
- **US2 (Phase 4)**: depende de Foundational. Independente de US1 (parser/serviço/tela próprios)
- **US3 (Phase 5)**: depende de US2 (pendências nascem no confirmarImport) e toca a tela de US1 no T044
- **US4 (Phase 6)**: depende de Foundational apenas; T045 re-aponta vínculos criados por US3, mas é testável sozinha com seed
- **US5 (Phase 7)**: depende de US1 (T053 liga a oferta na calculadora); serviço/tela testáveis sozinhos após Foundational
- **US6 (Phase 8)**: depende de dados de US1/US2 para ter o que exibir; leituras próprias, sem alterar nada
- **Polish (Phase 9)**: depende das stories desejadas completas; T060/T061 por último

### Ordem sequencial recomendada (espelha o roadmap seção 9)

Setup → Foundational → **US1 (motor testado antes de qualquer tela)** → US2 → US3 → US4 (= v0 completo) → US5 → US6 → Polish (= v1)

### Parallel Opportunities

- Phase 1: T002, T003, T004 em paralelo após T001
- Phase 2: T008, T009, T010, T012 em paralelo após T006/T007
- US1: T014–T020 (todos os testes do motor) em paralelo; depois T021–T025 sequencial (mesmo módulo)
- US2: T030–T033 em paralelo; T035 em paralelo com T034
- Entre stories: após Foundational, US1 (calculista-aporte) e US2 (especialista-csv) avançam em paralelo — camadas e arquivos disjuntos
- US4 pode rodar em paralelo com US3 (serviços distintos), convergindo no re-aponte de vínculos

## Parallel Example: User Story 1

```bash
# Testes do motor primeiro, todos em paralelo (devem falhar):
Task: "T015 tests/motor/deficit.test.ts"      [calculista-aporte]
Task: "T016 tests/motor/fila.test.ts"         [calculista-aporte]
Task: "T017 tests/motor/divisao.test.ts"      [calculista-aporte]
Task: "T018 tests/motor/redistribuicao.test.ts" [calculista-aporte]
Task: "T019 tests/motor/arredondamento.test.ts" [calculista-aporte]
Task: "T020 tests/motor/invariantes.test.ts"  [calculista-aporte]

# Em paralelo com o motor (camada disjunta):
Task: "T030–T033 tests/parser/*"              [especialista-csv]
```

## Implementation Strategy

### MVP First (US1 apenas)

1. Phases 1–2 (Setup + Foundational, incluindo o seed sintético)
2. Phase 3 (US1): testes do motor → motor verde → serviço → tela
3. **PARAR e VALIDAR**: calculadora completa sobre o seed; suíte do motor roda sem banco
4. Demo: a dor central ("tenho R$ X, onde coloco?") já está resolvida com dados sintéticos

### Incremental Delivery (espelha v0 → v1)

1. + US2 (import real) → ritual com CSVs reais
2. + US3 (vínculos) → primeiro import guiado, calculadora desbloqueando
3. + US4 (alvos) → **v0 completo, seed dispensável**
4. + US5 (dividendos) + US6 (dashboard/histórico) + Polish → **v1 completo**
5. Cada incremento passa por T061 (engenheiro-testes → guardiao-spec → gerente-release) antes de commit

## Notes

- Regras invioláveis em TODAS as tasks: centavos inteiros (nunca float), sessões imutáveis, posições só mudam via import, camadas isoladas (lint T004 verifica), escopo negativo da seção 1
- Fixtures de docs/samples/ são dados reais gitignored — testes que dependem delas fazem skip com aviso (T032)
- Testes de motor/parser escritos antes e falhando; implementação só depois
- Commits apenas com aprovação explícita do usuário (fluxo gerente-release)
