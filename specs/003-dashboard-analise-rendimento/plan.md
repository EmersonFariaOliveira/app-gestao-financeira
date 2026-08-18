# Implementation Plan: Análise de Rendimento da Carteira

**Branch**: `003-dashboard-analise-rendimento` | **Date**: 2026-08-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-dashboard-analise-rendimento/spec.md`

**Autoridade**: `docs/app-gestao-aportes.md` (nova seção 6.10, decisão a registrar como follow-up — ver Assumptions do spec.md) + `.specify/memory/constitution.md` v1.1.0 (Princípio I, exceção explícita ratificada via `/speckit-constitution` em 2026-08-18, especificamente para esta feature). Toda ambiguidade de produto já foi fechada em `/speckit-clarify` (seção Clarifications do spec.md) — este plano só resolve decisões técnicas (`research.md`).

## Summary

Uma nova área de análise ("rendimento" = `valor_atual − valor_investido`, nunca preço médio/imposto/TIR/CAGR/TWR — Constitution v1.1.0, Princípio I) permite ao usuário ver quanto sua carteira, sua reserva de emergência, cada tag/carteira, cada alvo individual e cada ativo fora da carteira ganharam ou perderam num período selecionável, com gráfico interativo de evolução. O dado vem de um campo novo do próprio CSV do MyCapital ("Patrimônio Aplicado", equivalente ao `valor_investido` já usado em posições manuais/ajustes da feature 002), capturado a cada sessão de import. Um alerta não-bloqueante avisa quando o valor investido de um ativo (ou de um alvo com múltiplos ativos) mudou mais do que os aportes registrados no app explicam — possível aporte ou resgate feito fora do fluxo do app.

Abordagem técnica: **o Motor de Aporte puro (`src/core/motor/**`) não é alterado** ([contracts/motor-nao-tocado.md](./contracts/motor-nao-tocado.md)) — toda a lógica de rendimento é leitura derivada dos snapshots já persistidos, calculada num novo `src/services/rendimento-service.ts` (mesmo padrão de `dashboard-service.ts`, não delegado a `calculista-aporte` — research.md R11). Uma única coluna nova em `posicao` (`patrimonio_investido_centavos`, nullable) captura o dado do CSV; o parser trata a coluna como opcional (nunca invalida um import por sua ausência — research.md R2). A elegibilidade usada para decidir "validar por ativo ou por alvo" no alerta de movimentação não explicada (FR-011/FR-011a) é um conjunto **novo**, mais amplo que o já usado pela feature 002 para incremento automático (research.md R6) — reflete que agora todo ativo do CSV tem valor investido rastreável, não só CDBs e fundos ajustados.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node.js 20+ LTS — inalterado das features 001/002.

**Primary Dependencies**: Next.js 15.5 (App Router, server actions, React 19), Prisma ORM 6.19 (provider `sqlite`), Recharts 3.10 (já usado em `evolucao-patrimonial-chart.tsx`/`sugerido-vs-executado-chart.tsx` — reaproveitado para o novo gráfico interativo de rendimento, US3, sem dependência nova), Tailwind CSS 4 + shadcn/ui, Vitest — mesma stack das features anteriores, **sem dependência nova**.

**Storage**: SQLite em arquivo único via Prisma (`data/app.db`). Uma única migration adiciona `posicao.patrimonio_investido_centavos Int?` — sem CHECK novo, sem tabela nova ([data-model.md](./data-model.md)).

**Testing**: Vitest. Foco desta feature: `src/parser/mycapital.ts` (captura opcional de "Patrimônio Aplicado" — [contracts/parser-patrimonio-aplicado.md](./contracts/parser-patrimonio-aplicado.md)), novo `rendimento-service.ts` (fórmulas R5, prioridade de fonte R4, elegibilidade R6, tolerância FR-018) e `import-service.ts` estendido (`movimentacoesNaoExplicadas` no preview). **Nenhum teste novo em `tests/motor/`** — o motor não muda (research.md R1), verificável por `git diff --stat src/core/motor` vazio.

**Target Platform**: localhost apenas — inalterado.

**Project Type**: Web application local full-stack (mesmo projeto Next.js único das features anteriores; nenhuma estrutura nova de projeto).

**Performance Goals**: seleção de período recalcula o gráfico e os números consolidados em poucos segundos, sem recarregar a página (SC-005) — consulta direta ao SQLite local, sem paginação necessária dado o volume single-user (dezenas de sessões, dezenas de ativos).

**Constraints**: `patrimonio_investido_centavos` nunca lido por nenhuma consulta que alimente o motor (FR-019) — garantido estruturalmente por não existir em `PosicaoConsolidada`/`EntradaMotor` ([contracts/motor-nao-tocado.md](./contracts/motor-nao-tocado.md)); percentual de rendimento nunca rotulado "rentabilidade" na UI (FR-020); sessões de import permanecem imutáveis (o campo novo é escrito uma única vez, na confirmação da sessão, nunca `UPDATE` depois); dinheiro exclusivamente `Int` em centavos, inclusive nos cálculos intermediários de rendimento (só a conversão final para `%` de exibição usa ponto flutuante, na borda da UI).

**Scale/Scope**: mesma escala single-user das features anteriores; nova tela (`/rendimento`), extensão do preview de import, sem impacto de performance.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution v1.1.0 (emendada em 2026-08-18 especificamente para esta feature, via `/speckit-constitution` — ver Sync Impact Report no topo de `.specify/memory/constitution.md`).

| # | Princípio | Avaliação | Status |
|---|---|---|---|
| I | Escopo Negativo é Lei | Rendimento é estritamente `valor_atual − valor_investido` (R$ exato) + percentual sobre o valor investido no início do período — exatamente o escopo da exceção explícita ratificada no Princípio I v1.1.0. Nenhum preço médio, imposto, TIR/XIRR/CAGR/TWR, busca automática de proventos ou recomendação de ativos é introduzido (FR-015). UI nunca chama o percentual de "rentabilidade" (FR-020). | ✅ PASS (sob a exceção v1.1.0) |
| II | Camadas Isoladas | `src/parser/mycapital.ts` continua o único módulo que interpreta colunas do CSV (nova coluna "Patrimônio Aplicado" capturada só ali — [contracts/parser-patrimonio-aplicado.md](./contracts/parser-patrimonio-aplicado.md)). Motor de Aporte não sofre nenhuma alteração ([contracts/motor-nao-tocado.md](./contracts/motor-nao-tocado.md), research.md R1/R11) — `rendimento-service.ts` é camada de serviço (I/O), nunca importado por `src/core/**`. | ✅ PASS |
| III | Fonte Única da Verdade | `patrimonio_investido_centavos` só muda via sessão de import (mesma regra de `patrimonio_hoje_centavos`); registrar um aporte executado nunca escreve em `posicao` — o alerta de movimentação não explicada (FR-011/FR-011a) é só leitura/comparação no preview, nunca escreve nada em `posicao` fora da confirmação normal do import. | ✅ PASS |
| IV | Imutabilidade e Auditabilidade | Novo campo segue o mesmo padrão de snapshot imutável de `posicao` — nunca `UPDATE` após a sessão confirmada (data-model.md). Sessões `SUBSTITUIDO` continuam fora de qualquer série de rendimento (FR-013), mesma regra já aplicada ao histórico patrimonial. `MovimentacaoNaoExplicada` é explicitamente não-persistida (FR-019) — sempre recalculável a partir dos snapshots existentes. | ✅ PASS |
| V | Falhar Alto, Nunca em Silêncio | Ausência/invalidade de "Patrimônio Aplicado" nunca falha o import inteiro nem é tratada como zero — vira `null` explícito, propagado como "sem histórico suficiente" (FR-010), nunca um valor incorreto silencioso. Divisão por valor investido zero é guardada explicitamente (`null`, nunca `Infinity`/`NaN` — research.md R5). | ✅ PASS |
| VI | Dinheiro é Inteiro | `patrimonio_investido_centavos: Int?`; todo cálculo intermediário de rendimento em centavos inteiros (research.md R5) — só a razão final para `%` de exibição usa ponto flutuante, na borda da UI, nunca armazenada nem usada em outro cálculo. | ✅ PASS |
| VII | Local-First e Zero Infraestrutura | Nenhuma dependência nova, nenhum serviço externo, nenhuma cotação em tempo real — "Patrimônio Aplicado" já vem no mesmo CSV local que o usuário já importa. Migration aplicada localmente, coberta pelo backup automático `.db` já existente antes de cada import. | ✅ PASS |
| VIII | Veto Humano | O alerta de movimentação não explicada é puramente informativo — nunca bloqueia a confirmação do import (research.md R13), mesmo padrão do aviso de instituição faltante já existente. Nenhuma integração com corretora, nenhuma execução real. | ✅ PASS |
| IX | Stack Fixa | Next.js + Prisma + SQLite, exatamente como fixado; Recharts já é dependência existente (reaproveitada, não nova); novo campo segue sem enum nativo e sem lista escalar nativa. | ✅ PASS |
| X | Conflitos Resolvem-se no Spec | Toda decisão técnica em aberto foi registrada em `research.md` com racional e alternativas. A exceção ao Princípio I foi formalizada na própria constitution (não improvisada em código) antes deste plano ser escrito — ordem exigida pelo processo de governance (`/speckit-clarify` → `/speckit-constitution` → `/speckit-plan`). | ✅ PASS |

**Resultado pré-Phase 0**: PASS em todos os gates — sem violações a justificar (Complexity Tracking vazio).

**Re-check pós-Phase 1 (design)**: os artefatos gerados (`data-model.md`, `contracts/motor-nao-tocado.md`, `contracts/parser-patrimonio-aplicado.md`, `contracts/server-actions.md`, `quickstart.md`) foram revisados contra os 10 princípios — nenhuma violação introduzida. Em particular: `patrimonio_investido_centavos` é `Int?` (nenhum Float em nenhuma camada); `contracts/motor-nao-tocado.md` confirma por escrito que `src/core/motor/**` não é tocado e explica a garantia estrutural (tipo `PosicaoConsolidada` inalterado); nenhuma action nova escreve em `posicao` fora da confirmação de import; a elegibilidade nova de R6 foi documentada como conjunto distinto da feature 002, evitando reaproveitamento incorreto de uma função já testada em produção. ✅ PASS

## Project Structure

### Documentation (this feature)

```text
specs/003-dashboard-analise-rendimento/
├── plan.md                          # Este arquivo (/speckit-plan)
├── research.md                      # Phase 0 (/speckit-plan)
├── data-model.md                    # Phase 1 (/speckit-plan) — patrimonio_investido_centavos + entidades calculadas
├── quickstart.md                    # Phase 1 (/speckit-plan)
├── contracts/                       # Phase 1 (/speckit-plan)
│   ├── motor-nao-tocado.md          # Garantia de isolamento do motor (calculista-aporte não é acionado)
│   ├── parser-patrimonio-aplicado.md # Contrato para especialista-csv
│   └── server-actions.md            # Contrato das actions novas/estendidas (desenvolvedor-ui)
├── checklists/
│   └── requirements.md
└── tasks.md                         # Phase 2 (/speckit-tasks — NÃO criado por /speckit-plan)
```

### Source Code (repository root)

```text
prisma/
├── schema.prisma                    # + posicao.patrimonio_investido_centavos (Int?)
└── migrations/                      # nova migration (sem CHECK novo)

src/
├── app/
│   ├── page.tsx                     # + card/atalho para /rendimento (tela 6.1, inalterada estruturalmente)
│   ├── import/page.tsx              # + exibição de movimentacoesNaoExplicadas no preview (tela 6.2)
│   ├── rendimento/                  # NOVO — tela 6.10
│   │   └── page.tsx
│   └── actions/
│       ├── import.ts                # previewImport retorna movimentacoesNaoExplicadas
│       └── rendimento.ts            # NOVO — dadosRendimento (única action desta feature)
├── components/
│   └── rendimento/                  # NOVO — gráfico interativo (Recharts), cards por bucket, seletor de período
├── core/motor/                      # SEM ALTERAÇÃO NESTA FEATURE (research.md R1)
├── parser/
│   ├── types.ts                     # + PosicaoParseada.patrimonioAplicadoCentavos
│   └── mycapital.ts                 # + captura opcional de "Patrimônio Aplicado" (especialista-csv)
├── services/
│   ├── import-service.ts            # + patrimonio_investido_centavos na persistência de posicao;
│   │                                 #   + cálculo de movimentacoesNaoExplicadas no preview
│   ├── aporte-service.ts            # SEM ALTERAÇÃO (gerarIncrementosPendentes não reaproveitado — R6)
│   └── rendimento-service.ts        # NOVO — fórmulas R4/R5/R6/R7, elegibilidade, tolerância FR-018
└── db/client.ts                     # inalterado

tests/
├── motor/                           # SEM teste novo — verificação de que nada mudou
├── parser/
│   └── mycapital.test.ts            # + casos de patrimonioAplicadoCentavos (contracts/parser-patrimonio-aplicado.md)
└── services/
    ├── import-service.test.ts       # + casos de movimentacoesNaoExplicadas
    └── rendimento-service.test.ts   # NOVO — fórmulas, prioridade de fonte, granularidade, tolerância
```

**Structure Decision**: mesmo projeto único Next.js full-stack das features anteriores — nenhuma nova fronteira de projeto. O isolamento de camadas já verificado por lint (`src/core/**` não importa Prisma/Next/fs/`src/services`) continua válido sem exceção nova: esta feature não introduz nenhum import de `src/core/motor` para fora de si mesmo, nem nenhuma dependência nova de `src/core/motor` para dentro. A lógica nova mora em `src/services/rendimento-service.ts` (I/O + cálculo) e `src/app/` (UI + actions), exatamente como as features 001/002 já estabeleceram — nenhuma responsabilidade nova atribuída a `calculista-aporte` (research.md R11).

## Complexity Tracking

Sem violações ao Constitution Check — tabela não aplicável.
