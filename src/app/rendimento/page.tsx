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
 * Fatia atual (US1/P1, MVP): só o card de rendimento consolidado do
 * patrimônio total + seletor de período (presets 1M/3M/6M/12M/Desde o
 * início). Os cards de segmentação por bucket (US2) e o gráfico (US3)
 * chegam em tasks futuras.
 *
 * FR-020 (inviolável): o percentual de rendimento NUNCA é rotulado como
 * "rentabilidade" — é uma razão simples sobre o capital investido no início
 * do período, não uma métrica ponderada por tempo (TWR/XIRR).
 */
import { useEffect, useState } from "react";

import { dadosRendimento } from "@/app/actions/rendimento";
import type { PeriodoInput, RendimentoOutput } from "@/app/actions/rendimento";
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
        <CardContent className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => {
            const ativo = periodoSelecionado.tipo === preset.tipo;
            return (
              <Button
                key={preset.tipo}
                variant={ativo ? "default" : "outline"}
                onClick={() => setPeriodoSelecionado({ tipo: preset.tipo })}
              >
                {preset.label}
              </Button>
            );
          })}
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

      {fase === "pronto" && dados && <CardConsolidado dados={dados} />}
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

  const { consolidado } = dados;
  const semHistorico = consolidado.rendimentoCentavos === null;

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
      <CardContent>
        {semHistorico ? (
          <p className="text-sm text-muted-foreground">
            Sem histórico suficiente para calcular o rendimento neste período — pelo menos
            uma das sessões não tem valor investido rastreável (import antigo sem
            &quot;Patrimônio Aplicado&quot; ou ajuste preenchido).
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {dados.semPeriodoAnteriorParaComparacao && (
              <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                Ainda não há período anterior para comparação — mostrando o rendimento
                acumulado desde a única sessão de import disponível.
              </p>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
                <span className="text-xs text-muted-foreground">Rendimento em R$</span>
                <span
                  className={
                    "text-2xl font-semibold " +
                    (consolidado.rendimentoCentavos! < 0 ? "text-destructive" : "")
                  }
                >
                  {formatCentavosParaReais(consolidado.rendimentoCentavos!)}
                </span>
              </div>
              <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
                <span className="text-xs text-muted-foreground">
                  Ganho sobre capital investido
                </span>
                <span
                  className={
                    "text-2xl font-semibold " +
                    (consolidado.rendimentoPct !== null && consolidado.rendimentoPct < 0
                      ? "text-destructive"
                      : "")
                  }
                >
                  {consolidado.rendimentoPct === null
                    ? "sem histórico suficiente"
                    : formatPercentual(consolidado.rendimentoPct)}
                </span>
              </div>
            </div>
          </div>
        )}
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
