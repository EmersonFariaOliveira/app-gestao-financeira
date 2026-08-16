# Implementation Plan: Posições Manuais e Ajustes de Valor Investido

**Branch**: `002-posicoes-manuais-ajustes` | **Date**: 2026-08-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-posicoes-manuais-ajustes/spec.md`

**Autoridade**: `docs/app-gestao-aportes.md` (seções 4.1, 5.2, 6.9). Modelo de dados, regras de negócio e telas já estão fechados no doc-fonte — este plano materializa as entidades Prisma, o algoritmo de integração com o Motor de Aporte e o contrato de server actions, delegados às camadas correspondentes (`arquiteto-dados`, `calculista-aporte`, `desenvolvedor-ui`) e consolidados aqui.

## Summary

Duas capacidades complementares sobre a feature 001 (Gestão de Aportes v0+v1): (1) registrar como "posição manual" um ativo que o export do MyCapital não traz corretamente (CDBs), substituindo-o na base de cálculo do déficit; (2) corrigir o `valor_investido` de um ativo que continua vindo do CSV (fundos), sem tocar o `valor_atual`. Ambos os valores de `valor_investido` são puramente informativos — nunca entram no cálculo de déficit. Uma tela de revisão, integrada ao fluxo de import, oferece carry-forward mês a mês desses valores, e o registro de um aporte executado gera incrementos automáticos de `valor_investido` quando o alvo aportado mapeia exclusivamente um único ativo elegível (posição manual ou fundo ajustado); casos ambíguos ficam pendentes de distribuição manual.

Abordagem técnica: **o Motor de Aporte puro (`src/core/motor/**`) não é alterado** — `PosicaoConsolidada` já é agnóstica de origem, então incluir posições manuais no cálculo de déficit é inteiramente uma responsabilidade da camada de serviço (`aporte-service.ts` monta mais entradas antes de chamar `calcularAporte`). Quatro entidades Prisma novas (`posicao_manual`, `posicao_manual_valor`, `ajuste_valor_investido`, `incremento_valor_investido_pendente`) seguem as mesmas convenções da feature 001 (sem enum nativo, sem lista escalar nativa, dinheiro em centavos). Um novo campo `ativo_mapeado.ignorar_no_import` completa o de-para da tela de vínculo. A tela de revisão (6.9) é uma seção adicional dentro do mesmo card de preview de import já existente — não um wizard separado — preservando a atomicidade já garantida hoje (nada persiste antes da confirmação).

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node.js 20+ LTS — inalterado da feature 001.

**Primary Dependencies**: Next.js 15 (App Router, server actions, React 19), Prisma ORM (provider `sqlite`), Tailwind CSS 4 + shadcn/ui, Vitest — mesma stack da feature 001, sem dependência nova.

**Storage**: SQLite em arquivo único via Prisma (mesmo `data/app.db`). Nova migration adiciona 4 tabelas + 1 campo em `ativo_mapeado`, com 2 `CHECK` constraints manuais (exclusividade mútua de FK em `incremento_valor_investido_pendente`; consistência `aplicado`/`sessao_aplicacao_id`) no mesmo padrão de `sessao_import.status` (research.md R12 da feature 001).

**Testing**: Vitest. Foco desta feature: `aporte-service.ts` (montagem de `PosicaoConsolidada[]` incluindo posições manuais e excluindo `ignorar_no_import`; algoritmo de elegibilidade de incremento) e um novo `posicao-manual-service.ts` (carry-forward, consumo de pendências, CRUD). **Nenhum teste novo em `tests/motor/`** — o motor não muda (research.md R1), verificável por `git diff` vazio em `src/core/motor/`.

**Target Platform**: localhost apenas — inalterado.

**Project Type**: Web application local full-stack (mesmo projeto Next.js único da feature 001; nenhuma estrutura nova de projeto).

**Performance Goals**: cadastro de posição manual reflete no cálculo de déficit na mesma sessão de uso, sem esperar novo import (SC-001); demais metas de performance inalteradas da feature 001 (patrimônio pequeno, cálculo instantâneo).

**Constraints**: `valor_investido`/`valor_investido_corrigido` nunca lidos por nenhuma consulta que alimente o motor (FR-006/SC-004) — garantido estruturalmente por `PosicaoConsolidada` não ter esse campo; sessões de import permanecem imutáveis (o carry-forward e o consumo de pendências são sempre um novo snapshot, nunca `UPDATE` em sessão confirmada, exceto a transição binária `aplicado` de `incremento_valor_investido_pendente`, que é fila de trabalho, não snapshot histórico); dinheiro exclusivamente `Int` em centavos.

**Scale/Scope**: mesma escala single-user da feature 001; acréscimo esperado de poucas posições manuais/ajustes por usuário (ordem de dezena), sem impacto de performance.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Princípio | Avaliação | Status |
|---|---|---|---|
| I | Escopo Negativo é Lei | `valor_investido`/`valor_investido_corrigido` são explicitamente informativos — nenhuma tela ou cálculo de rentabilidade, preço médio ou performance é introduzido; nenhuma cotação em tempo real (o `valor_atual` de posições manuais é sempre digitado pelo usuário, nunca buscado). | ✅ PASS |
| II | Camadas Isoladas | Motor de Aporte não sofre nenhuma alteração (research.md R1) — verificado explicitamente pelos dois subagentes envolvidos (`calculista-aporte` confirmou por escrito em `contracts/motor-integracao.md` §1). Nenhuma lógica de CSV vaza para as novas entidades (`posicao_manual`/`ajuste_valor_investido` não têm relação com o parser). | ✅ PASS |
| III | Fonte Única da Verdade | Posições continuam só mudando via import; `valor_atual` de posição manual só muda via revisão de import (ou cadastro inicial) — nunca por `registrarAporte`, que apenas GERA a pendência de incremento, não altera valor nenhum diretamente. | ✅ PASS |
| IV | Imutabilidade e Auditabilidade | `posicao_manual_valor`/`ajuste_valor_investido` seguem o mesmo padrão de snapshot imutável por sessão de `posicao` (nunca `UPDATE`/`DELETE` após confirmação). `incremento_valor_investido_pendente` é a única exceção documentada (transição `aplicado: false→true`), pela mesma razão que dividendos têm uma transição de estado (`aporte_id: null→set`) — é fila de trabalho, não histórico de posição. | ✅ PASS |
| V | Falhar Alto, Nunca em Silêncio | Colisão de identidade `chave_manual`×`chave_export` lança erro explícito (research.md R8) em vez de somar silenciosamente. Cadastro de posição manual sem sessão vigente falha com a mesma mensagem já usada pela calculadora, em vez de criar um estado inconsistente. | ✅ PASS |
| VI | Dinheiro é Inteiro | Todos os campos monetários novos são `Int` em centavos (`valor_investido_centavos`, `valor_atual_centavos`, `valor_investido_corrigido_centavos`, `valor_incremento_centavos`) — nenhum Float em nenhuma camada, inclusive nos somatórios de incremento pendente. | ✅ PASS |
| VII | Local-First e Zero Infraestrutura | Nenhuma dependência nova, nenhum serviço externo. Migration aplicada localmente via `prisma migrate dev`, coberta pelo mesmo backup automático `.db` já existente antes de cada import. | ✅ PASS |
| VIII | Veto Humano | Toda correção de `valor_investido`/`valor_atual` é editável pelo usuário na tela de revisão antes da confirmação (FR-008); incremento automático é sempre uma sugestão pré-preenchida, nunca aplicado de forma não visível — o usuário confirma a sessão para persistir. Nenhuma integração com corretora ou execução real. | ✅ PASS |
| IX | Stack Fixa | Next.js + Prisma + SQLite, exatamente como fixado; novas entidades seguem sem enum nativo (String + CHECK) e sem lista escalar nativa — nenhum desvio de convenção introduzido. | ✅ PASS |
| X | Conflitos Resolvem-se no Spec | Toda decisão técnica em aberto (não literal no doc-fonte) foi registrada em `research.md` com racional e alternativas — nenhuma decisão de produto improvisada em código. A única divergência encontrada entre dois contratos de camadas diferentes (distribuição parcial de incremento ambíguo, research.md R5) foi reconciliada nesta fase de plano, antes de qualquer implementação. | ✅ PASS |

**Resultado pré-Phase 0**: PASS em todos os gates — sem violações a justificar.

**Re-check pós-Phase 1 (design)**: os artefatos gerados (`data-model.md`, `contracts/motor-integracao.md`, `contracts/server-actions.md`, `quickstart.md`) foram revisados contra os 10 princípios — nenhuma violação introduzida. Em particular: nenhum campo monetário não-inteiro nas 4 entidades novas; `contracts/motor-integracao.md` confirma por escrito que `src/core/motor/**` não é tocado; nenhuma action ou fluxo de UI escreve em `posicao` fora da confirmação de import; a reconciliação R5 eliminou a única divergência entre camadas antes da implementação começar. ✅ PASS

## Project Structure

### Documentation (this feature)

```text
specs/002-posicoes-manuais-ajustes/
├── plan.md                      # Este arquivo (/speckit-plan)
├── research.md                  # Phase 0 (/speckit-plan)
├── data-model.md                # Phase 1 (/speckit-plan) — entidades novas (arquiteto-dados)
├── quickstart.md                # Phase 1 (/speckit-plan)
├── contracts/                   # Phase 1 (/speckit-plan)
│   ├── motor-integracao.md      # Contrato de integração com o Motor (calculista-aporte)
│   └── server-actions.md        # Contrato das novas/estendidas server actions (desenvolvedor-ui)
├── checklists/
│   └── requirements.md
└── tasks.md                     # Phase 2 (/speckit-tasks — NÃO criado por /speckit-plan)
```

### Source Code (repository root)

```text
prisma/
├── schema.prisma                # + ativo_mapeado.ignorar_no_import
│                                 # + posicao_manual, posicao_manual_valor,
│                                 #   ajuste_valor_investido, incremento_valor_investido_pendente
└── migrations/                  # nova migration + SQL manual para os 2 CHECK novos

src/
├── app/
│   ├── vinculos/page.tsx        # + opção "Ignorar (substituído por posição manual)" (6.3)
│   ├── import/page.tsx          # + seção de revisão (6.9) no mesmo card de preview
│   ├── posicoes-manuais/        # NOVO — tela dedicada (6.9 fora do import, FR-014)
│   │   └── page.tsx
│   └── actions/
│       ├── vinculos.ts          # estende VincularAtivoInput (ignorarNoImport)
│       ├── import.ts            # estende previewImport/confirmarImport
│       └── posicoes-manuais.ts  # NOVO — CRUD de posição manual/ajuste
├── components/                  # componentes novos da tela 6.9 (linhas de revisão, destaque de ambíguo)
├── core/motor/                  # SEM ALTERAÇÃO NESTA FEATURE (research.md R1)
├── parser/                      # SEM ALTERAÇÃO NESTA FEATURE
├── services/
│   ├── aporte-service.ts        # estende montarContextoEntradaMotor (inclui posições manuais,
│   │                             #   exclui ignorar_no_import) e registrarAporte (gera incrementos)
│   ├── mapeamento-service.ts    # estende vincularAtivo (forma ignorarNoImport)
│   └── posicao-manual-service.ts # NOVO — CRUD, carry-forward, consumo de incremento pendente
└── db/client.ts                 # inalterado

tests/
├── motor/                       # SEM teste novo — verificação de que nada mudou
├── services/
│   ├── aporte-service.test.ts   # + casos: posição manual no déficit, ignorar_no_import excluído,
│   │                             #   geração de incremento (exclusivo/ambíguo/zero elegíveis)
│   └── posicao-manual-service.test.ts # NOVO — carry-forward, consumo de pendência, CRUD
```

**Structure Decision**: mesmo projeto único Next.js full-stack da feature 001 — nenhuma nova fronteira de projeto. O isolamento de camadas já verificado por lint (`src/core/**` não importa Prisma/Next/fs/`src/services`) continua válido sem nenhuma exceção nova: esta feature não introduz nenhum import de `src/core/motor` para fora de si mesmo, nem nenhuma dependência nova de `src/core/motor` para dentro. Toda a lógica nova mora em `src/services/` (I/O) e `src/app/` (UI + actions), exatamente como a feature 001 já estabeleceu.

## Complexity Tracking

Sem violações ao Constitution Check — tabela não aplicável.
