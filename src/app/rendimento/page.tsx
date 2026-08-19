"use client";

/**
 * src/app/rendimento/page.tsx — Análise de Rendimento (tela 6.10,
 * specs/003-dashboard-analise-rendimento/research.md R9).
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * reimplementa a fórmula de rendimento (déficit/soma/percentual) — ela
 * apenas chama `src/app/actions/rendimento.ts` (que delega a
 * `src/services/rendimento-service.ts`) e exibe o resultado. Toda formatação
 * monetária usa `formatCentavosParaReais` (src/core/money) na borda de
 * exibição.
 *
 * Fatia atual (US1+US2+US3): card de rendimento consolidado do patrimônio
 * total + seletor de período (presets 1M/3M/6M/12M/Desde o início, mais um
 * modo customizado com duas sessões vigentes específicas), a segmentação por
 * bucket (US2, FR-008/FR-009): reserva de emergência, cada tag/alvo dentro
 * dela, e cada ativo fora da carteira individualmente, e o gráfico
 * interativo de evolução (US3, `GraficoEvolucaoRendimento`).
 *
 * Redesenho de UX (puramente apresentação — nenhum dado/fórmula mudou): a
 * pilha de dezenas de cards quase idênticos (um par de caixas "Rendimento em
 * R$" / "Ganho sobre capital investido" por tag/alvo/ativo) virou tabelas
 * compactas e ordenáveis (`useSortableRows`/`SortableTableHead`), com a
 * seção "por tag e por alvo" como tabela expansível em accordion (tag ->
 * alvos da tag). Cor de status (verde/vermelho, `CHART_COLORS.statusGood`/
 * `statusCritical`) NUNCA é a única pista — sempre acompanhada de ícone
 * (▲/▼/—) e do sinal do número.
 *
 * FR-020 (inviolável): o percentual de rendimento NUNCA é rotulado como
 * "rentabilidade" — é uma razão simples sobre o capital investido no início
 * do período, não uma métrica ponderada por tempo (TWR/XIRR).
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Minus, TrendingDown, TrendingUp } from "lucide-react";

import { dadosRendimento } from "@/app/actions/rendimento";
import type { PeriodoInput, RendimentoOutput } from "@/app/actions/rendimento";
import type {
  PeriodoDisponivel,
  RendimentoAtivoForaDaCarteira,
  RendimentoPeriodo,
  RendimentoPorAlvo,
} from "@/services/rendimento-service";
import { GraficoEvolucaoRendimento } from "@/components/rendimento/grafico-evolucao";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  SortableTableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TagBadge } from "@/components/ui/tag-badge";
import { CHART_COLORS } from "@/components/charts/chart-colors";
import { ordenarLinhas, useSortableRows } from "@/hooks/use-sortable-rows";
import type { SortDirection } from "@/hooks/use-sortable-rows";
import { formatCentavosParaReais } from "@/core/money";
import { cn } from "@/lib/utils";

type FaseCarregamento = "carregando" | "erro" | "pronto";

type PresetPeriodo = "1M" | "3M" | "6M" | "12M" | "DESDE_INICIO";

const PRESETS: Array<{ tipo: PresetPeriodo; label: string }> = [
  { tipo: "1M", label: "Último mês" },
  { tipo: "3M", label: "3 meses" },
  { tipo: "6M", label: "6 meses" },
  { tipo: "12M", label: "12 meses" },
  { tipo: "DESDE_INICIO", label: "Desde o início" },
];

/** `number` (percentual já dividido, ex.: 12.5) -> "12,50%", sem passar por `Intl` (mesma convenção pt-BR do resto do app). */
function formatPercentual(pct: number): string {
  const negativo = pct < 0;
  const abs = Math.abs(pct);
  const formatado = abs.toFixed(2).replace(".", ",");
  return `${negativo ? "-" : ""}${formatado}%`;
}

export default function RendimentoPage() {
  const [fase, setFase] = useState<FaseCarregamento>("carregando");
  const [erro, setErro] = useState<string | null>(null);
  const [dados, setDados] = useState<RendimentoOutput | null>(null);
  const [periodoSelecionado, setPeriodoSelecionado] = useState<PeriodoInput>({ tipo: "3M" });
  // Seleção do modo customizado (só usada quando `modoCustomizado: true`) —
  // separada de `periodoSelecionado` para o usuário poder escolher as duas
  // sessões antes de disparar a busca (evita re-fetch a cada seleção parcial
  // com um id vazio/incompleto).
  const [modoCustomizado, setModoCustomizado] = useState(false);
  const [sessaoInicioCustom, setSessaoInicioCustom] = useState("");
  const [sessaoFimCustom, setSessaoFimCustom] = useState("");

  useEffect(() => {
    let cancelado = false;
    setFase("carregando");
    (async () => {
      const resp = await dadosRendimento(periodoSelecionado);
      if (cancelado) return;
      if (!resp.ok) {
        setErro(resp.erro);
        setFase("erro");
        return;
      }
      setDados(resp.data);
      setFase("pronto");
    })();
    return () => {
      cancelado = true;
    };
  }, [periodoSelecionado]);

  return (
    <div className="flex flex-col gap-6">
      <Cabecalho />

      <Card>
        <CardHeader>
          <CardTitle>Período de análise</CardTitle>
          <CardDescription>
            Escolha o intervalo entre duas sessões de import vigentes para calcular o
            rendimento consolidado do patrimônio total.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => {
              const ativo = !modoCustomizado && periodoSelecionado.tipo === preset.tipo;
              return (
                <Button
                  key={preset.tipo}
                  variant={ativo ? "default" : "outline"}
                  onClick={() => {
                    setModoCustomizado(false);
                    setPeriodoSelecionado({ tipo: preset.tipo });
                  }}
                >
                  {preset.label}
                </Button>
              );
            })}
            <Button
              variant={modoCustomizado ? "default" : "outline"}
              onClick={() => setModoCustomizado(true)}
            >
              Personalizado
            </Button>
          </div>

          {modoCustomizado && (
            <SeletorPeriodoCustomizado
              periodosDisponiveis={dados?.periodosDisponiveis ?? []}
              sessaoInicioId={sessaoInicioCustom}
              sessaoFimId={sessaoFimCustom}
              onSessaoInicioChange={setSessaoInicioCustom}
              onSessaoFimChange={setSessaoFimCustom}
              onAplicar={() =>
                setPeriodoSelecionado({
                  tipo: "CUSTOMIZADO",
                  sessaoInicioId: sessaoInicioCustom,
                  sessaoFimId: sessaoFimCustom,
                })
              }
            />
          )}
        </CardContent>
      </Card>

      {fase === "carregando" && (
        <p className="text-sm text-muted-foreground">Carregando rendimento…</p>
      )}

      {fase === "erro" && (
        <Card>
          <CardHeader>
            <CardTitle>Não foi possível carregar o rendimento</CardTitle>
            <CardDescription>{erro}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {fase === "pronto" && dados && (
        <>
          <CardConsolidado dados={dados} />
          <CardGraficoEvolucao dados={dados} />
          <SecaoReservaEmergencia dados={dados} />
          <SecaoTagsEAlvos dados={dados} />
          <TabelaAtivosFlat
            titulo="Ativos fora da carteira alvo"
            descricao="Rendimento de cada ativo marcado como fora da carteira alvo, individualmente — o total acima resume o bucket, mas nenhum ativo é somado ao rendimento de um alvo/tag. Ordenado por rendimento em R$, maior ganho primeiro."
            mensagemVazio="Nenhum ativo fora da carteira alvo."
            itens={dados.foraDaCarteira}
            total={dados.foraDaCarteiraTotal}
          />
          <TabelaAtivosFlat
            titulo="Pendentes de vínculo"
            descricao="Ativos ainda sem vínculo a um alvo da carteira — não fora da carteira nem reserva de emergência. O total acima resume o bucket, mas nenhum ativo é somado ao rendimento de nenhum alvo ou tag; entram apenas no consolidado do patrimônio total."
            mensagemVazio="Nenhum ativo pendente de vínculo."
            itens={dados.pendentes}
            total={dados.pendentesTotal}
          />
        </>
      )}
    </div>
  );
}

/**
 * Modo customizado do seletor de período (US3, FR-005/FR-006): duas listas
 * suspensas com as sessões VIGENTE disponíveis (`periodosDisponiveis`, já
 * ordenadas por `mesReferencia` como retornado pela camada de serviço), para
 * o usuário escolher início/fim explicitamente em vez de um preset relativo.
 * O botão "Aplicar" só dispara o novo fetch quando as duas sessões estão
 * selecionadas — nunca envia um `PeriodoInput` customizado incompleto.
 */
function SeletorPeriodoCustomizado({
  periodosDisponiveis,
  sessaoInicioId,
  sessaoFimId,
  onSessaoInicioChange,
  onSessaoFimChange,
  onAplicar,
}: {
  periodosDisponiveis: PeriodoDisponivel[];
  sessaoInicioId: string;
  sessaoFimId: string;
  onSessaoInicioChange: (id: string) => void;
  onSessaoFimChange: (id: string) => void;
  onAplicar: () => void;
}) {
  const selectClassName =
    "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-end sm:gap-4">
      <div className="flex flex-1 flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="sessao-inicio-custom">
          Sessão de início
        </label>
        <select
          id="sessao-inicio-custom"
          className={selectClassName}
          value={sessaoInicioId}
          onChange={(e) => onSessaoInicioChange(e.target.value)}
        >
          <option value="">Selecione…</option>
          {periodosDisponiveis.map((p) => (
            <option key={p.sessaoImportId} value={p.sessaoImportId}>
              {p.mesReferencia}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-1 flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="sessao-fim-custom">
          Sessão de fim
        </label>
        <select
          id="sessao-fim-custom"
          className={selectClassName}
          value={sessaoFimId}
          onChange={(e) => onSessaoFimChange(e.target.value)}
        >
          <option value="">Selecione…</option>
          {periodosDisponiveis.map((p) => (
            <option key={p.sessaoImportId} value={p.sessaoImportId}>
              {p.mesReferencia}
            </option>
          ))}
        </select>
      </div>

      <Button
        disabled={!sessaoInicioId || !sessaoFimId}
        onClick={onAplicar}
      >
        Aplicar
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocos de apresentação de rendimento (valor R$ + percentual). Cor de
// status NUNCA é a única pista — sempre acompanhada de ícone (▲/▼/—) e do
// sinal do número (FR-020: nunca "rentabilidade").
// ---------------------------------------------------------------------------

/** Célula de tabela com o valor em R$, colorido por status (verde/vermelho), apagado quando zero, nota quando `null` (FR-010). */
function CelulaValor({ centavos, className }: { centavos: number | null; className?: string }) {
  if (centavos === null) {
    return <span className="text-xs whitespace-normal italic text-muted-foreground">sem histórico</span>;
  }
  const zero = centavos === 0;
  const cor = zero ? undefined : centavos > 0 ? CHART_COLORS.statusGood : CHART_COLORS.statusCritical;
  return (
    <span
      className={cn("font-medium tabular-nums", zero && "text-muted-foreground/50", className)}
      style={cor ? { color: cor } : undefined}
    >
      {formatCentavosParaReais(centavos)}
    </span>
  );
}

/** Célula de tabela com o percentual (ganho sobre capital investido), ícone ▲/▼/— + cor, nota quando `null` (FR-010). */
function CelulaPercentual({ pct, className }: { pct: number | null; className?: string }) {
  if (pct === null) {
    return <span className="text-xs whitespace-normal italic text-muted-foreground">sem histórico</span>;
  }
  const zero = pct === 0;
  const positivo = pct > 0;
  const cor = zero ? undefined : positivo ? CHART_COLORS.statusGood : CHART_COLORS.statusCritical;
  const Icone = zero ? Minus : positivo ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        zero && "text-muted-foreground/50",
        className,
      )}
      style={cor ? { color: cor } : undefined}
    >
      <Icone className="size-3.5 shrink-0" aria-hidden />
      {formatPercentual(pct)}
    </span>
  );
}

/** Pill de tendência para destaques fora de tabela (hero consolidado, faixa da reserva de emergência) — mesma semântica de `CelulaPercentual`, maior. */
function BadgeTendencia({ pct }: { pct: number }) {
  const zero = pct === 0;
  const positivo = pct > 0;
  const cor = zero ? CHART_COLORS.textMuted : positivo ? CHART_COLORS.statusGood : CHART_COLORS.statusCritical;
  const Icone = zero ? Minus : positivo ? TrendingUp : TrendingDown;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-base font-semibold tabular-nums"
      style={{ color: cor }}
    >
      <Icone className="size-4 shrink-0" aria-hidden />
      {formatPercentual(pct)}
    </span>
  );
}

/**
 * Célula de tabela com um valor ABSOLUTO (não ganho/perda) — "Valor
 * investido"/"Valor atual" das colunas novas de todas as tabelas de
 * ativo/alvo/tag. Cor neutra de propósito (nunca verde/vermelho de
 * `CelulaValor`/`CelulaPercentual`): essa semântica de status é exclusiva do
 * RENDIMENTO, não de um valor bruto. Mesmo tratamento "sem histórico"
 * (itálico/muted) de `CelulaValor` quando `centavos` é `null` (FR-010).
 */
function CelulaValorAbsoluto({ centavos, className }: { centavos: number | null; className?: string }) {
  if (centavos === null) {
    return <span className="text-xs whitespace-normal italic text-muted-foreground">sem histórico</span>;
  }
  return (
    <span className={cn("tabular-nums text-foreground", className)}>{formatCentavosParaReais(centavos)}</span>
  );
}

/**
 * "R$ grande + badge de tendência" reutilizado no cabeçalho (`CardAction`)
 * das 4 seções de bucket (reserva de emergência, tags/alvos, fora da
 * carteira, pendentes) — extraído para não duplicar o mesmo JSX quatro vezes
 * (redesenho de UX, unificação visual pedida pelo usuário). `null` = "sem
 * histórico suficiente" no bucket inteiro (FR-010), mesma nota textual usada
 * antes só pela reserva de emergência.
 */
function TotalDoBucket({
  rendimentoCentavos,
  rendimentoPct,
}: {
  rendimentoCentavos: number | null;
  rendimentoPct: number | null;
}) {
  if (rendimentoCentavos === null) {
    return <span className="text-xs italic text-muted-foreground">sem histórico suficiente</span>;
  }
  return (
    <div className="flex items-center gap-3">
      <CelulaValor centavos={rendimentoCentavos} className="text-lg" />
      {rendimentoPct !== null && <BadgeTendencia pct={rendimentoPct} />}
    </div>
  );
}

/** Número de destaque do card consolidado: valor grande + badge de tendência ao lado. */
function ValorHero({ rendimento }: { rendimento: RendimentoPeriodo }) {
  if (rendimento.rendimentoCentavos === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Sem histórico suficiente para calcular o rendimento neste período — pelo menos uma das
        sessões não tem valor investido rastreável (import antigo sem &quot;Patrimônio
        Aplicado&quot; ou ajuste preenchido).
      </p>
    );
  }

  const centavos = rendimento.rendimentoCentavos;
  const zero = centavos === 0;
  const cor = zero ? undefined : centavos > 0 ? CHART_COLORS.statusGood : CHART_COLORS.statusCritical;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="text-3xl font-bold tabular-nums sm:text-4xl"
          style={cor ? { color: cor } : undefined}
        >
          {formatCentavosParaReais(centavos)}
        </span>
        {rendimento.rendimentoPct !== null && <BadgeTendencia pct={rendimento.rendimentoPct} />}
      </div>
      <span className="text-xs text-muted-foreground">Ganho sobre capital investido</span>
    </div>
  );
}

function CardConsolidado({ dados }: { dados: RendimentoOutput }) {
  if (dados.vazio) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Rendimento consolidado</CardTitle>
          <CardDescription>
            Nenhum import confirmado ainda — importe os CSVs do mês para começar a
            acompanhar o rendimento da carteira.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rendimento consolidado do patrimônio total</CardTitle>
        <CardDescription>
          Variação de valor entre o início e o fim do período selecionado, considerando
          todo o patrimônio (na carteira alvo, fora da carteira, reserva de emergência e
          pendentes de vínculo com dado disponível).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ValorHero rendimento={dados.consolidado} />
        {dados.semPeriodoAnteriorParaComparacao && (
          <p className="text-xs text-muted-foreground">
            Nota: ainda não há período anterior para comparação — o valor acima é o
            rendimento acumulado desde a única sessão de import disponível.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Gráfico interativo de evolução (US3): um ponto por sessão VIGENTE do
 * período selecionado, com valor investido/valor atual/rendimento. Não
 * renderiza nada com menos de 2 pontos — um único ponto não forma uma linha
 * de evolução (o card consolidado já cobre esse caso via
 * `semPeriodoAnteriorParaComparacao`), evitando um gráfico vazio/confuso.
 */
function CardGraficoEvolucao({ dados }: { dados: RendimentoOutput }) {
  if (dados.vazio) return null;
  if (dados.serie.length < 2) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Evolução do rendimento</CardTitle>
          <CardDescription>
            É preciso pelo menos duas sessões vigentes no período selecionado para
            desenhar a evolução — escolha um período mais amplo.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Evolução do rendimento</CardTitle>
        <CardDescription>
          Valor investido, valor atual e rendimento em cada sessão de import vigente do
          período selecionado. Passe o mouse (ou toque) sobre um ponto para ver os valores
          exatos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <GraficoEvolucaoRendimento serie={dados.serie} />
      </CardContent>
    </Card>
  );
}

/**
 * Rendimento de tudo que está marcado `reserva_emergencia = true` (US2,
 * FR-008) — total do bucket no cabeçalho do card (agregado, nunca somado a
 * nenhum outro bucket — FR-007), mais a lista dos ativos individuais que
 * compõem a reserva (`reservaEmergenciaItens`) numa tabela ordenável SEMPRE
 * visível abaixo (mesmo padrão visual de "fora da carteira"/"pendentes"/
 * "tags e alvos" — nenhuma seção da tela esconde a tabela atrás de um
 * toggle), mesmo componente `TabelaRendimentoPorAtivo` reutilizado por
 * "fora da carteira"/"pendentes".
 */
function SecaoReservaEmergencia({ dados }: { dados: RendimentoOutput }) {
  if (dados.vazio) return null;
  return <SecaoReservaEmergenciaComDados dados={dados} />;
}

function SecaoReservaEmergenciaComDados({ dados }: { dados: RendimentoOutput }) {
  const r = dados.reservaEmergencia;
  const itens = dados.reservaEmergenciaItens;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reserva de emergência</CardTitle>
        <CardDescription>
          Ativos/posições marcados como reserva de emergência, no período selecionado acima —
          o total ao lado é o agregado do bucket, nunca somado a nenhum outro (fora da
          carteira, tag/alvo ou pendentes).
        </CardDescription>
        <CardAction>
          <TotalDoBucket rendimentoCentavos={r.rendimentoCentavos} rendimentoPct={r.rendimentoPct} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {itens.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum ativo marcado como reserva de emergência.
          </p>
        ) : (
          <TabelaRendimentoPorAtivo itens={itens} />
        )}
      </CardContent>
    </Card>
  );
}

const CHAVE_SEM_TAG = "__sem_tag__";

/**
 * Rendimento por tag e, dentro de cada tag, por alvo individual (US2,
 * FR-008/FR-009) — tabela expansível em accordion (uma linha por tag,
 * `aria-expanded` no botão de expandir revela os alvos daquela tag como
 * sub-linhas indentadas). Alvos sem tag (`tag: null`) formam um grupo
 * próprio "Sem tag", com o mesmo padrão de linha expansível, mas sem
 * agregado (não existe `RendimentoPorTag` para tag nula — a UI não calcula
 * um agregado, só lista os alvos individuais).
 */
function SecaoTagsEAlvos({ dados }: { dados: RendimentoOutput }) {
  if (dados.vazio) return null;
  if (dados.porTag.length === 0 && dados.porAlvo.length === 0) return null;

  return <SecaoTagsEAlvosComDados dados={dados} />;
}

/**
 * Corpo de `SecaoTagsEAlvos` com hooks incondicionais (regra dos hooks) —
 * separado do wrapper acima, que só faz os early-returns dos casos
 * "vazio"/"sem nenhuma tag ou alvo".
 */
function SecaoTagsEAlvosComDados({ dados }: { dados: RendimentoOutput }) {
  const alvosSemTag = dados.porAlvo.filter((a) => a.tag === null);

  const gruposOrdenados = useSortableRows(dados.porTag, {
    rendimentoCentavos: (t) => t.rendimento.rendimentoCentavos ?? Number.NEGATIVE_INFINITY,
    rendimentoPct: (t) => t.rendimento.rendimentoPct ?? Number.NEGATIVE_INFINITY,
  });

  // Conjunto de grupos RECOLHIDOS (default vazio = tudo expandido no
  // primeiro load — normalmente há poucas tags, então começar tudo visível
  // é mais scaneável do que uma tela em branco exigindo cliques extras; o
  // recolhimento continua disponível por linha e via "Recolher tudo").
  const [colapsados, setColapsados] = useState<Set<string>>(new Set());

  function alternar(chave: string) {
    setColapsados((prev) => {
      const proximo = new Set(prev);
      if (proximo.has(chave)) proximo.delete(chave);
      else proximo.add(chave);
      return proximo;
    });
  }

  const todasAsChaves = [
    ...dados.porTag.map((t) => t.tag),
    ...(alvosSemTag.length > 0 ? [CHAVE_SEM_TAG] : []),
  ];
  const tudoRecolhido = todasAsChaves.length > 0 && todasAsChaves.every((c) => colapsados.has(c));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rendimento por tag e por alvo</CardTitle>
        <CardDescription>
          Rendimento agrupado por tag da carteira alvo e, dentro de cada tag, o rendimento
          de cada alvo individualmente. Clique numa linha para expandir os alvos da tag.
        </CardDescription>
        <CardAction className="flex items-center gap-4">
          <TotalDoBucket
            rendimentoCentavos={dados.carteiraAlvoTotal.rendimentoCentavos}
            rendimentoPct={dados.carteiraAlvoTotal.rendimentoPct}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setColapsados(tudoRecolhido ? new Set() : new Set(todasAsChaves))}
          >
            {tudoRecolhido ? "Expandir tudo" : "Recolher tudo"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tag / alvo</TableHead>
              <TableHead className="text-right">Valor investido</TableHead>
              <TableHead className="text-right">Valor atual</TableHead>
              <SortableTableHead
                className="text-right"
                sortDirection={gruposOrdenados.sortDirectionFor("rendimentoCentavos")}
                onSort={() => gruposOrdenados.toggleSort("rendimentoCentavos")}
              >
                Rendimento em R$
              </SortableTableHead>
              <SortableTableHead
                className="text-right"
                sortDirection={gruposOrdenados.sortDirectionFor("rendimentoPct")}
                onSort={() => gruposOrdenados.toggleSort("rendimentoPct")}
              >
                Ganho sobre capital investido
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {gruposOrdenados.sortedRows.map((porTag) => (
              <LinhaGrupoTag
                key={porTag.tag}
                expandido={!colapsados.has(porTag.tag)}
                onToggle={() => alternar(porTag.tag)}
                rendimento={porTag.rendimento}
                rotulo={<TagBadge tag={porTag.tag} />}
                alvos={dados.porAlvo.filter((a) => a.tag === porTag.tag)}
                sortKey={gruposOrdenados.sortKey}
                sortDirection={gruposOrdenados.direction}
              />
            ))}
            {alvosSemTag.length > 0 && (
              <LinhaGrupoTag
                expandido={!colapsados.has(CHAVE_SEM_TAG)}
                onToggle={() => alternar(CHAVE_SEM_TAG)}
                rendimento={null}
                rotulo={<span className="text-sm font-medium text-muted-foreground">Sem tag</span>}
                alvos={alvosSemTag}
                sortKey={gruposOrdenados.sortKey}
                sortDirection={gruposOrdenados.direction}
              />
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Accessors de ordenação por rendimento — mesmo critério reaplicado às linhas de tag (nível 1) e aos alvos dentro de cada tag (nível 2), nunca duplicado (helper reusado por `LinhaGrupoTag`). */
const ACCESSORS_RENDIMENTO_ALVO = {
  rendimentoCentavos: (a: RendimentoPorAlvo) => a.rendimento.rendimentoCentavos ?? Number.NEGATIVE_INFINITY,
  rendimentoPct: (a: RendimentoPorAlvo) => a.rendimento.rendimentoPct ?? Number.NEGATIVE_INFINITY,
};

type SortKeyRendimento = "rendimentoCentavos" | "rendimentoPct";

/**
 * Uma linha de grupo (tag, ou "Sem tag") + suas sub-linhas de alvo quando
 * expandido. `rendimento: null` = grupo sem agregado calculável pela UI (só
 * o grupo "Sem tag", que não corresponde a nenhum `RendimentoPorTag") — as
 * colunas de R$/% mostram "—" em vez de um número inventado.
 *
 * `sortKey`/`sortDirection`: MESMO critério ativo nos cabeçalhos "Rendimento
 * em R$"/"Ganho sobre capital investido" da tabela de tags (nível 1) —
 * reaplicado aqui aos alvos dentro do grupo (nível 2) via `ordenarLinhas`
 * (nunca uma segunda função de comparação duplicada), para que clicar num
 * cabeçalho reordene tags E os alvos dentro de cada tag expandida juntos.
 * `sortKey: null` (nenhuma coluna clicada ainda) usa o mesmo padrão default
 * de `TabelaAtivosFlatComItens`: rendimento em R$ decrescente, nulos por
 * último.
 */
function LinhaGrupoTag({
  expandido,
  onToggle,
  rendimento,
  rotulo,
  alvos,
  sortKey,
  sortDirection,
}: {
  expandido: boolean;
  onToggle: () => void;
  rendimento: RendimentoPeriodo | null;
  rotulo: React.ReactNode;
  alvos: RendimentoPorAlvo[];
  sortKey: SortKeyRendimento | null;
  sortDirection: SortDirection;
}) {
  const alvosOrdenados = ordenarLinhas(
    alvos,
    ACCESSORS_RENDIMENTO_ALVO,
    sortKey ?? "rendimentoCentavos",
    sortKey === null ? "desc" : sortDirection,
  );

  return (
    <>
      <TableRow>
        <TableCell>
          <button
            type="button"
            aria-expanded={expandido}
            onClick={onToggle}
            className="inline-flex items-center gap-2 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                expandido && "rotate-90",
              )}
              aria-hidden
            />
            {rotulo}
          </button>
        </TableCell>
        <TableCell className="text-right">
          {rendimento ? (
            <CelulaValorAbsoluto centavos={rendimento.pontoInicio.valorInvestidoCentavos} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="text-right">
          {rendimento ? (
            <CelulaValorAbsoluto centavos={rendimento.pontoFim.valorAtualCentavos} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="text-right">
          {rendimento ? (
            <CelulaValor centavos={rendimento.rendimentoCentavos} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="text-right">
          {rendimento ? (
            <CelulaPercentual pct={rendimento.rendimentoPct} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
      </TableRow>

      {expandido && alvos.length === 0 && (
        <TableRow className="bg-muted/20">
          <TableCell colSpan={5} className="pl-9 text-xs text-muted-foreground">
            Nenhum alvo com dado disponível nesta tag.
          </TableCell>
        </TableRow>
      )}

      {expandido &&
        alvosOrdenados.map((alvo) => (
          <TableRow key={alvo.alvoId} className="bg-muted/20">
            <TableCell className="pl-9 text-xs text-muted-foreground">{alvo.nomeAlvo}</TableCell>
            <TableCell className="text-right">
              <CelulaValorAbsoluto
                centavos={alvo.rendimento.pontoInicio.valorInvestidoCentavos}
                className="text-sm"
              />
            </TableCell>
            <TableCell className="text-right">
              <CelulaValorAbsoluto
                centavos={alvo.rendimento.pontoFim.valorAtualCentavos}
                className="text-sm"
              />
            </TableCell>
            <TableCell className="text-right">
              <CelulaValor centavos={alvo.rendimento.rendimentoCentavos} className="text-sm" />
            </TableCell>
            <TableCell className="text-right">
              <CelulaPercentual pct={alvo.rendimento.rendimentoPct} className="text-xs" />
            </TableCell>
          </TableRow>
        ))}
    </>
  );
}

/**
 * Tabela plana e ordenável reutilizada por "Ativos fora da carteira alvo" e
 * "Pendentes de vínculo" (mesmo shape `RendimentoAtivoForaDaCarteira`) — os
 * dois buckets continuam SEPARADOS, cada chamada renderiza sua própria
 * `Card`/`Table`, nunca somados entre si (FR-007/FR-009/FR-017). Ordenada
 * por padrão por rendimento em R$ decrescente (maior ganho primeiro); o
 * usuário pode reordenar por qualquer coluna via `SortableTableHead`.
 */
function TabelaAtivosFlat({
  titulo,
  descricao,
  mensagemVazio,
  itens,
  total,
}: {
  titulo: string;
  descricao: string;
  mensagemVazio: string;
  itens: RendimentoAtivoForaDaCarteira[];
  total: RendimentoPeriodo;
}) {
  if (itens.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{titulo}</CardTitle>
          <CardDescription>{descricao}</CardDescription>
          <CardAction>
            <TotalDoBucket rendimentoCentavos={total.rendimentoCentavos} rendimentoPct={total.rendimentoPct} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{mensagemVazio}</p>
        </CardContent>
      </Card>
    );
  }

  return <TabelaAtivosFlatComItens titulo={titulo} descricao={descricao} itens={itens} total={total} />;
}

function TabelaAtivosFlatComItens({
  titulo,
  descricao,
  itens,
  total,
}: {
  titulo: string;
  descricao: string;
  itens: RendimentoAtivoForaDaCarteira[];
  total: RendimentoPeriodo;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{titulo}</CardTitle>
        <CardDescription>{descricao}</CardDescription>
        <CardAction>
          <TotalDoBucket rendimentoCentavos={total.rendimentoCentavos} rendimentoPct={total.rendimentoPct} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <TabelaRendimentoPorAtivo itens={itens} />
      </CardContent>
    </Card>
  );
}

/**
 * Tabela ordenável de `RendimentoAtivoForaDaCarteira[]` sem o `Card`
 * envolvente — usada tanto por `TabelaAtivosFlatComItens` ("fora da
 * carteira"/"pendentes") quanto por `SecaoReservaEmergenciaComDados` (ativos
 * individuais da reserva de emergência), que já tem seu próprio `Card`/
 * `CardHeader` com o agregado do bucket no topo.
 */
function TabelaRendimentoPorAtivo({ itens }: { itens: RendimentoAtivoForaDaCarteira[] }) {
  // Ordem inicial (antes de qualquer clique em cabeçalho): rendimento em R$
  // decrescente, nulos ("sem histórico") por último — nunca omitidos, só
  // empurrados para o fim (regra 5 do redesenho).
  const itensNaOrdemPadrao = useMemo(
    () =>
      [...itens].sort((a, b) => {
        const va = a.rendimento.rendimentoCentavos ?? Number.NEGATIVE_INFINITY;
        const vb = b.rendimento.rendimentoCentavos ?? Number.NEGATIVE_INFINITY;
        return vb - va;
      }),
    [itens],
  );

  const ordenados = useSortableRows(itensNaOrdemPadrao, {
    ativo: (i) => i.chaveExport,
    rendimentoCentavos: (i) => i.rendimento.rendimentoCentavos ?? Number.NEGATIVE_INFINITY,
    rendimentoPct: (i) => i.rendimento.rendimentoPct ?? Number.NEGATIVE_INFINITY,
  });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead
            sortDirection={ordenados.sortDirectionFor("ativo")}
            onSort={() => ordenados.toggleSort("ativo")}
          >
            Ativo
          </SortableTableHead>
          <TableHead className="text-right">Valor investido</TableHead>
          <TableHead className="text-right">Valor atual</TableHead>
          <SortableTableHead
            className="text-right"
            sortDirection={ordenados.sortDirectionFor("rendimentoCentavos")}
            onSort={() => ordenados.toggleSort("rendimentoCentavos")}
          >
            Rendimento em R$
          </SortableTableHead>
          <SortableTableHead
            className="text-right"
            sortDirection={ordenados.sortDirectionFor("rendimentoPct")}
            onSort={() => ordenados.toggleSort("rendimentoPct")}
          >
            Ganho sobre capital investido
          </SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordenados.sortedRows.map((item) => (
          <TableRow key={item.chaveExport}>
            <TableCell className="max-w-[200px] truncate font-medium" title={item.chaveExport}>
              {item.chaveExport}
            </TableCell>
            <TableCell className="text-right">
              <CelulaValorAbsoluto centavos={item.rendimento.pontoInicio.valorInvestidoCentavos} />
            </TableCell>
            <TableCell className="text-right">
              <CelulaValorAbsoluto centavos={item.rendimento.pontoFim.valorAtualCentavos} />
            </TableCell>
            <TableCell className="text-right">
              <CelulaValor centavos={item.rendimento.rendimentoCentavos} />
            </TableCell>
            <TableCell className="text-right">
              <CelulaPercentual pct={item.rendimento.rendimentoPct} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Cabecalho() {
  return (
    <div>
      <h1 className="text-2xl font-heading font-semibold tracking-tight">
        Análise de rendimento
      </h1>
      <p className="text-sm text-muted-foreground">
        Quanto o patrimônio variou em R$ e em ganho sobre o capital investido, num período
        escolhido.
      </p>
    </div>
  );
}
