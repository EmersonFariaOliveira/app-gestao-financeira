# Manual de uso — Gestão de Aportes

Guia prático para quem vai usar o app no dia a dia. Para as regras completas por trás de cada tela, veja `docs/app-gestao-aportes.md`; este manual foca no "o que eu clico e em que ordem".

O app é local e single-user: tudo fica no seu computador (`data/app.db`), sem nuvem, sem login, sem cotação em tempo real. Ele não calcula rentabilidade, preço médio ou imposto, e não recomenda ativos — só ajuda a decidir **onde colocar o próximo aporte** dentro da carteira que você já definiu.

## Configuração inicial (só na primeira vez)

Faça nesta ordem — cada passo depende do anterior.

### 1. Cadastre a carteira alvo (`/alvos`)

Defina os "baldes" que compõem sua carteira ideal (ex.: "Ações BR", "Ações EUA", "Pós-fixado", "Tesouro IPCA+") e o percentual que cada um deve ter. A tela mostra a soma em tempo real — ela precisa fechar em **100%** antes de seguir adiante (uma barra/indicador acusa quando não fecha).

Não precisa ser perfeito de primeira: você pode voltar aqui e ajustar quando quiser (ver "Mudar a carteira alvo" mais abaixo).

### 2. Ajuste as configurações (`/configuracoes`)

Três números controlam o comportamento do cálculo:

- **Aporte mínimo por transação** (padrão R$ 500) — o app nunca sugere mandar, por exemplo, R$ 12,37 para um ativo só porque a conta matemática deu isso; ou o valor todo vai para o alvo, ou nada. Ajuste para o mínimo que faz sentido pra você não pagar corretagem/taxa à toa.
- **Banda de tolerância** (padrão ±1,5 p.p.) — só afeta a cor que o Dashboard mostra (verde = dentro da banda, vermelho = fora). Não muda o cálculo do aporte.
- **Retenção de backups** (padrão 12) — quantas cópias do banco o app guarda em `backups/` antes de começar a apagar as mais antigas.

Essa mesma tela mostra onde ficam o arquivo do banco (`data/app.db`) e a pasta de backups — vale anotar esses caminhos, porque **backup é sua responsabilidade** (o app não sincroniza com nada externo).

### 3. Faça o primeiro import (`/import`)

Exporte do MyCapital um CSV por instituição (corretora/banco) e arraste todos juntos nessa tela. O app mostra um preview antes de gravar qualquer coisa: total por instituição, quantidade de ativos, e o mês de referência (que você pode editar, caso as posições sejam de virada de mês). Confira e clique em confirmar.

### 4. Resolva os vínculos (`/vinculos`)

No primeiro import, **todo ativo aparece como pendente** — o app não sabe ainda a qual "balde" da sua carteira alvo cada ativo pertence. Para cada um, escolha uma das três opções:

- vincular a um alvo já cadastrado;
- criar um alvo novo na hora (se esqueceu de cadastrar algum na etapa 1);
- marcar como **"fora da carteira alvo"** — para ativos que você tem mas não fazem parte da estratégia (ex.: uma ação legada, uma reserva de emergência que você não quer misturar no cálculo). Esses ficam de lado, aparecem à parte no Dashboard, e nunca recebem aporte.

Enquanto houver qualquer pendência, **a calculadora de aporte fica bloqueada** — é assim de propósito, pra você nunca calcular com a carteira incompleta. Resolvido tudo, ela libera sozinha, sem precisar de mais nenhum clique.

Isso é memorizado: nos próximos meses, só ativos **novos** (que nunca apareceram antes) vão gerar pendência de novo.

Pronto — configuração inicial concluída. Dá pra já calcular o primeiro aporte (`/aporte`).

## O ritual de todo mês

Depois da configuração inicial, o uso mensal é curto (a ideia é caber em uns 5 minutos):

1. **Import** (`/import`) — arraste os CSVs atualizados do mês. Se você reimportar dentro do mesmo mês (por engano ou pra corrigir algo), o app avisa e substitui a sessão anterior — sem apagar nada, ela continua acessível no Histórico para auditoria.
   - Se faltar o CSV de alguma instituição que você tinha no mês anterior, o app avisa forte e pede confirmação explícita antes de seguir (pra você não gravar sem querer uma carteira "incompleta" achando que é a real).
2. **Vínculos** (`/vinculos`) — só se algum ativo novo apareceu no import (comprou algo diferente pela primeira vez). Se nada mudou, pule este passo.
3. **Dividendos** (`/dividendos`) — se recebeu proventos no mês e quer somá-los ao aporte, lance aqui (ativo + mês + valor). Não precisa lançar todo mês religiosamente: um dividendo lançado fica disponível até você decidir usá-lo, mesmo que demore alguns meses.
4. **Aporte** (`/aporte`) — a tela principal:
   - digite o valor que vai aportar no mês;
   - marque se quer incluir dividendos disponíveis e/ou o troco do mês anterior (se houver);
   - clique em calcular — o app mostra a fila de prioridade (quem está mais abaixo do alvo primeiro) e a divisão sugerida;
   - **edite se quiser**: pode zerar uma linha ou fixar um valor diferente do sugerido, e o app redistribui o resto automaticamente pelas mesmas regras;
   - para ações/FIIs/ETFs, o valor já vem ajustado para comprar em cotas inteiras — a sobra do arredondamento vai para um ativo de renda fixa (se houver um na fila) ou fica registrada como "troco" para oferecer de novo no mês seguinte;
   - confira a simulação de "como fica depois" e registre. No registro final, você informa o que **realmente** executou na corretora (pode diferir um pouco do sugerido, por causa de cotação defasada) — o app grava os dois lados, sugerido e executado, para você conferir depois.

**Importante**: registrar o aporte não muda as posições da sua carteira automaticamente. As posições só são atualizadas quando você faz o **próximo import** — é o CSV real do banco/corretora que é a fonte da verdade, nunca o que o app "acha" que você comprou.

5. **Dashboard** (`/`) e **Histórico** (`/historico`) — dão uma olhada de 10 segundos: alocação atual vs. alvo (verde/vermelho pela banda de tolerância), evolução patrimonial mês a mês, e comparação sugerido vs. executado ao longo do tempo.

## Tarefas ocasionais

**Mudar a carteira alvo** (`/alvos`, botão "a carteira de referência mudou") — quando você decide reequilibrar os percentuais-alvo (não os ativos que já tem, mas a estratégia). Isso fecha a configuração atual como histórico (nunca é apagada) e abre uma nova, já copiando os vínculos existentes — você só ajusta os percentuais.

**Corrigir um vínculo** — a tela `/vinculos` também serve para revisão: dá pra reatribuir um ativo já vinculado para outro alvo, ou mudar de "fora da carteira" para dentro, a qualquer momento.

**Exportar/importar configuração** (`/configuracoes`) — gera um JSON portável com seus alvos, vínculos e ajustes de settings. Serve como um segundo backup mais legível, ou para levar sua configuração para outra máquina. Não inclui histórico de posições, aportes ou dividendos — só o que é "configuração".

**Backup do banco** — acontece sozinho a cada import (antes de gravar qualquer coisa, o app salva uma cópia datada em `backups/`). Ainda assim, copie periodicamente `data/app.db` e a pasta `backups/` para algum lugar seguro fora da máquina — é local-first, então a responsabilidade de não perder o arquivo é sua.

## O que o app não faz (de propósito)

Cotação em tempo real, preço médio, cálculo de imposto, rentabilidade/performance automática, busca automática de proventos, recomendação de ativos, venda ou rebalanceamento por venda, login/múltiplos usuários. Ele resolve um problema específico — "tenho R$ X esse mês, para onde ele vai?" — e para por aí.
