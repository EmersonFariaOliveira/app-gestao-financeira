# Feature Specification: Gestão de Aportes Mensais (v0 + v1)

**Feature Branch**: `001-gestao-aportes-v0-v1`

**Created**: 2026-07-29

**Status**: Draft

**Input**: User description: "App local, single-user, de gestão de aportes mensais de investimentos. Uma vez por mês, o usuário exporta CSVs da plataforma MyCapital (um por instituição financeira), arrasta para o app, digita quanto quer aportar, e recebe uma sugestão de divisão desse valor entre os ativos mais abaixo da meta — editável antes de registrar. Cobre v0 + v1 do roadmap (seção 9 de docs/app-gestao-aportes.md, autoridade final do projeto)."

> **Autoridade**: `docs/app-gestao-aportes.md` é a fonte da verdade deste projeto. Este spec transcreve e organiza o conteúdo daquele documento para as fases v0 + v1; em caso de divergência, o documento prevalece e este spec deve ser corrigido.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Calculadora de aporte com registro sugerido vs. executado (Priority: P1)

Com a carteira consolidada e os alvos cadastrados, o usuário informa quanto tem para aportar no mês (ex.: R$ 2.000) e, opcionalmente, inclui dividendos ainda não utilizados. O app devolve a fila de prioridade por déficit e a divisão sugerida do aporte, concentrada nos 1–3 alvos mais abaixo da meta, respeitando o aporte mínimo por transação. O usuário pode zerar ou alterar qualquer linha (veto humano) — o restante é redistribuído pelas mesmas regras. Para ativos B3, os valores são arredondados por lote (cotas inteiras) com destino do troco visível. Uma simulação mostra como ficaria a alocação "depois" do aporte. Ao registrar, o app grava tanto a sugestão quanto o que o usuário declarou ter executado.

**Why this priority**: É a tela-coração — responde à única pergunta que o app existe para responder: "tenho R$ X, em quais ativos coloco e quanto em cada um?". Sem ela não há produto.

**Independent Test**: Com posições e alvos pré-carregados (dados sintéticos), digitar um valor de aporte e verificar que a divisão sugerida obedece às regras do motor (déficit, fila, mínimo, transbordo, arredondamento), que a edição redistribui corretamente e que o registro persiste sugerido + executado.

**Acceptance Scenarios**:

1. **Given** carteira consolidada com alvos cujos déficits somam mais que R$ 2.000, **When** o usuário informa aporte de R$ 2.000, **Then** o app apresenta a fila de alvos ordenada do maior déficit para o menor e distribui o valor de cima para baixo, cobrindo o déficit do 1º antes de passar ao 2º.
2. **Given** uma divisão sugerida em que a fatia de um alvo ficaria abaixo do aporte mínimo configurado (ex.: R$ 500), **When** o app calcula a sugestão, **Then** essa fatia não é criada e o valor é realocado para o topo da fila.
3. **Given** um aporte maior que a soma de todos os déficits (ex.: 13º salário), **When** o app calcula a sugestão, **Then** o excedente é distribuído proporcionalmente aos percentuais-alvo.
4. **Given** uma sugestão exibida, **When** o usuário zera ou altera uma linha, **Then** o app redistribui o restante seguindo as mesmas regras do motor.
5. **Given** um alvo composto por ativo B3 (ação/FII/ETF) com cotação disponível no export, **When** o app sugere um valor para esse alvo, **Then** o valor é arredondado para cotas inteiras e o troco é direcionado ao alvo de renda fixa ou registrado para o mês seguinte, com destino visível.
6. **Given** dividendos lançados e ainda não utilizados totalizando R$ X, **When** o usuário abre a calculadora, **Then** o app oferece "incluir R$ X de dividendos ainda não utilizados"; ao registrar o aporte com a opção marcada, esses dividendos ficam vinculados ao aporte e nunca mais são oferecidos.
7. **Given** um aporte registrado como executado, **When** o usuário consulta as posições da carteira, **Then** elas permanecem inalteradas — posições só mudam via import (comportamento intencional).
8. **Given** ativos importados pendentes de vínculo, **When** o usuário tenta abrir a calculadora, **Then** ela está bloqueada até que todas as pendências sejam resolvidas.

---

### User Story 2 - Import mensal em sessões (Priority: P2)

Uma vez por mês, o usuário exporta um CSV por instituição no MyCapital e arrasta todos os arquivos para o app. Os arquivos formam uma sessão de import. O app exibe um preview (total por instituição, quantidade de ativos, data das cotações), avisa se já houver sessão vigente no mesmo mês (a nova substituirá a anterior, que é preservada), compara as instituições com a sessão anterior e pede confirmação explícita se alguma estiver faltando, mostra o diff contra a sessão anterior (ativos novos, sumidos, variações grandes) e cria um backup automático datado antes de confirmar.

**Why this priority**: É a porta de entrada dos dados reais — elimina a coleta manual, a segunda maior dor. Sem import não há carteira real para comparar com o alvo.

**Independent Test**: Arrastar os CSVs reais de `docs/samples/` (Itaú, Nubank, Avenue) e verificar que o preview reflete os totais corretos, que a sessão é criada como vigente e que um segundo import no mesmo mês gera aviso e marca a anterior como substituída sem deletá-la.

**Acceptance Scenarios**:

1. **Given** múltiplos arquivos CSV do MyCapital (um por instituição), **When** o usuário os arrasta para a área de import, **Then** o app agrupa todos numa única sessão e exibe preview com total por instituição, quantidade de ativos e data das cotações.
2. **Given** uma sessão vigente já existente para o mesmo mês de referência, **When** o usuário inicia um novo import desse mês, **Then** o app exibe aviso claro ("Já existe um import de julho (27/07). Este novo passará a ser o vigente.") antes de confirmar; ao confirmar, a sessão anterior é marcada como substituída (nunca deletada) e a nova torna-se vigente, automaticamente e sem perguntar.
3. **Given** que a sessão anterior continha Itaú + Nubank, **When** o novo import contém apenas Itaú, **Then** o app exibe aviso forte com confirmação explícita — sem bloquear, pois encerramento de conta é legítimo.
4. **Given** uma sessão anterior existente, **When** o preview é exibido, **Then** o app mostra o diff: ativos novos, ativos que sumiram e variações grandes de valor.
5. **Given** um import prestes a ser confirmado, **When** o usuário confirma, **Then** o app cria antes uma cópia de backup datada dos dados, respeitando a retenção configurada (padrão: últimas 12).
6. **Given** um arquivo com formato inesperado ou campo inválido, **When** o parse falha, **Then** o app exibe erro claro com linha/coluna do problema e não persiste nada — nunca falha silenciosa nem dado parcial.
7. **Given** um export feito em 01/08 com posições de 31/07, **When** o preview é exibido, **Then** o mês de referência proposto é julho (derivado da data das posições, não do upload) e é editável pelo usuário.
8. **Given** o mesmo ativo presente em instituições diferentes, **When** a sessão é consolidada, **Then** as posições são somadas pela chave do ativo antes da comparação com o alvo.

---

### User Story 3 - Vínculo de ativos ao alvo (Priority: P3)

Quando um import traz um ativo que o app ainda não conhece, o usuário é levado a resolvê-lo: vincular a um alvo existente, criar um alvo novo na hora, ou marcar como "Fora da carteira alvo" (ativo legado que não participa dos cálculos nem recebe aporte). Os vínculos são memorizados — imports futuros do mesmo ativo não perguntam de novo. A tela também é acessível para revisão e correção de vínculos.

**Why this priority**: Sem vínculo completo, os déficits seriam distorcidos silenciosamente — por isso a calculadora fica bloqueada com pendências. É pré-requisito de qualidade do cálculo, mas só agrega valor após import e alvos existirem.

**Independent Test**: Importar um CSV com um ativo inédito e verificar que o app sinaliza a pendência, oferece as três opções de resolução, memoriza a escolha e desbloqueia a calculadora somente após todas as pendências serem resolvidas.

**Acceptance Scenarios**:

1. **Given** um import com ativo sem vínculo conhecido, **When** a sessão é confirmada, **Then** o app sinaliza a pendência e apresenta a tela de vínculo com as opções: alvo existente, criar alvo novo, ou "Fora da carteira alvo".
2. **Given** um ativo vinculado num import anterior, **When** ele aparece num novo import, **Then** o vínculo memorizado é aplicado automaticamente, sem perguntar.
3. **Given** um ativo marcado como "Fora da carteira alvo", **When** os percentuais e déficits são calculados, **Then** ele é excluído da base de cálculo do patrimônio, nunca recebe aporte e é exibido à parte no dashboard.
4. **Given** vários ativos apontando para o mesmo alvo (ex.: Tesouro Selic 2027 e 2031 → "Pós-fixado"), **When** os déficits são calculados, **Then** os valores dos ativos são agregados no alvo (relação N-para-1).
5. **Given** uma mudança de grafia no nome do ativo no export, **When** o import é processado, **Then** o ativo aparece como novo e pendente de vínculo (comportamento desejado: avisar em vez de errar).

---

### User Story 4 - Gestão da carteira alvo (Priority: P4)

O usuário cadastra manualmente os alvos da sua carteira de referência (nome + percentual) e o app valida que a soma fecha em 100%. Quando a carteira de referência muda, o usuário aciona o versionamento: a vigência atual é encerrada e uma nova é aberta, preservando a coerência do histórico. A tela mostra quais ativos do export apontam para cada alvo.

**Why this priority**: A carteira alvo é a metade "onde deveria estar" da comparação — pré-requisito do cálculo, mas de baixa frequência de uso (cadastro inicial + mudanças ocasionais).

**Independent Test**: Cadastrar um conjunto de alvos, verificar a validação da soma em 100%, editar e excluir alvos, e acionar o versionamento verificando que a vigência anterior é encerrada e uma nova é criada.

**Acceptance Scenarios**:

1. **Given** a tela de carteira alvo, **When** o usuário cria, edita ou remove alvos (nome + percentual), **Then** o app valida que a soma dos percentuais vigentes é 100% (com tolerância) e sinaliza quando não é.
2. **Given** uma carteira alvo vigente, **When** o usuário aciona "a carteira de referência mudou", **Then** a vigência atual é encerrada e uma nova é aberta, sem apagar a anterior.
3. **Given** alvos cadastrados e ativos vinculados, **When** o usuário consulta um alvo, **Then** vê quais ativos do export apontam para ele.

---

### User Story 5 - Lançamento e utilização de dividendos (Priority: P5)

O usuário lança manualmente os dividendos recebidos (ativo da lista de conhecidos + mês de referência + valor em R$; para ativos internacionais, o valor já convertido que caiu na conta). Múltiplos lançamentos por ativo/mês são permitidos. A tela lista os lançamentos do mês corrente e o total acumulado disponível — o mesmo total que a calculadora oferece para incluir no aporte. Lançamentos podem ser editados e excluídos. Dividendo utilizado num aporte nunca mais é oferecido; dividendo não utilizado permanece disponível nos meses seguintes.

**Why this priority**: Alimenta a calculadora com dinheiro novo real, mas o produto funciona sem isso — é otimização do ritual, não o núcleo.

**Independent Test**: Lançar dividendos para ativos conhecidos, verificar o total disponível, incluí-los num aporte registrado e confirmar que deixam de ser oferecidos; verificar edição/exclusão de lançamentos ainda não utilizados.

**Acceptance Scenarios**:

1. **Given** ativos conhecidos pelos imports, **When** o usuário lança um dividendo (ativo + mês + valor em R$), **Then** o lançamento é salvo e passa a compor o total disponível para inclusão no aporte.
2. **Given** um FII que paga em datas diferentes no mesmo mês, **When** o usuário faz dois lançamentos para o mesmo ativo/mês, **Then** ambos são aceitos.
3. **Given** um dividendo incluído num aporte registrado, **When** o usuário abre a calculadora em meses seguintes, **Then** esse dividendo nunca mais é oferecido (sem dupla contagem).
4. **Given** um dividendo lançado e não utilizado, **When** meses se passam, **Then** ele permanece disponível (não expira).
5. **Given** um lançamento com erro de digitação, **When** o usuário o edita ou exclui, **Then** a alteração é refletida no total disponível.
6. **Given** um re-import do mês, **When** a sessão anterior é substituída, **Then** os dividendos lançados permanecem intactos (independentes das sessões de import).

---

### User Story 6 - Dashboard e histórico (Priority: P6)

Na home, o usuário tem a visão de 10 segundos: patrimônio total consolidado com a data do último import, alocação atual vs. alvo por grupo com desvio destacado (verde dentro da banda de tolerância, vermelho fora), atalhos para "Novo import" e "Calcular aporte", e alerta se houver vínculos pendentes. No histórico, vê a evolução patrimonial mês a mês (um ponto por mês, da sessão vigente) e a linha do tempo de aportes com sugerido vs. executado.

**Why this priority**: Consolida a confiança no método ao longo do tempo, mas o ritual mensal funciona sem ela — é leitura, não ação.

**Independent Test**: Com pelo menos duas sessões de import de meses distintos e um aporte registrado, verificar que o dashboard mostra alocação atual vs. alvo com a banda aplicada e que o histórico mostra a série mensal e o comparativo sugerido vs. executado.

**Acceptance Scenarios**:

1. **Given** uma sessão de import vigente, **When** o usuário abre o dashboard, **Then** vê o patrimônio total consolidado e a data das posições ("posições de 28/07").
2. **Given** alvos e posições consolidadas, **When** o dashboard exibe a alocação atual vs. alvo, **Then** desvios dentro da banda de tolerância (padrão ±1,5 p.p.) aparecem em verde e fora dela em vermelho.
3. **Given** ativos pendentes de vínculo, **When** o usuário abre o dashboard, **Then** um alerta de pendência é exibido.
4. **Given** sessões vigentes de meses distintos, **When** o usuário abre o histórico, **Then** vê a evolução patrimonial com exatamente um ponto por mês (sessões substituídas não entram na série, mas ficam acessíveis em visão de auditoria).
5. **Given** aportes registrados, **When** o usuário abre o histórico, **Then** vê a linha do tempo de aportes com sugerido vs. executado por mês.

---

### Edge Cases

Decisões já tomadas na seção 7 do documento-fonte — **não reabrir**:

- **Re-import no mesmo mês**: automático — nova sessão substitui a vigente; a anterior é preservada como substituída, com aviso no preview. Nada é deletado nem sobrescrito.
- **Aporte vs. re-import**: o aporte fica permanentemente amarrado à sessão sobre a qual foi calculado, mesmo que ela seja substituída depois. Substituição de vigência nunca reescreve nem re-vincula aportes passados. Reabrir a calculadora após novo import gera novo cálculo sobre a nova sessão vigente.
- **Instituição faltante no import**: aviso forte + confirmação explícita, sem bloqueio (encerramento de conta é legítimo).
- **Ativos legados fora da carteira alvo**: marcador "Fora da carteira alvo" — excluídos da base de percentuais e do aporte, exibidos à parte.
- **Transbordo do aporte** (aporte > soma dos déficits): excedente distribuído proporcionalmente aos percentuais-alvo.
- **Dupla contagem de dividendos**: impossível por construção — dividendo utilizado ganha vínculo permanente com o aporte e sai da oferta; não utilizado permanece disponível sem expirar.
- **Origem do mês de referência**: derivado da data das posições (data do export), não da data do upload; editável no preview.

Demais casos de borda a cobrir:

- CSV com layout alterado pelo MyCapital: o parse quebra com mensagem clara (linha/coluna) — jamais calcular errado em silêncio.
- Campos com o texto literal `null` no CSV: aceitos pelo parser conforme o formato conhecido.
- Ativos internacionais (grupo EXTERIOR): valor de mercado já vem em R$ (sem conversão cambial própria); quantidades fracionadas — arredondamento por lote **não** se aplica; tipo internacional tratado como texto opaco, exibido como veio.
- Tesouro com cotação de D-1: irrelevante para o aporte mensal; a data do export é exibida na UI.
- Todos os alvos acima da meta (todos os déficits negativos ou zero): todo o aporte segue a regra de transbordo (distribuição proporcional aos percentuais-alvo).
- Aporte total menor que o aporte mínimo por transação: a divisão concentra tudo no topo da fila (nenhuma fatia abaixo do mínimo é criada).
- Cotação do export defasada no arredondamento por lote: o registro do executado aceita os valores reais da ordem.
- Soma dos percentuais dos alvos vigentes diferente de 100%: sinalizada na tela de alvos.
- Grupos acima do alvo: nunca geram sugestão de venda — o app apenas mostra excessos (fase de acumulação, sem rebalanceamento por venda).

## Requirements *(mandatory)*

### Functional Requirements

#### Import mensal (sessões)

- **FR-001**: O sistema MUST aceitar upload multi-arquivo de CSVs do MyCapital (um por instituição), agrupando-os numa única sessão de import.
- **FR-002**: O sistema MUST exibir preview da sessão antes da confirmação: total por instituição, quantidade de ativos e data das cotações.
- **FR-003**: O sistema MUST identificar a instituição de cada arquivo a partir do nome do arquivo.
- **FR-004**: O sistema MUST derivar o mês de referência da sessão a partir da data das posições nos arquivos (não da data do upload) e permitir edição no preview.
- **FR-005**: O sistema MUST, ao confirmar uma sessão num mês que já possui sessão vigente, marcar a anterior como substituída (preservando-a integralmente) e tornar a nova vigente — automaticamente, com aviso claro no preview antes da confirmação. Sessões de import NUNCA são deletadas ou sobrescritas.
- **FR-006**: O sistema MUST comparar as instituições da nova sessão com as da sessão anterior e, se alguma estiver faltando, exibir aviso forte com confirmação explícita — sem bloquear o import.
- **FR-007**: O sistema MUST exibir diff contra a sessão anterior antes da confirmação: ativos novos, ativos que sumiram e variações grandes de valor.
- **FR-008**: O sistema MUST criar automaticamente uma cópia de backup datada dos dados antes de confirmar cada sessão de import, com retenção configurável (padrão: manter as últimas 12).
- **FR-009**: O sistema MUST exibir erros de parse com clareza (linha/coluna do problema) e abortar o processamento sem persistir dados parciais — nunca falhar em silêncio.
- **FR-010**: O sistema MUST somar posições do mesmo ativo em instituições diferentes pela chave do ativo antes da comparação com o alvo.
- **FR-011**: O sistema MUST processar ativos internacionais (grupo EXTERIOR) com o mesmo formato de arquivo, usando o valor de mercado já convertido em R$ (sem conversão cambial própria) e tratando o tipo internacional como texto opaco, aceito e exibido como veio.

#### Vínculo de ativos (de-para)

- **FR-012**: O sistema MUST detectar ativos do import sem vínculo conhecido e exigir resolução: vincular a alvo existente, criar alvo novo na hora, ou marcar como "Fora da carteira alvo".
- **FR-013**: O sistema MUST memorizar os vínculos — a chave é a identificação exata do ativo como vem no arquivo; mudanças de grafia aparecem como ativo novo pendente.
- **FR-014**: O sistema MUST suportar vínculo N-para-1 (vários ativos compondo um mesmo alvo).
- **FR-015**: O sistema MUST bloquear a calculadora de aporte enquanto houver ativos pendentes de vínculo.
- **FR-016**: O sistema MUST oferecer tela de revisão/correção dos vínculos existentes.

#### Carteira alvo

- **FR-017**: O sistema MUST permitir criar, editar e remover alvos (nome + percentual), validando que a soma dos percentuais vigentes é 100% (com tolerância).
- **FR-018**: O sistema MUST versionar a carteira alvo por vigência: ao acionar a mudança da carteira de referência, encerrar a vigência atual e abrir uma nova, preservando a anterior para coerência do histórico.
- **FR-019**: O sistema MUST exibir quais ativos do export apontam para cada alvo.

#### Motor de Aporte — regras de negócio (seção 5 do documento, transcritas sem alteração; são também a especificação dos testes do motor)

- **FR-020 (Regra 1 — Déficit por alvo, em R$)**: `déficit = (percentual_alvo × patrimônio_total) − valor_atual_do_grupo`. Grupos acima do alvo (déficit negativo) são ignorados no mês — não se vende, apenas se deixa diluir.
- **FR-021 (Regra 2 — Fila de prioridade)**: alvos ordenados do maior déficit para o menor.
- **FR-022 (Regra 3 — Divisão do aporte)**: preencher a fila de cima para baixo. O aporte cobre o déficit do 1º da fila; se sobrar, vai para o 2º, e assim por diante. **Transbordo:** se o aporte exceder a soma de todos os déficits (ex.: mês de 13º), o excedente é distribuído proporcionalmente aos percentuais-alvo — a carteira cresce equilibrada.
- **FR-023 (Regra 4 — Ativos "Fora da carteira alvo" não participam)**: posições vinculadas ao marcador especial "Fora da carteira" são excluídas da base de cálculo do patrimônio usado nos percentuais e nunca recebem aporte. São exibidas à parte no dashboard. Sem isso, ativos legados que não existem na carteira de referência corromperiam todos os déficits.
- **FR-024 (Regra 5 — Aporte mínimo por transação, configurável, ex.: R$ 500)**: se a fatia destinada a um alvo ficar abaixo do mínimo, ela não é criada — o valor é realocado para o topo da fila. Elimina micro-transações por definição.
- **FR-025 (Regra 6 — Sugestão editável, veto humano)**: o usuário pode zerar ou alterar qualquer linha; o app redistribui o restante seguindo as mesmas regras.
- **FR-026 (Regra 7 — Arredondamento por lote, v1)**: para ativos B3 (ações/FIIs/ETFs), arredondar para cotas inteiras usando a cotação do export; sobras de troco vão para o alvo de renda fixa (que aceita valor quebrado) ou ficam registradas para o mês seguinte. **Não se aplica a EXTERIOR** (compra fracionada) nem a renda fixa/Tesouro (valor livre). Nota: a cotação do export pode estar defasada — o registro do executado aceita os valores reais da ordem.
- **FR-027 (Regra 8 — Banda de tolerância, padrão ±1,5 p.p., configurável)**: usada no dashboard para colorir desvios (dentro/fora da banda). É apenas visual — o motor sempre usa o déficit bruto para ordenar a fila, mesmo com todos os alvos dentro da banda.
- **FR-028 (Regra 9 — Posições só mudam via import, intencional)**: registrar um aporte executado NÃO atualiza as posições — a fonte única da verdade é o export do MyCapital. O dashboard reflete o aporte apenas no import seguinte. Não "corrigir" este comportamento na implementação.

#### Dividendos — regras de negócio (seção 5.1 do documento, transcritas sem alteração)

Dividendo é tratado como **dinheiro novo em caixa** — insumo da calculadora de aporte, não relatório de performance.

- **FR-029 (Lançamento)**: o usuário seleciona o ativo (da lista de ativos já conhecidos pelos imports), informa o mês de referência e o valor **em R$** (para ativos EXTERIOR, lança-se o valor já convertido que caiu na conta). Múltiplos lançamentos por ativo/mês são permitidos (ex.: FII que paga em datas diferentes).
- **FR-030 (Integração com a calculadora)**: ao calcular o aporte do mês, o app oferece "incluir R$ X de dividendos ainda não utilizados" — somando ao valor digitado. **Controle de utilização:** quando incluído num aporte registrado, o dividendo ganha vínculo com esse aporte e nunca mais é oferecido. Dividendos lançados e não utilizados permanecem disponíveis nos meses seguintes (não expiram, não são contados duas vezes).
- **FR-031 (Independência de imports)**: dividendos lançados são independentes das sessões de import (não são substituídos por re-imports).
- **FR-032**: O sistema MUST permitir edição e exclusão de lançamentos de dividendos (erro de digitação é o caso comum) e listar os lançamentos do mês corrente com o total acumulado disponível — o mesmo total oferecido pela calculadora.

#### Calculadora de aporte (tela)

- **FR-033**: O sistema MUST receber o valor do aporte do mês e o aporte mínimo por transação (lembrado da última utilização).
- **FR-034**: O sistema MUST exibir a fila de prioridade com o déficit de cada alvo e a divisão sugerida em R$, com cada linha editável (zerar/alterar) e redistribuição automática do restante.
- **FR-035**: O sistema MUST exibir o arredondamento por lote aplicado aos ativos B3 (cotas inteiras) com o destino do troco visível.
- **FR-036**: O sistema MUST exibir a simulação do "depois": como fica a alocação se o aporte for executado como sugerido.
- **FR-037**: O sistema MUST, ao registrar, gravar tanto a divisão sugerida quanto a executada declarada pelo usuário, amarradas permanentemente à sessão de import sobre a qual o cálculo foi feito.

#### Dashboard e histórico

- **FR-038**: O dashboard MUST exibir o patrimônio total consolidado e a data das posições do último import.
- **FR-039**: O dashboard MUST exibir a alocação atual vs. alvo por grupo, com desvio destacado — dentro da banda de tolerância em verde, fora em vermelho.
- **FR-040**: O dashboard MUST exibir atalhos para "Novo import" e "Calcular aporte", e alerta quando houver ativos pendentes de vínculo.
- **FR-041**: O histórico MUST exibir a evolução patrimonial mês a mês usando apenas a sessão vigente de cada mês (um ponto por mês); sessões substituídas ficam acessíveis numa visão de auditoria.
- **FR-042**: O histórico MUST exibir a linha do tempo de aportes com sugerido vs. executado por mês.

#### Configurações

- **FR-043**: O sistema MUST permitir configurar a banda de tolerância (padrão ±1,5 p.p.), o aporte mínimo por transação (padrão R$ 500) e a retenção de backups automáticos (padrão: últimas 12 cópias).
- **FR-044**: O sistema MUST exportar e importar a configuração (alvos, vínculos e settings) em formato portável, e exibir a localização dos dados e da pasta de backups, com lembrete de que copiar o arquivo de dados é o backup completo do app.

#### Requisitos transversais

- **FR-045**: Valores monetários MUST ser exatos ao centavo em todas as camadas — sem erros de arredondamento acumulados em déficit, divisão ou troco.
- **FR-046**: O app MUST funcionar totalmente offline, local e single-user, sem autenticação e sem chamadas de rede em tempo de execução.

### Escopo Negativo (Non-Goals)

O app NÃO faz — proteger a todo custo (seção 1 do documento; Princípio I da constitution):

- Não busca cotações em tempo real (o export já traz o valor de mercado).
- Não calcula preço médio nem imposto (especialidade do MyCapital).
- Não calcula rentabilidade nem performance, e não busca proventos automaticamente — dividendos entram apenas por lançamento manual.
- Não recomenda ativos — o app só executa a matemática da convergência ao alvo.
- Não faz rebalanceamento por venda — apenas mostra excessos (fase de acumulação).
- Não é multi-usuário e não é hospedado remotamente.

Fora desta feature (ficam para v2, conforme roadmap): métrica de convergência histórica (distância média ao alvo ao longo do tempo), série de renda mensal de dividendos por alvo, e UI completa de navegação entre vigências de alvos.

### Key Entities *(include if feature involves data)*

O modelo de dados conceitual completo está na **seção 4 de `docs/app-gestao-aportes.md`** e a stack na **seção 3** — ambos pertencem à fase de plan e não são detalhados aqui. Resumo conceitual das entidades:

- **Alvo**: item da carteira de referência — nome + percentual alvo, com vigência versionada (início/fim) para preservar o histórico quando a carteira de referência muda.
- **Ativo mapeado (vínculo)**: de-para memorizado entre a identificação exata do ativo no export e um alvo (relação N-para-1), ou o marcador "Fora da carteira alvo"; sem nenhum dos dois = pendente.
- **Sessão de import (snapshot)**: conjunto imutável de posições de um mês de referência, com estado vigente/substituído, instituições incluídas e a data das posições; contém as posições (ativo, instituição, quantidade, valor de mercado, grupo).
- **Aporte**: registro de um cálculo — valor total, parcela vinda de dividendos, divisão sugerida e divisão executada — amarrado permanentemente à sessão de import do cálculo.
- **Dividendo**: lançamento manual (ativo conhecido + mês + valor em R$), com vínculo permanente ao aporte em que foi utilizado (ou disponível, se ainda não usado); independente das sessões de import.
- **Configuração**: banda de tolerância, aporte mínimo por transação, retenção de backups — exportável/importável como backup portável.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: O ritual mensal completo (exportar CSVs → importar → resolver vínculos → calcular → ajustar → registrar) é executável em aproximadamente 5 minutos por um usuário que já conhece o fluxo.
- **SC-002**: Os três CSVs reais de exemplo em `docs/samples/` (Itaú, Nubank, Avenue) são importados sem erro, e o preview reflete exatamente os totais por instituição e as quantidades de ativos dos arquivos — incluindo os ativos internacionais em R$.
- **SC-003**: Todas as 9 regras do motor (seção 5) e as regras de dividendos (seção 5.1) possuem casos de teste no formato "carteira X + aporte Y ⇒ divisão Z", com 100% delas passando.
- **SC-004**: Para uma carteira de ~20 ativos e aporte de R$ 2.000, a divisão sugerida concentra o valor em 1–3 alvos e nenhuma fatia sugerida fica abaixo do aporte mínimo configurado.
- **SC-005**: A soma das fatias sugeridas (incluindo troco de arredondamento registrado) é exatamente igual ao valor total do aporte, ao centavo, em qualquer cenário — inclusive após edições do usuário e no transbordo.
- **SC-006**: Nenhum dividendo é oferecido para inclusão mais de uma vez: após ser usado num aporte registrado, ele desaparece da oferta em 100% dos casos.
- **SC-007**: Após qualquer re-import no mesmo mês, a sessão anterior permanece íntegra e acessível, e a série histórica mantém exatamente um ponto por mês.
- **SC-008**: Com qualquer ativo pendente de vínculo, a calculadora está inacessível; resolvidas as pendências, torna-se acessível sem etapa adicional.
- **SC-009**: 100% dos erros de parse apresentados ao usuário indicam o arquivo e a linha/coluna do problema, e nenhum dado parcial é persistido.

## Assumptions

- **Fatiamento do roadmap**: esta feature cobre v0 + v1 (seção 9 do documento). O pedido do usuário incluiu explicitamente o diff contra a sessão anterior (no import) e o versionamento por vigência (na carteira alvo), que a seção 9 situa total ou parcialmente na v2 — foram incluídos aqui na forma funcional mínima descrita nas seções 6.2 e 6.4 (diff no preview; versionamento por botão de vigência). A "UI completa" de navegação entre vigências, a métrica de convergência histórica e a série de renda mensal permanecem na v2, fora desta feature.
- **Decisões fechadas**: a seção 8 do documento declara que não há pendências de produto ou arquitetura; a tabela da seção 7 é definitiva e nenhum caso de borda ali decidido é reaberto por este spec.
- **Formato do export**: o formato conhecido do CSV do MyCapital (separador ponto-e-vírgula, encoding com BOM, campos `null` literais, mesmas colunas para todas as instituições, grupo EXTERIOR já em R$) é o descrito na seção 3 do documento e validado com os arquivos reais de `docs/samples/`; o detalhamento técnico do parse pertence à fase de plan.
- **Usuário único e ambiente local**: single-user, sem autenticação, rodando apenas na máquina do próprio usuário — decisão consciente da seção 3 e da constitution (Princípio VII).
- **Aporte mínimo e banda**: valores padrão R$ 500 e ±1,5 p.p., ambos configuráveis, conforme seções 4 (config) e 5.
- **Precisão monetária**: valores exatos ao centavo em todas as camadas (constitution, Princípio VI); a representação técnica pertence à fase de plan.
