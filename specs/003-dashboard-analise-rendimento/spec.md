# Feature Specification: Análise de Rendimento da Carteira

**Feature Branch**: `003-dashboard-analise-rendimento`

**Created**: 2026-08-18

**Status**: Draft

**Input**: User description: "Quero melhorar a qualidade do nosso dashboard, ele deve me conseguir passar mais insights, ate agora não exploramos o que podemos fazer com a diferença de dos valores investido e o valor atual dos ativos. Atualmente os dados do dash são muito bons para acompanhar a carteira alvo e ter um overview de quanto dinheiro tenho investido no geral, mas por exemplo não consigo ver quanto esta rendendo minha reserva de emergencio, quanto esta rendendo minha alocação por carteira/tag, nem dos ativos que estão fora de minha carteira. Quero que voce pense como um plataforma completa de analise dos meuns investimentos, onde eu possa selecionar coisas do tipo, selecionar o preriodo e ver quando meu dinheiro rendeu, que me mostre graficos interativos que me de insights etc."

## Clarifications

### Session 2026-08-18

- Q: Como resolver o conflito entre esta feature e o Princípio I da constitution ("Escopo Negativo é Lei", que proíbe calcular rentabilidade/performance)? → A: Emendar o Princípio I com uma exceção explícita e justificada (rendimento = diferença simples valor atual − valor investido, sem IRR/CAGR/imposto/preço médio) — via `/speckit-constitution`, antes do `/speckit-plan`.
- Q: Qual critério dispara o alerta de "movimentação não explicada" (FR-011/US4), e em que granularidade (ativo vs. alvo)? → A: Percentual relativo ao valor investido anterior do ativo/alvo (>5%) **E** piso mínimo em R$ 20,00 (as duas condições precisam ser excedidas). Granularidade: por ativo individual quando o alvo mapeia exclusivamente esse ativo; por soma de todos os ativos do alvo quando o alvo tem mais de um ativo elegível (nunca aponta um ativo específico como culpado nesse caso). O valor gravado como snapshot da sessão é sempre o valor real (CSV/ajuste/manual) — o "esperado" é só um cálculo de comparação, nunca persistido; diferenças dentro da tolerância são absorvidas silenciosamente, sem resíduo.
- Q: Sobre qual base o percentual de rendimento de um período (não de uma sessão isolada) deve ser calculado? → A: Valor investido no **início** do período: `% = (rendimento_fim_R$ − rendimento_início_R$) / valor_investido_início × 100` — evita que um aporte novo no meio do período dilua artificialmente o percentual exibido.
- Q: Essa fórmula simples é a métrica certa a exibir, frente a alternativas mais sofisticadas (rentabilidade ponderada por tempo/XIRR, usada por investidores para medir o retorno real considerando quando cada aporte foi feito)? → A: Manter a fórmula simples (rendimento em R$ sempre exato + percentual sobre o valor investido no início do período) — XIRR/TWR fica fora de escopo (reabriria a negociação do Princípio I com um pedido bem maior, e exigiria dados de fluxo de caixa com granularidade diária que o app não tem). Como contrapartida, o percentual NUNCA deve ser rotulado como "rentabilidade" na interface, para não sugerir uma precisão que a fórmula não entrega.
- Q: Os cards "Ativos fora da carteira alvo" (FR-007) e "Pendentes de vínculo" (FR-017) podem mostrar um total agregado (R$ + %) no cabeçalho, no mesmo estilo do badge que "Reserva de emergência" já mostra? → A: Sim — "sem ser somado ao rendimento por alvo/tag" (Acceptance Scenario 3 acima) e "sem influenciar o rendimento de nenhum alvo/tag" (FR-017) proíbem FUNDIR esses ativos com o rendimento de um alvo/tag, não proíbem um total agregado do PRÓPRIO bucket. Os itens continuam SEMPRE exibidos individualmente, linha a linha (nunca escondidos/substituídos pelo total); o total é só um número adicional de cabeçalho, calculado com a mesma técnica de "somar antes de aplicar a fórmula" já usada por `reservaEmergencia`/`porTag`/`consolidado` — o mesmo número que SC-006 já soma internamente para o bucket como um todo, agora exposto como campo (`foraDaCarteiraTotal`/`pendentesTotal`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ver quanto rendeu o patrimônio total num período escolhido (Priority: P1)

O usuário abre a análise de rendimento, escolhe um período (ex.: últimos 3 meses) e vê, em destaque, quanto seu patrimônio total variou em R$ e em percentual nesse intervalo — a resposta direta para "quanto meu dinheiro rendeu".

**Why this priority**: É o pedido central do usuário — hoje o dashboard mostra "quanto tenho", mas não "quanto ganhei". Sem isso, nenhuma quebra por reserva/tag/fora-da-carteira tem contexto.

**Independent Test**: Pode ser testado com duas sessões de import vigentes de meses diferentes já com o campo de valor investido capturado, escolhendo esse intervalo como período e conferindo que (a) o rendimento em R$ exibido é exatamente `[valor_atual(fim) - valor_investido(fim)] - [valor_atual(início) - valor_investido(início)]`, e (b) o percentual exibido é esse mesmo valor dividido pelo `valor_investido(início)`, multiplicado por 100.

**Acceptance Scenarios**:

1. **Given** ao menos duas sessões de import vigentes com dado de valor investido disponível, **When** o usuário seleciona um período entre elas, **Then** o sistema exibe o rendimento consolidado em R$ e em percentual referente a esse intervalo.
2. **Given** apenas uma sessão de import vigente, **When** o usuário abre a análise de rendimento, **Then** o sistema exibe o rendimento daquela única sessão (valor atual − valor investido) e sinaliza que não há período anterior para comparação de variação.
3. **Given** nenhuma sessão de import confirmada ainda, **When** o usuário abre a análise de rendimento, **Then** o sistema exibe um estado vazio explicativo, sem erro.

---

### User Story 2 - Ver rendimento por reserva de emergência, tag/carteira e ativos fora da carteira (Priority: P1)

O usuário quebra o rendimento consolidado por grupo: quanto rendeu a reserva de emergência, quanto rendeu cada tag/carteira (e cada alvo dentro dela) e quanto rendeu cada ativo marcado como fora da carteira alvo — os três buckets hoje mostrados só em valor absoluto no dashboard, sem indicação de ganho ou perda.

**Why this priority**: É o exemplo concreto citado pelo usuário como lacuna atual; sem quebra por grupo, o número consolidado da US1 esconde que uma parte da carteira pode estar rendendo bem e outra mal.

**Independent Test**: Pode ser testado com uma sessão contendo ao menos um ativo em cada bucket (reserva de emergência, uma tag, fora da carteira) e conferindo que o rendimento de cada bucket bate com a soma do rendimento individual dos ativos que o compõem.

**Acceptance Scenarios**:

1. **Given** posições marcadas como reserva de emergência com valor investido e valor atual conhecidos, **When** o usuário abre a análise de rendimento, **Then** o rendimento da reserva de emergência é exibido separadamente do restante da carteira.
2. **Given** alvos agrupados por tag, **When** o usuário abre a análise de rendimento, **Then** o rendimento é exibido por tag e, dentro de cada tag, por alvo individual.
3. **Given** ativos marcados como fora da carteira alvo, **When** o usuário abre a análise de rendimento, **Then** o rendimento de cada ativo fora da carteira é exibido individualmente, sem ser somado ao rendimento por alvo/tag.
4. **Given** um ativo ou alvo sem dado de valor investido suficiente no período (ex.: apareceu pela primeira vez), **When** o usuário visualiza o rendimento desse grupo, **Then** o sistema sinaliza "sem histórico suficiente" em vez de exibir um valor de rendimento incorreto ou zero.

---

### User Story 3 - Selecionar período e ver a evolução em gráfico interativo (Priority: P2)

O usuário escolhe um período (pré-definido ou customizado) e visualiza, num gráfico interativo, a evolução do valor investido, do valor atual e do rendimento ao longo do tempo, podendo passar o cursor/tocar em qualquer ponto para ver o valor exato daquela data.

**Why this priority**: Complementa US1/US2 (que dão o número do período) com a trajetória — é o pedido explícito de "gráficos interativos que me dê insights", mas depende dos cálculos de rendimento das duas primeiras histórias já existirem.

**Independent Test**: Pode ser testado com três ou mais sessões vigentes de meses diferentes, selecionando "desde o início" como período e conferindo que o gráfico exibe um ponto por sessão vigente, com valores consistentes com os exibidos textualmente em US1.

**Acceptance Scenarios**:

1. **Given** três ou mais sessões de import vigentes, **When** o usuário seleciona o período "desde o início", **Then** o gráfico exibe um ponto por sessão vigente no intervalo, ordenado cronologicamente.
2. **Given** o gráfico exibido, **When** o usuário interage com um ponto específico (hover/toque/clique), **Then** o sistema mostra o valor investido, valor atual, rendimento em R$ e em percentual daquela data.
3. **Given** os períodos pré-definidos disponíveis, **When** o usuário alterna entre eles (ex.: último mês, 3 meses, 6 meses, 12 meses), **Then** o gráfico e os números consolidados são recalculados para refletir apenas o intervalo selecionado.
4. **Given** o seletor de período, **When** o usuário informa um intervalo customizado (duas datas dentro do histórico disponível), **Then** o gráfico e os números consolidados refletem exatamente esse intervalo.

---

### User Story 4 - Ser alertado sobre movimentação de valor investido não explicada pelo app (Priority: P3)

A cada novo import, o sistema compara o valor investido esperado (o valor da sessão anterior somado a qualquer aporte registrado no app desde então) com o valor investido real que chegou nessa nova sessão, e sinaliza ao usuário quando a diferença sugere um aporte ou resgate feito fora do fluxo do app (ex.: comprou direto na corretora sem passar pela calculadora, ou resgatou parte da posição). Quando um alvo mapeia mais de um ativo elegível, a comparação é feita pela soma de todos os ativos do alvo, nunca apontando um ativo específico como responsável pela diferença.

**Why this priority**: É um insight valioso mencionado pelo próprio usuário ("validar os aportes ou resgate de um mês para o outro"), mas depende das três histórias anteriores existirem primeiro — é um refinamento de qualidade de dado sobre o rendimento já calculado, não um pré-requisito dele.

**Independent Test**: Pode ser testado registrando um aporte executado num alvo com um único ativo elegível, depois confirmando um novo import onde o valor investido real desse ativo aumenta mais do que o valor executado registrado, e conferindo que o sistema sinaliza a diferença não explicada; e, separadamente, testado com um alvo de múltiplos ativos, conferindo que a comparação usa a soma do alvo em vez de qualquer ativo isolado.

**Acceptance Scenarios**:

1. **Given** um ativo (ou alvo) cujo valor investido subiu, no novo import, dentro da tolerância de um aporte já registrado no app, **When** a sessão é confirmada, **Then** nenhum alerta de divergência é exibido, e o valor gravado como valor investido da sessão é sempre o valor real recebido (nunca o valor esperado calculado para comparação).
2. **Given** um ativo (ou alvo) cujo valor investido mudou (para mais ou para menos) além do que qualquer aporte registrado no app explica, excedendo tanto 5% do valor investido anterior quanto R$ 20,00 em módulo, **When** a sessão é confirmada, **Then** o sistema sinaliza essa diferença como possível movimentação fora do fluxo do app, indicando o valor não explicado.
3. **Given** um ativo novo (primeira aparição, sem sessão anterior), **When** a sessão é confirmada, **Then** nenhum alerta de divergência é gerado para ele (não há base de comparação).
4. **Given** um alvo que mapeia mais de um ativo elegível, **When** a soma do valor investido de todos os seus ativos diverge do esperado além da tolerância, **Then** o alerta é exibido no nível do alvo (ex.: "R$ 300 não explicados no alvo Multimercado"), sem apontar nenhum ativo específico como causa.
5. **Given** um ativo (ou alvo) cuja diferença fica abaixo de 5% do valor investido anterior OU abaixo de R$ 20,00, **When** a sessão é confirmada, **Then** nenhum alerta é exibido, mesmo que a diferença não seja exatamente zero.

---

### Edge Cases

- O que acontece com o rendimento de um ativo que muda de `chave_export` (renomeado no CSV) entre sessões? Ele aparece como ativo novo, sem histórico de rendimento anterior — mesmo comportamento já documentado para vínculos.
- Como o sistema trata um alvo cujos ativos vinculados mudaram entre sessões (ex.: um ativo foi remapeado de um alvo para outro)? O rendimento histórico por alvo/tag reflete o vínculo vigente no momento da consulta, aplicado retroativamente às sessões passadas — mesmo comportamento já usado hoje na série de patrimônio do histórico.
- O que acontece com o rendimento de uma posição manual (CDB) numa sessão em que ela não tem snapshot (`posicao_manual_valor`)? A posição é omitida do cálculo daquele período, sem gerar erro — mesmo comportamento já aplicado ao patrimônio.
- Como o sistema exibe o rendimento de um ativo com `ajuste_valor_investido` cujo valor ainda está vazio (aguardando primeiro preenchimento)? Tratado como "sem histórico suficiente", nunca como rendimento zero.
- O que acontece com ativos `ignorar_no_import`? Continuam totalmente excluídos de qualquer cálculo ou exibição de rendimento, mesma exclusão já aplicada ao patrimônio.
- Como sessões `SUBSTITUIDO` entram nos cálculos de rendimento e no gráfico de evolução? Não entram — apenas sessões `VIGENTE` compõem a série, mesma regra já aplicada ao histórico patrimonial hoje.
- O que acontece se o usuário selecionar um período customizado sem nenhuma sessão vigente dentro do intervalo? O sistema exibe um estado vazio explicativo para esse período, sem erro.
- Como o sistema trata um ativo fora da carteira alvo que deixou de existir na carteira (zerou) entre duas sessões? O rendimento é calculado até a última sessão em que o ativo teve valor, sinalizando que a posição foi encerrada/zerada.
- Como a "movimentação não explicada" (US4) é avaliada quando um alvo mapeia mais de um ativo elegível? Pela soma do valor investido de todos os ativos do alvo, nunca por ativo individual — o app não tem como saber qual ativo específico dentro do alvo recebeu o dinheiro (limitação já existente hoje na granularidade das sugestões do motor, que trabalha por alvo, não por ativo).
- O que acontece quando a diferença de valor investido está dentro da tolerância (< 5% OU < R$ 20,00)? Nenhum alerta é exibido, e o valor real (não o esperado) continua sendo o único gravado no snapshot da sessão — pequenas diferenças de arredondamento/corretagem são absorvidas sem deixar resíduo.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema MUST capturar o valor investido/aplicado de cada posição do CSV do MyCapital (campo "Patrimônio Aplicado"), preservando-o como snapshot imutável por sessão de import, no mesmo padrão já usado para o valor de mercado atual.
- **FR-002**: O sistema MUST calcular o rendimento de um ativo, alvo, tag, reserva de emergência ou ativo fora da carteira como a diferença entre o valor atual e o valor investido, em R$ e em percentual, para uma sessão específica (percentual = rendimento em R$ dividido pelo valor investido daquela sessão) ou para a variação entre duas sessões (percentual = variação do rendimento em R$ dividida pelo valor investido da sessão inicial do período — nunca pelo valor investido do fim, para não diluir o percentual quando há aportes novos no meio do período).
- **FR-003**: Para um ativo com `ajuste_valor_investido` ativo, o sistema MUST usar o valor investido corrigido no lugar do valor investido bruto do CSV no cálculo de rendimento — mesma prioridade de correção já aplicada hoje a esses ativos.
- **FR-004**: Para posições manuais (CDBs e afins), o sistema MUST continuar usando o `valor_investido` informado manualmente pelo usuário no cálculo de rendimento, sem alteração no fluxo de cadastro existente.
- **FR-005**: O usuário MUST conseguir selecionar um período de análise entre duas sessões de import vigentes (ou entre uma sessão e a mais recente disponível) para visualizar o rendimento consolidado do patrimônio total.
- **FR-006**: O sistema MUST oferecer, no mínimo, os períodos pré-definidos: último mês, últimos 3 meses, últimos 6 meses, últimos 12 meses e desde a primeira sessão vigente, além de um intervalo customizado por data.
- **FR-007**: O usuário MUST conseguir visualizar o rendimento (R$ e %) segmentado por reserva de emergência, por cada tag/carteira, por cada alvo individual dentro de uma tag, e por cada ativo marcado como fora da carteira alvo.
- **FR-008**: O sistema MUST exibir a evolução do valor investido, valor atual e rendimento ao longo do tempo num gráfico interativo, com um ponto por sessão de import vigente dentro do período selecionado.
- **FR-009**: O usuário MUST conseguir ver o valor exato (valor investido, valor atual, rendimento em R$ e %, data) de qualquer ponto do gráfico ao interagir com ele.
- **FR-010**: O sistema MUST sinalizar quando um ativo, alvo ou posição manual não tiver dado de valor investido suficiente para calcular rendimento no período selecionado (ex.: ativo novo, ajuste ainda sem valor preenchido), em vez de exibir um valor de rendimento incorreto ou zero.
- **FR-011**: A cada novo import confirmado, para um ativo cujo alvo mapeia exclusivamente esse ativo, o sistema MUST comparar o valor investido esperado (sessão vigente anterior somada a aportes registrados no app desde então para esse ativo) com o valor investido real recebido na nova sessão, e sinalizar ao usuário quando a diferença exceder a tolerância (FR-018).
- **FR-011a**: A cada novo import confirmado, para um alvo que mapeia mais de um ativo elegível, o sistema MUST comparar a soma do valor investido esperado de todos os seus ativos com a soma do valor investido real recebido na nova sessão, e sinalizar a diferença no nível do alvo (nunca apontando um ativo individual) quando exceder a tolerância (FR-018).
- **FR-012**: Ativos marcados `ignorar_no_import` MUST continuar excluídos de todos os cálculos e exibições de rendimento, mesma exclusão já aplicada ao patrimônio.
- **FR-013**: Sessões `SUBSTITUIDO` MUST NOT entrar na série de rendimento ao longo do tempo nem no gráfico de evolução — apenas sessões `VIGENTE`, mesma regra já aplicada ao histórico patrimonial.
- **FR-014**: O rendimento consolidado do patrimônio total exibido MUST ser consistente com a soma dos rendimentos dos buckets individuais (reserva de emergência + cada tag + fora da carteira + pendentes com dado disponível).
- **FR-015**: O sistema MUST NOT calcular preço médio, imposto, taxa de retorno anualizada (TIR/CAGR) ou qualquer métrica de rentabilidade regulatória — o rendimento desta funcionalidade é estritamente a diferença simples entre valor investido e valor atual, não uma substituição do cálculo de rentabilidade do MyCapital.
- **FR-016**: O usuário MUST conseguir acessar a análise de rendimento a partir do dashboard atual, sem perder a visão existente de alocação atual vs. alvo.
- **FR-017**: Ativos pendentes de vínculo MUST ser exibidos à parte na análise de rendimento, sem influenciar o rendimento de nenhum alvo/tag, mesma regra de exclusão já aplicada ao dashboard atual.
- **FR-018**: O sistema MUST sinalizar uma movimentação como "não explicada" (FR-011/FR-011a) somente quando a diferença exceder **simultaneamente** 5% do valor investido anterior (do ativo ou da soma do alvo, conforme o caso) **e** R$ 20,00 em módulo — ambas as condições precisam ser excedidas; diferenças abaixo de qualquer uma delas não geram alerta.
- **FR-019**: O valor investido gravado como snapshot de cada sessão MUST ser sempre o valor real recebido (do CSV, do ajuste corrigido ou informado manualmente) — o valor "esperado" usado na comparação de FR-011/FR-011a é puramente um cálculo de exibição para o alerta, nunca persistido nem usado para corrigir o valor real.
- **FR-020**: A interface MUST NOT rotular o percentual de rendimento (FR-002) como "rentabilidade" — usar terminologia como "ganho sobre capital investido" ou equivalente, deixando claro que é uma razão simples sobre o valor investido no início do período, não uma métrica ponderada por tempo (TWR/XIRR).

### Key Entities

- **Valor Investido do CSV (novo dado capturado)**: campo "Patrimônio Aplicado" do export do MyCapital, capturado por posição a cada sessão de import, ao lado do valor de mercado já existente — equivalente conceitual ao `valor_investido` já usado em posições manuais e ajustes.
- **Rendimento (conceito calculado, não persistido)**: diferença entre valor atual e valor investido de um ativo, alvo, tag, reserva de emergência ou ativo fora da carteira, num ponto no tempo ou entre dois pontos — sempre derivado dos snapshots de sessão já existentes, nunca uma métrica de rentabilidade anualizada.
- **Movimentação Não Explicada (conceito calculado, não persistido)**: diferença entre o valor investido esperado (snapshot anterior + aportes registrados no app) e o valor investido real recebido na nova sessão — calculada por ativo individual quando seu alvo é exclusivo, ou pela soma de todos os ativos do alvo quando ele é compartilhado por vários; só sinalizada quando excede 5% e R$ 20,00 simultaneamente (FR-018); usada para indicar possíveis aportes ou resgates feitos fora do fluxo do app.
- **Período de Análise**: intervalo entre duas sessões de import vigentes (ou entre uma sessão e a mais recente disponível), usado para consolidar rendimento e alimentar o gráfico de evolução.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Um usuário consegue ver o rendimento consolidado (R$ e %) de qualquer período com dado disponível em até 3 interações a partir do dashboard atual.
- **SC-002**: A partir do primeiro import realizado após esta funcionalidade, 100% dos ativos importados via CSV (exceto os marcados como ignorados) passam a ter rendimento calculável, sem exigir nenhum lançamento manual adicional do usuário.
- **SC-003**: Um usuário consegue comparar, na mesma tela, o rendimento da reserva de emergência, de cada tag/carteira e dos ativos fora da carteira alvo, sem precisar navegar entre telas diferentes.
- **SC-004**: Em 100% dos casos em que a diferença de valor investido entre duas sessões excede 5% do valor anterior e R$ 20,00 simultaneamente, sem ser explicada pelos aportes registrados no app, o sistema sinaliza a divergência automaticamente, sem exigir conferência manual do usuário — e nunca aponta um ativo individual como causa quando o alvo é compartilhado por vários ativos.
- **SC-005**: Um usuário consegue alternar entre ao menos 5 períodos (4 pré-definidos + 1 customizado) e ver o gráfico de evolução atualizado em poucos segundos, sem recarregar a página manualmente.
- **SC-006**: A soma dos rendimentos exibidos por bucket (reserva de emergência + cada tag + fora da carteira) bate exatamente com o rendimento consolidado do patrimônio total exibido para o mesmo período, em 100% dos casos com dado suficiente.

## Assumptions

- O campo "Patrimônio Aplicado" do CSV do MyCapital é a fonte primária de valor investido para ativos que vêm do CSV; onde já existe um `ajuste_valor_investido` ativo (ex.: fundos de investimento cujo "Patrimônio Aplicado" do export sempre vem igual ao valor atual), o valor corrigido continua tendo prioridade — o novo campo do CSV não substitui o mecanismo de correção já existente, apenas elimina a necessidade dele para os ativos que já vêm corretos.
- Posições manuais (CDBs) não têm "Patrimônio Aplicado" no CSV (não vêm do CSV) — seu valor investido continua sendo de responsabilidade exclusiva do usuário, sem mudança no fluxo de cadastro/carry-forward já existente (feature 002).
- A granularidade temporal do rendimento é mensal (uma sessão vigente por mês, sem dado diário) — "período" sempre se refere a um intervalo entre sessões de import vigentes, nunca a datas arbitrárias sem sessão correspondente.
- Vínculos ativo→alvo/tag usados no rendimento histórico são os vigentes no momento da consulta (não versionados por sessão) — mesmo comportamento já usado hoje na série de patrimônio do histórico (dashboard-service.dadosHistorico).
- Esta funcionalidade revisa a decisão de escopo negativo original registrada em `docs/app-gestao-aportes.md` §1 e no Princípio I da constitution (`.specify/memory/constitution.md`) — ambos dizem "não calcula rentabilidade nem performance". O rendimento aqui é estritamente uma variação simples de valor (valor atual − valor investido), não uma substituição do cálculo de rentabilidade/TIR/imposto do MyCapital (ver Clarifications). Por decisão explícita do usuário, a constitution MUST ser emendada (Princípio I, com exceção justificada) via `/speckit-constitution` antes do `/speckit-plan` desta feature; a atualização de `docs/app-gestao-aportes.md` §1 pode acompanhar essa emenda ou ficar registrada como tarefa de acompanhamento.
- A análise de rendimento é uma nova área da aplicação (extensão da seção 6 do documento de especificação), acessível a partir de um atalho no dashboard atual (tela 6.1) — a tela de overview existente (alocação atual vs. alvo) não é substituída, apenas complementada.
- A tolerância usada para sinalizar "movimentação não explicada" (US4/FR-011/FR-011a/FR-018) é 5% do valor investido anterior E R$ 20,00 em módulo, simultaneamente — valores fixos definidos nesta clarificação, não a mesma banda de tolerância de alocação (percentual sobre patrimônio) já usada no dashboard, que mede outra grandeza. Tornar esses dois números configuráveis (em vez de fixos no código) fica a critério do planejamento técnico.
- Rentabilidade ponderada por tempo (TWR) ou por fluxo de caixa (XIRR/TIR) está deliberadamente fora de escopo desta feature — o rendimento em R$ é sempre exato (valor atual − valor investido), mas o percentual é uma razão simples sobre o valor investido no início do período, não ponderada pelo momento de cada aporte dentro do período. Por isso a interface nunca chama esse percentual de "rentabilidade" (FR-020). Se essa limitação se mostrar insuficiente no uso real, XIRR/TWR fica como possível feature futura, exigindo nova negociação do Princípio I e dados de fluxo de caixa mais granulares do que o app coleta hoje.
