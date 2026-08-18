# Research: Análise de Rendimento da Carteira

**Input**: [spec.md](./spec.md) — todas as ambiguidades de produto já foram resolvidas em `/speckit-clarify` (seção Clarifications do spec) e na emenda de constitution (v1.1.0, Princípio I). Este documento resolve as decisões técnicas necessárias para o design (Phase 1), sem reabrir nenhuma decisão de produto já fechada.

## R1 — O Motor de Aporte (`src/core/motor/**`) não é tocado

**Decision**: Nenhum arquivo de `src/core/motor/**` é alterado por esta feature.

**Rationale**: FR-002/FR-015/FR-019 deixam explícito que rendimento nunca influencia déficit, fila, divisão ou qualquer decisão do motor — é uma leitura derivada dos snapshots de sessão, calculada inteiramente na camada de serviço (mesmo padrão que `dashboard-service.classificarPosicoesDaSessao` já usa hoje para alocação atual vs. alvo). `PosicaoConsolidada` (tipo de entrada do motor) não ganha nenhum campo novo.

**Alternatives considered**: Adicionar `valor_investido` a `PosicaoConsolidada` "só para carregar o dado" — rejeitado: violaria Princípio II (Camadas Isoladas) sem necessidade, já que nenhuma regra do motor (seção 5 do doc-fonte) lê esse campo.

## R2 — Captura de "Patrimônio Aplicado" no parser: coluna opcional, não obrigatória

**Decision**: `src/parser/mycapital.ts` passa a ler a coluna `"Patrimônio Aplicado"` e expõe `patrimonioAplicadoCentavos: number | null` em `PosicaoParseada`. A coluna **não** entra em `COLUNAS_OBRIGATORIAS` — sua ausência ou um valor não numérico/`"null"` literal resulta em `patrimonioAplicadoCentavos: null` para aquela linha, **sem invalidar o arquivo**.

**Rationale**: `COLUNAS_OBRIGATORIAS` hoje invalida o arquivo inteiro quando falta (Princípio V, "falhar alto"). Isso é correto para `Patrimônio Hoje` porque o déficit depende dele — mas rendimento (FR-002) é estritamente informativo (FR-015/FR-019) e não deve poder travar o fluxo central de import (déficit/vínculo) por um campo que nenhuma regra de negócio essencial consome. Tratar como opcional é consistente com `tipoAtivoInternacional`/`dataUltimaCotacao`, já tratados como opcionais/opacos no parser hoje. Quando `null`, a camada de serviço aplica FR-010 ("sem histórico suficiente"), nunca infere ou zera silenciosamente.

**Alternatives considered**: (a) Adicionar às `COLUNAS_OBRIGATORIAS` — rejeitado, um layout antigo do MyCapital sem essa coluna bloquearia toda a calculadora de aporte por causa de uma feature de insight, desproporcional. (b) Falhar só a linha (não o arquivo) quando ausente — rejeitado por inconsistência: o parser hoje é "tudo ou nada" por arquivo (nunca resultado parcial, contracts/parser.md); a rota de "campo opcional nulo por linha" já existe e é mais simples que introduzir uma segunda semântica de erro parcial.

**Nota para especialista-csv**: validar com um arquivo real de amostra (`docs/samples/*.csv`, se disponível localmente) o nome exato da coluna e se ela está presente em 100% das linhas ou só nalguns grupos (`Tipo de Grupo`). Se o nome divergir do assumido aqui (`"Patrimônio Aplicado"`), corrigir antes da implementação — este research.md assume o nome informado pelo usuário na sessão de `/speckit-clarify`, ainda não confirmado contra um arquivo real.

## R3 — Novo campo em `posicao`: `patrimonio_investido_centavos`

**Decision**: `model posicao` ganha `patrimonio_investido_centavos Int?` (nullable — reflete `null` do parser quando a coluna está ausente/inválida naquela sessão). Snapshot imutável por sessão, mesmo padrão de `patrimonio_hoje_centavos` — nunca `UPDATE` após a sessão confirmada.

**Rationale**: Mesmo padrão de imutabilidade (Princípio IV) já usado por todo o resto de `posicao`. `Int?` (não `Int` com default 0) para diferenciar corretamente "veio zero do CSV" de "coluna ausente/inválida" — um valor investido de R$ 0,00 é teoricamente possível (ativo recém-criado sem posição ainda) e não deve ser confundido com "sem dado".

**Alternatives considered**: Tabela separada (`posicao_valor_investido`, 1:1 com `posicao`) espelhando o padrão de `posicao_manual_valor` — rejeitado: `posicao_manual_valor` existe separada porque `posicao_manual` não é filha de `sessao_import` (precisa de uma tabela de snapshot dedicada); `posicao` já É a tabela de snapshot por sessão, então um campo a mais nela é mais simples e não introduz um JOIN novo em nenhuma query existente.

## R4 — Prioridade de fonte do valor investido por ativo

**Decision**: Para um `chave_export`, em uma sessão, o valor investido usado no cálculo de rendimento é resolvido nesta ordem:
1. `ajuste_valor_investido.valor_investido_corrigido_centavos` da sessão, se existir uma linha **e** o campo não for `null` (ajuste ativo e já preenchido).
2. Caso contrário, `posicao.patrimonio_investido_centavos` da sessão (o "Patrimônio Aplicado" do CSV).
3. Se ambos ausentes/nulos → "sem histórico suficiente" (FR-010), rendimento não calculado para essa chave nessa sessão.

Para `posicao_manual`, inalterado: sempre `posicao_manual_valor.valor_investido_centavos` (feature 002).

**Rationale**: Materializa a decisão já registrada nas Assumptions do spec — o `ajuste_valor_investido` existe precisamente porque o "Patrimônio Aplicado" do CSV é conhecido-incorreto para certos ativos (ex.: fundos, onde hoje sempre vem igual ao valor atual); manter essa prioridade evita que o novo campo do CSV "reintroduza" o bug que a feature 002 já corrigiu.

**Alternatives considered**: Preferir sempre o CSV e descartar `ajuste_valor_investido` — rejeitado explicitamente pelo spec (Assumptions) e pela feature 002, que continua vigente.

## R5 — Fórmulas de rendimento (referência técnica)

**Decision** (já fechado no spec, replicado aqui como referência de implementação):

```
// Rendimento de uma sessão única (ponto no tempo):
rendimentoCentavos(t) = valorAtualCentavos(t) - valorInvestidoCentavos(t)
rendimentoPct(t) = valorInvestidoCentavos(t) > 0
  ? rendimentoCentavos(t) / valorInvestidoCentavos(t) * 100
  : null // FR-010: sem histórico suficiente, nunca 0

// Rendimento de um período [início, fim]:
deltaRendimentoCentavos = rendimentoCentavos(fim) - rendimentoCentavos(início)
rendimentoPctPeriodo = valorInvestidoCentavos(início) > 0
  ? deltaRendimentoCentavos / valorInvestidoCentavos(início) * 100
  : null
```

Válido para ativo individual, alvo (soma de `valorAtual`/`valorInvestido` dos ativos do alvo antes de aplicar a fórmula), tag (soma dos alvos do grupo), reserva de emergência e fora-da-carteira (soma dos ativos do bucket) — mesma técnica de "somar antes de aplicar a fórmula" já usada por `dashboard-service.agruparAlocacaoPorTag`.

**Rationale**: Nenhuma divisão por zero silenciosa (Princípio V); toda centavo em `Int` (Princípio VI) — a única operação de ponto flutuante é a conversão final para exibição em percentual na borda da UI, nunca em cálculo intermediário armazenado.

## R6 — Elegibilidade para validação de "movimentação não explicada" (FR-011/FR-011a) é um conjunto NOVO, diferente da elegibilidade de incremento automático (feature 002)

**Decision**: A função que determina "quantos ativos elegíveis um alvo mapeia" para FR-011/FR-011a é **nova** (`contarAtivosComValorInvestidoRastreavel`, nome de trabalho) e **não reutiliza** `aporte-service.gerarIncrementosPendentes`. Conjunto elegível (por alvo):
- toda `posicao_manual` ativa vinculada ao alvo, **e**
- todo `chave_export` vinculado ao alvo, com `fora_da_carteira = false` e `ignorar_no_import = false` — **sem exigir ajuste ativo** (diferente da feature 002).

Se `n = 1` → validação por ativo (FR-011). Se `n >= 2` → validação agregada por alvo (FR-011a). Se `n = 0` → nada a validar (alvo sem posição ainda).

**Rationale**: A elegibilidade da feature 002 (`gerarIncrementosPendentes`) responde "para qual ativo eu pré-preencho um incremento na tela de revisão?" — só faz sentido para ativos cujo valor investido é **digitado manualmente** (posição manual, ajuste). Ativos comuns do CSV não precisam de pré-preenchimento (o próprio import seguinte já traz o valor real via "Patrimônio Aplicado") mas **precisam** entrar na validação de FR-011/FR-011a, porque agora têm valor investido rastreável. Reutilizar a função da feature 002 sub-contaria os alvos (todo alvo só-CSV apareceria como `n=0`, nunca gerando alerta nem quando deveria).

**Alternatives considered**: Estender `gerarIncrementosPendentes` para também contar ativos CSV simples — rejeitado: misturaria duas responsabilidades (pré-preenchimento vs. validação) numa função já testada e em produção (feature 002); mais seguro manter as duas eligibility functions fisicamente separadas, mesmo com alguma sobreposição de critério.

## R7 — Fonte de "aportes registrados no app" para FR-011/FR-011a

**Decision**: Soma de `aporte.executado` (JSON `LinhaAporte[]`, campo `valor_centavos` agrupado por `alvo_id`), para todo `aporte` cujo `sessao_import_id` aponta para a sessão vigente **imediatamente anterior** à nova sessão sendo confirmada (a mesma sessão usada como referência do "valor investido anterior" na comparação).

**Rationale**: Replica o mesmo vínculo temporal que a feature 002 já usa para `incremento_valor_investido_pendente` (aporte calculado sobre a sessão N gera uma pendência esperada para a sessão N+1) — sem precisar de nenhuma tabela nova, já que `aporte.sessao_import_id` é permanente (Princípio IV) e nunca re-vinculado.

**Alternatives considered**: Somar por `criado_em` dentro do intervalo de datas — rejeitado pelo mesmo racional já documentado em `dashboard-service.ts` (comentário sobre "Data usada para ordenar a linha do tempo"): `criado_em` pode ficar defasado e não reflete o mês ao qual o aporte conceitualmente pertence.

## R8 — Tolerância de FR-018 (5% e R$ 20,00): constante de aplicação, não configuração de usuário nesta versão

**Decision**: Os dois valores (5%, R$ 2000 centavos) entram como constantes nomeadas no serviço de rendimento (ex.: `TOLERANCIA_MOVIMENTACAO_PCT = 5`, `TOLERANCIA_MOVIMENTACAO_PISO_CENTAVOS = 2000`), não como `config` no banco.

**Rationale**: Spec (Assumptions) deixa explícito que "tornar configurável fica a critério do planejamento técnico" — YAGNI: nenhuma tela pede esses valores hoje, e `config-service.ts` já existe caso vire necessário depois (mudança aditiva, sem migration). Evita introduzir uma tela/campo de configuração não pedida por nenhuma user story desta feature.

**Alternatives considered**: Adicionar a `config` desde já (mesma tabela chave-valor de `banda_tolerancia`) — rejeitado por escopo: nenhuma acceptance scenario pede isso editável agora; adicionar müito é sempre mais barato que remover.

## R9 — Nova rota de UI: `/rendimento`

**Decision**: Nova tela em `src/app/rendimento/page.tsx` (seção 6.10 do doc-fonte, análoga à numeração de `posicoes-manuais` como 6.9). Acessível via atalho/card no dashboard (`src/app/page.tsx`, tela 6.1) — dashboard existente não é alterado estruturalmente, só ganha um novo link.

**Rationale**: Nome curto e consistente com as rotas existentes (`/aporte`, `/alvos`, `/vinculos`, `/historico`, `/dividendos`, `/posicoes-manuais`, `/configuracoes`) — todas substantivos únicos em kebab-case. "Rendimento" é o termo usado consistentemente no spec (FR-002 em diante).

**Alternatives considered**: Expandir `/historico` em vez de criar rota nova — rejeitado: histórico (6.7) já tem três blocos (evolução patrimonial, sugerido vs. executado, sessões substituídas); acrescentar seleção de período + segmentação por bucket + gráfico de rendimento sobrecarregaria uma página já densa. Assumption do spec já registra isso como decisão (nova área, não substituição).

## R10 — Tratamento de sessões anteriores à feature (sem `patrimonio_investido_centavos`)

**Decision**: Sessões confirmadas antes desta feature têm `patrimonio_investido_centavos = null` em todas as suas `posicao` (coluna nova, sem backfill). Para essas sessões, rendimento é "sem histórico suficiente" (FR-010) — nunca um erro, nunca um valor incorreto.

**Rationale**: Consistente com SC-002 do spec ("a partir do primeiro import realizado após esta funcionalidade"). Backfill retroativo é impossível (o dado não existia na sessão original — o CSV daquele mês nunca foi reprocessado) e não foi pedido.

**Alternatives considered**: Nenhuma — comportamento já decidido no spec, apenas confirmado aqui como decisão técnica (sem migração de dado, `Int?` cobre o caso naturalmente).

## R11 — Localização da lógica de cálculo: novo `rendimento-service.ts`, não `calculista-aporte`

**Decision**: Toda a lógica de agregação/cálculo de rendimento (R5, R6, R7) mora em `src/services/rendimento-service.ts`, um serviço de leitura no mesmo padrão de `dashboard-service.ts` — não em `src/core/motor/**`.

**Rationale**: Por CLAUDE.md, `calculista-aporte` é dono de "déficit, fila de prioridade, divisão do aporte, transbordo, mínimo, arredondamento, dividendos" — rendimento não está nessa lista, e R1 já estabelece que o motor puro não muda. `dashboard-service.ts` já é o precedente direto de "cálculo de agregação read-only fora do motor, sobre dados persistidos" (ex.: `classificarPosicoesDaSessao`, `agruparAlocacaoPorTag`). Isso também define a delegação correta por CLAUDE.md: esta feature usa `arquiteto-dados` (schema/migration), `especialista-csv` (parser), `desenvolvedor-ui` (telas/actions) — e o próprio serviço de rendimento, por não ser "motor" nem "parser" nem "schema" nem "UI", é escrito diretamente (mesmo padrão que `dashboard-service.ts` já estabeleceu, que também não foi atribuído a nenhum subagente específico da tabela).

**Alternatives considered**: Colocar em `calculista-aporte`/`src/core/motor/rendimento.ts` como "motor" — rejeitado: rendimento precisa ler múltiplas sessões do banco (I/O), o que por definição não é "lógica pura sem I/O" (Princípio II); forçar isso no motor exigiria inventar uma camada de I/O dentro do motor, quebrando o isolamento que a Constitution protege.

## R12 — Ativos EXTERIOR: "Patrimônio Aplicado" tratado igual a qualquer outro grupo

**Decision**: Nenhum tratamento especial para `tipo_grupo = EXTERIOR` — mesma leitura de `patrimonio_investido_centavos`, já convertido para BRL pelo próprio CSV (mesmo padrão de `patrimonio_hoje_centavos`, doc-fonte seção 3).

**Rationale**: Consistente com a decisão já tomada para `Patrimônio Hoje` — "o motor usa uma única coluna em reais para toda a carteira, sem conversão cambial própria" se estende naturalmente ao novo campo, sem necessidade de nova decisão.

## R13 — Alerta de FR-011/FR-011a: informativo, não bloqueante

**Decision**: O alerta de movimentação não explicada aparece (a) no preview de confirmação da sessão de import (`src/app/import/page.tsx`, tela 6.2), no mesmo padrão visual do aviso de instituição faltante — aviso forte, mas **não bloqueia** a confirmação; e (b) fica revisável depois na tela de Análise de Rendimento (R9).

**Rationale**: Mesmo padrão já estabelecido pelo doc-fonte para o aviso de completude de instituições ("aviso forte + confirmação explícita — não bloquear, pois [cenário] é um caso legítimo") — aqui, o "caso legítimo" é o usuário ter feito uma movimentação fora do app de propósito (ex.: resgate de emergência). Bloquear a confirmação do import por causa disso violaria o espírito do Princípio VIII (Veto Humano: o app avisa, o usuário decide).

**Alternatives considered**: Bloquear a confirmação até o usuário "confirmar que está ciente" — rejeitado por inconsistência com o único outro precedente de aviso forte já existente no app (completude de instituições), que também não bloqueia.
