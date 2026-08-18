# Contrato — Captura de "Patrimônio Aplicado" no Parser CSV MyCapital

Referência: `research.md` R2. Destinado ao subagente `especialista-csv` — este é o único módulo do sistema que conhece o formato do export (CLAUDE.md), então esta é a especificação a ser validada/implementada por ele, não por outra camada.

## Extensão de tipo (`src/parser/types.ts`)

`PosicaoParseada` ganha um campo:

```ts
export interface PosicaoParseada {
  chaveExport: string;
  quantidade: string;
  patrimonioHojeCentavos: number;
  tipoGrupo: string;
  tipoAtivoInternacional: string | null;
  dataUltimaCotacao: string | null;
  /**
   * NOVO (feature 003). Coluna "Patrimônio Aplicado" do CSV, convertida para
   * centavos inteiros — mesmo tratamento de parseDecimalParaCentavos já usado
   * para patrimonioHojeCentavos. `null` quando a coluna está ausente do
   * cabeçalho, veio "null" literal, veio vazia, ou não é um número válido
   * naquela linha — NUNCA lança erro nem invalida o arquivo por causa deste
   * campo (research.md R2: coluna opcional, ao contrário de Patrimônio Hoje).
   */
  patrimonioAplicadoCentavos: number | null;
}
```

## Regras de parse

1. **Coluna opcional no cabeçalho**: `"Patrimônio Aplicado"` NÃO entra em `COLUNAS_OBRIGATORIAS`. Se o cabeçalho não tiver essa coluna, todas as linhas do arquivo recebem `patrimonioAplicadoCentavos: null` (o resto do parse continua normalmente).
2. **Valor ausente/`"null"` literal/vazio por linha**: mesma função `valorOuNulo` já usada para `dataUltimaCotacao`/`tipoAtivoInternacional` → `null`.
3. **Valor presente mas não numérico ou negativo**: ao contrário de `Patrimônio Hoje` (que gera `ErroParse` e invalida o arquivo), aqui o campo simplesmente vira `null` para aquela linha — **não gera `ErroParse`, não invalida o arquivo**. Rationale: research.md R2 (falhar o import inteiro por um campo puramente informativo é desproporcional).
4. **Sem mudança em nenhuma outra regra do parser** — `extrairInstituicao`, tratamento de BOM, separador `;`, decimal com ponto, grupo `EXTERIOR` (`Patrimônio Aplicado` já vem convertido para BRL pelo próprio export, mesmo padrão de `Patrimônio Hoje` — research.md R12) permanecem inalterados.

## Impacto em `ArquivoParseado`

Nenhum novo campo agregado necessário (`totalCentavos`/`dataMaisRecente` continuam baseados em `patrimonioHojeCentavos`) — a agregação de valor investido acontece na camada de serviço (`rendimento-service.ts`), não no parser.

## Validação recomendada antes de implementar

Conferir contra um arquivo real de `docs/samples/*.csv` (se disponível localmente — arquivo gitignored, não está no repo): (a) o nome exato da coluna é `"Patrimônio Aplicado"` (não `"Valor Aplicado"`, `"Valor Investido"` ou outra variação); (b) se a coluna existe para todos os `Tipo de Grupo` (ACOES, FII_FIAGRO, ETF, TESOURO_DIRETO, FUNDOS_INVESTIMENTO, OUTROS_FUNDOS, EXTERIOR) ou só para alguns — se só para alguns, os demais grupos simplesmente recebem `null` naturalmente pela regra 2 acima, sem necessidade de tratamento especial por grupo.

## Testes esperados (`tests/parser/`)

- Arquivo com a coluna presente e válida em todas as linhas → `patrimonioAplicadoCentavos` preenchido corretamente em cada `PosicaoParseada`.
- Arquivo sem a coluna no cabeçalho → parse continua `ok: true`, todas as linhas com `patrimonioAplicadoCentavos: null`, nenhum `ErroParse` novo.
- Linha com `"Patrimônio Aplicado"` = `"null"` literal ou vazio → `null` só naquela linha, resto do arquivo processado normalmente.
- Linha com `"Patrimônio Aplicado"` inválido (texto não numérico) → `null` só naquela linha, **sem** `ErroParse`, ao contrário do teste equivalente para `Patrimônio Hoje` inválido (que continua invalidando o arquivo — regra inalterada).
