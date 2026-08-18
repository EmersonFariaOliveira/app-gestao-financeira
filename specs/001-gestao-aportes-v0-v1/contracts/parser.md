# Contrato — Parser CSV MyCapital (`src/parser/`)

**Este é o ÚNICO módulo do sistema que conhece o formato do export do MyCapital** (seção 3; Princípio II). Nenhum outro código interpreta colunas ou nomes de campos do CSV. Sem imports de Prisma/Next; entrada é conteúdo em memória, saída são tipos próprios.

## API

```ts
// Parse de um arquivo (uma instituição)
function parseArquivoMyCapital(input: ArquivoImport): ResultadoParse

// Extração da instituição do nome do arquivo (ex.: "..._Itaú.csv" → "Itaú")
function extrairInstituicao(nomeArquivo: string): string

interface ArquivoImport {
  nomeArquivo: string
  conteudo: Uint8Array          // bytes crus do upload
}

type ResultadoParse =
  | { ok: true; arquivo: ArquivoParseado }
  | { ok: false; erros: ErroParse[] }     // qualquer erro ⇒ NADA é aproveitado do arquivo

interface ArquivoParseado {
  instituicao: string
  linhas: PosicaoParseada[]
  totalCentavos: number          // soma de patrimonioHojeCentavos (para o preview)
  dataMaisRecente: string | null // máx. dataUltimaCotacao (ISO date), p/ data_export
}

interface PosicaoParseada {
  chaveExport: string                    // coluna "Ação", string exata
  quantidade: string                     // decimal literal preservado (fracionado no EXTERIOR)
  patrimonioHojeCentavos: number         // Int centavos — convertido sem float (R5)
  tipoGrupo: string                      // string opaca (ACOES, FII_FIAGRO, ETF, TESOURO_DIRETO, EXTERIOR, …)
  tipoAtivoInternacional: string | null  // string opaca, nunca validada
  dataUltimaCotacao: string | null       // ISO date ou null (campo "null" literal)
}

interface ErroParse {
  arquivo: string
  linha: number      // 1-based, contando o cabeçalho como linha 1
  coluna: string     // nome da coluna ofensora, ou '<cabeçalho>' / '<arquivo>'
  mensagem: string   // clara, em português, exibível ao usuário
}
```

## Regras de formato (validadas com `docs/samples/`)

1. **Encoding**: UTF-8 com BOM — os bytes iniciais `EF BB BF` são ignorados se presentes.
2. **Separador**: `;`. **Decimais**: ponto (`1234.56`).
3. **Cabeçalho estrito**: as colunas-chave `Ação`, `Quantidade`, `Patrimônio Hoje`, `Tipo de Grupo`, `dataUltimaCotacao` são obrigatórias. Coluna faltante ⇒ erro em `linha: 1, coluna: <nome>` — é assim que uma mudança de layout do MyCapital quebra alto em um único lugar.
4. **`null` literal**: o texto `null` em qualquer campo é tratado como ausente. `Patrimônio Hoje` nulo ou não numérico ⇒ erro (linha/coluna).
5. **Dinheiro**: `Patrimônio Hoje` convertido para centavos por manipulação de string (nunca `parseFloat`); valor negativo ⇒ erro.
6. **EXTERIOR**: mesmo schema; `Patrimônio Hoje` já vem em BRL (não converter); `Quantidade` pode ser fracionada; `tipoAtivoInternacional` aceito com qualquer valor (string opaca).
7. **Instituição**: extraída do nome do arquivo (último segmento antes de `.csv`, após `_` quando houver; arquivo `Itaú.csv` ⇒ `Itaú`). Nome vazio ⇒ erro `coluna: '<arquivo>'`.
8. **Arquivo vazio / só cabeçalho**: erro claro (`<arquivo>`: "arquivo sem posições").
9. **Falhar alto**: qualquer linha inválida invalida o arquivo inteiro (`ok: false` com TODOS os erros encontrados) — nunca resultado parcial, nunca inferência silenciosa.

## Testes obrigatórios (Vitest, fixtures reais)

- `docs/samples/Itaú.csv`, `docs/samples/Nubank.csv`, `docs/samples/Avenue.csv` parseiam com `ok: true`; totais e contagens conferidos manualmente uma vez e cravados no teste (golden values) — SC-002. **Atenção**: são dados reais, gitignored (só existem localmente) — esses testes fazem skip com aviso quando os arquivos não estão presentes; os casos sintéticos de erro abaixo rodam sempre.
- Avenue: linhas EXTERIOR com quantidade fracionada preservada e `tipoAtivoInternacional` preenchido.
- Sintéticos de erro: sem BOM (aceita), BOM presente (aceita), coluna-chave faltante, `Patrimônio Hoje` = `null`, valor não numérico, arquivo vazio, só cabeçalho, separador errado (vira coluna faltante).
