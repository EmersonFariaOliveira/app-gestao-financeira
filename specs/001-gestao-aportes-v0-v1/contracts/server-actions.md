# Contrato — Server Actions (`src/app/actions/`)

Borda entre UI e serviços (research.md R11). Actions **não contêm lógica de negócio**: validam input, chamam `src/services/`, retornam DTOs serializáveis. Nenhuma API route pública. Valores monetários trafegam em centavos até a UI, que formata para R$ apenas na exibição.

Formato de retorno padrão: `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.

## import.ts (tela 6.2)

| Action | Input | Output (`data`) | Regras |
|---|---|---|---|
| `previewImport` | `FormData` com `File[]` | `{ arquivos: {instituicao, totalCentavos, qtdAtivos, dataMaisRecente}[], mesReferenciaProposto, dataExport, avisoSubstituicao?: {mes, dataAnterior}, instituicoesFaltantes?: string[], diff?: {novos, sumiram, variacoesGrandes}, errosParse?: ErroParse[] }` | Parse em memória, nada persiste. Erros de parse ⇒ `ok: false` com linha/coluna (FR-009). `mesReferenciaProposto` derivado de `data_export` (R9). Diff/completude contra sessão anterior (FR-006/007) |
| `confirmarImport` | `{ arquivos (re-upload ou token de preview), mesReferencia, confirmouInstituicoesFaltantes?: boolean }` | `{ sessaoId, pendenciasVinculo: string[] }` | Ordem: backup (`VACUUM INTO`, FR-008) → transação: cria sessão VIGENTE + posições + pendências de vínculo; sessão anterior do mês → SUBSTITUIDO (FR-005). Instituição faltante sem confirmação explícita ⇒ `ok: false` |

## vinculos.ts (tela 6.3)

| Action | Input | Output | Regras |
|---|---|---|---|
| `listarVinculos` | — | `{ pendentes: [], vinculados: [], foraDaCarteira: [] }` | — |
| `vincularAtivo` | `{ chaveExport, alvoId }` \| `{ chaveExport, foraDaCarteira: true }` \| `{ chaveExport, novoAlvo: {nome, percentualBps} }` | vínculo atualizado | Memorizado (FR-013); criar alvo na hora (FR-012); exclusão mútua alvo/fora-da-carteira |

## alvos.ts (tela 6.4)

| Action | Input | Output | Regras |
|---|---|---|---|
| `listarAlvos` | — | alvos vigentes + soma bps + ativos apontando para cada um (FR-019) | — |
| `salvarAlvo` / `removerAlvo` | dados do alvo / `{alvoId}` | lista atualizada + status da soma (= 10000 bps ± tolerância) | Só na vigência aberta (FR-017) |
| `novaVigencia` | — | nova vigência com alvos clonados | Fecha vigência atual, preserva histórico, re-aponta vínculos (FR-018) |

## aporte.ts (tela 6.5)

| Action | Input | Output | Regras |
|---|---|---|---|
| `prepararCalculadora` | — | `{ bloqueada: boolean, pendencias: string[], dividendosDisponiveisCentavos, trocoAnteriorCentavos, aporteMinimoCentavos }` | Bloqueada com pendências (FR-015); oferta de dividendos não utilizados (FR-030) e troco anterior (R10) |
| `calcular` | `{ valorCentavos, incluirDividendos: boolean, incluirTroco: boolean, aporteMinimoCentavos, ajustesUsuario? }` | `ResultadoMotor` + banda aplicada para exibição | Monta `EntradaMotor` da sessão vigente e delega ao motor; atualiza `aporte_minimo_centavos` na config ("lembrado") |
| `registrarAporte` | `{ input do cálculo, sugestao: LinhaAporte[], executado: LinhaAporte[] }` | `{ aporteId }` | Transação: cria aporte amarrado à sessão vigente + marca dividendos incluídos com `aporte_id` (FR-037, FR-030). **Não altera posições** (regra 9) |

## dividendos.ts (tela 6.6)

| Action | Input | Output | Regras |
|---|---|---|---|
| `listarDividendos` | `{ mes? }` | lançamentos + total disponível (mesmo número da calculadora) | FR-032 |
| `lancarDividendo` | `{ chaveExport, mesReferencia, valorCentavos }` | lançamento criado | Só ativos conhecidos; múltiplos por ativo/mês (FR-029) |
| `editarDividendo` / `excluirDividendo` | `{ id, … }` | — | Recusa se `aporte_id != null` (utilizado é imutável) |

## dashboard/histórico (telas 6.1 e 6.7 — leituras, via RSC ou actions)

| Leitura | Output | Regras |
|---|---|---|
| `dadosDashboard` | patrimônio total + data das posições, alocação atual vs. alvo por alvo com desvio e banda (verde/vermelho), fora-da-carteira à parte, alerta de pendências | FR-038..040; banda é visual (regra 8) |
| `dadosHistorico` | série mensal (só sessões VIGENTES, 1 ponto/mês), linha do tempo sugerido vs. executado, acesso de auditoria a sessões SUBSTITUIDAS | FR-041/042 |

## config.ts (tela 6.8)

| Action | Input | Output | Regras |
|---|---|---|---|
| `lerConfig` / `salvarConfig` | chaves: `banda_tolerancia_bps`, `aporte_minimo_centavos`, `retencao_backups` | config atual + caminhos do `.db` e da pasta `backups/` | FR-043/044 |
| `exportarConfigJson` | — | JSON portável (alvos + vínculos + settings) | FR-044 |
| `importarConfigJson` | JSON | resultado com validação | Nunca toca sessões/aportes/dividendos |
