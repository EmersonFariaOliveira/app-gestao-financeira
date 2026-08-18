# Contrato — Integração de Posições Manuais e Ajustes com o Motor de Aporte

**O motor puro (`src/core/motor/**`) NÃO é tocado por esta feature.** Nenhum tipo em
`src/core/motor/types.ts` muda de forma, nenhuma regra 1-9 (`deficit.ts`, `fila.ts`,
`divisao.ts`, `arredondamento.ts`) muda de comportamento. Toda a feature é
responsabilidade da camada de serviço (`src/services/aporte-service.ts` e um futuro
`posicao-manual-service.ts`) e da camada de dados (schema Prisma). Isso é intencional
e verificado abaixo (seção 1), não uma omissão.

Este documento cobre três coisas, na ordem em que o design foi derivado:

1. Por que o motor não precisa mudar (contrato de `PosicaoConsolidada`).
2. Como a camada de serviço monta `PosicaoConsolidada[]` incluindo posições manuais
   (entrada do motor).
3. O algoritmo exato de geração e consumo do `incremento_valor_investido_pendente`
   (fora do motor — puro fluxo de serviço/dados, do lado de saída do `registrarAporte`).

---

## 1. O motor não muda — justificativa

`PosicaoConsolidada` (`src/core/motor/types.ts`) já é agnóstica de origem:

```ts
export interface PosicaoConsolidada {
  chaveExport: string;
  alvoId: string | null;
  foraDaCarteira: boolean;
  valorCentavos: number;
  tipoGrupo: string;
}
```

Nenhum desses quatro campos carrega semântica de "veio do CSV". `deficit.ts` só soma
`valorCentavos` por `alvoId` e ignora `foraDaCarteira`/`alvoId: null` — não importa se
a posição nasceu de uma linha de `posicao` (CSV) ou de `posicao_manual_valor` (manual).
`arredondamento.ts` só aplica lote a alvos presentes em `cotacoes` (regra 7) — posições
manuais nunca entram em `cotacoes` (ver seção 2), então nunca são candidatas a
arredondamento por construção, sem qualquer alteração no motor.

Conclusão: **incluir posições manuais no cálculo de déficit é inteiramente uma questão
de "quantas `PosicaoConsolidada` a camada de serviço monta antes de chamar
`calcularAporte`"**, não uma questão de contrato do motor. O mesmo vale para
`valor_investido`/`valor_investido_corrigido`: como esses campos nunca aparecem em
`PosicaoConsolidada`, é estruturalmente impossível que o motor os utilize — FR-006 é
satisfeito por construção (o campo simplesmente não existe do lado de dentro da
fronteira do motor), não por uma checagem em tempo de execução.

Se no futuro isso deixar de ser verdade (e.g. o motor precisar saber "esta posição é
manual" para alguma regra nova), o ponto de entrada correto seria adicionar um campo
opcional a `PosicaoConsolidada` (ex.: `origem?: 'CSV' | 'MANUAL'`) — mas nenhuma regra
1-9 da seção 5 do doc, nem nenhum requisito desta feature, precisa disso hoje.

---

## 2. Montagem de `PosicaoConsolidada[]` com posições manuais

Responsabilidade: `montarContextoEntradaMotor()` em `src/services/aporte-service.ts`.
Hoje essa função só lê `prisma.posicao` (CSV). Ela passa a agregar, na MESMA lista
`posicoes: PosicaoConsolidada[]`, dois conjuntos adicionais, sem duplicar identidade:

### 2.1 Exclusão de ativos `ignorar_no_import`

Antes de consolidar `posicao` por `chave_export` (loop atual em
`montarContextoEntradaMotor`), qualquer `chave_export` cujo `ativo_mapeado.ignorar_no_import`
seja `true` é **excluída inteiramente** do `consolidadoPorChave` — nunca entra em
`posicoes[]` com o dado (incorreto) do CSV. Ela é substituída pela `posicao_manual` cujo
`chave_export_origem` aponta para esta `chave_export` (match exato, ver
`mapeamento-service.ts` `existePosicaoManualSubstituta` — **não** "vinculada ao mesmo alvo":
`ativo_mapeado.alvo_id` é sempre `null` para `chave_export` ignorada, então não há alvo
comum para casar; a única identidade que liga as duas é `chave_export_origem`). Isso
espelha o padrão já existente para `foraDaCarteira` (filtrado dentro do motor) e para
pendências (filtrado antes de chegar ao motor) — `ignorar_no_import` é filtrado **na
camada de serviço**, porque não é um conceito do motor (`PosicaoConsolidada` não tem esse
campo e não deveria ganhar um).

> Dependência de schema (fora do escopo deste contrato, responsabilidade
> `arquiteto-dados`): `ativo_mapeado` precisa do campo `ignorar_no_import Boolean` —
> hoje só existe `fora_da_carteira`.

### 2.2 Inclusão de posições manuais ativas

Para a sessão vigente (`sessao.id`) resolvida no início de `montarContextoEntradaMotor`:

```
posicoesManuaisAtivas = prisma.posicao_manual.findMany({ where: { ativo: true } })
snapshots = prisma.posicao_manual_valor.findMany({
  where: {
    sessao_import_id: sessao.id,
    posicao_manual_id: { in: posicoesManuaisAtivas.map(p => p.id) },
  },
})
```

> **Atualização (decisão de produto pós-implementação inicial):** `posicao_manual`
> deixou de exigir `alvo_id` na criação — ela agora tem exatamente a MESMA máquina de
> estados que `ativo_mapeado` já tem: `alvo_id: string | null` (null = pendente de
> vínculo, resolvido em `/vinculos`), mais `fora_da_carteira: boolean` e
> `reserva_emergencia: boolean`, mutuamente exclusivos com `alvo_id` preenchido (mesma
> invariante de `ativo_mapeado`, validada na camada de aplicação). O trecho abaixo
> (`alvoId: posicaoManual.alvo_id, // nunca null`) descrevia o design original — não é
> mais verdade; a versão corrigida é a que segue.

Para cada `posicao_manual` ativa com snapshot na sessão vigente, `montarContextoEntradaMotor`
espelha EXATAMENTE o tratamento que já dá a `ativo_mapeado` (bloco do CSV, alguns
parágrafos acima):

```ts
// reserva_emergencia: EXCLUÍDA inteiramente de posicoes[] — mesmo padrão do bloco
// CSV (`if (mapeamento?.reserva_emergencia) continue;`). Checagem de colisão de
// identidade (abaixo) roda ANTES deste continue — mesmo posição manual pendente/
// fora-da-carteira/reserva precisa ser validada quanto à colisão.
if (posicaoManual.reserva_emergencia) continue;

posicoes.push({
  chaveExport: posicaoManual.chave_manual,       // identificador análogo, não é chave_export do CSV
  alvoId: posicaoManual.alvo_id,                 // agora pode ser null (pendente de vínculo)
  foraDaCarteira: posicaoManual.fora_da_carteira,// agora reflete o campo real, não mais fixo `false`
  valorCentavos: snapshot.valor_atual_centavos,  // NUNCA valor_investido — regra 5.2/FR-006
  tipoGrupo: "RENDA_FIXA_MANUAL",                // fixo, seção 4.1
});

// Mesmo `if (!alvoId || foraDaCarteira) continue;` do bloco CSV: posição
// pendente ou fora da carteira entra em posicoes[] mas não participa da
// agregação de tipos/cotação por alvo (regra 4) — sem isso, tiposGrupoPorAlvoId
// quebraria de tipo com alvo_id null.
if (!posicaoManual.alvo_id || posicaoManual.fora_da_carteira) continue;
```

Notas:

- **`valor_atual`, nunca `valor_investido`.** O motor só enxerga `valor_atual_centavos`
  do snapshot — `valor_investido_centavos` nunca é lido por `montarContextoEntradaMotor`
  para fins de `PosicaoConsolidada` (é lido separadamente, só para exibição/histórico,
  em outro serviço fora deste contrato).
- **Posição manual PENDENTE bloqueia a calculadora (FR-015), mesmo tratamento que
  `ativo_mapeado` pendente já recebe.** Uma `posicao_manual` ativa com `alvo_id = null
  AND fora_da_carteira = false AND reserva_emergencia = false` é uma pendência de
  vínculo — listada por uma função irmã de `listarPendenciasDaSessao`
  (`listarPendenciasPosicoesManuais`, em `aporte-service.ts`), identificada por
  `chave_manual` na mesma lista de strings de pendência que já usa `chave_export`.
  Diferente das pendências de CSV (que dependem de uma sessão de import ter trazido
  a `chave_export`), a pendência de `posicao_manual` é **independente de sessão**
  (`posicao_manual` não é filha de `sessao_import`) — `listarPendencias()` retorna
  pendências de posição manual mesmo quando não há sessão VIGENTE nenhuma.
- **`fora_da_carteira = true` entra em `posicoes[]` mas nunca no déficit** — mesmo
  tratamento de `ativo_mapeado.fora_da_carteira` (regra 4): excluída de
  `patrimonioBaseCentavos` e da fila, mas ainda sujeita à checagem de colisão de
  identidade (não é "invisível" ao sistema, só não participa dos percentuais).
- **`reserva_emergencia = true` é EXCLUÍDA inteiramente de `posicoes[]`** — mesmo
  tratamento de `ativo_mapeado.reserva_emergencia`: nem entra na base do motor, nem
  na fila, nem bloqueia a calculadora (é um estado RESOLVIDO, análogo a
  `fora_da_carteira`, não uma pendência).
- **`RENDA_FIXA_MANUAL` na heurística `rendaFixa`.** `GRUPOS_NAO_RENDA_FIXA` (hoje
  `{ACOES, FII_FIAGRO, ETF, EXTERIOR}`) já trata qualquer tipo fora dessa lista como
  renda-fixa-like — `RENDA_FIXA_MANUAL` cai nesse "qualquer outro" sem precisar de
  nenhuma mudança no `Set`. Um alvo cujas posições são só `RENDA_FIXA_MANUAL` é
  `rendaFixa: true` (destino de troco de lote, regra 7) — comportamento correto e
  automático, não precisa de caso especial.
- **`GRUPOS_B3` nunca inclui `RENDA_FIXA_MANUAL`.** A geração de `cotacoes` (loop
  `candidatosCotacaoPorAlvo`) só considera `GRUPOS_B3.has(dados.tipoGrupo)` — posições
  manuais nunca entram em `cotacoes`, logo nunca são arredondadas por lote (regra 7,
  "não se aplica a posições manuais" — seção 5, regra 7, já garante isso na
  documentação; esta seção garante isso na implementação).
- **Guarda de colisão de identidade (fail loud).** Antes de inserir, verificar que
  `posicaoManual.chave_manual` não coincide com nenhuma `chave_export` de
  `consolidadoPorChave` já montado (CSV) nem com outra `chave_manual` já inserida.
  Colisão é um erro de integridade de dados (cadastro do usuário permitiu uma
  `chave_manual` igual a um ticker/nome real do CSV) — lançar erro explícito, no
  mesmo padrão de "Falhar Alto, Nunca em Silêncio" já usado em `divisao.ts` e
  `arredondamento.ts`, em vez de somar silenciosamente duas posições distintas sob a
  mesma chave. Recomenda-se também um `@unique` em `chave_manual` no schema
  (`arquiteto-dados`) para prevenir a colisão na origem, mas a checagem na camada de
  serviço é a garantia definitiva porque `chave_export` e `chave_manual` vivem em
  tabelas diferentes (SQLite não valida unicidade cross-table).

### 2.3 Pré-condição para uma posição manual aparecer no cálculo

Uma `posicao_manual` ativa só entra em `posicoes[]` se existir um `posicao_manual_valor`
para `(posicao_manual_id, sessao_import_id = sessão vigente)`. Isso implica um requisito
de contrato para o (futuro) `posicao-manual-service.ts`, fora deste arquivo mas
documentado aqui porque afeta diretamente esta integração: **o cadastro de uma nova
`posicao_manual` (FR-002, tela 6.9 ou tela dedicada FR-014) deve, na mesma operação,
criar o `posicao_manual_valor` inicial vinculado à sessão vigente no momento do
cadastro** — sem isso, uma posição recém-criada "fora do fluxo de import" não
apareceria na calculadora até o próximo import, o que contradiz o Independent Test da
User Story 1 ("cadastrando uma posição manual... conferindo que o déficit... passa a
considerar esse valor" no mesmo fluxo, sem esperar um import). Se não existir sessão
vigente no momento do cadastro, o cadastro deve falhar alto com a mesma mensagem já
usada por `montarContextoEntradaMotor` ("Nenhuma sessão de import VIGENTE
encontrada..."), pelo mesmo motivo que a calculadora inteira já exige uma sessão
vigente — não um caso novo, apenas uma aplicação do padrão existente.

---

## 3. Algoritmo de "mapeamento exclusivo" (FR-010 a FR-012)

Ponto de gatilho: dentro de `registrarAporte()`, depois de persistir o `aporte`
(mesma transação Prisma), para cada linha de `input.executado` com
`valor_centavos > 0` (linhas com 0 ou ausentes não geram pendência — nada foi
aportado ali).

### 3.1 Definição de "ativo elegível" para um `alvo_id`

Dois conjuntos, avaliados no estado ATUAL do banco (não histórico):

**(a) Posições manuais elegíveis:**
```
posicao_manual WHERE alvo_id = X AND ativo = true
```

**(b) Ajustes elegíveis (por `chave_export`):**
```
chave_export tal que:
  ativo_mapeado.alvo_id = X
  AND ativo_mapeado.fora_da_carteira = false
  AND ativo_mapeado.ignorar_no_import = false
  AND EXISTS (SELECT 1 FROM ajuste_valor_investido WHERE chave_export = chave_export)
```

A condição `EXISTS ajuste_valor_investido` é a definição de **"ajuste ativo"**: um
`chave_export` vinculado ao alvo mas que **nunca** teve nenhum `ajuste_valor_investido`
criado NÃO é elegível — ele é uma posição comum do CSV, sem correção de valor
investido habilitada; incluí-lo geraria uma pendência para um campo que não existe na
tela de revisão (FR-009 só define comportamento de "campo vazio" para um ajuste que
JÁ existe e aparece pela primeira vez com valor vazio — não cria um ajuste do nada a
partir de um incremento de aporte). Isso é uma decisão de leitura de spec, não uma
regra explícita no doc — documentada aqui como interpretação de "ajuste ativo"
(FR-010), coerente com o fato de `ajuste_valor_investido` ser uma correção pontual
que o usuário opta em criar (seção 5.2), nunca implícita.

A condição `ativo_mapeado.alvo_id = X` usa o vínculo ATUAL (não o vínculo no momento
em que o `ajuste_valor_investido` foi criado) — se o ativo foi desvinculado do alvo
desde então, `alvo_id` já não é mais `X` e o ajuste correspondente naturalmente sai do
conjunto elegível para esse alvo (consistente com FR-015 e com a Assumption de
spec.md: "ajuste só é relevante enquanto o `chave_export` estiver vinculado a um alvo
ativo").

### 3.2 Contagem e decisão

```
elegiveis = posicoesManuaisElegiveis ++ ajustesElegiveis   (união, cada item com seu tipo)
n = elegiveis.length

se n === 0:
    NÃO cria incremento_valor_investido_pendente para este alvo.
    (Não há nenhuma entidade de valor_investido vinculada a este alvo — nada a
    incrementar; documentado explicitamente para não gerar linhas "fantasma" na
    tela de revisão para alvos 100% CSV/B3 sem posição manual/ajuste.)

se n === 1:
    cria 1 linha:
      alvo_id = X
      chave_export = elegivel.chaveExport   (se veio de (b))   | null
      posicao_manual_id = elegivel.id       (se veio de (a))   | null
      aporte_id = <id do aporte recém-criado>
      valor_incremento = executado.valor_centavos
      aplicado = false
    (no máximo um dos dois FKs preenchido — nunca ambos, por construção do algoritmo)

se n >= 2:
    cria 1 linha:
      alvo_id = X
      chave_export = null
      posicao_manual_id = null
      aporte_id = <id do aporte recém-criado>
      valor_incremento = executado.valor_centavos
      aplicado = false
    (pendência ambígua, nível do alvo — FR-012)
```

Toda a operação roda dentro da MESMA transação Prisma que já cria o `aporte` em
`registrarAporte` (seção "REGRA 9" do arquivo atual) — se a criação de qualquer
`incremento_valor_investido_pendente` falhar, o `aporte` inteiro reverte, mesmo padrão
de atomicidade já usado para os dividendos incluídos.

### 3.3 FR-015 — bloqueio explícito

FR-015 ("bloquear a geração de incremento pendente para posições manuais encerradas
ou ajustes sem vínculo de alvo ativo") já está satisfeito pela própria definição de
"elegível" na seção 3.1 (`ativo = true` para posição manual; `alvo_id = X` +
`fora_da_carteira = false` para ajuste) — não é um `if` adicional depois do cálculo,
é a condição de entrada no conjunto `elegiveis`. Não há caminho de código em que uma
posição encerrada ou um ajuste desvinculado entre na contagem `n`.

---

## 4. Consumo da pendência no próximo import (FR-008, FR-011 a FR-013)

Ponto de gatilho: montagem da tela de revisão (US3/US4, seção 6.9) para a NOVA sessão
de import, antes da confirmação. Fora do escopo estrito de `aporte-service.ts` (é um
`posicao-manual-service.ts` futuro), mas documentado aqui por ser o lado de saída
simétrico ao algoritmo da seção 3.

### 4.1 Pré-preenchimento por ativo (caso exclusivo, `n === 1` histórico)

Para cada `posicao_manual` ativa / `chave_export` com ajuste ativo, o CONJUNTO exibido
na tela de revisão usa a identidade ampliada de "ativo sob ajuste" (data-model.md,
seção "Identidade de 'ativo sob ajuste'"): `ignorar_no_import = false` E (`alvo_id
IS NOT NULL` OU `fora_da_carteira = true`) — **não** a elegibilidade de incremento
automático da seção 3.1 (`alvo_id = X AND fora_da_carteira = false`), que continua
restrita a ativos vinculados a um alvo, por ser inerentemente por-alvo (um aporte é
sempre registrado NUM alvo). As duas condições são deliberadamente distintas: um
`chave_export` fora-da-carteira aparece na revisão com o valor anterior carregado
(carry-forward normal de `valorAnterior`, ver abaixo), mas `incrementoPendenteCentavos`
é sempre `0` para ele, porque nunca existe `incremento_valor_investido_pendente` para
uma chave sem alvo (a seção 3.1 nunca gera uma linha dessas). Não "corrija" este
comportamento para reaproveitar a fórmula de 3.1 aqui — foi ampliado por decisão de
produto (ver data-model.md).

```
valorAnterior = valor_investido (ou valor_investido_corrigido) do snapshot
                da sessão VIGENTE imediatamente anterior a esta nova sessão
                (0 / vazio se não houver — primeira vez, FR-009)

pendentes = incremento_valor_investido_pendente WHERE
              aplicado = false
              AND (posicao_manual_id = <esta posição> OR chave_export = <este ativo>)
            -- TODAS as pendências não aplicadas, não só a mais recente: se dois
            -- aportes foram registrados antes do próximo import (ex.: dois meses
            -- de aporte sem reimportar), ambas as pendências se acumulam e são
            -- somadas juntas — nenhuma é descartada.

incremento = sum(pendentes.valor_incremento)

valorPrePreenchido = valorAnterior + incremento    -- editável (FR-008)
```

### 4.2 Destaque de pendência ambígua por alvo (`n >= 2` histórico)

```
Para cada alvo_id com linhas incremento_valor_investido_pendente
  WHERE aplicado = false AND chave_export IS NULL AND posicao_manual_id IS NULL:

totalPendenteAlvo = sum(valor_incremento dessas linhas)

Exibido como texto de destaque na tela de revisão (seção 6.9):
  "R$ totalPendenteAlvo aportados em '<nome do alvo>' sem fundo específico —
   distribua abaixo"
-- Não é somado automaticamente a nenhum campo de valor_investido específico.
```

### 4.3 `aplicado = true` na confirmação da sessão (FR-013)

Na confirmação da nova sessão de import (mesma transação que cria os
`posicao_manual_valor`/`ajuste_valor_investido` da sessão nova):

```
UPDATE incremento_valor_investido_pendente
SET aplicado = true
WHERE id IN (todas as linhas somadas nas seções 4.1 e 4.2 para esta revisão)
```

Isso vale tanto para pendências exclusivas (seção 4.1) quanto para pendências
ambíguas de alvo (seção 4.2) — mesmo padrão "oferecida uma vez, nunca mais" já usado
para dividendos (`dividendo.aporte_id`). Uma pendência ambígua marcada `aplicado = true`
não é reaberta se o usuário só distribuiu parte do valor entre os campos do alvo — ver
decisão de julgamento na seção 5.

### 4.4 Idempotência em reimport antes de confirmar

`aplicado` só é setado no momento da CONFIRMAÇÃO da sessão (seção 4.3), nunca no
momento em que a tela de revisão apenas exibe o pré-preenchimento (seção 4.1/4.2). Se
o usuário reimporta um novo conjunto de CSVs antes de confirmar a sessão em
andamento (a sessão em preview simplesmente não chega a existir como registro
confirmado), nenhuma pendência foi marcada `aplicado = true` ainda — a nova tela de
revisão soma as mesmas pendências novamente, sem duplicação e sem perda. Nenhum
código de reconciliação extra é necessário: a regra "só marca aplicado na
confirmação" já garante isso por construção.

Para o caso em que uma sessão JÁ foi confirmada (pendências já `aplicado = true`) e
depois um novo import do MESMO mês a substitui (`VIGENTE → SUBSTITUIDO`): as
pendências permanecem `aplicado = true` (nunca revertidas — imports são imutáveis,
seção 4.1 do doc) e o carry-forward da nova sessão parte do snapshot da sessão que
ESTAVA vigente um instante antes (que já continha o incremento aplicado) — o valor já
incrementado é preservado por carry-forward comum, sem reaplicar o incremento uma
segunda vez. Nenhum caso especial de código é necessário aqui também.

---

## 5. Decisões de julgamento (fora de FR/regra explícita — sinalizar se divergente)

1. **"Ajuste ativo" exige `ajuste_valor_investido` já criado ao menos uma vez** para o
   `chave_export` (seção 3.1-b). Sem isso, um `chave_export` comum do CSV, vinculado a
   um alvo mas nunca "promovido" a ajuste pelo usuário, seria tratado como candidato a
   incremento automático — o que criaria um `ajuste_valor_investido` implícito nunca
   pedido pelo usuário. Interpretação adotada: NÃO elegível até o usuário criar o
   primeiro ajuste manualmente.
2. **`n === 0` não gera nenhuma linha** (nem exclusiva, nem ambígua). Não há requisito
   que descreva esse caso explicitamente; a alternativa (gerar uma linha ambígua de
   alvo mesmo sem nenhum ativo elegível) poluiria a tela de revisão com alvos 100%
   CSV/B3 que nunca terão onde aplicar o valor. Se o produto quiser esse tipo de
   pendência "informativa" mesmo sem elegíveis, é uma revisão futura, não coberta aqui.
3. **Pendência ambígua de alvo é marcada `aplicado = true` integralmente na
   confirmação, mesmo com distribuição parcial pelo usuário** (seção 4.3). O
   edge case de spec.md ("resto não alocado") fica sem rastreamento de centavo a
   centavo — uma vez oferecida numa revisão confirmada, não é reoferecida, e o
   eventual resto não distribuído é responsabilidade do usuário perceber
   manualmente (mesmo modelo dos dividendos: "utilizado" é binário, não fracionário).
   Se essa perda de precisão for inaceitável, a alternativa é permitir "aplicado
   parcial" com um campo de valor residual — mudança de schema não coberta por este
   contrato.
4. **Cadastro de `posicao_manual` fora do fluxo de import exige sessão vigente
   existente** (seção 2.3) e cria o `posicao_manual_valor` inicial na mesma operação.
   Não há sessão "zero" no schema atual para guardar posições manuais antes do
   primeiro import — mesma exigência que já vale para toda a calculadora.

---

## 6. Dependências de schema não cobertas por este contrato (arquiteto-dados)

Listadas aqui apenas porque o algoritmo acima as pressupõe — não são especificadas em
detalhe neste documento:

- `ativo_mapeado.ignorar_no_import Boolean @default(false)` (seção 2.1).
- Tabelas `posicao_manual`, `posicao_manual_valor`, `ajuste_valor_investido`,
  `incremento_valor_investido_pendente` conforme seção 4.1 do doc.
- Recomenda-se `@unique` em `posicao_manual.chave_manual` (guarda adicional à
  checagem em tempo de execução da seção 2.2).
