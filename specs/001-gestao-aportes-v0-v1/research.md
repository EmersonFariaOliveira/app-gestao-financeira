# Research — Gestão de Aportes Mensais (v0 + v1)

**Phase 0 do plano.** A stack (Next.js + Prisma + SQLite) é fixa pela constitution (Princípio IX) e não foi objeto de pesquisa. Abaixo, apenas as escolhas técnicas deixadas em aberto pelo documento-fonte (seção 8) e os pontos que exigiam definição para eliminar ambiguidade na implementação. Nenhuma decisão reabre itens das seções 3, 4, 5, 7 ou 9.

## R1 — Framework de testes: Vitest

- **Decision**: Vitest (com `vitest run` na CI/suíte e cobertura via `@vitest/coverage-v8`).
- **Rationale**: TS-nativo sem transpilação extra, execução rápida de módulos puros (motor/parser são a prioridade declarada) e API compatível com Jest; integra com projeto Next sem configuração especial porque motor e parser não dependem de framework.
- **Alternatives considered**: Jest (mais lento com TS/ESM, exige transform), node:test (sem watch/cobertura ergonômicos), Playwright (E2E de UI — fora da prioridade; pode entrar depois, sem mudar esta decisão).

## R2 — Parse do CSV: parser manual, sem dependência

- **Decision**: parser próprio em `src/parser/mycapital.ts` — strip do BOM UTF-8, split de linhas, separador `;`, validação estrita do cabeçalho (colunas-chave obrigatórias: `Ação`, `Quantidade`, `Patrimônio Hoje`, `Tipo de Grupo`, `dataUltimaCotacao`), `"null"` literal → ausente, decimais com ponto, `tipoAtivoInternacional` como string opaca.
- **Rationale**: o formato é simples, estável e validado com arquivos reais; parser manual dá controle total sobre erros com arquivo/linha/coluna (Princípio V) e zero dependência; qualquer mudança de layout quebra na validação do cabeçalho com mensagem clara.
- **Alternatives considered**: `papaparse` / `csv-parse` — rejeitados: dependência para um formato trivial, mapeamento de erros linha/coluna menos direto, e tolerâncias automáticas (inferência de delimitador, coerção de tipos) que violam o "falhar alto".

## R3 — UI/componentes: Tailwind CSS 4 + shadcn/ui

- **Decision**: Tailwind CSS 4 para estilo; componentes shadcn/ui **copiados para `src/components/`** (tabela, dialog, form, toast, tabs); gráficos do dashboard/histórico com Recharts.
- **Rationale**: shadcn/ui não é dependência de runtime externa — o código entra no repo (compatível com local-first e zero serviços); Tailwind elimina CSS ad-hoc; Recharts cobre barras/linhas simples (alocação atual vs. alvo, evolução patrimonial) sem serviço externo.
- **Alternatives considered**: MUI/Chakra (dependência de runtime pesada e tema próprio desnecessário para 8 telas), CSS puro (mais lento para produzir as telas, sem ganho), Chart.js (equivalente; Recharts escolhido por ser React-idiomático).

## R4 — Percentuais como inteiro em pontos-base (bps)

- **Decision**: todo percentual persiste e calcula como `Int` em bps: `12,5% → 1250`; soma dos alvos vigentes válida = `10000` (com tolerância de arredondamento de ±1 bps); banda de tolerância padrão `150` bps (±1,5 p.p.).
- **Rationale**: estende o Princípio VI (dinheiro é inteiro) aos percentuais — o cálculo do déficit (`percentual_alvo × patrimônio_total`) fica inteiramente em aritmética de inteiros: `deficit_centavos = alvoBps * patrimonioCentavos / 10000` com divisão inteira e política de resto documentada no contrato do motor.
- **Alternatives considered**: `Float` (proibido em espírito — mesmo não sendo dinheiro, contamina o cálculo do déficit), `Decimal` do Prisma (não suportado em SQLite), string decimal (empurra parsing para o motor).

## R5 — Conversão string decimal → centavos sem float

- **Decision**: função única em `src/core/money/` que converte `"1234.56"` → `123456` por manipulação de string (split no `.`, pad/truncate de casas, validação de dígitos), com erro para formato inesperado. Usada pelo parser (valores do CSV) e pela borda da UI (inputs do usuário, aceitando vírgula decimal brasileira).
- **Rationale**: `parseFloat` seguido de `*100` gera erros clássicos (`1.15*100 = 114.99…`); string→inteiro é exato e testável.
- **Alternatives considered**: `parseFloat + Math.round` (arredonda certo na maioria dos casos, mas é exatamente a classe de bug que o Princípio VI proíbe), bibliotecas decimal (dependência desnecessária para 2 operações).

## R6 — Quantidade de ativos: string decimal preservada + preço derivado em centavos

- **Decision**: `posicao.quantidade` persiste como `String` exatamente como veio do export (suporta frações do EXTERIOR, ex.: `0.14451`). Para o arredondamento por lote (regra 7), o serviço deriva `precoCentavos = round(patrimonioCentavos / quantidade)` apenas para ativos B3 — onde a quantidade é inteira, mantendo a aritmética em inteiros; EXTERIOR e renda fixa nunca passam pelo cálculo de lote.
- **Rationale**: quantidade não é dinheiro, mas persistir como string evita qualquer perda de precisão e adia conversão para o único ponto que precisa (lote B3, onde a quantidade é inteira por natureza).
- **Alternatives considered**: `Float` no banco (perde exatidão e convida uso indevido), `Int` (impossível: EXTERIOR é fracionado).

## R7 — Enforcement do isolamento de camadas: ESLint `no-restricted-imports`

- **Decision**: regras de lint por diretório: `src/core/**` proíbe importar `@prisma/*`, `next/*`, `fs`, `path`, `src/db`, `src/services`, `src/parser`, `src/app`; `src/parser/**` proíbe `@prisma/*`, `next/*`, `src/db`, `src/services`; `src/app/**` proíbe `src/db` direto (passa por actions → services). Verificado no `npm run lint` da suíte.
- **Rationale**: a constitution exige revisão de vazamento de camadas — automatizar no lint torna a violação um erro de build, não um item de review.
- **Alternatives considered**: dependency-cruiser (mais poderoso, porém mais uma ferramenta/configuração; ESLint já estará no projeto via Next), disciplina manual (falha silenciosa garantida com o tempo).

## R8 — Backup do banco: `VACUUM INTO` datado antes de confirmar import

- **Decision**: `backup-service.ts` executa `VACUUM INTO 'backups/app-YYYY-MM-DD.db'` (via `$queryRawUnsafe` do Prisma, caminho montado com data local; sufixo `-2`, `-3`… se já existir no dia) imediatamente antes da transação de confirmação da sessão; depois aplica retenção (padrão 12, configurável) apagando os mais antigos.
- **Rationale**: `VACUUM INTO` produz um snapshot consistente e compactado pelo próprio SQLite, sem depender de janela sem escrita; cópia de arquivo simples poderia capturar estado torn com WAL/journal.
- **Alternatives considered**: `fs.copyFile` do `.db` (arrisca inconsistência com journal/WAL), sqlite3 CLI `.backup` (dependência de binário externo — viola zero infraestrutura).

## R9 — Derivação do `mes_referencia` e `data_export`

- **Decision**: `data_export` da sessão = data mais recente entre os `dataUltimaCotacao` de todas as linhas dos arquivos da sessão; `mes_referencia` proposto = `YYYY-MM` dessa data; **sempre editável no preview** antes de confirmar (decisão da seção 7 — export de 01/08 com posições de 31/07 = julho).
- **Rationale**: a data das posições vem por linha no export (Tesouro pode vir D-1); o máximo entre as linhas representa a data efetiva das posições, e a editabilidade cobre qualquer ambiguidade residual sem heurística adicional.
- **Alternatives considered**: data do upload (explicitamente rejeitada pela seção 7), data extraída do nome do arquivo (formato não garantido).

## R10 — Troco do arredondamento por lote (regra 7)

- **Decision**: o troco que não puder ir para um alvo de renda fixa (valor livre) é persistido no próprio registro do aporte (`troco_centavos`); ao abrir a calculadora no mês seguinte, o serviço soma o troco do último aporte registrado à oferta ("R$ X de troco do mês anterior"), nos mesmos moldes dos dividendos.
- **Rationale**: manter o troco no aporte preserva a auditabilidade (Princípio IV) — nada de contador solto em config que se dessincroniza; a regra 7 pede exatamente "sobras registradas para o mês seguinte".
- **Alternatives considered**: chave em `config` (estado mutável sem trilha de auditoria), ignorar o troco (viola SC-005 — soma exata ao centavo).

## R11 — Server actions vs. API routes

- **Decision**: server actions para todas as mutações e leituras das telas (upload de arquivos incluso — server actions aceitam `FormData` com `File`); nenhuma API route pública.
- **Rationale**: app localhost single-user sem consumidores externos — actions eliminam a camada de rotas, mantêm tipagem ponta a ponta e já rodam no servidor local onde estão Prisma e o filesystem.
- **Alternatives considered**: API routes REST (indireção sem consumidor), tRPC (dependência extra para um único cliente).

## R12 — CHECK constraints via migration SQL

- **Decision**: após `prisma migrate dev` gerar a migration, editar o SQL para adicionar `CHECK (status IN ('VIGENTE','SUBSTITUIDO'))` em `sessao_import` (e validação equivalente na camada de aplicação, que continua sendo a validação primária).
- **Rationale**: a seção 3 sugere exatamente isso como defesa em profundidade para a ausência de enum no SQLite.
- **Alternatives considered**: só validação de aplicação (aceitável, mas o CHECK é gratuito), tabela de domínio (complexidade desnecessária).

**Resultado**: nenhum NEEDS CLARIFICATION remanescente. Todas as decisões acima são compatíveis com as camadas da seção 3 e com os 10 princípios da constitution.
