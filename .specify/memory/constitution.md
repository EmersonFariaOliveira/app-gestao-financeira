<!--
Sync Impact Report
==================
Version change: [TEMPLATE] → 1.0.0 (initial ratification)
Modified principles: n/a (first concrete version, replacing all template placeholders)
Added sections:
  - Core Principles I–X (Escopo Negativo é Lei; Camadas Isoladas; Fonte Única da
    Verdade; Imutabilidade e Auditabilidade; Falhar Alto, Nunca em Silêncio;
    Dinheiro é Inteiro; Local-First e Zero Infraestrutura; Veto Humano; Stack
    Fixa; Conflitos Resolvem-se no Spec)
  - Documento de Especificação (section 2)
  - Fluxo de Desenvolvimento e Qualidade (section 3)
  - Governance
Removed sections: none (template placeholders only)
Templates requiring follow-up:
  - .specify/templates/plan-template.md — ⚠ pending manual review to confirm its
    Constitution Check gates reference these 10 principles by name
  - .specify/templates/spec-template.md — ⚠ pending manual review for alignment
    with the negative-scope principle (I) when scoring feature requests
  - .specify/templates/tasks-template.md — ⚠ pending manual review to confirm
    task categorization (parser / motor / persistence) matches Principle II's
    layer isolation
Deferred items: none — all placeholder values were supplied by user input or
  the project spec (docs/app-gestao-aportes.md).
-->

# App de Gestão de Aportes Constitution

## Core Principles

### I. Escopo Negativo é Lei
O app faz uma única coisa: matemática de convergência da carteira real ao alvo
declarado. O app NÃO busca cotações em tempo real, NÃO calcula preço médio,
NÃO calcula imposto, NÃO calcula rentabilidade ou performance, NÃO busca
proventos automaticamente e NÃO recomenda ativos. Qualquer proposta de feature
nessas direções DEVE ser rejeitada na revisão, mesmo que pareça útil ou
tecnicamente simples de adicionar.

**Racional:** essas funções já são resolvidas por outras ferramentas
(MyCapital para cotação/preço médio/imposto/performance/proventos, Finclass
para seleção de ativos). Absorvê-las infla o escopo, duplica fontes de
verdade e distrai do único problema que o app resolve.

### II. Camadas Isoladas
O parser de CSV é o único módulo do sistema que conhece o formato do export
do MyCapital; nenhum outro código deve interpretar colunas ou nomes de campos
do CSV diretamente. O Motor de Aporte é lógica pura — sem I/O, sem acesso a
banco, sem dependência de framework — e DEVE ser testável isoladamente com
casos sintéticos no formato "carteira X + aporte Y ⇒ divisão Z". As regras da
seção 5 de `docs/app-gestao-aportes.md` são a fonte canônica desses casos de
teste.

**Racional:** exports de plataformas mudam layout sem aviso — isolar o parser
garante que uma mudança de formato quebre em um único lugar, com erro claro,
em vez de contaminar o motor de cálculo. Lógica pura no motor garante que ele
seja verificável sem infraestrutura.

### III. Fonte Única da Verdade
Posições da carteira só mudam através de uma sessão de import. Registrar um
aporte executado NUNCA atualiza posições diretamente — o dashboard só reflete
o aporte no import seguinte. Este comportamento é intencional e não deve ser
"corrigido" para parecer mais reativo.

**Racional:** misturar dados declarados (o que o usuário disse que fez) com
dados importados (o que de fato está na carteira, segundo o MyCapital) cria
duas fontes de verdade divergentes e mascara erros de execução real.

### IV. Imutabilidade e Auditabilidade
Sessões de import nunca são deletadas ou sobrescritas; apenas a vigência
mensal muda de estado (VIGENTE → SUBSTITUIDO), preservando o histórico
completo para auditoria. Aportes ficam permanentemente amarrados à sessão de
import sobre a qual foram calculados, mesmo que essa sessão seja substituída
depois. Dividendos utilizados em um aporte ganham vínculo permanente com esse
aporte e nunca são oferecidos novamente para uso futuro.

**Racional:** o valor do histórico do app depende de nunca reescrever o
passado. Se um cálculo antigo pudesse ser silenciosamente re-vinculado a
dados novos, a auditoria de "sugerido vs. executado" perderia sentido.

### V. Falhar Alto, Nunca em Silêncio
Erros de parse do CSV DEVEM mostrar linha/coluna do problema e abortar o
processamento — nunca prosseguir com dado parcial ou inferido. A calculadora
de aporte é bloqueada enquanto houver ativos importados sem vínculo a um
alvo. Mudanças no formato do CSV do MyCapital DEVEM quebrar com mensagem
clara para o usuário; jamais produzir um cálculo de déficit incorreto de
forma silenciosa.

**Racional:** neste domínio, um número errado sem aviso é pior do que uma
tela de erro — o usuário tomaria uma decisão financeira sobre dado
corrompido sem saber.

### VI. Dinheiro é Inteiro
Todo valor monetário é armazenado como número inteiro em centavos, em
qualquer camada de persistência ou cálculo. O uso de ponto flutuante para
representar dinheiro é proibido, inclusive em cálculos intermediários do
Motor de Aporte. Conversão para representação decimal (R$) ocorre apenas na
borda de apresentação (UI).

**Racional:** erros de arredondamento de float acumulam de forma sutil em
cálculos de déficit e divisão de aporte, produzindo divergências de centavos
que corroem a confiança no número final.

### VII. Local-First e Zero Infraestrutura
O app persiste dados em um único arquivo SQLite via Prisma. Não há serviços
externos, não há chamadas de rede em tempo de execução e não há autenticação
— o app roda exclusivamente em localhost, e a proteção do acesso é a própria
máquina do usuário. Um backup automático datado do arquivo `.db` é criado
antes de cada sessão de import. Caso o app venha um dia a ser hospedado
remotamente, a introdução de autenticação passa a ser obrigatória antes desse
lançamento.

**Racional:** o app é single-user e lida com dados financeiros pessoais;
manter tudo local elimina superfície de ataque, custo de infraestrutura e
dependência de terceiros — trade-off aceitável enquanto o uso for de uma
única pessoa em sua própria máquina.

### VIII. Veto Humano
O app sugere, o usuário decide. Toda sugestão de divisão de aporte é editável
antes de ser registrada, com redistribuição automática do restante seguindo
as mesmas regras. O app nunca executa uma operação financeira real — ele
apenas registra o que o usuário declara ter feito.

**Racional:** o app não tem (e não deve buscar) integração com corretoras;
sugerir sem executar mantém o usuário como responsável final por toda decisão
de alocação.

### IX. Stack Fixa
A stack é Next.js (App Router) + Prisma + SQLite, e mudanças nessa escolha
exigem emenda a esta constitution, não decisão ad-hoc de implementação. Dadas
as limitações do Prisma com SQLite, o schema NÃO usa enums nem listas
escalares nativas: campos de enumeração são `String` validados na camada de
aplicação, e listas são armazenadas como JSON serializado, conforme as notas
de implementação do spec.

**Racional:** fixar a stack evita debates recorrentes de tecnologia num
projeto single-user de escopo definido; as restrições de schema são uma
consequência direta e conhecida de usar SQLite via Prisma, não uma escolha
arbitrária.

### X. Conflitos Resolvem-se no Spec
`docs/app-gestao-aportes.md` é a autoridade final de produto e arquitetura
deste projeto. Se a implementação divergir do spec, ou se surgir um caso de
uso não coberto por ele, a resposta correta é atualizar o spec primeiro e só
então implementar — nunca improvisar uma decisão de produto diretamente no
código.

**Racional:** decisões de produto tomadas apenas em código ficam invisíveis
na próxima revisão e tendem a divergir silenciosamente do documento que todo
o time (mesmo sendo um único usuário) usa como referência.

## Documento de Especificação

`docs/app-gestao-aportes.md` contém o objetivo do produto, o fluxo mensal do
usuário, o modelo de dados conceitual, as regras de negócio do Motor de
Aporte (seção 5) e o desenho de todas as telas. Esta constitution define os
princípios inegociáveis que regem *como* o projeto é construído; o spec
define *o que* é construído. Em qualquer dúvida de comportamento não coberta
explicitamente aqui, a resposta está no spec — e o spec DEVE ser consultado
antes de qualquer decisão de design ou implementação que toque regras de
negócio, modelo de dados ou fluxo de telas.

## Fluxo de Desenvolvimento e Qualidade

Toda feature ou alteração PRECISA ser avaliada, antes da implementação,
contra o Princípio I (Escopo Negativo): se a mudança introduzir cotação em
tempo real, cálculo de preço médio/imposto/rentabilidade/performance, busca
automática de proventos ou recomendação de ativos, ela é rejeitada
independentemente de mérito técnico.

O Motor de Aporte DEVE ter cobertura de teste com os casos sintéticos
derivados da seção 5 do spec (déficit, fila de prioridade, transbordo,
aporte mínimo, arredondamento por lote, banda de tolerância) antes de ser
considerado pronto para uso. Testes do motor NÃO podem depender de banco de
dados, rede ou do parser de CSV.

Revisões de código DEVEM verificar: (a) que nenhuma lógica de interpretação
do CSV do MyCapital vazou para fora do parser; (b) que valores monetários
trafegam como inteiros em centavos em todas as camadas tocadas; (c) que
nenhuma operação de import sobrescreve ou deleta uma sessão existente; (d)
que qualquer alteração de schema Prisma respeita as restrições da seção
"Notas de implementação específicas do SQLite" do spec (sem enum nativo, sem
lista escalar nativa).

## Governance

Esta constitution tem precedência sobre qualquer prática de desenvolvimento,
convenção de código ou decisão de implementação que a contradiga. Em caso de
conflito entre esta constitution e `docs/app-gestao-aportes.md`, a
constitution rege os princípios de engenharia (isolamento de camadas,
imutabilidade, tratamento de dinheiro, etc.) e o spec rege as decisões de
produto — se o conflito for sobre uma regra de negócio específica, o spec
prevalece e a constitution deve ser atualizada para refletir a coerência.

**Emendas:** qualquer alteração a esta constitution deve ser proposta por
escrito (PR ou commit dedicado), descrever o racional da mudança e atualizar
o Sync Impact Report no topo deste arquivo. Alterações que afetem o Princípio
I (Escopo Negativo) exigem justificativa explícita de por que a exceção não
compromete o propósito central do app.

**Versionamento:** esta constitution segue versionamento semântico
(MAJOR.MINOR.PATCH):
- MAJOR: remoção ou redefinição incompatível de um princípio existente.
- MINOR: adição de um novo princípio ou expansão material de uma seção
  existente.
- PATCH: esclarecimentos de redação, correções de erro de digitação ou
  ajustes não semânticos.

**Revisão de conformidade:** toda alteração de código que toque o Motor de
Aporte, o parser de CSV, o schema Prisma ou o fluxo de import/aporte DEVE ser
avaliada contra os dez princípios acima antes de ser mesclada. Divergências
encontradas em runtime ou em revisão devem ser resolvidas atualizando o spec
(Princípio X) e, se necessário, esta constitution — nunca silenciosamente
no código.

**Version**: 1.0.0 | **Ratified**: 2026-07-29 | **Last Amended**: 2026-07-29
