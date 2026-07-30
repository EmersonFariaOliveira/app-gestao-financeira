# Data Model — Gestão de Aportes Mensais (v0 + v1)

Materialização do modelo conceitual da **seção 4 de `docs/app-gestao-aportes.md`** sob as restrições Prisma + SQLite (seção 3): sem enums (String + CHECK), sem listas escalares (JSON em String), dinheiro como `Int` em centavos, percentuais como `Int` em bps (research.md R4). Nomes de tabela/campo em português, como no documento.

## Convenções

- `*_centavos Int` — valor monetário exato (R$ 1.234,56 → `123456`). Nenhum campo monetário usa Float.
- `*_bps Int` — percentual em pontos-base (12,5% → `1250`; total válido = `10000`).
- `mes_referencia String` — formato `YYYY-MM`, validado na aplicação.
- Campos JSON serializados são `String` com o shape documentado abaixo; parse/serialize só na camada de serviços.
- Todas as tabelas têm `id String @id @default(cuid())` e `criado_em DateTime @default(now())` (omitidos abaixo por brevidade quando padrão).

## Entidades

### alvo

Item da carteira de referência, versionado por vigência.

| Campo | Tipo | Regras |
|---|---|---|
| id | String @id | cuid |
| nome | String | obrigatório, não vazio; ex.: "WRLD11", "Pós-fixado" |
| percentual_alvo_bps | Int | > 0; soma dos alvos da vigência ativa = 10000 (validação na tela/serviço, com tolerância ±1 bps de arredondamento) |
| vigencia_inicio | DateTime | obrigatório |
| vigencia_fim | DateTime? | null = vigência aberta |
| ativo | Bool | default true |
| criado_em | DateTime | — |

**Versionamento (seção 6.4)**: ação "a carteira de referência mudou" fecha a vigência (seta `vigencia_fim` em todos os alvos com `vigencia_fim = null`) e clona os alvos numa nova vigência para edição. Alvos de vigências fechadas nunca são alterados nem deletados. **Alvos vigentes** = `vigencia_fim = null AND ativo = true`.

### ativo_mapeado

De-para memorizado entre a chave exata do export e um alvo (N-para-1), ou marcador fora-da-carteira.

| Campo | Tipo | Regras |
|---|---|---|
| id | String @id | cuid |
| chave_export | String @unique | string exata da coluna `Ação` do CSV; case/acentos preservados |
| alvo_id | String? (FK → alvo) | N-para-1; null permitido |
| fora_da_carteira | Bool | default false |
| criado_em | DateTime | — |

**Estados derivados** (invariante validado na aplicação — `alvo_id` e `fora_da_carteira = true` são mutuamente exclusivos):

- *Vinculado*: `alvo_id != null` e `fora_da_carteira = false`
- *Fora da carteira alvo*: `alvo_id = null` e `fora_da_carteira = true` — excluído da base de percentuais, nunca recebe aporte, exibido à parte
- *Pendente*: `alvo_id = null` e `fora_da_carteira = false` — **bloqueia a calculadora**

Mudança de grafia no export ⇒ nova `chave_export` ⇒ novo registro pendente (comportamento desejado). O vínculo aponta para o alvo *conceitual*; ao versionar a carteira, os clones da nova vigência mantêm a associação (o serviço re-aponta os vínculos para os alvos clonados na mesma transação do versionamento).

### sessao_import

Snapshot imutável das posições de um mês. **Nunca é deletada nem tem posições alteradas** — apenas o `status` transiciona.

| Campo | Tipo | Regras |
|---|---|---|
| id | String @id | cuid |
| mes_referencia | String | `YYYY-MM`; derivado de `data_export`, editável no preview (research.md R9) |
| data_export | DateTime | data das posições (máx. `dataUltimaCotacao` dos arquivos) |
| status | String | `'VIGENTE'` \| `'SUBSTITUIDO'` — validado na aplicação + `CHECK (status IN ('VIGENTE','SUBSTITUIDO'))` via migration SQL (research.md R12) |
| instituicoes | String | JSON `string[]` extraído dos nomes dos arquivos; uso: checagem de completude |
| criado_em | DateTime | — |

**Índice**: `(mes_referencia, status)`. **Invariante de aplicação**: no máximo uma sessão `VIGENTE` por `mes_referencia`.

**Transição de estado** (única existente, unidirecional, em transação na confirmação do import):

```
[nova sessão criada VIGENTE] ──┐
sessão anterior do mesmo mês: VIGENTE → SUBSTITUIDO (nunca o inverso, nunca DELETE)
```

### posicao

Linha de posição de uma sessão (filha imutável de `sessao_import`).

| Campo | Tipo | Regras |
|---|---|---|
| id | String @id | cuid |
| sessao_import_id | String (FK → sessao_import) | obrigatório; onDelete: Restrict |
| chave_export | String | como veio na coluna `Ação` |
| instituicao | String | extraída do nome do arquivo |
| quantidade | String | decimal literal do export, preservado (research.md R6); EXTERIOR pode ser fracionado |
| patrimonio_hoje_centavos | Int | ≥ 0; valor de mercado em BRL (EXTERIOR já vem convertido) |
| tipo_grupo | String | como veio (`ACOES`, `FII_FIAGRO`, `ETF`, `TESOURO_DIRETO`, `FUNDOS_INVESTIMENTO`, `OUTROS_FUNDOS`, `EXTERIOR`, …) — string opaca, sem enum |
| tipo_ativo_internacional | String? | string opaca (`STOCK`, …), exibida como veio |
| data_ultima_cotacao | DateTime? | pode faltar (`null` literal no CSV) |

**Consolidação** (em leitura, nunca materializada): posições da sessão vigente somadas por `chave_export` (mesma chave em instituições diferentes = uma posição consolidada).

### aporte

Registro de um cálculo + execução declarada. Amarrado **permanentemente** à sessão do cálculo.

| Campo | Tipo | Regras |
|---|---|---|
| id | String @id | cuid |
| sessao_import_id | String (FK → sessao_import) | sessão vigente no momento do cálculo; NUNCA re-vinculado se ela for substituída |
| valor_total_centavos | Int | > 0; valor digitado + dividendos incluídos + troco anterior incluído |
| valor_dividendos_centavos | Int | ≥ 0; parcela vinda de dividendos |
| sugestao | String | JSON `LinhaAporte[]` — o que o motor sugeriu |
| executado | String | JSON `LinhaAporte[]` — o que o usuário declarou ter feito (valores reais da ordem; cotação defasada aceita) |
| troco_centavos | Int | ≥ 0; sobra de arredondamento por lote registrada para o mês seguinte (research.md R10) |
| criado_em | DateTime | — |

**Shape `LinhaAporte`** (JSON): `{ alvo_id: string, nome_alvo: string, valor_centavos: number, origem: 'DEFICIT' | 'TRANSBORDO' | 'AJUSTE_USUARIO', cotas?: number, preco_centavos?: number }` — `nome_alvo` denormalizado para auditoria estável mesmo após versionamento de alvos.

**Regra 9 (inviolável)**: registrar um aporte **não** escreve em `posicao` — nenhum código de escrita em posições existe fora da confirmação de import.

### dividendo

Lançamento manual, independente das sessões de import.

| Campo | Tipo | Regras |
|---|---|---|
| id | String @id | cuid |
| chave_export | String (FK → ativo_mapeado.chave_export) | ativo da lista de conhecidos |
| mes_referencia | String | `YYYY-MM` |
| valor_centavos | Int | > 0; em R$ (EXTERIOR: valor já convertido recebido) |
| aporte_id | String? (FK → aporte) | null = **disponível**; preenchido = **utilizado**, nunca mais oferecido |
| criado_em | DateTime | — |

**Estados**: disponível (`aporte_id = null`) → utilizado (`aporte_id` set, na transação de registro do aporte). Unidirecional. Edição/exclusão permitidas **apenas** enquanto disponível. Múltiplos lançamentos por ativo/mês permitidos. Re-imports não tocam dividendos.

### config

Chave-valor em JSON, exportável/importável (backup portável).

| Campo | Tipo | Regras |
|---|---|---|
| chave | String @id | — |
| valor | String | JSON |

**Chaves e defaults**:

| chave | default | significado |
|---|---|---|
| `banda_tolerancia_bps` | `150` | ±1,5 p.p. — visual (regra 8) |
| `aporte_minimo_centavos` | `50000` | R$ 500 — regra 5; atualizado a cada uso da calculadora ("lembrado da última vez") |
| `retencao_backups` | `12` | cópias mantidas em `backups/` |

## Relações (resumo)

```
alvo 1 ── N ativo_mapeado          (alvo_id, nullable)
sessao_import 1 ── N posicao       (imutáveis após confirmação)
sessao_import 1 ── N aporte        (FK permanente, sobrevive à substituição)
aporte 1 ── N dividendo            (aporte_id marca utilização, nullable)
ativo_mapeado 1 ── N dividendo     (por chave_export)
```

## Regras de integridade transversais

1. Nenhum `DELETE` em `sessao_import`, `posicao` e `aporte`; nenhum `UPDATE` em `posicao` e em `aporte.sugestao` após criação. `dividendo` só sofre UPDATE/DELETE enquanto `aporte_id = null`. `alvo` de vigência fechada é somente-leitura.
2. Transação de confirmação de import: (backup via `VACUUM INTO` **antes**, fora da transação) → cria `sessao_import` + `posicao[]` + `ativo_mapeado` pendentes para chaves novas → marca sessão anterior do mesmo mês como `SUBSTITUIDO`.
3. Transação de registro de aporte: cria `aporte` → seta `aporte_id` nos dividendos incluídos. Nada mais.
4. Base de cálculo dos percentuais/déficits = posições consolidadas da sessão vigente **excluindo** `fora_da_carteira = true` e ignorando pendentes (que bloqueiam a calculadora antes de qualquer cálculo).
