# Quickstart — Validação de Posições Manuais e Ajustes de Valor Investido

Guia de validação ponta a ponta. Não contém implementação — referencia [data-model.md](./data-model.md) e [contracts/](./contracts/).

## Pré-requisitos

- Ambiente da feature 001 já funcional (`npm install`, `npx prisma migrate dev`, `npm run dev`) — ver [specs/001-gestao-aportes-v0-v1/quickstart.md](../001-gestao-aportes-v0-v1/quickstart.md).
- Ao menos uma sessão de import VIGENTE já confirmada (esta feature não cria dados do zero — estende o fluxo de import existente).
- Migration desta feature aplicada (`npx prisma migrate dev`) — adiciona `ativo_mapeado.ignorar_no_import` e as 4 tabelas novas de [data-model.md](./data-model.md).

## Suíte de testes

```bash
npm test                        # vitest run — inclui services novos/estendidos
npm run lint                    # regras de isolamento de camadas (motor continua intocado — research.md R1)
```

**Resultado esperado**: `src/core/motor/**` sem nenhuma alteração de arquivo (verificável por `git diff --stat src/core/motor` vazio ao final da implementação — research.md R1); testes de `aporte-service.ts` cobrindo a montagem de `PosicaoConsolidada[]` com posições manuais incluídas e ativos `ignorar_no_import` excluídos (SC-001, SC-002, SC-004).

## Validação manual — User Story 1 (posição manual, P1)

1. **Vínculo** (`/vinculos`): num ativo pendente (ex.: um CDB do CSV), escolher "Ignorar (substituído por posição manual)" e um alvo. O ativo some do balde "pendentes" e aparece no novo balde "ignorados" (FR-001).
2. **Cadastro** (`/posicoes-manuais` ou CTA da própria tela de vínculo): "+ Nova posição manual" com o mesmo alvo, `valor_investido` e `valor_atual` informados.
3. **Calculadora** (`/aporte`): sem novo import, o déficit do alvo já reflete o `valor_atual` da posição manual (SC-001, Independent Test da US1 — research.md R7).
4. **Encerrar**: marcar a posição como encerrada; ela some da calculadora e da próxima revisão de import, mas continua visível no histórico.

## Validação manual — User Story 2 (ajuste de fundo, P2)

1. Na tela de posições manuais/ajustes, criar um ajuste para um `chave_export` de fundo já vinculado a um alvo, informando um `valor_investido_corrigido` diferente do valor do CSV.
2. Conferir no dashboard/histórico: `valor_atual` exibido continua igual ao do CSV; `valor_investido` exibido é o corrigido.
3. Rodar a calculadora antes e depois do ajuste com os mesmos dados de posição — o déficit do alvo deve ser **idêntico** nos dois casos (SC-004).

## Validação manual — User Story 3 (revisão no import, P3)

1. Com pelo menos uma posição manual e um ajuste já cadastrados, iniciar um novo import (`/import`) com os mesmos CSVs.
2. No preview, antes de confirmar, a seção de revisão (6.9) lista a posição manual e o ajuste, com `valor_investido`/`valor_atual` pré-preenchidos com os valores da sessão anterior.
3. Editar apenas o `valor_atual` da posição manual (simulando extrato bancário atualizado); confirmar o import.
4. Reabrir a revisão no import seguinte: o valor editado (não o original) aparece como base do carry-forward.

## Validação manual — User Story 4 (incremento automático, P4)

1. Registrar um aporte executado (`/aporte` → "registrar como executado") num alvo que mapeia **exclusivamente** uma posição manual ativa (nenhum outro ativo elegível nesse alvo).
2. Iniciar o próximo import: a revisão pré-preenche `valor_investido` dessa posição como anterior + valor executado, sem exigir cálculo manual (FR-011).
3. Repetir com um alvo que mapeia **dois ou mais** ativos elegíveis (ex.: dois fundos ajustados no mesmo alvo): a revisão do próximo import exibe o valor total pendente em destaque no nível do alvo, sem atribuição automática (FR-012).
4. Confirmar essa sessão sem preencher totalmente os campos daquele alvo: no import seguinte, a pendência **não** é reoferecida (aplicada integralmente na confirmação anterior — research.md R5).

## Validações específicas por comportamento crítico

| Cenário | Como validar | Esperado |
|---|---|---|
| valor_investido nunca no motor | Alterar um ajuste ou valor_investido de posição manual sem alterar valor_atual, recalcular aporte | Sugestão de divisão idêntica à anterior (SC-004) |
| Primeira aparição de ajuste | Criar `ajuste_valor_investido` pela primeira vez para um `chave_export` | Campo vazio/aviso visual na revisão, sem carry-forward (FR-009) |
| Reimport antes de confirmar | Abrir novo import, sair sem confirmar, abrir de novo | Pendências de incremento continuam disponíveis, sem duplicação (research.md R4) |
| Posição manual encerrada | Encerrar uma posição com incremento pendente ainda não aplicado | Incremento não é mais ofertado; posição não aparece na próxima revisão nem no cálculo (FR-004/FR-015) |
| Colisão de identidade | Cadastrar uma `chave_manual` igual a uma `chave_export` real do CSV | Erro explícito ao montar a calculadora, nada calculado silenciosamente (research.md R8) |
| Ativo desvinculado do alvo com ajuste | Desvincular (ou marcar fora da carteira) um `chave_export` que tem ajuste ativo | Ajuste para de aparecer no carry-forward e de ser elegível a incremento; histórico permanece consultável |

## Escopo negativo (conferir que NÃO existe)

`valor_investido` (manual ou corrigido) não deve aparecer em nenhuma consulta do Motor de Aporte nem influenciar `deficit.ts`/`fila.ts`/`divisao.ts` — `src/core/motor/**` permanece sem alterações (research.md R1). Nenhuma tela nova de rentabilidade, preço médio ou performance — `valor_investido` é puramente informativo (Princípio I, escopo negativo).
