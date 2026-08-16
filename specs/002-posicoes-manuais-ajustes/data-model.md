# Data Model — Posições Manuais e Ajustes de Valor Investido

Materialização das entidades novas descritas na **seção 4.1 de `docs/app-gestao-aportes.md`** (com a seção 5.2 como regra de negócio e a seção 6.9 como fluxo de tela), sob as mesmas restrições Prisma + SQLite já usadas em `specs/001-gestao-aportes-v0-v1/data-model.md`: sem enums (String + CHECK), sem listas escalares (JSON em String), dinheiro como `Int` em centavos. Nomes de tabela/campo em português, como no documento fonte.

Este documento cobre **apenas as entidades novas** desta feature: `posicao_manual`, `posicao_manual_valor`, `ajuste_valor_investido`, `incremento_valor_investido_pendente`. As entidades `alvo`, `ativo_mapeado`, `sessao_import`, `posicao`, `aporte`, `dividendo` e `config` já existem (ver data-model.md da feature 001) e são referenciadas aqui apenas como FK.

## Convenções

Mesmas da feature 001 (não repetidas): `*_centavos Int` para dinheiro, nunca Float; `id String @id @default(cuid())` e `criado_em DateTime @default(now())` omitidos nas tabelas abaixo quando padrão; campos JSON são `String` com shape documentado; `status`/enums são `String` + CHECK manual na migration (research.md R12 da feature 001).

## Alteração necessária em entidade existente

### ativo_mapeado — novo campo `ignorar_no_import`

O schema atual (`prisma/schema.prisma`) ainda não tem este campo, exigido por FR-001. Adição mínima, sem alterar o resto da entidade:

| Campo | Tipo | Regras |
|---|---|---|
| ignorar_no_import | Boolean | default `false`. `true` = ativo lido do CSV mas excluído da consolidação (substituído por uma `posicao_manual`); não dispara alarme de "ativo novo" em imports futuros |

**Invariante de estados** (estende o invariante já documentado em 001 para `ativo_mapeado`): `ignorar_no_import = true` é mutuamente exclusivo com `fora_da_carteira = true` (validado na aplicação). Quando `ignorar_no_import = true`, o `alvo_id` de `ativo_mapeado` **não é usado em nenhum cálculo** — a posição manual que substitui o ativo carrega seu próprio `alvo_id`; `alvo_id` pode ficar `null` nesse estado (não há valor do CSV a atribuir a um alvo).

## Entidades

### posicao_manual

Identidade memorizada de um ativo que não vem (ou não deve vir) corretamente do CSV — tipicamente um CDB. Não é filha de `sessao_import`: existe fora do ciclo de import, com valores que mudam a cada sessão via `posicao_manual_valor`.

| Campo | Tipo | Regras |
|---|---|---|
| id | String @id | cuid |
| chave_manual | String @unique | definida pelo usuário, ex.: `"CDB-ITAU-2029"`; imutável após criação — trocar a chave é cadastrar uma posição manual nova |
| instituicao | String | obrigatório |
| alvo_id | String (FK → alvo) | obrigatório — toda posição manual tem exatamente um alvo (Assumption do spec.md); referencia o alvo *conceitual*, mesmo padrão de `ativo_mapeado.alvo_id` ao versionar a carteira (seção 6.4) |
| descricao | String | obrigatório; ex.: `"CDB Itaú 120% CDI 2029"` |
| tipo_grupo | String | default `"RENDA_FIXA_MANUAL"` — string livre (sem enum), como `posicao.tipo_grupo`; não entra no arredondamento por lote (regra 7 do motor) |
| chave_export_origem | String? (FK → ativo_mapeado.chave_export) | opcional; registra qual `chave_export` marcado `ignorar_no_import` esta posição substitui — fecha a pendência "ativo ignorado sem posição manual associada" (edge case do spec.md). `null` quando a posição foi cadastrada sem CSV de origem (ex.: CDB que nunca apareceu no export) |
| ativo | Boolean | default `true`; `false` = encerrada (FR-004) — some do carry-forward e do cálculo de déficit, histórico preservado; transição unidirecional, sem reativação (Assumption do spec.md) |
| criado_em | DateTime | — |

**Decisão de design (além do diagrama conceitual da seção 4.1):** o diagrama do doc não tem `chave_export_origem`. Adiciono este campo para resolver de forma auditável o edge case "pendência de cadastro visível até criar a posição manual" — sem ele não haveria como o app saber, de forma consultável, quais `ignorar_no_import` já têm posição manual associada. Campo opcional e sem impacto em cálculo; puramente para rastreabilidade/alertas de UI.

### posicao_manual_valor

Snapshot por sessão — o que muda mês a mês numa posição manual. Nunca sobrescrito; um novo import gera novas linhas, nunca `UPDATE` em linhas de sessões já confirmadas.

| Campo | Tipo | Regras |
|---|---|---|
| id | String @id | cuid |
| posicao_manual_id | String (FK → posicao_manual, onDelete Restrict) | obrigatório |
| sessao_import_id | String (FK → sessao_import, onDelete Restrict) | obrigatório — sessão em que este snapshot foi confirmado |
| valor_investido_centavos | Int | ≥ 0; pré-preenchido = valor da sessão vigente anterior + incremento pendente aplicado (ver "Fluxo técnico" abaixo); editável até a confirmação; **nunca usado no cálculo de déficit** (FR-006) |
| valor_atual_centavos | Int | ≥ 0; pré-preenchido = valor da sessão vigente anterior, sem cálculo; editável — vem do extrato do banco; compõe o patrimônio do alvo exatamente como `posicao.patrimonio_hoje_centavos` (FR-003) |
| criado_em | DateTime | — |

`@@unique([posicao_manual_id, sessao_import_id])` — no máximo um snapshot por posição manual por sessão.

### ajuste_valor_investido

Correção pontual do `valor_investido` de um ativo que **continua vindo do CSV** (ex.: fundo de investimento). Mesmo padrão de snapshot por sessão de `posicao_manual_valor`; `valor_atual` não é duplicado aqui — continua vindo de `posicao.patrimonio_hoje_centavos` da sessão.

| Campo | Tipo | Regras |
|---|---|---|
| id | String @id | cuid |
| chave_export | String (FK → ativo_mapeado.chave_export, onDelete Restrict) | ativo já conhecido pelo import |
| sessao_import_id | String (FK → sessao_import, onDelete Restrict) | obrigatório |
| valor_investido_corrigido_centavos | Int? | `null` = primeira aparição desse `chave_export` na tela de ajustes, aguardando preenchimento (FR-009) — nenhuma sessão anterior da qual herdar; quando preenchido, ≥ 0; pré-preenchido nas sessões seguintes = anterior + incremento pendente aplicado; **nunca usado no cálculo de déficit** (FR-006) |
| criado_em | DateTime | — |

`@@unique([chave_export, sessao_import_id])` — no máximo um snapshot por ativo ajustado por sessão.

**Identidade de "ativo sob ajuste":** não há flag própria de ativação/desativação — um `chave_export` está "sob ajuste" a partir do momento em que existe ao menos uma linha `ajuste_valor_investido` para ele (criada na tela de gestão dedicada, fora do fluxo de import, análoga ao "+ Nova posição manual" da seção 6.9 — decisão de UI fora do escopo deste documento). "Ajuste ativo" para fins de exibição na revisão de import (FR-007) é uma condição **derivada**: existe histórico de `ajuste_valor_investido` para o `chave_export` **E** `ativo_mapeado.alvo_id IS NOT NULL` **E** `ativo_mapeado.fora_da_carteira = false` **E** `ativo_mapeado.ignorar_no_import = false`. Isso cobre o edge case do spec.md ("ajuste cujo ativo é desvinculado do alvo": o histórico permanece auditável, mas ele para de aparecer no carry-forward e deixa de ser elegível a incremento — FR-015).

### incremento_valor_investido_pendente

Gerado ao registrar um aporte como executado (tela 6.5); consumido (aplicado) no próximo import que oferecer pré-preenchimento para o ativo/alvo correspondente.

| Campo | Tipo | Regras |
|---|---|---|
| id | String @id | cuid |
| alvo_id | String (FK → alvo, onDelete Restrict) | obrigatório — alvo do aporte que originou o incremento |
| chave_export | String? (FK → ativo_mapeado.chave_export, onDelete Restrict) | preenchido apenas quando o alvo mapeia exclusivamente um único `chave_export` com ajuste ativo (FR-010/011) |
| posicao_manual_id | String? (FK → posicao_manual, onDelete Restrict) | preenchido apenas quando o alvo mapeia exclusivamente uma única `posicao_manual` ativa (FR-010/011) |
| aporte_id | String (FK → aporte, onDelete Restrict) | obrigatório — proveniência, auditável |
| valor_incremento_centavos | Int | > 0; valor executado daquele alvo (ou fração do alvo, se o motor gerar múltiplas linhas por alvo — não ocorre em v1) |
| aplicado | Boolean | default `false`; `true` = já consumido por uma sessão de import (FR-013), nunca mais oferecido |
| sessao_aplicacao_id | String? (FK → sessao_import, onDelete SetNull) | `null` enquanto `aplicado = false`; preenchido no momento em que `aplicado` vira `true`, com a sessão que o consumiu — auditoria de "qual import aplicou este incremento" |
| criado_em | DateTime | — |

**CHECK constraints (migration SQL manual, mesmo padrão de `sessao_import.status` — research.md R12 da feature 001):**

```sql
CHECK (NOT (chave_export IS NOT NULL AND posicao_manual_id IS NOT NULL))
CHECK ((aplicado = 0 AND sessao_aplicacao_id IS NULL) OR (aplicado = 1 AND sessao_aplicacao_id IS NOT NULL))
```

A primeira garante a exclusividade mútua descrita na seção 4.1 ("no máximo um dos dois FKs é preenchido; ambos `null` = alvo ambíguo, distribuição manual"). A segunda garante que `aplicado` e `sessao_aplicacao_id` transicionam juntos.

## Fluxo técnico (carry-forward + consumo de incremento pendente)

Este fluxo estende — sem substituir — a "Transação de confirmação de import" já documentada no item 2 das Regras de integridade transversais de `specs/001-gestao-aportes-v0-v1/data-model.md`.

1. **Sessão de referência para carry-forward.** Ao abrir a tela de revisão (6.9), antes de qualquer `sessao_import` nova existir, o app consulta a **sessão `VIGENTE` mais recente por `mes_referencia`** (`ORDER BY mes_referencia DESC` ou `data_export DESC`, `LIMIT 1`) — não necessariamente do "mês civil anterior", pois `posicao_manual`/`ajuste_valor_investido` não são escopados por mês e um mês pode ter sido pulado sem import. Não é a mesma consulta que resolve o mês do import atual.
2. **Pré-preenchimento (em memória, não persistido ainda).** Para cada `posicao_manual` com `ativo = true`: busca o `posicao_manual_valor` dessa sessão de referência (se existir — pode ser a primeira sessão da posição, criada fora do fluxo de import, sem carry-forward, conforme Assumption do spec.md); soma qualquer `incremento_valor_investido_pendente` com `posicao_manual_id` igual e `aplicado = false` ao `valor_investido_centavos`; `valor_atual_centavos` é copiado sem soma. Para cada `chave_export` com ajuste ativo (derivado, ver seção acima): mesma lógica sobre `ajuste_valor_investido.valor_investido_corrigido_centavos` e `incremento_valor_investido_pendente.chave_export`.
3. **Incrementos ambíguos (nível de alvo).** Para cada `incremento_valor_investido_pendente` com `chave_export IS NULL AND posicao_manual_id IS NULL AND aplicado = false`, soma-se por `alvo_id` e exibe-se em destaque (FR-012) — não é somado a nenhum campo específico; o usuário distribui manualmente entre as linhas de posição manual/ajuste daquele alvo digitando os valores. **Decisão/trade-off assumido:** o spec.md deixa em aberto o que acontece se a distribuição manual não fechar 100% do valor pendente (edge case não resolvido pelos FRs). Este documento assume, por padrão razoável, que o incremento ambíguo é marcado `aplicado = true` na confirmação da sessão **independentemente de reconciliação exata** (a mesma regra de "nunca aplicado silenciosamente, mas sempre marcado como visto" já vale para `chave_export`/`posicao_manual_id` específicos) — cabe à UI (fora do escopo deste documento) decidir se avisa sobre resíduo não alocado antes de confirmar. Se o produto quiser bloquear a confirmação até a distribuição fechar, isso é uma regra de validação de aplicação, não de schema.
4. **Persistência (transação de confirmação, junto com a criação de `sessao_import` + `posicao[]`):**
   - cria uma linha `posicao_manual_valor` por `posicao_manual` ativa exibida na revisão, com os valores confirmados (editados ou herdados);
   - cria uma linha `ajuste_valor_investido` por `chave_export` sob ajuste ativo exibido na revisão, com o valor confirmado (ou mantém `null` se o usuário não preencheu ainda, na primeira aparição);
   - para cada `incremento_valor_investido_pendente` com `aplicado = false` cujo `chave_export`/`posicao_manual_id`/`alvo_id` foi coberto pela revisão desta sessão, faz `UPDATE` para `aplicado = true, sessao_aplicacao_id = <nova sessão>` — a única exceção às regras de imutabilidade deste documento, pois `incremento_valor_investido_pendente` não é um snapshot histórico de posição, é uma fila de trabalho.
5. **Robustez a reimport antes de confirmar.** Como `aplicado` só muda dentro da transação de confirmação (passo 4), um import iniciado e abandonado (nunca confirmado) não persiste `sessao_import` nem `posicao_manual_valor`/`ajuste_valor_investido`, e não marca nenhum incremento como aplicado — reabrir a tela de revisão depois (mesmo com uma sessão nova) refaz os passos 1–3 do zero e os mesmos incrementos pendentes continuam disponíveis. Isso resolve o edge case "reimport antes de confirmar a sessão anterior" do spec.md sem necessidade de lógica extra: não há dupla aplicação porque nada foi de fato aplicado na tentativa abandonada.
6. **Primeira posição manual / primeiro ajuste, fora do fluxo de import.** Cadastro na tela dedicada (FR-014) cria diretamente `posicao_manual` (sem `posicao_manual_valor` inicial obrigatório — os valores iniciais entram como `posicao_manual_valor` vinculado à sessão vigente atual, se houver uma, ou ficam pendentes de primeiro snapshot no próximo import) ou `ajuste_valor_investido` com `sessao_import_id` da sessão vigente atual e `valor_investido_corrigido_centavos` informado ou `null`.

## Elegibilidade para incremento automático (FR-010/FR-011/FR-015)

Ao registrar um aporte como executado, para cada linha do `executado` (JSON `LinhaAporte[]` de `aporte`, ver data-model.md da feature 001) com um `alvo_id`:

```
elegíveis =
    { ativo_mapeado WHERE alvo_id = <alvo> AND fora_da_carteira = false AND ignorar_no_import = false
      AND EXISTS (ajuste_valor_investido histórico para essa chave_export) }
  UNION
    { posicao_manual WHERE alvo_id = <alvo> AND ativo = true }
```

- `count(elegíveis) = 1` → cria `incremento_valor_investido_pendente` com o FK correspondente preenchido (`chave_export` ou `posicao_manual_id`), `alvo_id` sempre preenchido, `aplicado = false`.
- `count(elegíveis) = 0` → **nenhum incremento é criado** (FR-015: sem ativo elegível, não há para onde incrementar — diferente do caso ambíguo, que tem ≥ 2 candidatos).
- `count(elegíveis) >= 2` → cria `incremento_valor_investido_pendente` só com `alvo_id` preenchido, `chave_export = null`, `posicao_manual_id = null` (alvo ambíguo, FR-012).

## Relações (resumo)

```
alvo 1 ── N posicao_manual                        (alvo_id, obrigatório)
alvo 1 ── N incremento_valor_investido_pendente    (alvo_id, obrigatório)

posicao_manual 1 ── N posicao_manual_valor          (snapshot por sessão)
posicao_manual 1 ── N incremento_valor_investido_pendente  (posicao_manual_id, nullable)
ativo_mapeado  1 ── N posicao_manual                (chave_export_origem, nullable, rastreabilidade)

ativo_mapeado  1 ── N ajuste_valor_investido        (chave_export, snapshot por sessão)
ativo_mapeado  1 ── N incremento_valor_investido_pendente  (chave_export, nullable)

sessao_import  1 ── N posicao_manual_valor          (imutável após confirmação)
sessao_import  1 ── N ajuste_valor_investido         (imutável após confirmação)
sessao_import  1 ── N incremento_valor_investido_pendente  (sessao_aplicacao_id, nullable)

aporte  1 ── N incremento_valor_investido_pendente  (aporte_id, proveniência)
```

## Regras de integridade transversais

1. **Nenhum `DELETE`** em `posicao_manual_valor` ou `ajuste_valor_investido` após a sessão ser confirmada — mesmo padrão de `posicao` (feature 001). **Nenhum `UPDATE`** nessas linhas após confirmação; qualquer correção posterior nasce como snapshot novo na próxima sessão.
2. `posicao_manual` admite `UPDATE` em `instituicao`, `descricao`, `alvo_id` (re-vínculo) e `ativo` (somente `true → false`, irreversível). `chave_manual` é imutável após criação.
3. `ativo_mapeado.ignorar_no_import = true` e `ativo_mapeado.fora_da_carteira = true` são mutuamente exclusivos (validado na aplicação, mesmo padrão do invariante de estados já existente para `alvo_id`/`fora_da_carteira` em 001).
4. `incremento_valor_investido_pendente` é a única entidade desta feature que sofre `UPDATE` depois de criada (transição `aplicado: false → true` + `sessao_aplicacao_id`), porque é fila de trabalho, não snapshot histórico — nunca `DELETE`.
5. Transação de confirmação de import (estende o item 2 das regras transversais de 001): backup do `.db` **antes**, fora da transação → cria `sessao_import` + `posicao[]` + `ativo_mapeado` pendentes → cria `posicao_manual_valor[]` e `ajuste_valor_investido[]` da revisão → marca `incremento_valor_investido_pendente` consumidos como aplicados → marca sessão anterior do mesmo `mes_referencia` como `SUBSTITUIDO`. Tudo atômico.
6. `valor_investido_centavos` (`posicao_manual_valor`) e `valor_investido_corrigido_centavos` (`ajuste_valor_investido`) **nunca** são lidos pelo motor de aporte — nenhuma consulta de cálculo de déficit deve fazer `JOIN` nesses campos (FR-006/SC-004). Apenas `valor_atual_centavos` de `posicao_manual_valor` entra na base de cálculo, como `posicao.patrimonio_hoje_centavos`.
7. Elegibilidade de incremento (ver seção dedicada acima) é recalculada a cada registro de aporte executado — nunca lida de um cache; `posicao_manual` encerrada ou `ajuste_valor_investido` sem `ativo_mapeado` vinculado a um alvo ativo nunca entram no conjunto `elegíveis` (FR-015).
8. Consolidação por `chave_export`/`posicao_manual` em instituições diferentes não se aplica aqui: cada `posicao_manual` é uma posição única (não somada com outras) — diferente de `posicao`, que é somada por `chave_export` entre instituições (regra da seção 4.1 do doc fonte, mantida em 001).
