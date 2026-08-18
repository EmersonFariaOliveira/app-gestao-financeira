# Research — Posições Manuais e Ajustes de Valor Investido

Fase 0 do `/speckit-plan`. Todas as decisões abaixo foram produzidas pelos subagentes de camada
(`arquiteto-dados`, `calculista-aporte`, `desenvolvedor-ui`) em `data-model.md` e
`contracts/*.md` — este documento consolida as decisões técnicas em aberto (não cobertas
literalmente pela seção 4.1/5.2/6.9 do doc-fonte) no formato Decisão/Racional/Alternativas, e
resolve a única divergência encontrada entre os dois contratos (R5).

## R1 — O Motor de Aporte não muda

**Decisão**: `src/core/motor/**` permanece intocado — nenhum tipo, nenhuma regra 1-9. Toda a
integração é responsabilidade de `src/services/aporte-service.ts` (monta mais
`PosicaoConsolidada[]` antes de chamar `calcularAporte`).

**Racional**: `PosicaoConsolidada` já é agnóstica de origem (`chaveExport`, `alvoId`,
`foraDaCarteira`, `valorCentavos`, `tipoGrupo`) e não tem campo de `valor_investido` — logo
FR-006 ("valor investido nunca entra no cálculo de déficit") é garantido por construção do tipo,
não por uma checagem em runtime. Ver `contracts/motor-integracao.md` §1.

**Alternativas consideradas**: adicionar um campo `origem?: 'CSV' | 'MANUAL'` a
`PosicaoConsolidada` para o motor tratar posições manuais de forma diferenciada — rejeitada
porque nenhuma regra 1-9 precisa dessa distinção hoje; adicionar o campo sem uso violaria
YAGNI e abriria superfície para o motor um dia "vazar" lógica de origem de dado, que é
justamente o que a Camada II (Camadas Isoladas) da constitution proíbe.

## R2 — Novas entidades Prisma seguem as convenções da feature 001

**Decisão**: `posicao_manual`, `posicao_manual_valor`, `ajuste_valor_investido`,
`incremento_valor_investido_pendente` — schema completo em `data-model.md` deste diretório,
seguindo exatamente as convenções já estabelecidas (sem enum nativo, sem lista escalar nativa,
`*_centavos Int`, cuid, CHECK constraints via migration SQL manual). Inclui também o campo novo
`ativo_mapeado.ignorar_no_import Boolean @default(false)`, ausente no schema atual e exigido por
FR-001.

**Racional**: manter uma única convenção de schema em todo o projeto reduz custo cognitivo e
evita que a feature 002 precise justificar um desvio de padrão perante o Constitution Check
(Princípio IX — Stack Fixa).

**Alternativas consideradas**: modelar `posicao_manual` como uma extensão de `ativo_mapeado`
(mesma tabela, campo discriminador) — rejeitada porque `ativo_mapeado.chave_export` é `@unique`
e semanticamente atrelada ao CSV (`chave_export` "string exata da coluna Ação do CSV" —
data-model.md 001); forçar uma chave manual no mesmo campo misturaria dois conceitos de
identidade com origens diferentes, contrariando a intenção do doc-fonte (seção 4.1 já separa as
duas entidades propositalmente).

## R3 — Algoritmo de "mapeamento exclusivo" para incremento automático

**Decisão**: por alvo, o conjunto de "ativos elegíveis" é a união de (a) `posicao_manual` ativas
vinculadas ao alvo e (b) `chave_export` vinculados ao alvo (não fora-da-carteira, não
ignorados) que já têm pelo menos um `ajuste_valor_investido` histórico criado. 0 elegíveis → sem
incremento; 1 → incremento atribuído; ≥2 → incremento ambíguo no nível do alvo. Algoritmo
completo em `contracts/motor-integracao.md` §3.

**Racional**: "ajuste ativo" exige opt-in explícito do usuário (criar ao menos um
`ajuste_valor_investido`) — um `chave_export` comum do CSV, vinculado a um alvo mas nunca
"promovido" pelo usuário, não deve virar candidato a incremento automático; isso criaria um
ajuste implícito nunca pedido, violando o espírito de "correção pontual" da seção 5.2 do doc.

**Alternativas consideradas**: tratar qualquer `chave_export` vinculado ao alvo (mesmo sem
ajuste criado) como elegível — rejeitada pelo motivo acima; exigir configuração explícita de
"elegibilidade" por ativo (flag extra) — rejeitada por redundância, já que a existência de um
`ajuste_valor_investido` já é o sinal de opt-in.

## R4 — Consumo idempotente do incremento pendente (carry-forward + reimport)

**Decisão**: `incremento_valor_investido_pendente.aplicado` só transiciona para `true` dentro da
MESMA transação que confirma a nova sessão de import (nunca ao simplesmente abrir/pré-visualizar
a tela de revisão). Detalhe completo em `contracts/motor-integracao.md` §4.

**Racional**: garante por construção que (a) abandonar um import em andamento não perde nem
duplica pendências — a próxima tentativa recalcula do zero a partir do estado atual do banco; e
(b) reimportar o mesmo mês (sessão substituída) preserva o incremento já aplicado via
carry-forward comum do snapshot anterior, sem necessidade de nenhuma lógica de reconciliação
extra. Resolve os dois edge cases do spec.md sobre reimport sem código especial.

**Alternativas consideradas**: marcar `aplicado = true` assim que a pendência é exibida na
revisão (antimistura otimista) — rejeitada por poder marcar como aplicado um incremento cuja
sessão nunca chega a ser confirmada, perdendo-o silenciosamente (viola Princípio V — Falhar
Alto, Nunca em Silêncio).

## R5 — Distribuição parcial de incremento ambíguo (reconciliação entre contratos)

**Decisão**: ao confirmar a sessão, TODO `incremento_valor_investido_pendente` ambíguo exibido
na revisão é marcado `aplicado = true` integralmente, independentemente de quanto o usuário de
fato somou manualmente aos campos de `valor_investido` dos ativos daquele alvo. Não há
rastreamento de "resto não alocado" no schema.

**Racional**: este edge case não é coberto por nenhum FR do spec.md (ficou registrado lá como
edge case em aberto). Os dois contratos gerados em paralelo (`motor-integracao.md` e
`server-actions.md`) inicialmente divergiram — o primeiro assumiu aplicação binária integral
(mesmo padrão de `dividendo.aporte_id`), o segundo desenhou um mecanismo de distribuição
parcial com "resto preservado". Optou-se pela solução binária por consistência com o único
precedente já existente no código (dividendos: `utilizado` é binário, nunca fracionário) e por
não introduzir uma tabela/campo de "saldo residual" não pedido por nenhum FR. `contracts/server-actions.md`
foi ajustado para refletir esta decisão (campo `distribuicoesIncrementosAmbiguos` agora é
opcional/informativo, não persiste alocação fracionária).

**Alternativas consideradas**: aplicação parcial com campo de valor residual — rejeitada por
exigir mudança de schema não pedida por nenhum FR (over-engineering para um edge case de
frequência baixa); manter a divergência e decidir só na fase de tasks — rejeitada porque geraria
tasks conflitantes entre a camada de dados/motor e a camada de UI.

## R6 — Ponto de entrada da tela de revisão (6.9) no fluxo de import

**Decisão**: a revisão de posições manuais/ajustes entra como seção final do MESMO card de
`previewImport` (depois do diff/checagem de completude, antes do botão "Confirmar import") — não
é um passo de wizard separado.

**Racional**: replica o padrão já estabelecido em 6.2 (tudo decidido a partir de um único
preview em memória; nada persiste até a confirmação) e casa com a redação da seção 6.9 do
doc-fonte ("mesmo momento da checagem de completude").

**Alternativas consideradas**: wizard multi-etapa dedicado — rejeitada por introduzir um padrão
de navegação novo no app sem necessidade (a tela de import já é o único fluxo com múltiplas
seções condicionais, e adicionar mais uma seção é consistente com o que já existe).

## R7 — Efeito imediato de cadastro/edição fora do fluxo de import

**Decisão**: `criarPosicaoManual` e `criarOuAtualizarAjuste` (tela dedicada, FR-014), quando
executadas fora do fluxo de import, anexam o valor informado à sessão `VIGENTE` mais recente (se
existir), em vez de esperar o próximo import.

**Racional**: exigido pelo Independent Test da User Story 1 do spec.md ("cadastrando uma posição
manual... conferindo que o déficit... passa a considerar esse valor" no mesmo fluxo) e por
SC-001. Sem sessão vigente ainda, o cadastro é criado mas só aparece na calculadora após o
primeiro import (mesma exigência de sessão vigente que já vale para toda a calculadora hoje).

**Alternativas consideradas**: sempre esperar o próximo import para qualquer efeito, mesmo
cadastro dedicado — rejeitada por contradizer explicitamente o Independent Test da US1.

## R8 — Guarda de colisão de identidade `chave_manual` × `chave_export`

**Decisão**: `posicao_manual.chave_manual` ganha `@unique` no schema E a camada de serviço
verifica, antes de montar `PosicaoConsolidada[]`, que nenhuma `chave_manual` coincide com uma
`chave_export` do CSV já consolidada na mesma sessão — colisão lança erro explícito.

**Racional**: Princípio V (Falhar Alto, Nunca em Silêncio) — SQLite não valida unicidade
cross-tabela; sem a checagem em runtime, uma colisão acidental (usuário cadastra uma
`chave_manual` igual a um ticker real) somaria duas posições distintas sob a mesma chave
silenciosamente, corrompendo o déficit do alvo.

## Resumo de dependências entre camadas

```
schema (arquiteto-dados)         → data-model.md
        ↓ (FKs, campos novos)
motor-integracao (calculista-aporte) → contracts/motor-integracao.md
        ↓ (shape de PosicaoConsolidada[], algoritmo de elegibilidade)
server-actions (desenvolvedor-ui)    → contracts/server-actions.md
```

Nenhuma decisão de uma camada exigiu retrabalho nas outras, exceto R5 (reconciliação pontual,
já aplicada).
