/**
 * src/parser/types.ts — tipos do Parser CSV MyCapital.
 *
 * Contrato: specs/001-gestao-aportes-v0-v1/contracts/parser.md
 *
 * Este é o ÚNICO módulo do sistema que conhece o formato do export do
 * MyCapital (docs/app-gestao-aportes.md, seção 3). Nenhum outro código
 * interpreta colunas ou nomes de campos do CSV. Camada isolada: sem
 * imports de Prisma/Next/db/services (verificado por ESLint em
 * src/parser/**); entrada é conteúdo em memória, saída são tipos
 * próprios.
 *
 * NOTA (fase RED do TDD, T030): apenas as assinaturas e tipos estão
 * declarados aqui. `parseArquivoMyCapital` e `extrairInstituicao` NÃO
 * têm corpo/implementação real neste arquivo — a implementação de
 * verdade é T034 (src/parser/mycapital.ts e src/parser/instituicao.ts).
 * Os testes de tests/parser/ que dependem delas devem FALHAR até lá.
 */

/** Entrada crua de um arquivo de import (uma instituição). */
export interface ArquivoImport {
  /** Nome do arquivo tal como veio do upload (usado para extrair a instituição). */
  nomeArquivo: string;
  /** Bytes crus do upload — o parser decodifica UTF-8 e ignora BOM se presente. */
  conteudo: Uint8Array;
}

/**
 * Uma posição (linha) já parseada e validada do CSV.
 *
 * `quantidade` é preservada como string decimal literal (research.md R6):
 * nunca convertida para number aqui — suporta frações do EXTERIOR
 * (ex.: "0.14451") sem perda de precisão; a conversão para uso no
 * arredondamento por lote é responsabilidade do motor/serviço, não do
 * parser.
 */
export interface PosicaoParseada {
  /** Coluna "Ação" do CSV — string exata, é a chave de vínculo com o alvo. */
  chaveExport: string;
  /** Coluna "Quantidade" — decimal literal preservado como string. */
  quantidade: string;
  /** Coluna "Patrimônio Hoje" convertida para centavos inteiros (nunca float). */
  patrimonioHojeCentavos: number;
  /**
   * Coluna "Tipo de Grupo" — string opaca (ACOES, FII_FIAGRO, ETF,
   * TESOURO_DIRETO, FUNDOS_INVESTIMENTO, OUTROS_FUNDOS, EXTERIOR, ...).
   * O parser não valida contra uma lista fechada de valores.
   */
  tipoGrupo: string;
  /**
   * Coluna "tipoAtivoInternacional" — string opaca, nunca validada
   * (só STOCK foi observado; REIT/ETF/BOND ou qualquer outro valor deve
   * passar sem erro). `null` quando ausente ou literal "null" no CSV.
   */
  tipoAtivoInternacional: string | null;
  /**
   * Coluna "dataUltimaCotacao" — string tal como veio do CSV (ISO date/
   * datetime), ou `null` quando ausente ou literal "null".
   */
  dataUltimaCotacao: string | null;
}

/** Resultado de um parse bem-sucedido (nenhum erro em nenhuma linha). */
export interface ArquivoParseado {
  /** Instituição extraída do nome do arquivo (ver `extrairInstituicao`). */
  instituicao: string;
  /** Todas as posições (linhas de dados) do arquivo. */
  linhas: PosicaoParseada[];
  /** Soma de `patrimonioHojeCentavos` de todas as linhas — usada no preview. */
  totalCentavos: number;
  /** Máximo de `dataUltimaCotacao` entre as linhas (ISO date), ou `null` se nenhuma linha tiver data. */
  dataMaisRecente: string | null;
}

/**
 * Um erro de parse localizado — sempre com linha e coluna, nunca
 * genérico. Falha alta: qualquer `ErroParse` em um arquivo invalida o
 * arquivo inteiro (ver `ResultadoParse`).
 */
export interface ErroParse {
  /** Nome do arquivo onde o erro ocorreu. */
  arquivo: string;
  /** 1-based; a linha do cabeçalho conta como linha 1. */
  linha: number;
  /**
   * Nome da coluna ofensora, ou os marcadores especiais `'<cabeçalho>'`
   * (problema estrutural do cabeçalho) / `'<arquivo>'` (problema do
   * arquivo como um todo: vazio, nome inválido, etc.).
   */
  coluna: string;
  /** Mensagem clara, em português, exibível diretamente ao usuário. */
  mensagem: string;
}

/**
 * Resultado do parse de um arquivo.
 *
 * `ok: false` ⇒ NADA é aproveitado do arquivo — o array `erros` reúne
 * TODOS os problemas encontrados de uma vez (nunca resultado parcial,
 * nunca falha silenciosa).
 */
export type ResultadoParse =
  | { ok: true; arquivo: ArquivoParseado }
  | { ok: false; erros: ErroParse[] };

/**
 * Assinatura de `parseArquivoMyCapital`: parse de um arquivo de export
 * do MyCapital (uma instituição). Definida aqui como tipo (e não como
 * `declare function`) para documentar o contrato sem criar um binding
 * de runtime vazio — a implementação real fica em
 * `src/parser/mycapital.ts` (T034), que deve satisfazer este tipo.
 *
 * Fase RED (T030): este arquivo só define tipos; nenhuma implementação
 * de `parseArquivoMyCapital` existe ainda em `src/parser/`.
 */
export type ParseArquivoMyCapitalFn = (input: ArquivoImport) => ResultadoParse;

/**
 * Assinatura de `extrairInstituicao`: extrai o nome da instituição a
 * partir do nome do arquivo.
 *
 * Regra (contracts/parser.md #7): último segmento antes de `.csv`, após
 * `_` quando houver (`"..._Itaú.csv"` → `"Itaú"`); sem `_`, o nome
 * inteiro antes de `.csv` é a instituição (`"Nubank.csv"` → `"Nubank"`).
 * Nome vazio ou só `.csv` ⇒ erro com `coluna: '<arquivo>'`.
 *
 * A implementação real fica em `src/parser/instituicao.ts` — diferente
 * de `parseArquivoMyCapital`, esta função é simples e isolada o
 * suficiente para já ter sido implementada nesta mesma entrega (T030),
 * então os testes de `tests/parser/instituicao.test.ts` já passam (ver
 * relatório final para a justificativa dessa escolha).
 */
export type ExtrairInstituicaoFn = (nomeArquivo: string) => string;
