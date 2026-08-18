# Implementation Plan: Gestão de Aportes Mensais (v0 + v1)

**Branch**: `001-gestao-aportes-v0-v1` | **Date**: 2026-07-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-gestao-aportes-v0-v1/spec.md`

**Autoridade**: `docs/app-gestao-aportes.md` (seções 3, 4, 5, 7 e 9). Todas as decisões de produto e arquitetura estão fechadas — este plano apenas as materializa e propõe as escolhas puramente técnicas deixadas em aberto (estrutura de pastas, UI, testes, parse CSV), justificadas em `research.md`.

## Summary

App local single-user que, uma vez por mês, importa CSVs do MyCapital (um por instituição, formando uma sessão de import imutável), consolida a carteira real, compara com a carteira alvo cadastrada manualmente e divide o aporte do mês entre os alvos com maior déficit em R$ — com aporte mínimo por transação, transbordo proporcional, veto humano com redistribuição, arredondamento por lote B3 e inclusão de dividendos lançados manualmente. Registro de sugerido vs. executado; posições só mudam via import.

Abordagem técnica: Next.js (App Router, server actions) + Prisma/SQLite, com quatro camadas isoladas — parser CSV (único que conhece o formato MyCapital), Motor de Aporte (lógica pura, sem I/O, testada antes de existir UI), mapeamento (de-para N-para-1) e persistência. Dinheiro trafega como inteiro em centavos em todas as camadas; percentuais como inteiro em pontos-base (bps). Ordem: v0 (parser → alvos → vínculo → calculadora) de ponta a ponta, depois v1 (snapshots/dashboard, registro sugerido/executado, arredondamento por lote, dividendos, configurações + backup JSON).

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node.js 20+ LTS

**Primary Dependencies**: Next.js 15 (App Router, server actions, React 19), Prisma ORM (provider `sqlite`), Tailwind CSS 4 + shadcn/ui (componentes copiados para o repo), Vitest (testes). Parser CSV: implementação manual, sem dependência (ver research.md R2).

**Storage**: SQLite em arquivo único local via Prisma — `DATABASE_URL="file:./data/app.db"`, fora do build, no `.gitignore`. Backups datados em `backups/` (também gitignored). Sem enums (String + CHECK constraint via migration SQL), sem listas escalares (JSON serializado em String).

**Testing**: Vitest. Motor: casos sintéticos "carteira X + aporte Y ⇒ divisão Z" derivados das regras 1–9 da seção 5 + 5.1, sem banco/rede/parser. Parser: fixtures reais de `docs/samples/` (Itaú, Nubank, Avenue) + casos de erro (coluna faltante, BOM, `null` literal, arquivo vazio). Serviços: testes de integração com SQLite temporário. Testes de UI têm prioridade mínima.

**Target Platform**: localhost apenas (máquina do usuário, Windows/macOS/Linux via `npm run dev` ou build local). Sem autenticação, sem serviços externos, sem chamadas de rede em runtime.

**Project Type**: Web application local full-stack (um único projeto Next.js).

**Performance Goals**: ritual mensal completo em ~5 min (SC-001); parse + preview de 3 CSVs em < 2 s; cálculo do motor instantâneo (< 50 ms para ~20 ativos); telas respondem sem loading perceptível (dados locais).

**Constraints**: dinheiro exclusivamente como Int em centavos (float proibido, inclusive em cálculos intermediários); percentuais como Int em bps; sessões de import imutáveis (nunca DELETE/UPDATE de posições — apenas transição de status VIGENTE→SUBSTITUIDO); erros de parse com linha/coluna e abort sem persistência parcial; calculadora bloqueada com vínculos pendentes; backup do `.db` antes de cada confirmação de import (retenção padrão 12).

**Scale/Scope**: single-user, ~20 ativos, ~3 instituições, 12 sessões/ano, 8 telas (dashboard, import, vínculos, alvos, calculadora, dividendos, histórico, configurações).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Princípio | Avaliação | Status |
|---|---|---|---|
| I | Escopo Negativo é Lei | Plano não inclui cotações em tempo real, preço médio, imposto, rentabilidade, proventos automáticos nem recomendação de ativos. Non-goals transcritos no spec e reforçados no quickstart. | ✅ PASS |
| II | Camadas Isoladas | Estrutura de pastas separa `src/parser/` (único módulo que conhece o CSV), `src/core/motor/` (puro, sem imports de Prisma/Next/fs), `src/services/` (orquestração + mapeamento) e `src/db/`. Isolamento reforçado por regras ESLint `no-restricted-imports` (research.md R7). Testes do motor sem banco/rede/parser. | ✅ PASS |
| III | Fonte Única da Verdade | `registrarAporte` grava apenas o registro do aporte — nenhum caminho de código atualiza `posicao`. Posições só nascem em `confirmarImport`. | ✅ PASS |
| IV | Imutabilidade e Auditabilidade | Sessões nunca deletadas/sobrescritas; transição única VIGENTE→SUBSTITUIDO em transação. Aporte com FK permanente à sessão do cálculo. Dividendo utilizado ganha `aporte_id` definitivo. Modelo de dados não tem operação de UPDATE em posições nem DELETE em sessões. | ✅ PASS |
| V | Falhar Alto, Nunca em Silêncio | Contrato do parser retorna erro com arquivo/linha/coluna e aborta (nada persiste). Cabeçalho inesperado = erro imediato. Calculadora bloqueada com pendências de vínculo. | ✅ PASS |
| VI | Dinheiro é Inteiro | `*_centavos Int` em todas as tabelas; parser converte string decimal → centavos sem passar por float (research.md R5); motor opera só com inteiros; formatação R$ apenas na borda da UI. Percentuais em bps para eliminar float também nos percentuais. | ✅ PASS |
| VII | Local-First e Zero Infraestrutura | SQLite local via Prisma, sem autenticação, sem rede em runtime. Backup datado via `VACUUM INTO` antes de cada import (research.md R8), retenção configurável padrão 12. | ✅ PASS |
| VIII | Veto Humano | Motor expõe entrada `ajustesUsuario` (linhas zeradas/alteradas) e redistribui o restante pelas mesmas regras. Registro grava sugerido e executado separadamente. Nenhuma integração com corretora. | ✅ PASS |
| IX | Stack Fixa | Next.js (App Router) + Prisma + SQLite, exatamente como fixado. Sem enums nativos (String + CHECK via migration SQL), sem listas escalares (JSON em String). Escolhas em aberto (Vitest, Tailwind/shadcn, parser manual) não tocam a stack fixada. | ✅ PASS |
| X | Conflitos Resolvem-se no Spec | Plano referencia `docs/app-gestao-aportes.md` por seção em cada decisão; nenhuma decisão de produto foi improvisada. Casos da seção 7 transcritos como comportamentos críticos, não reabertos. | ✅ PASS |

**Resultado pré-Phase 0**: PASS em todos os gates — sem violações a justificar.

**Re-check pós-Phase 1 (design)**: os artefatos gerados (data-model.md, contracts/, quickstart.md) foram revisados contra os 10 princípios — nenhuma violação introduzida. Em particular: nenhum campo monetário não-inteiro no data-model; contrato do motor sem nenhum tipo de I/O; contrato do parser é o único que menciona colunas do CSV; nenhuma rota/ação que altere posições fora do import. ✅ PASS

## Project Structure

### Documentation (this feature)

```text
specs/001-gestao-aportes-v0-v1/
├── plan.md              # Este arquivo (/speckit-plan)
├── research.md          # Phase 0 (/speckit-plan)
├── data-model.md        # Phase 1 (/speckit-plan)
├── quickstart.md        # Phase 1 (/speckit-plan)
├── contracts/           # Phase 1 (/speckit-plan)
│   ├── parser.md        # Contrato do parser CSV MyCapital
│   ├── motor.md         # Contrato do Motor de Aporte (puro)
│   └── server-actions.md# Contrato das ações de servidor por tela
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — NÃO criado por /speckit-plan)
```

### Source Code (repository root)

```text
prisma/
├── schema.prisma            # modelo da seção 4 (sem enum, sem lista escalar)
└── migrations/              # inclui SQL manual p/ CHECK constraints

data/                        # app.db (gitignored)
backups/                     # app-YYYY-MM-DD.db (gitignored, retenção 12)
docs/samples/                # CSVs reais — fixtures do parser (já existem)

src/
├── app/                     # camada UI (Next.js App Router)
│   ├── layout.tsx
│   ├── page.tsx             # 6.1 Dashboard
│   ├── import/page.tsx      # 6.2 Import mensal (drag-and-drop, preview, avisos, diff)
│   ├── vinculos/page.tsx    # 6.3 Vínculo de ativos
│   ├── alvos/page.tsx       # 6.4 Carteira alvo
│   ├── aporte/page.tsx      # 6.5 Calculadora (tela-coração)
│   ├── dividendos/page.tsx  # 6.6 Dividendos
│   ├── historico/page.tsx   # 6.7 Histórico
│   ├── configuracoes/page.tsx # 6.8 Configurações
│   └── actions/             # server actions — borda UI ↔ serviços
│       ├── import.ts
│       ├── vinculos.ts
│       ├── alvos.ts
│       ├── aporte.ts
│       ├── dividendos.ts
│       └── config.ts
├── components/              # componentes React (shadcn/ui copiados + próprios)
├── core/                    # LÓGICA PURA — proibido importar Prisma/Next/fs
│   ├── motor/               # Motor de Aporte (regras 1–9 + 5.1)
│   │   ├── types.ts         # tipos de entrada/saída (contracts/motor.md)
│   │   ├── deficit.ts       # regra 1 (+ regra 4: exclusão fora-da-carteira)
│   │   ├── fila.ts          # regra 2
│   │   ├── divisao.ts       # regras 3, 5, 6 (transbordo, mínimo, redistribuição)
│   │   ├── arredondamento.ts# regra 7 (lote B3, exceções EXTERIOR/renda fixa)
│   │   ├── simulacao.ts     # alocação "depois" + banda (regra 8, visual)
│   │   └── index.ts         # calcularAporte(input) → resultado
│   └── money/               # centavos: parse string→Int, format Int→R$, bps
├── parser/                  # ÚNICO módulo que conhece o formato MyCapital
│   ├── mycapital.ts         # BOM, ';', null literal, colunas, EXTERIOR
│   ├── instituicao.ts       # extração do nome do arquivo
│   └── types.ts             # PosicaoParseada, ParseError (linha/coluna)
├── services/                # orquestração com I/O (usa parser, motor, db)
│   ├── import-service.ts    # sessão, preview, completude, diff, vigência
│   ├── mapeamento-service.ts# de-para N-para-1, fora_da_carteira, pendências
│   ├── alvo-service.ts      # CRUD + soma 100% + vigências
│   ├── aporte-service.ts    # monta input do motor, registra sugerido/executado
│   ├── dividendo-service.ts # CRUD + disponível/utilizado
│   ├── config-service.ts    # chave-valor + export/import JSON
│   └── backup-service.ts    # VACUUM INTO datado + retenção
└── db/
    └── client.ts            # instância única do Prisma Client

tests/
├── motor/                   # unitários puros — 1+ arquivo por regra da seção 5
├── parser/                  # fixtures docs/samples/ + casos de erro sintéticos
└── services/                # integração com SQLite temporário
```

**Structure Decision**: projeto único Next.js full-stack (o app é local e single-user — separar backend/frontend seria infraestrutura sem benefício). O isolamento de camadas da seção 3 é materializado por diretórios com fronteiras verificadas por lint: `src/core/**` não importa Prisma/Next/fs/`src/services`; `src/parser/**` não importa Prisma/Next; apenas `src/parser/` menciona nomes de colunas do CSV; `src/app/**` só acessa dados via `src/app/actions/` → `src/services/`.

## Complexity Tracking

Sem violações ao Constitution Check — tabela não aplicável.
