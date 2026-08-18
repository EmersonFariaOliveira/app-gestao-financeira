# Quickstart — Validação da Análise de Rendimento

Guia de validação ponta a ponta. Não contém implementação — referencia [data-model.md](./data-model.md) e [contracts/](./contracts/).

## Pré-requisitos

- Ambiente das features 001/002 já funcional (`npm install`, `npx prisma migrate dev`, `npm run dev`).
- Migration desta feature aplicada (`npx prisma migrate dev`) — adiciona `posicao.patrimonio_investido_centavos` ([data-model.md](./data-model.md)).
- Pelo menos **duas** sessões de import VIGENTE confirmadas **depois** da migration (SC-002 — sessões anteriores não têm o campo novo, ver research.md R10), para validar variação de período (US1/US3).

## Suíte de testes

```bash
npm test                        # vitest run — inclui parser, rendimento-service, import-service estendido
npm run lint                    # regras de isolamento de camadas
```

**Resultado esperado**: `src/core/motor/**` sem nenhuma alteração de arquivo (`git diff --stat src/core/motor` vazio — [contracts/motor-nao-tocado.md](./contracts/motor-nao-tocado.md)); `tests/parser/` cobrindo `patrimonioAplicadoCentavos` opcional (coluna ausente, valor inválido por linha, valor válido); `tests/services/rendimento-service.test.ts` novo cobrindo as fórmulas de R5, a prioridade de fonte de R4, e a granularidade de R6.

## Validação manual — User Story 1 (rendimento consolidado por período, P1)

1. Confirmar duas sessões de import (meses diferentes) com o campo "Patrimônio Aplicado" presente no CSV.
2. Abrir `/rendimento`, selecionar o período entre essas duas sessões.
3. Conferir que o rendimento em R$ exibido é exatamente `[valorAtual(fim) − valorInvestido(fim)] − [valorAtual(início) − valorInvestido(início)]`, e o percentual é esse valor dividido por `valorInvestido(início)` (Clarifications do spec.md).
4. Com apenas uma sessão vigente disponível: abrir `/rendimento` e conferir que aparece o rendimento daquela sessão isolada, com aviso de que não há período anterior para comparação (US1, cenário 2).

## Validação manual — User Story 2 (rendimento por bucket, P1)

1. Ter ao menos um ativo em cada bucket: reserva de emergência, uma tag/alvo, e um ativo fora da carteira.
2. Em `/rendimento`, conferir que os três aparecem separadamente, cada um com seu próprio rendimento em R$/%.
3. Conferir SC-006: soma dos rendimentos dos buckets (reserva + cada tag + fora da carteira) bate com o rendimento consolidado do patrimônio total no mesmo período.
4. Incluir um ativo que apareceu pela primeira vez na sessão mais recente (sem sessão anterior) — conferir que aparece "sem histórico suficiente" no lugar de um valor de rendimento (FR-010).

## Validação manual — User Story 3 (gráfico interativo, P2)

1. Com três ou mais sessões vigentes, selecionar o período "desde o início" em `/rendimento`.
2. Conferir que o gráfico mostra um ponto por sessão vigente, ordenado cronologicamente, e que sessões `SUBSTITUIDO` não aparecem (FR-013).
3. Passar o cursor/tocar num ponto do gráfico e conferir que os valores exibidos (investido, atual, rendimento R$/%) batem com os números da mesma sessão em US1.
4. Alternar entre os períodos pré-definidos (1M/3M/6M/12M) e um intervalo customizado — conferir que o gráfico e os números consolidados são recalculados a cada troca.

## Validação manual — User Story 4 (movimentação não explicada, P3)

1. Registrar um aporte executado num alvo que mapeia **exclusivamente** um ativo com valor investido rastreável (CDB, fundo ajustado, ou ativo comum do CSV — research.md R6, diferente da elegibilidade de incremento automático da feature 002).
2. Confirmar o próximo import com o valor investido real desse ativo batendo exatamente com "anterior + aporte executado" (dentro da tolerância de FR-018) — conferir que **nenhum** alerta aparece no preview.
3. Repetir, mas editando manualmente o CSV (ou usando um ativo cujo valor investido no import realmente mudou mais do que o aporte explica) — conferir que o preview exibe o alerta de movimentação não explicada, **sem bloquear** a confirmação (research.md R13).
4. Repetir com um alvo que mapeia **dois ou mais** ativos elegíveis — conferir que o alerta (se houver) aparece no nível do alvo, nunca apontando um ativo específico (FR-011a).
5. Confirmar a sessão com uma diferença pequena (abaixo de 5% OU abaixo de R$ 20,00) — conferir que nenhum alerta aparece, e que o valor gravado é o valor real recebido, não um valor "corrigido" pelo app (FR-019).

## Validações específicas por comportamento crítico

| Cenário | Como validar | Esperado |
|---|---|---|
| Rendimento nunca no motor | Alterar `patrimonio_investido_centavos` de uma posição sem alterar `patrimonio_hoje_centavos`, recalcular aporte | Sugestão de divisão idêntica à anterior (FR-019) |
| Ajuste tem prioridade sobre CSV | Ativo com `ajuste_valor_investido` ativo e "Patrimônio Aplicado" diferente no CSV da mesma sessão | Rendimento usa o valor do ajuste, não o do CSV (R4) |
| Coluna ausente no CSV | Importar um arquivo sem a coluna "Patrimônio Aplicado" | Import continua funcionando normalmente (déficit/vínculo intactos); rendimento desses ativos aparece como "sem histórico suficiente" (research.md R2) |
| Sessão anterior à feature | Selecionar um período que inclui uma sessão confirmada antes da migration | Rendimento dessa sessão/período aparece como "sem histórico suficiente", nunca erro (research.md R10) |
| Terminologia da UI | Revisar toda tela/texto que exibe o percentual de rendimento | Nunca usa a palavra "rentabilidade" (FR-020) |
| Divisão por zero | Ativo com `valorInvestidoCentavos = 0` numa sessão | `rendimentoPct: null`, nunca `Infinity`/`NaN`/0 enganoso (R5) |

## Escopo negativo (conferir que NÃO existe)

`src/core/motor/**` permanece sem alterações ([contracts/motor-nao-tocado.md](./contracts/motor-nao-tocado.md)). Nenhuma tela calcula preço médio, imposto, TIR/XIRR/CAGR/TWR ou qualquer rentabilidade ponderada por tempo — apenas a diferença simples `valor_atual − valor_investido` (Constitution v1.1.0, Princípio I, exceção explícita). Nenhum termo "rentabilidade" na interface (FR-020). A calculadora de aporte (`/aporte`) continua bloqueada apenas por pendência de vínculo — nunca por movimentação não explicada (US4 é sempre informativo, nunca bloqueante).
