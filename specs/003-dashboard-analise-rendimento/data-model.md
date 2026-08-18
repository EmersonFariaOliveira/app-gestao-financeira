# Data Model — Análise de Rendimento da Carteira

Materialização das decisões técnicas de `research.md` sobre a spec (`spec.md`, FR-001 em diante). Mesmas restrições Prisma + SQLite das features 001/002: sem enums (String + CHECK), sem listas escalares (JSON em String), dinheiro como `Int` em centavos.

Este documento cobre: (1) a única alteração de schema desta feature (`posicao.patrimonio_investido_centavos`), e (2) as entidades **conceituais e calculadas** que vivem inteiramente na camada de serviço (`src/services/rendimento-service.ts`) — nunca persistidas, sempre derivadas dos snapshots já existentes (Key Entities do spec.md).

## Alteração necessária em entidade existente

### posicao — novo campo `patrimonio_investido_centavos`

| Campo | Tipo | Regras |
|---|---|---|
| patrimonio_investido_centavos | Int? | `null` = coluna "Patrimônio Aplicado" ausente/inválida nessa linha do CSV daquela sessão (R2/R10) — nunca tratado como zero. Quando presente, snapshot imutável junto com o resto de `posicao` (mesmo padrão de `patrimonio_hoje_centavos`); nunca `UPDATE` após a sessão confirmada. |

**Sessões anteriores à esta feature**: todas as `posicao` já existentes ficam com `patrimonio_investido_centavos = null` (sem backfill — R10). O serviço de rendimento trata isso como "sem histórico suficiente" (FR-010), nunca como erro.

**Invariante**: este campo nunca é lido por `src/core/motor/**` nem por nenhuma query que alimente `PosicaoConsolidada`/`EntradaMotor` (R1) — garantido estruturalmente por não existir em nenhum desses tipos.

## Entidades calculadas (não persistidas)

Vivem como interfaces TypeScript em `src/services/rendimento-service.ts`, no mesmo padrão de `dashboard-service.ts` (`AlocacaoPorAlvo`, `AlocacaoPorTag`). Nunca gravadas em tabela — sempre recalculadas a partir de `posicao.patrimonio_investido_centavos`/`patrimonio_hoje_centavos`, `posicao_manual_valor`, `ajuste_valor_investido` e `aporte.executado`.

### ValorInvestidoResolvido

Resultado da resolução de prioridade R4, para um `chave_export` numa sessão.

```ts
interface ValorInvestidoResolvido {
  chaveExport: string;
  /** null = sem dado suficiente (FR-010) — nem ajuste preenchido, nem CSV. */
  valorInvestidoCentavos: number | null;
  fonte: "ajuste" | "csv" | "indisponivel";
}
```

### RendimentoPonto

Rendimento de um ativo, alvo, tag, reserva de emergência ou ativo fora da carteira, numa única sessão (fórmula R5, ponto no tempo).

```ts
interface RendimentoPonto {
  /** null = FR-010 (sem valor investido rastreável nessa sessão). */
  rendimentoCentavos: number | null;
  /** null quando rendimentoCentavos é null OU valorInvestidoCentavos = 0. */
  rendimentoPct: number | null;
  valorAtualCentavos: number;
  /** null = sem dado (não confundir com 0). */
  valorInvestidoCentavos: number | null;
}
```

### RendimentoPeriodo

Rendimento entre duas sessões (fórmula R5, variação de período) — o que US1/US3 exibem.

```ts
interface RendimentoPeriodo {
  sessaoInicioId: string;
  sessaoFimId: string;
  /** Sempre calculável quando ambos os pontos têm dado — diferença exata em centavos. */
  rendimentoCentavos: number | null;
  /** Base = valorInvestidoCentavos do ponto de início (Clarifications, spec.md). */
  rendimentoPct: number | null;
  pontoInicio: RendimentoPonto;
  pontoFim: RendimentoPonto;
}
```

### SerieRendimento

Um ponto por sessão vigente dentro do período selecionado (US3, gráfico interativo) — nunca inclui sessões `SUBSTITUIDO` (FR-013).

```ts
interface PontoSerieRendimento {
  sessaoImportId: string;
  mesReferencia: string;
  dataExport: Date;
  valorInvestidoCentavos: number | null;
  valorAtualCentavos: number;
  rendimentoCentavos: number | null;
  rendimentoPct: number | null;
}

type SerieRendimento = PontoSerieRendimento[];
```

### MovimentacaoNaoExplicada

Resultado da validação FR-011/FR-011a para um ativo ou alvo, ao confirmar uma nova sessão. Granularidade decidida pela contagem de R6 (`contarAtivosComValorInvestidoRastreavel`).

```ts
interface MovimentacaoNaoExplicada {
  /** "ativo" quando o alvo mapeia exclusivamente 1 elegível (FR-011); "alvo" quando mapeia >1 (FR-011a). */
  granularidade: "ativo" | "alvo";
  /** chaveExport OU posicaoManualId quando granularidade = "ativo"; alvoId sempre presente. */
  chaveExport?: string;
  posicaoManualId?: string;
  alvoId: string;
  nomeAlvo: string;
  valorInvestidoEsperadoCentavos: number;
  valorInvestidoRealCentavos: number;
  diferencaCentavos: number;
  /** true apenas quando |diferencaCentavos| excede AMBOS os limiares de FR-018 (R8). */
  excedeTolerancia: boolean;
}
```

**Nunca persistida** (FR-019) — calculada sob demanda ao confirmar uma sessão de import, exibida como aviso (R13) e recalculável a qualquer momento a partir dos snapshots existentes (não há necessidade de guardar o resultado; se precisasse ser reconsultada depois, os mesmos snapshots ainda estão lá).

### PeriodoAnalise

Intervalo selecionado pelo usuário (FR-005/FR-006), sempre resolvido para duas `sessao_import` `VIGENTE` (ou uma sessão + "mais recente disponível").

```ts
type PeriodoPredefinido = "1M" | "3M" | "6M" | "12M" | "DESDE_INICIO";

interface PeriodoAnalise {
  tipo: PeriodoPredefinido | "CUSTOMIZADO";
  sessaoInicioId: string | null; // null = nenhuma sessão vigente no intervalo (edge case do spec)
  sessaoFimId: string | null;
}
```

## Constantes de aplicação (R8)

```ts
// src/services/rendimento-service.ts
const TOLERANCIA_MOVIMENTACAO_PCT = 5;
const TOLERANCIA_MOVIMENTACAO_PISO_CENTAVOS = 2000; // R$ 20,00
```

Não persistidas em `config` nesta versão (R8) — mudança aditiva e de baixo risco caso vire configurável no futuro.

## Migration

Uma única migration Prisma: `ALTER TABLE posicao ADD COLUMN patrimonio_investido_centavos INTEGER NULL`. Sem `CHECK` novo (campo nullable simples, sem máquina de estados). Sem alteração em nenhuma outra tabela.
