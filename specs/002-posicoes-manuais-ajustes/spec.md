# Feature Specification: Posições Manuais e Ajustes de Valor Investido

**Feature Branch**: `002-posicoes-manuais-ajustes`

**Created**: 2026-08-16

**Status**: Draft

**Input**: User description: "Adicionar ao app de gestão de aportes a capacidade de (1) registrar posições que não vêm corretas do export do MyCapital (CDBs) como posições manuais, e (2) corrigir o valor investido de ativos cujo export vem errado (fundos de investimento) — mantendo o valor atual desses ativos vindo do CSV."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Registrar posição manual no lugar de um ativo mal importado (Priority: P1)

O usuário tem um CDB que o export do MyCapital não traz corretamente (ou não traz de forma alguma). Na tela de vínculo de ativos, ele marca o ativo do CSV como "Ignorar (substituído por posição manual)" e cadastra uma posição manual equivalente, vinculada a um alvo da carteira, com valor investido e valor atual informados por ele. A partir daí, essa posição manual passa a representar o ativo nos cálculos de déficit e alocação, no lugar do dado (incorreto) que viria do CSV.

**Why this priority**: É o problema central relatado — sem isso, CDBs distorcem silenciosamente os cálculos de déficit ou obrigam o usuário a ignorar o app para esses ativos. Sem esta capacidade, nenhuma das demais faz sentido.

**Independent Test**: Pode ser testado cadastrando uma posição manual vinculada a um alvo com valor atual conhecido e conferindo que o déficit desse alvo, na calculadora de aporte, passa a considerar esse valor exatamente como consideraria uma posição vinda do CSV.

**Acceptance Scenarios**:

1. **Given** um ativo do CSV sem posição manual associada, **When** o usuário o marca como "Ignorar (substituído por posição manual)" na tela de vínculo, **Then** o ativo passa a ser tratado como `ignorar_no_import` e some da consolidação normal do import (não gera mais alarme de "ativo novo" a cada import).
2. **Given** um ativo marcado como ignorado, **When** o usuário cadastra a posição manual correspondente (instituição, descrição, alvo, valor investido, valor atual), **Then** o valor atual dessa posição passa a compor o patrimônio do alvo vinculado na próxima calculadora de aporte, exatamente como uma posição do CSV comporia.
3. **Given** uma posição manual ativa, **When** o usuário a marca como "Encerrar", **Then** ela deixa de aparecer nas próximas revisões de import (carry-forward) e de compor o cálculo de déficit, mas seu histórico permanece consultável.

---

### User Story 2 - Corrigir o valor investido de um fundo sem alterar o valor atual (Priority: P2)

O export do MyCapital traz o valor investido de fundos de investimento sempre igual ao valor atual (não reflete o aporte real feito historicamente). O usuário corrige esse valor investido para um ativo específico do CSV, mantendo o valor atual exatamente como veio do export (esse continua confiável e usado no cálculo de déficit).

**Why this priority**: Sem valor investido correto, o dashboard e o histórico mostram rentabilidade zero para todo fundo, mascarando informação relevante — mas o problema é apenas informativo, não distorce a divisão do aporte, por isso vem depois da P1.

**Independent Test**: Pode ser testado corrigindo o valor investido de um ativo do CSV e conferindo que (a) o valor atual exibido continua idêntico ao do CSV, (b) o valor investido exibido é o corrigido, e (c) o cálculo de déficit do alvo correspondente não muda em relação ao mesmo cenário sem a correção.

**Acceptance Scenarios**:

1. **Given** um ativo do CSV (fundo) já vinculado a um alvo, **When** o usuário informa um valor investido corrigido para ele, **Then** o valor atual continua sendo o do CSV e o valor investido exibido passa a ser o valor corrigido.
2. **Given** um ativo com valor investido corrigido, **When** o motor de aporte calcula o déficit do alvo, **Then** o resultado é idêntico ao que seria obtido sem nenhuma correção de valor investido (o campo é puramente informativo).
3. **Given** um ativo do CSV que nunca recebeu correção, **When** ele aparece pela primeira vez na tela de ajustes, **Then** o campo de valor investido é exibido vazio ou com aviso visual de que o valor do CSV está incorreto, aguardando preenchimento.
4. **Given** um ativo do CSV marcado "fora da carteira alvo" (sem vínculo a nenhum alvo), **When** o usuário abre o seletor de "novo ajuste", **Then** esse ativo aparece na lista de opções (identificado como fora da carteira) e pode receber um valor investido corrigido normalmente, sem exigir vínculo a um alvo — apenas sem elegibilidade a incremento automático por aporte executado (FR-015).

---

### User Story 3 - Revisar posições manuais e ajustes antes de confirmar o import (Priority: P3)

Antes de confirmar uma nova sessão de import, o usuário revisa, numa única tela, a lista de posições manuais ativas e de ajustes de valor investido ativos, já pré-preenchida com os valores da sessão anterior (carry-forward), editando apenas o que mudou.

**Why this priority**: Reduz o atrito recorrente (mensal) de manter posições manuais e ajustes atualizados — sem isso, US1 e US2 exigiriam redigitação completa a cada mês, o que na prática levaria ao abandono da funcionalidade.

**Independent Test**: Pode ser testado confirmando uma sessão de import com posições manuais e ajustes já cadastrados na sessão anterior, e conferindo que a nova sessão chega com os mesmos valores pré-preenchidos (exceto onde há incremento pendente, ver User Story 4), exigindo edição apenas dos campos que de fato mudaram.

**Acceptance Scenarios**:

1. **Given** uma sessão de import anterior com posições manuais e ajustes cadastrados, **When** o usuário inicia um novo import, **Then** a tela de revisão (antes da confirmação da sessão) lista todas as posições manuais ativas e ajustes ativos, com `valor_investido` e `valor_atual` pré-preenchidos com os valores da sessão anterior.
2. **Given** a tela de revisão pré-preenchida, **When** o usuário edita apenas o valor atual de uma posição manual (ex.: rendimento do CDB no extrato do banco), **Then** os demais campos não editados permanecem com o valor herdado da sessão anterior.
3. **Given** a tela de revisão, **When** o usuário confirma a sessão de import, **Then** os valores exibidos (editados ou herdados) são gravados como o snapshot da nova sessão para cada posição manual e ajuste.

---

### User Story 4 - Incrementar valor investido automaticamente a partir do aporte executado (Priority: P4)

Ao registrar um aporte como executado, o valor investido das posições manuais e fundos ajustados que receberam esse aporte é incrementado automaticamente e oferecido já somado na próxima tela de revisão de import — quando o alvo aportado mapeia exclusivamente uma posição manual ou um fundo ajustado. Quando o alvo mapeia mais de um ativo elegível, o valor fica pendente de distribuição manual, destacado na tela de revisão.

**Why this priority**: É um refinamento de conveniência sobre US1+US2+US3 — automatiza a atualização mais comum (o aporte do mês), mas o app já é útil e coerente sem ela (o usuário poderia digitar o incremento manualmente na tela de revisão).

**Independent Test**: Pode ser testado registrando um aporte executado num alvo que mapeia exclusivamente uma posição manual (ou fundo ajustado), e conferindo que o próximo import chega com o valor investido correspondente pré-preenchido como "valor anterior + valor executado", sem exigir que o usuário calcule ou digite a soma.

**Acceptance Scenarios**:

1. **Given** um aporte registrado como executado num alvo que mapeia exclusivamente uma posição manual ativa, **When** o próximo import é iniciado, **Then** a tela de revisão pré-preenche o valor investido dessa posição manual como o valor anterior somado ao valor executado naquele alvo.
2. **Given** um aporte registrado como executado num alvo que mapeia exclusivamente um `chave_export` com ajuste ativo, **When** o próximo import é iniciado, **Then** a tela de revisão pré-preenche o valor investido corrigido desse ativo como o valor anterior somado ao valor executado.
3. **Given** um aporte registrado como executado num alvo que mapeia mais de um ativo elegível (posição manual e/ou fundo ajustado), **When** o próximo import é iniciado, **Then** a tela de revisão exibe o valor total pendente daquele alvo em destaque, sem atribuí-lo automaticamente a nenhum ativo específico, e permite que o usuário distribua o valor manualmente entre os campos correspondentes.
4. **Given** um incremento pendente já aplicado numa sessão de import confirmada, **When** um novo import é iniciado depois, **Then** esse incremento não é oferecido novamente (não há dupla contagem).

---

### Edge Cases

- O que acontece quando o usuário marca como "Ignorar (substituído por posição manual)" um ativo que ainda não tem posição manual cadastrada? A pendência de cadastro deve ficar visível até que uma posição manual seja criada e vinculada.
- Como o sistema trata uma posição manual encerrada (`ativo = false`) que tinha um incremento pendente ainda não aplicado? O incremento não deve mais ser oferecido para uma posição encerrada.
- O que acontece se, no mesmo mês, o usuário reimporta uma nova sessão antes de confirmar a anterior — os incrementos pendentes já aplicados na sessão substituída são reaplicados ou preservados na nova sessão vigente?
- Como o sistema se comporta na primeira sessão de import de uma posição manual recém-criada no meio do mês (fora do fluxo de import)? Não há sessão anterior para herdar valores.
- O que acontece se um ativo com ajuste de valor investido é desvinculado do alvo (fica sem alvo ou passa a "fora da carteira")? O ajuste deixa de ser relevante para o cálculo de déficit, mas o valor histórico deve continuar auditável.
- Como o sistema exibe um alvo com incremento ambíguo se o usuário distribuir apenas parte do valor pendente entre os ativos elegíveis, deixando um resto não alocado?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema MUST permitir, na tela de vínculo de ativos, marcar um ativo do CSV como "Ignorar (substituído por posição manual)", excluindo-o da consolidação normal do import sem gerar alarme de ativo novo em imports futuros.
- **FR-002**: O sistema MUST permitir cadastrar uma posição manual com instituição, descrição, alvo vinculado, valor investido e valor atual, independente do fluxo de import.
- **FR-003**: O sistema MUST incluir o valor atual de posições manuais ativas na base de cálculo do patrimônio e do déficit do alvo vinculado, com o mesmo tratamento dado a posições vindas do CSV.
- **FR-004**: O sistema MUST permitir encerrar uma posição manual (marcá-la como inativa) sem apagar seu histórico, removendo-a das próximas revisões de import e do cálculo de déficit.
- **FR-005**: O sistema MUST permitir corrigir o valor investido de um ativo do CSV (identificado pela chave do export) sem alterar o valor atual desse ativo, que continua vindo do CSV.
- **FR-006**: O sistema MUST garantir que o valor investido (manual ou corrigido) nunca seja usado no cálculo de déficit do motor de aporte — é exclusivamente informativo (dashboard e histórico).
- **FR-007**: O sistema MUST exibir, antes de confirmar uma sessão de import, uma tela de revisão listando todas as posições manuais ativas e todos os ajustes de valor investido ativos.
- **FR-008**: O sistema MUST pré-preencher, na tela de revisão, o valor investido e o valor atual de cada posição manual, e o valor investido corrigido de cada ajuste, com os valores da sessão de import vigente anterior (carry-forward), permitindo edição de qualquer campo antes da confirmação.
- **FR-009**: O sistema MUST exibir vazio (ou com aviso visual) o campo de valor investido de um ajuste na primeira vez que o ativo correspondente aparece na tela de revisão, já que não há sessão anterior da qual herdar.
- **FR-010**: O sistema MUST, ao registrar um aporte como executado, identificar para cada alvo aportado se ele mapeia exclusivamente uma única posição manual ativa ou um único `chave_export` com ajuste ativo.
- **FR-011**: O sistema MUST, quando o mapeamento for exclusivo (FR-010), gerar automaticamente um incremento pendente de valor investido com o valor executado daquele alvo, a ser aplicado como pré-preenchimento no próximo import.
- **FR-012**: O sistema MUST, quando o alvo aportado mapear mais de um ativo elegível (posição manual e/ou fundo ajustado), manter o incremento pendente no nível do alvo, sem atribuí-lo automaticamente a nenhum ativo específico, e destacá-lo na tela de revisão do próximo import para distribuição manual.
- **FR-013**: O sistema MUST marcar um incremento pendente como aplicado assim que a sessão de import correspondente for confirmada, garantindo que ele nunca seja oferecido novamente.
- **FR-014**: O sistema MUST permitir acessar e gerenciar posições manuais e ajustes de valor investido fora do fluxo de import (tela dedicada), para cadastro ou revisão a qualquer momento.
- **FR-015**: O sistema MUST bloquear a geração de incremento pendente para posições manuais encerradas ou ajustes sem vínculo de alvo ativo no momento do registro do aporte executado.

### Key Entities

- **Posição Manual**: representa um ativo que não deve vir do CSV (ex.: CDB). Tem identidade própria (chave definida pelo usuário), instituição, descrição, vínculo com um alvo da carteira e um indicador de ativa/encerrada. Seus valores (investido e atual) mudam a cada sessão de import.
- **Ajuste de Valor Investido**: corrige o valor investido de um ativo que continua vindo do CSV (ex.: fundo de investimento), identificado pela chave do export. Não duplica nem substitui o valor atual, que continua vindo do CSV.
- **Incremento de Valor Investido Pendente**: gerado ao registrar um aporte executado; representa um valor a somar ao valor investido de uma posição manual ou de um ajuste no próximo import — ou, em caso de alvo ambíguo (mais de um ativo elegível), um valor pendente de distribuição manual no nível do alvo.
- **Snapshot de Posição Manual por Sessão**: os valores (investido e atual) de cada posição manual em cada sessão de import, preservando histórico mês a mês sem sobrescrever sessões anteriores.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Um usuário consegue cadastrar uma posição manual e ver seu valor refletido no cálculo de déficit da calculadora de aporte no mesmo fluxo, sem precisar de nenhum passo fora do app.
- **SC-002**: Em 100% dos casos de ajuste de valor investido, o valor atual exibido para o ativo permanece idêntico ao valor do export do CSV daquela sessão.
- **SC-003**: Em 100% dos casos de aporte executado em alvo com mapeamento exclusivo a um único ativo elegível, o próximo import chega com o valor investido pré-preenchido já somado, sem exigir que o usuário calcule o incremento manualmente.
- **SC-004**: Nenhuma alteração de valor investido (manual ou corrigido) altera a sugestão de divisão do aporte calculada pelo motor — comparação antes/depois da correção produz o mesmo resultado.
- **SC-005**: Na revisão mensal de import, o usuário edita em média apenas os campos que de fato mudaram desde o mês anterior — nenhuma posição manual ou ajuste já cadastrado exige redigitação completa dos valores que não mudaram.

## Assumptions

- Cada posição manual está vinculada a exatamente um alvo da carteira (relação N-para-1, como nos ativos mapeados do CSV) — não há posição manual sem alvo.
- Um ajuste de valor investido pode ser criado/exibido tanto para um `chave_export` vinculado a um alvo ativo quanto para um marcado "fora da carteira" (sem alvo) — só ativos pendentes de vínculo, ignorados ou em reserva de emergência ficam de fora. O INCREMENTO AUTOMÁTICO por aporte executado, porém, continua exigindo alvo (FR-015): um ajuste fora-da-carteira nunca recebe incremento automático, só correção manual pontual. Um ajuste histórico não é apagado se o vínculo mudar depois.
- Uma posição manual encerrada não pode ser reativada — se o mesmo ativo precisar voltar a ser acompanhado, o usuário cadastra uma nova posição manual. Reativação fica fora do escopo desta funcionalidade.
- Quando não existe sessão de import anterior vigente (primeira posição manual ou primeiro ajuste cadastrado fora do fluxo de import), não há carry-forward a aplicar — os valores iniciais são os informados no cadastro.
- A tela de revisão de posições manuais e ajustes (User Story 3) é exibida mesmo quando não há nenhuma posição manual ou ajuste cadastrado, sem bloquear a confirmação da sessão de import nesse caso.
