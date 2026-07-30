"use client";

/**
 * src/app/page.tsx — Dashboard (tela 6.1, docs/app-gestao-aportes.md seção
 * 6.1: "a visão de 10 segundos: como estou vs. onde deveria estar").
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * reimplementa consolidação/percentuais/desvio — ela apenas chama
 * `src/app/actions/dashboard.ts` (que delega a
 * `src/services/dashboard-service.ts`) e exibe o resultado. Toda formatação
 * monetária usa `formatCentavosParaReais`/`formatBps` (src/core/money) na
 * borda de exibição; os valores trafegam em centavos/bps inteiros em todo o
 * restante do fluxo.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, Calculator, Upload } from "lucide-react";

import { dadosDashboard } from "@/app/actions/dashboard";
import { AlocacaoAtualVsAlvo } from "@/components/dashboard/alocacao-atual-vs-alvo";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCentavosParaReais } from "@/core/money";
import type { DadosDashboardOutput } from "@/services/dashboard-service";

type FaseCarregamento = "carregando" | "erro" | "pronto";

/** `Date` (já resolvido pela action) -> "DD/MM/AAAA" para "posições de DD/MM/AAAA". */
function formatarData(data: Date): string {
  const d = new Date(data);
  const dia = String(d.getDate()).padStart(2, "0");
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  return `${dia}/${mes}/${d.getFullYear()}`;
}

export default function DashboardPage() {
  const [fase, setFase] = useState<FaseCarregamento>("carregando");
  const [erro, setErro] = useState<string | null>(null);
  const [dados, setDados] = useState<DadosDashboardOutput | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const resp = await dadosDashboard();
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
  }, []);

  if (fase === "carregando") {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <p className="text-sm text-muted-foreground">Carregando dashboard…</p>
      </div>
    );
  }

  if (fase === "erro" || !dados) {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <Card>
          <CardHeader>
            <CardTitle>Não foi possível carregar o dashboard</CardTitle>
            <CardDescription>{erro}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (dados.vazio) {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <Card>
          <CardHeader>
            <CardTitle>Nenhum import ainda</CardTitle>
            <CardDescription>
              Importe os CSVs do MyCapital do mês (um por instituição) para começar a
              acompanhar sua carteira vs. a carteira alvo. O dashboard fica pronto assim
              que o primeiro import for confirmado.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button render={<Link href="/import" />}>
              <Upload className="size-4" />
              Novo import
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Cabecalho />

      {dados.qtdPendencias > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-5" />
              {dados.qtdPendencias} ativo(s) pendente(s) de vínculo
            </CardTitle>
            <CardDescription>
              Ativos novos do último import ainda não foram vinculados a um alvo. A
              calculadora de aporte fica bloqueada até resolver — uma pendência
              distorceria os déficits silenciosamente.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button variant="outline" render={<Link href="/vinculos" />}>
              Resolver vínculos pendentes
            </Button>
          </CardFooter>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Patrimônio consolidado</CardTitle>
          <CardDescription>Posições de {formatarData(dados.dataExport)}.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Estatistica
              titulo="Total"
              valor={formatCentavosParaReais(dados.patrimonioTotalCentavos)}
            />
            <Estatistica
              titulo="Na carteira alvo"
              valor={formatCentavosParaReais(dados.patrimonioNaCarteiraCentavos)}
            />
            <Estatistica
              titulo="Fora da carteira"
              valor={formatCentavosParaReais(dados.patrimonioForaDaCarteiraCentavos)}
            />
            <Estatistica
              titulo="Pendente de vínculo"
              valor={formatCentavosParaReais(dados.patrimonioPendenteCentavos)}
              destaque={dados.patrimonioPendenteCentavos > 0}
            />
          </div>
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button render={<Link href="/import" />}>
            <Upload className="size-4" />
            Novo import
          </Button>
          <Button variant="outline" render={<Link href="/aporte" />}>
            <Calculator className="size-4" />
            Calcular aporte
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alocação atual vs. alvo</CardTitle>
          <CardDescription>
            Percentual de cada alvo sobre o patrimônio na carteira alvo, comparado ao
            percentual definido em /alvos. Banda de tolerância:{" "}
            {(dados.bandaToleranciaBps / 100).toFixed(2)} p.p.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AlocacaoAtualVsAlvo alocacao={dados.alocacao} />
        </CardContent>
      </Card>

      {dados.foraDaCarteira.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Fora da carteira alvo</CardTitle>
            <CardDescription>
              Ativos legados marcados como &quot;Fora da carteira alvo&quot; — excluídos
              da base de cálculo dos percentuais e do aporte, exibidos aqui só para
              referência.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ativo</TableHead>
                  <TableHead>Valor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dados.foraDaCarteira.map((ativo) => (
                  <TableRow key={ativo.chaveExport}>
                    <TableCell>{ativo.chaveExport}</TableCell>
                    <TableCell>{formatCentavosParaReais(ativo.valorCentavos)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {dados.pendentes.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Ativos pendentes de vínculo</CardTitle>
            <CardDescription>
              Ainda sem alvo nem marcação de &quot;Fora da carteira&quot; — resolva em{" "}
              <Link href="/vinculos" className="underline">
                /vinculos
              </Link>
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ativo</TableHead>
                  <TableHead>Valor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dados.pendentes.map((ativo) => (
                  <TableRow key={ativo.chaveExport}>
                    <TableCell>{ativo.chaveExport}</TableCell>
                    <TableCell>{formatCentavosParaReais(ativo.valorCentavos)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Estatistica({
  titulo,
  valor,
  destaque = false,
}: {
  titulo: string;
  valor: string;
  destaque?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
      <span className="text-xs text-muted-foreground">{titulo}</span>
      <span
        className={
          destaque
            ? "text-lg font-semibold text-destructive"
            : "text-lg font-semibold"
        }
      >
        {valor}
      </span>
    </div>
  );
}

function Cabecalho() {
  return (
    <div>
      <h1 className="text-2xl font-heading font-semibold tracking-tight">Dashboard</h1>
      <p className="text-sm text-muted-foreground">
        Visão de 10 segundos: como a carteira está vs. onde deveria estar.
      </p>
    </div>
  );
}
