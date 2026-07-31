"use client";

/**
 * src/app/historico/page.tsx — Histórico (tela 6.7,
 * docs/app-gestao-aportes.md seção 6.7).
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * reimplementa a série mensal/linha do tempo/agregação de sessões — ela
 * apenas chama `src/app/actions/dashboard.ts` (que delega a
 * `src/services/dashboard-service.ts`) e exibe o resultado. Toda formatação
 * monetária usa `formatCentavosParaReais` (src/core/money) na borda de
 * exibição.
 *
 * Nota sobre a seção de auditoria (sessões SUBSTITUIDAS): o modelo de dados
 * (`prisma/schema.prisma`, `sessao_import`) não guarda um timestamp de
 * "quando foi substituída" — só `criado_em` (quando aquele import,
 * hoje substituído, foi originalmente feito). A coluna abaixo usa
 * "Import feito em" para esse campo em vez de inventar uma data de
 * substituição que não existe nos dados.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { dadosHistorico } from "@/app/actions/dashboard";
import {
  Card,
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
import { EvolucaoPatrimonialChart } from "@/components/historico/evolucao-patrimonial-chart";
import { SugeridoVsExecutadoChart } from "@/components/historico/sugerido-vs-executado-chart";
import { formatCentavosParaReais } from "@/core/money";
import { useSortableRows } from "@/hooks/use-sortable-rows";
import type { DadosHistoricoOutput } from "@/services/dashboard-service";

type FaseCarregamento = "carregando" | "erro" | "pronto";

/** `Date` -> "DD/MM/AAAA", mesma convenção do dashboard (src/app/page.tsx). */
function formatarData(data: Date): string {
  const d = new Date(data);
  const dia = String(d.getDate()).padStart(2, "0");
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  return `${dia}/${mes}/${d.getFullYear()}`;
}

export default function HistoricoPage() {
  const [fase, setFase] = useState<FaseCarregamento>("carregando");
  const [erro, setErro] = useState<string | null>(null);
  const [dados, setDados] = useState<DadosHistoricoOutput | null>(null);

  // Hook chamado incondicionalmente (regra dos hooks), com fallback `[]`
  // antes de `dados` carregar. "Instituições" fica de fora por ser uma
  // lista (join de várias, sem valor único estável para ordenar).
  const sessoesSubstituidasOrdenadas = useSortableRows(dados?.sessoesSubstituidas ?? [], {
    mesReferencia: (s) => s.mesReferencia,
    dataExport: (s) => new Date(s.dataExport).getTime(),
    criadoEm: (s) => new Date(s.criadoEm).getTime(),
    patrimonioTotalCentavos: (s) => s.patrimonioTotalCentavos,
  });

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const resp = await dadosHistorico();
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
        <p className="text-sm text-muted-foreground">Carregando histórico…</p>
      </div>
    );
  }

  if (fase === "erro" || !dados) {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <Card>
          <CardHeader>
            <CardTitle>Não foi possível carregar o histórico</CardTitle>
            <CardDescription>{erro}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const temSerieSuficiente = dados.serieMensal.length >= 2;
  const temAportes = dados.linhaDoTempoAportes.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <Cabecalho />

      <Card>
        <CardHeader>
          <CardTitle>Evolução patrimonial mensal</CardTitle>
          <CardDescription>
            Patrimônio total consolidado por mês, considerando apenas a sessão de import
            vigente de cada mês.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {dados.serieMensal.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum import confirmado ainda — importe os CSVs do mês em{" "}
              <Link href="/import" className="underline">
                /import
              </Link>{" "}
              para começar o histórico.
            </p>
          ) : temSerieSuficiente ? (
            <EvolucaoPatrimonialChart serieMensal={dados.serieMensal} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Ainda há só um mês de import ({dados.serieMensal[0].mesReferencia},{" "}
              {formatCentavosParaReais(dados.serieMensal[0].patrimonioTotalCentavos)}) — o
              gráfico de evolução aparece a partir do segundo mês.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sugerido vs. executado</CardTitle>
          <CardDescription>
            Linha do tempo de aportes registrados: o que o motor sugeriu vs. o que foi de
            fato executado, por mês.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {temAportes ? (
            <SugeridoVsExecutadoChart linhaDoTempoAportes={dados.linhaDoTempoAportes} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Nenhum aporte registrado ainda — calcule e registre o primeiro em{" "}
              <Link href="/aporte" className="underline">
                /aporte
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auditoria de imports substituídos</CardTitle>
          <CardDescription>
            Sessões que deixaram de ser a vigente do mês por causa de um re-import mais
            recente. Mantidas apenas para consulta histórica — não afetam o dashboard nem
            nenhum cálculo atual.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {dados.sessoesSubstituidas.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma sessão substituída até agora.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead
                    sortDirection={sessoesSubstituidasOrdenadas.sortDirectionFor("mesReferencia")}
                    onSort={() => sessoesSubstituidasOrdenadas.toggleSort("mesReferencia")}
                  >
                    Mês de referência
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={sessoesSubstituidasOrdenadas.sortDirectionFor("dataExport")}
                    onSort={() => sessoesSubstituidasOrdenadas.toggleSort("dataExport")}
                  >
                    Data das posições
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={sessoesSubstituidasOrdenadas.sortDirectionFor("criadoEm")}
                    onSort={() => sessoesSubstituidasOrdenadas.toggleSort("criadoEm")}
                  >
                    Import feito em
                  </SortableTableHead>
                  <TableHead>Instituições</TableHead>
                  <SortableTableHead
                    sortDirection={sessoesSubstituidasOrdenadas.sortDirectionFor(
                      "patrimonioTotalCentavos",
                    )}
                    onSort={() =>
                      sessoesSubstituidasOrdenadas.toggleSort("patrimonioTotalCentavos")
                    }
                  >
                    Patrimônio total (naquele import)
                  </SortableTableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessoesSubstituidasOrdenadas.sortedRows.map((sessao) => (
                  <TableRow key={sessao.sessaoImportId}>
                    <TableCell>{sessao.mesReferencia}</TableCell>
                    <TableCell>{formatarData(sessao.dataExport)}</TableCell>
                    <TableCell>{formatarData(sessao.criadoEm)}</TableCell>
                    <TableCell>{sessao.instituicoes.join(", ")}</TableCell>
                    <TableCell>
                      {formatCentavosParaReais(sessao.patrimonioTotalCentavos)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Cabecalho() {
  return (
    <div>
      <h1 className="text-2xl font-heading font-semibold tracking-tight">Histórico</h1>
      <p className="text-sm text-muted-foreground">
        Evolução patrimonial, aportes sugeridos vs. executados e auditoria de imports
        substituídos.
      </p>
    </div>
  );
}
