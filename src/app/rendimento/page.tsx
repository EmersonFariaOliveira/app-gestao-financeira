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
 * FR-020 (inviolável): o percentual de rendimento NUNCA é rotulado como
 * "rentabilidade" — é uma razão simples sobre o capital investido no início
 * do período, não uma métrica ponderada por tempo (TWR/XIRR).
 */
import { useEffect, useState } from "react";

import { dadosRendimento } from "@/app/actions/rendimento";
import type { PeriodoInput, RendimentoOutput } from "@/app/actions/rendimento";
import type {
  PeriodoDisponivel,
  RendimentoAtivoForaDaCarteira,
  RendimentoPeriodo,
  RendimentoPorAlvo,
  RendimentoPorTag,
} from "@/services/rendimento-service";
import { GraficoEvolucaoRendimento } from "@/components/rendimento/grafico-evolucao";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatCentavosParaReais } from "@/core/money";

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
          <CardReservaEmergencia dados={dados} />
          <SecaoTagsEAlvos dados={dados} />
          <SecaoForaDaCarteira dados={dados} />
          <SecaoPendentesDeVinculo dados={dados} />
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

/**
 * Bloco visual reutilizado por todos os cards de rendimento desta tela
 * (consolidado, reserva de emergência, cada tag/alvo, cada ativo fora da
 * carteira) — mesmo par R$/percentual, mesma mensagem "sem histórico
 * suficiente" quando `rendimentoCentavos: null` (FR-010), nunca a palavra
 * "rentabilidade" (FR-020).
 */
function BlocoRendimento({ rendimento }: { rendimento: RendimentoPeriodo }) {
  const semHistorico = rendimento.rendimentoCentavos === null;

  if (semHistorico) {
    return (
      <p className="text-sm text-muted-foreground">
        Sem histórico suficiente para calcular o rendimento neste período — pelo menos uma
        das sessões não tem valor investido rastreável (import antigo sem
        &quot;Patrimônio Aplicado&quot; ou ajuste preenchido).
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
        <span className="text-xs text-muted-foreground">Rendimento em R$</span>
        <span
          className={
            "text-2xl font-semibold " +
            (rendimento.rendimentoCentavos! < 0 ? "text-destructive" : "")
          }
        >
          {formatCentavosParaReais(rendimento.rendimentoCentavos!)}
        </span>
      </div>
      <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
        <span className="text-xs text-muted-foreground">Ganho sobre capital investido</span>
        <span
          className={
            "text-2xl font-semibold " +
            (rendimento.rendimentoPct !== null && rendimento.rendimentoPct < 0
              ? "text-destructive"
              : "")
          }
        >
          {rendimento.rendimentoPct === null
            ? "sem histórico suficiente"
            : formatPercentual(rendimento.rendimentoPct)}
        </span>
      </div>
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
      <CardContent className="flex flex-col gap-4">
        {dados.semPeriodoAnteriorParaComparacao && (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            Ainda não há período anterior para comparação — mostrando o rendimento
            acumulado desde a única sessão de import disponível.
          </p>
        )}
        <BlocoRendimento rendimento={dados.consolidado} />
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

/** Rendimento de tudo que está marcado `reserva_emergencia = true` (US2, FR-008). */
function CardReservaEmergencia({ dados }: { dados: RendimentoOutput }) {
  if (dados.vazio) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reserva de emergência</CardTitle>
        <CardDescription>
          Rendimento de todos os ativos/posições marcados como reserva de emergência, no
          mesmo período selecionado acima.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <BlocoRendimento rendimento={dados.reservaEmergencia} />
      </CardContent>
    </Card>
  );
}

/**
 * Rendimento por tag e, dentro de cada tag, por alvo individual (US2,
 * FR-008/FR-009). Alvos sem tag (`tag: null`) são agrupados numa seção "Sem
 * tag" separada, para nunca ficarem invisíveis.
 */
function SecaoTagsEAlvos({ dados }: { dados: RendimentoOutput }) {
  if (dados.vazio) return null;
  if (dados.porTag.length === 0 && dados.porAlvo.length === 0) return null;

  const alvosSemTag = dados.porAlvo.filter((a) => a.tag === null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rendimento por tag e por alvo</CardTitle>
        <CardDescription>
          Rendimento agrupado por tag da carteira alvo e, dentro de cada tag, o rendimento
          de cada alvo individualmente.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {dados.porTag.map((porTag) => (
          <BlocoTag key={porTag.tag} porTag={porTag} alvos={dados.porAlvo} />
        ))}

        {alvosSemTag.length > 0 && (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <h3 className="text-sm font-semibold">Sem tag</h3>
            <div className="flex flex-col gap-4">
              {alvosSemTag.map((alvo) => (
                <BlocoAlvo key={alvo.alvoId} alvo={alvo} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BlocoTag({
  porTag,
  alvos,
}: {
  porTag: RendimentoPorTag;
  alvos: RendimentoPorAlvo[];
}) {
  const alvosDaTag = alvos.filter((a) => a.tag === porTag.tag);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold">{porTag.tag}</h3>
      <BlocoRendimento rendimento={porTag.rendimento} />
      {alvosDaTag.length > 0 && (
        <div className="flex flex-col gap-4 border-t border-border pt-3">
          {alvosDaTag.map((alvo) => (
            <BlocoAlvo key={alvo.alvoId} alvo={alvo} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlocoAlvo({ alvo }: { alvo: RendimentoPorAlvo }) {
  return (
    <div className="flex flex-col gap-2 pl-3">
      <span className="text-xs font-medium text-muted-foreground">{alvo.nomeAlvo}</span>
      <BlocoRendimento rendimento={alvo.rendimento} />
    </div>
  );
}

/**
 * Cada ativo `fora_da_carteira = true` exibido individualmente, nunca
 * agregado num único número (US2, FR-007/FR-009 — Acceptance Scenario 3).
 */
function SecaoForaDaCarteira({ dados }: { dados: RendimentoOutput }) {
  if (dados.vazio) return null;
  if (dados.foraDaCarteira.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ativos fora da carteira alvo</CardTitle>
        <CardDescription>
          Rendimento de cada ativo marcado como fora da carteira alvo, individualmente —
          nunca somado num único total.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {dados.foraDaCarteira.map((item) => (
          <BlocoAtivoForaDaCarteira key={item.chaveExport} item={item} />
        ))}
      </CardContent>
    </Card>
  );
}

function BlocoAtivoForaDaCarteira({ item }: { item: RendimentoAtivoForaDaCarteira }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <span className="text-xs font-medium text-muted-foreground">{item.chaveExport}</span>
      <BlocoRendimento rendimento={item.rendimento} />
    </div>
  );
}

/**
 * Cada ativo pendente de vínculo (sem alvo, não fora da carteira, não
 * reserva de emergência) exibido individualmente, à parte dos demais
 * buckets — nunca agregado nem somado ao rendimento de nenhum alvo/tag
 * (FR-017). Mesmo shape de `foraDaCarteira`, então reaproveita
 * `BlocoAtivoForaDaCarteira` para o bloco individual.
 */
function SecaoPendentesDeVinculo({ dados }: { dados: RendimentoOutput }) {
  if (dados.vazio) return null;
  if (dados.pendentes.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pendentes de vínculo</CardTitle>
        <CardDescription>
          Ativos ainda sem vínculo a um alvo da carteira — não fora da carteira nem reserva
          de emergência. Exibidos à parte, individualmente, e não influenciam o rendimento de
          nenhum alvo ou tag. Entram apenas no rendimento consolidado do patrimônio total.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {dados.pendentes.map((item) => (
          <BlocoAtivoForaDaCarteira key={item.chaveExport} item={item} />
        ))}
      </CardContent>
    </Card>
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
