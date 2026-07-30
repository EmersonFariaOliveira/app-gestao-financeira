# App de Gestão de Aportes — Especificação Inicial

> Documento de visão e arquitetura. Não contém implementação — serve como base para a fase de desenvolvimento.

---

## 1. Objetivo

Eliminar o trabalho manual e a indecisão na hora de aportar. O app responde a uma única pergunta, uma vez por mês:

> **"Tenho R$ X para aportar este mês. Em quais ativos coloco esse dinheiro, e quanto em cada um?"**

Ele faz isso comparando a **carteira real** (importada via export CSV do MyCapital) com a **carteira alvo** (percentuais da carteira de valorização da Finclass, cadastrados manualmente), e sugerindo a alocação do aporte nos ativos mais abaixo da meta — sem micro-transações.

### O que o app NÃO faz (escopo negativo — proteger a todo custo)

- Não busca cotações em tempo real (o export já traz o valor de mercado atual).
- Não calcula preço médio nem imposto (especialidade do MyCapital).
- Não calcula rentabilidade nem performance, e não busca proventos automaticamente (MyCapital já faz). Dividendos entram apenas por **lançamento manual**, como insumo do aporte — ver seção 5.1.
- Não recomenda ativos (a Finclass já faz). O app só executa a matemática da convergência ao alvo.

### A dor que resolve

| Dor | Como o app resolve |
|---|---|
| Diluir R$ 2 mil em ~20 ativos gera micro-transações | Método do **maior déficit**: concentra o aporte nos 1–3 ativos mais abaixo do alvo, com regra de aporte mínimo por transação |
| Coletar valor atual de cada ativo manualmente | Import dos CSVs do MyCapital (1 arquivo por instituição, arrasta e pronto) |
| Calcular preço médio de compras fracionadas | Desnecessário para decidir aporte; já vem no export se precisar exibir |
| Saber se a carteira está convergindo para o alvo | Histórico de imports mês a mês + visão de desvio por ativo/grupo |

---

## 2. Fluxo mensal do usuário (ritual de ~5 minutos)

1. Exportar os CSVs do MyCapital (um por instituição).
2. Arrastar todos os arquivos para o app (eles formam uma **sessão de import**; re-exportar dias depois no mesmo mês simplesmente cria uma sessão nova que passa a ser a vigente).
3. App consolida posições, casa com os alvos e sinaliza ativos novos sem vínculo (se houver, o usuário vincula na hora — o vínculo fica memorizado).
4. Usuário digita o valor do aporte do mês (ex.: R$ 2.000).
5. App devolve a **fila de prioridade por déficit** e a **divisão sugerida do aporte**, editável.
6. Usuário ajusta se quiser (veto humano), registra o que de fato executou.
7. Snapshot do mês fica salvo → alimenta o histórico.

---

## 3. Arquitetura

### Stack

| Camada | Escolha | Justificativa |
|---|---|---|
| Frontend + Backend | **Next.js** (App Router, API routes / server actions) | Um único projeto full-stack; roda localmente (`npm run dev` ou build local) |
| Banco de dados | **SQLite** (arquivo único local, ex.: `data/app.db`) | App offline e single-user: zero infraestrutura, sem servidor de banco, backup = cópia de arquivo, dados nunca saem da máquina |
| ORM | **Prisma** (provider `sqlite`) | Migrations versionadas, schema como código; migração futura para Postgres é indolor se um dia precisar de multi-dispositivo |
| Autenticação | **Nenhuma** — app roda apenas em localhost, single-user | Decisão consciente: não exposto à internet; a proteção é o próprio acesso à máquina do usuário. Se um dia for hospedado remotamente, autenticação passa a ser obrigatória |
| Processamento do CSV | No servidor local (upload → parse → persistência) | Mantém o parser numa camada isolada e testável |

### Notas de implementação específicas do SQLite (para o agente implementador)

- **Sem enums:** Prisma + SQLite não suporta enum. Campos como `status` (VIGENTE | SUBSTITUIDO) são `String` com validação na camada de aplicação (e/ou CHECK constraint via migration SQL).
- **Sem listas escalares:** campos como `instituicoes[]` viram coluna `String` com JSON serializado (uso é apenas a checagem de completude — não precisa de tabela relacional).
- **Valores monetários:** evitar float; armazenar como inteiro em centavos, convertendo na borda da aplicação.
- **Backup:** o arquivo `.db` é o backup completo (histórico, alvos, vínculos, dividendos). Copiá-lo para nuvem/pendrive = backup total. O export JSON de configuração (alvos + vínculos + settings) permanece como formato portável complementar.
- **Localização do arquivo:** fora da pasta do build, em caminho configurável via env (`DATABASE_URL="file:./data/app.db"`), incluído no `.gitignore`.

### Camadas lógicas (isolamento intencional)

```
┌─────────────────────────────────────────────┐
│  UI (Next.js)                               │
│  telas de import, alvos, aporte, histórico  │
├─────────────────────────────────────────────┤
│  Motor de Aporte (lógica pura, sem I/O)     │
│  déficit → fila de prioridade → divisão     │
├─────────────────────────────────────────────┤
│  Mapeamento (de-para ativo → alvo)          │
│  relação N-para-1, memorizada               │
├─────────────────────────────────────────────┤
│  Parser CSV MyCapital (camada isolada)      │
│  único ponto que conhece o formato do export│
├─────────────────────────────────────────────┤
│  SQLite (arquivo local único)               │
└─────────────────────────────────────────────┘
```

**Por que o parser é uma camada isolada:** exports de plataformas mudam layout sem aviso. Se o MyCapital alterar o CSV, só o parser quebra — e o app avisa com erro claro em vez de calcular errado em silêncio.

**Por que o motor é lógica pura:** sem I/O, ele é trivial de testar com casos sintéticos (carteira X + aporte Y ⇒ divisão Z) e nunca depende de banco ou rede.

### O que sabemos sobre o formato do export (validado com arquivos reais)

- CSV separado por **ponto e vírgula**, decimais com **ponto**, encoding UTF-8 **com BOM** (parser deve ignorar os bytes iniciais).
- Schema idêntico entre instituições → um único parser serve para todas.
- Colunas-chave: `Ação` (ticker ou nome), `Quantidade`, `Patrimônio Hoje` (valor de mercado — o número que o motor usa), `Tipo de Grupo` (ACOES, FII_FIAGRO, ETF, TESOURO_DIRETO, FUNDOS_INVESTIMENTO, OUTROS_FUNDOS), `dataUltimaCotacao`.
- Campos podem vir como `null` literal; Tesouro vem com cotação de D-1 (`isCotacaoAtrasada`) — irrelevante para aporte mensal, mas exibir a data do export na UI.
- Identificação mista: ticker limpo para listados (PRIO3, XPML11), nome por extenso para fundos e Tesouro ("Kinea Atlas Multimercado") — a chave de vínculo é a string como vem no arquivo; mudanças de grafia aparecem como "ativo novo" (comportamento desejado: avisar em vez de errar).
- Nome da instituição extraível do nome do arquivo (`..._Itaú.csv`).
- **Ativos internacionais (validado com export da Avenue):** mesmo schema, `Tipo de Grupo = EXTERIOR` + coluna `tipoAtivoInternacional` (STOCK, etc.). O `Patrimônio Hoje` **já vem convertido em BRL** (colunas em dólar preenchidas em paralelo, apenas informativas) → o motor usa uma única coluna em reais para toda a carteira, sem conversão cambial própria. Quantidades são **fracionadas** (ex.: 0.14451 ações) → arredondamento por lote não se aplica a EXTERIOR. O `tipoAtivoInternacional` é tratado como **string opaca**: o parser aceita qualquer valor sem validar (só STOCK foi observado; REIT/ETF/BOND ou outros são exibidos como vierem, sem impacto no motor).

---

## 4. Modelo de dados (conceitual)

```
alvo (target)
├─ id
├─ nome                  ex.: "WRLD11", "Pós-fixado", "Multimercado"
├─ percentual_alvo       ex.: 12.5
├─ vigencia_inicio       versionamento: quando a Finclass muda a
├─ vigencia_fim (null)   carteira, fecha-se a vigência e cria-se outra
└─ ativo (bool)

ativo_mapeado (asset_mapping)
├─ id
├─ chave_export          string exata da coluna "Ação" do CSV
├─ alvo_id (FK, null)    relação N-para-1: vários ativos → um alvo
├─ fora_da_carteira      bool — ativo reconhecido mas que NÃO faz parte
│                        da carteira alvo: excluído da base de cálculo
│                        dos percentuais, nunca recebe aporte, exibido
│                        à parte. (alvo_id null + fora_da_carteira
│                        false = pendente de vínculo)
└─ criado_em             ex.: Tesouro Selic 2027 e 2031 → alvo "Pós-fixado"

sessao_import (snapshot)
├─ id
├─ mes_referencia        ex.: 2026-07 — chave da vigência mensal.
│                        Derivado da data das posições (data_export),
│                        NÃO da data do upload; editável no preview
│                        (export de 01/08 com posições de 31/07 = julho)
├─ data_export           data das posições nos arquivos
├─ criado_em
├─ status                VIGENTE | SUBSTITUIDO
│                        (novo import do mesmo mês → o anterior vira
│                        SUBSTITUIDO; nada é deletado)
├─ instituicoes[]        extraídas dos nomes dos arquivos; usadas na
│                        checagem de completude contra a sessão anterior
└─ posicoes[]
    ├─ chave_export
    ├─ instituicao
    ├─ quantidade
    ├─ patrimonio_hoje   valor de mercado usado no cálculo
    └─ tipo_grupo        classificação que já vem no CSV

aporte (contribution)
├─ id
├─ sessao_import_id (FK) sempre a sessão sobre a qual o cálculo foi
│                        feito — vínculo permanente, mesmo que a sessão
│                        seja depois substituída como vigente
├─ valor_total           ex.: 2000.00
├─ valor_dividendos      parcela do total vinda de dividendos incluídos
├─ sugestao[]            o que o motor sugeriu (alvo, valor)
└─ executado[]           o que o usuário registrou ter feito
                         → permite auditar "sugerido vs. executado"

dividendo (dividend)
├─ id
├─ chave_export (FK)     ativo da lista de conhecidos (ativo_mapeado)
├─ mes_referencia        ex.: 2026-07
├─ valor                 em R$ (EXTERIOR: valor já convertido recebido)
├─ aporte_id (FK, null)  null = disponível para incluir num aporte;
│                        preenchido = já utilizado, nunca mais oferecido
├─ criado_em             múltiplos lançamentos por ativo/mês permitidos;
└─                       independente de sessões de import (re-imports
                         não substituem dividendos)

config (settings)        chave-valor em JSON
├─ banda_tolerancia      padrão 1.5 p.p.
├─ aporte_minimo         padrão 500.00
└─ ...                   exportável/importável como backup manual
```

Observações:
- **Imports são imutáveis; a vigência mensal é que muda de mãos.** Cada sessão de import é um registro novo, nunca sobrescrito. Quando entra uma sessão nova do mesmo `mes_referencia`, a anterior é marcada como SUBSTITUIDO (não deletada) e a nova vira VIGENTE — regra automática, sem perguntar ao usuário, apenas com aviso no preview.
- **Histórico e cálculos usam sempre a sessão vigente de cada mês** → série mensal limpa (um ponto por mês). Sessões substituídas ficam acessíveis numa visão de auditoria.
- **Aportes ficam amarrados à sessão sobre a qual foram calculados**, mesmo que ela seja substituída depois. Substituição de vigência nunca reescreve nem re-vincula aportes passados — a sugestão só faz sentido à luz dos dados daquele momento. Reabrir a calculadora após um novo import gera um novo cálculo sobre a nova sessão vigente.
- Posições do mesmo ativo em instituições diferentes são **somadas pela chave** antes da comparação com o alvo.
- A soma dos percentuais dos alvos vigentes deve ser validada (= 100%, com tolerância) na tela de alvos.

---

## 5. Regras de negócio do Motor de Aporte

1. **Déficit por alvo (em R$):** `déficit = (percentual_alvo × patrimônio_total) − valor_atual_do_grupo`. Grupos acima do alvo (déficit negativo) são ignorados no mês — não se vende, apenas se deixa diluir.
2. **Fila de prioridade:** alvos ordenados do maior déficit para o menor.
3. **Divisão do aporte:** preencher a fila de cima para baixo. O aporte cobre o déficit do 1º da fila; se sobrar, vai para o 2º, e assim por diante. **Transbordo:** se o aporte exceder a soma de todos os déficits (ex.: mês de 13º), o excedente é distribuído proporcionalmente aos percentuais-alvo — a carteira cresce equilibrada.
4. **Ativos "Fora da carteira alvo" não participam:** posições vinculadas ao marcador especial *Fora da carteira* (ver 6.3) são excluídas da base de cálculo do patrimônio usado nos percentuais e nunca recebem aporte. São exibidas à parte no dashboard. Sem isso, ativos legados que não existem na carteira Finclass corromperiam todos os déficits.
5. **Aporte mínimo por transação (configurável, ex.: R$ 500):** se a fatia destinada a um alvo ficar abaixo do mínimo, ela não é criada — o valor é realocado para o topo da fila. Elimina micro-transações por definição.
6. **Sugestão editável (veto humano):** o usuário pode zerar ou alterar qualquer linha; o app redistribui o restante seguindo as mesmas regras.
7. **Arredondamento por lote (v1):** para ativos B3 (ações/FIIs/ETFs), arredondar para cotas inteiras usando a cotação do export; sobras de troco vão para o alvo de renda fixa (que aceita valor quebrado) ou ficam registradas para o mês seguinte. **Não se aplica a EXTERIOR** (compra fracionada) nem a renda fixa/Tesouro (valor livre). Nota: a cotação do export pode estar defasada — o registro do executado aceita os valores reais da ordem.
8. **Banda de tolerância (padrão ±1,5 p.p., configurável):** usada no dashboard para colorir desvios (dentro/fora da banda). É apenas visual — o motor sempre usa o déficit bruto para ordenar a fila, mesmo com todos os alvos dentro da banda.
9. **Posições só mudam via import (intencional):** registrar um aporte executado NÃO atualiza as posições — a fonte única da verdade é o export do MyCapital. O dashboard reflete o aporte apenas no import seguinte. Não "corrigir" este comportamento na implementação.

### 5.1 Dividendos (lançamento manual)

Dividendo é tratado como **dinheiro novo em caixa** — insumo da calculadora de aporte, não relatório de performance (isso é papel do MyCapital).

- **Lançamento:** usuário seleciona o ativo (da lista de ativos já conhecidos pelos imports), informa o mês de referência e o valor **em R$** (para ativos EXTERIOR, lança-se o valor já convertido que caiu na conta). Múltiplos lançamentos por ativo/mês são permitidos (ex.: FII que paga em datas diferentes).
- **Integração com a calculadora:** ao calcular o aporte do mês, o app oferece *"incluir R$ X de dividendos ainda não utilizados"* — somando ao valor digitado. **Controle de utilização:** quando incluído num aporte registrado, o dividendo ganha vínculo com esse aporte (`aporte_id`) e nunca mais é oferecido. Dividendos lançados e não utilizados permanecem disponíveis nos meses seguintes (não expiram, não são contados duas vezes).
- **Histórico:** série de renda mensal por ativo/alvo como subproduto (gráfico simples na tela de histórico).
- Dividendos lançados são independentes das sessões de import (não são substituídos por re-imports).

---

## 6. Telas

### 6.1 Dashboard (home)
A visão de 10 segundos: "como estou vs. onde deveria estar".
- Patrimônio total consolidado + data do último import ("posições de 28/07").
- Gráfico/barras de alocação **atual vs. alvo** por grupo, com desvio destacado (verde dentro da banda de tolerância, vermelho fora).
- Atalhos: "Novo import" e "Calcular aporte".
- Alerta se houver ativos sem vínculo pendentes.

### 6.2 Import mensal
- Área de drag-and-drop multi-arquivo (um CSV por instituição), agrupados numa **sessão de import**.
- Preview do que foi lido: total por instituição, quantidade de ativos, data das cotações.
- **Aviso de substituição:** se já existir sessão vigente no mesmo mês, exibir claramente — *"Já existe um import de julho (27/07). Este novo passará a ser o vigente."* — antes de confirmar.
- **Checagem de completude:** comparar instituições com a sessão anterior. Se faltar alguma (*"o import anterior tinha Itaú + Nubank; este só tem Itaú"*), exibir **aviso forte + confirmação explícita** — não bloquear, pois encerramento de conta numa corretora é um caso legítimo.
- Diff contra a sessão anterior: ativos novos, ativos que sumiram, variações grandes — como conferência antes de confirmar.
- **Backup automático:** antes de confirmar cada sessão de import, o app cria uma cópia datada do arquivo SQLite (ex.: `backups/app-2026-07-28.db`), com retenção configurável (sugestão: manter as últimas 12). O momento é ideal — o import é a única operação que altera dados em volume.
- Erros de parse exibidos com clareza (linha/coluna), nunca falha silenciosa.

### 6.3 Vínculo de ativos (de-para)
- Aparece automaticamente quando o import traz ativo sem vínculo.
- Lista: chave do export → dropdown de alvos existentes, criar alvo novo na hora, **ou marcar como "Fora da carteira alvo"** (ativo legado que não participa dos cálculos nem recebe aporte).
- Vínculos memorizados; tela também acessível para revisão/correção.
- A calculadora de aporte é **bloqueada enquanto houver ativos pendentes de vínculo** — pendência distorceria os déficits silenciosamente.

### 6.4 Carteira alvo
- CRUD dos alvos: nome + percentual, com validação da soma = 100%.
- Versionamento: botão "a Finclass mudou a carteira" fecha a vigência atual e abre uma nova, preservando a coerência do histórico.
- Visão de quais ativos do export apontam para cada alvo.

### 6.5 Calculadora de aporte (a tela-coração)
- Input: valor do aporte do mês + aporte mínimo por transação (lembrado da última vez).
- Opção *"incluir R$ X de dividendos ainda não utilizados"* — soma ao valor do aporte e marca os dividendos como utilizados ao registrar.
- Output: fila de prioridade com déficit de cada alvo e a divisão sugerida em R$.
- Cada linha editável (zerar/alterar) com redistribuição automática do restante.
- Arredondamento por lote aplicado a ativos B3 (cotas inteiras + destino do troco visível).
- Simulação do "depois": como fica a alocação se o aporte for executado como sugerido.
- Botão "registrar como executado" → grava sugerido + executado no snapshot.

### 6.6 Dividendos
- Lançamento rápido: ativo (dropdown dos conhecidos) + mês + valor em R$.
- Lista dos lançamentos do mês corrente e total acumulado — o mesmo total que a calculadora oferece para incluir no aporte.
- Edição/exclusão de lançamentos (erro de digitação é o caso comum).

### 6.7 Histórico
- Evolução patrimonial mês a mês (dos snapshots).
- Convergência: distância média da carteira ao alvo ao longo do tempo (a métrica de sucesso do app — deve cair).
- Linha do tempo de aportes: sugerido vs. executado por mês.
- Série de renda mensal (dividendos lançados) por mês e por alvo.

### 6.8 Configurações
- Banda de tolerância (padrão ±1,5 p.p.) e aporte mínimo por transação — editáveis.
- Retenção de backups automáticos (padrão: últimas 12 cópias).
- Backup: exportar/importar configuração (alvos, vínculos, settings) em JSON; exibir o caminho do arquivo SQLite e da pasta de backups, com lembrete de que copiar o `.db` é o backup completo do app.

---

## 7. Decisões tomadas

| Decisão | Escolha |
|---|---|
| Fonte da carteira real | Export CSV do MyCapital (mensal, multi-instituição) |
| Fonte da carteira alvo | Cadastro manual dos % da Finclass (sem import da Finclass) |
| Granularidade do alvo | Por alvo nomeado, com vínculo N-para-1 (vários ativos podem compor um alvo) |
| Cotações | Nenhuma integração — o export já traz valor de mercado |
| Estratégia de aporte | Maior déficit primeiro, com mínimo por transação e veto humano |
| Rebalanceamento por venda | Fora do escopo do motor (fase de acumulação); o app apenas mostra excessos |
| Persistência | **SQLite** (arquivo local único via Prisma) — app offline, zero infraestrutura, backup por cópia de arquivo; migração futura a Postgres possível se surgir necessidade multi-dispositivo |
| Histórico | Sessões de import imutáveis; um ponto por mês na série |
| Re-import no mesmo mês | Automático: mesmo mês = nova sessão substitui a vigente (anterior preservado como SUBSTITUIDO), com aviso no preview |
| Aporte vs. re-import | Aporte fica amarrado à sessão sobre a qual foi calculado, mesmo se substituída — auditabilidade acima de tudo |
| Import com instituição faltante | Aviso forte + confirmação explícita (sem bloqueio, para permitir encerramento legítimo de conta) |
| ORM | Prisma |
| Autenticação | Nenhuma — app local em localhost; obrigatória apenas se um dia for hospedado remotamente |
| Banda de tolerância | ±1,5 p.p. padrão, configurável |
| Arredondamento por lote | Entra na **v1**; só para ativos B3 (EXTERIOR e renda fixa aceitam valor livre) |
| Ativos internacionais | Validado com export Avenue: mesmo parser, `Patrimônio Hoje` já em BRL, sem conversão cambial própria |
| Dividendos | Lançamento manual (ativo + mês + valor em R$); tratados como dinheiro novo que pode ser incluído no aporte do mês |
| Backup de configuração | Export/import de alvos + vínculos + settings em JSON |
| Ativos legados sem alvo | Marcador "Fora da carteira alvo": excluídos da base de % e do aporte, exibidos à parte |
| Aporte maior que a soma dos déficits | Excedente distribuído proporcionalmente aos percentuais-alvo |
| Dividendo não utilizado | Permanece disponível nos meses seguintes; ao entrar num aporte, ganha `aporte_id` e sai da oferta (sem dupla contagem) |
| Origem do `mes_referencia` | Data das posições (data_export), não do upload; editável no preview |
| Calculadora com vínculos pendentes | Bloqueada até resolver — pendência distorceria os déficits |
| `tipoAtivoInternacional` | String opaca: parser aceita qualquer valor sem validar, exibe como veio (sem impacto no motor) |
| Backup do banco | Cópia datada automática do `.db` antes de cada sessão de import, retenção configurável (padrão: 12) |

## 8. Pendências para a fase de implementação

Nenhuma — todas as decisões de produto e arquitetura estão fechadas. Escolhas puramente técnicas remanescentes (estrutura de pastas, bibliotecas de UI, framework de testes) ficam a critério da implementação, desde que respeitem as camadas e regras deste documento.

## 9. Roadmap sugerido

1. **v0 (núcleo):** parser + alvos + vínculo + calculadora de aporte (com mínimo por transação). Sem histórico, sem dashboard. Já resolve a dor.
2. **v1:** snapshots + dashboard atual vs. alvo (com banda configurável) + registro sugerido/executado + **arredondamento por lote** + **lançamento de dividendos com inclusão no aporte** + configurações com backup JSON.
3. **v2:** histórico de convergência, série de renda mensal, diff entre imports, versionamento de alvos com UI completa.