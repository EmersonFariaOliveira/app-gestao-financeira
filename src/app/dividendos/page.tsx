"use client";

/**
 * src/app/dividendos/page.tsx — Dividendos (tela 6.6,
 * docs/app-gestao-aportes.md seção 6.6 / 5.1).
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * reimplementa a regra de disponibilidade/imutabilidade de dividendo — ela
 * apenas chama `src/app/actions/dividendos.ts` (que delega a
 * `src/services/dividendo-service.ts`) e exibe o resultado.
 *
 * Conteúdo (seção 6.6):
 * 1. Lançamento rápido: ativo (dropdown dos conhecidos) + mês + valor em R$.
 * 2. Total disponível GERAL em destaque — o MESMO número que a calculadora
 *    oferece para incluir no aporte (dividendo-service.listarDividendos:
 *    esse total é sempre global, independente do filtro de mês da lista
 *    abaixo — dividendos não utilizados de meses antigos continuam
 *    disponíveis). Lista de lançamentos filtrável por mês (padrão: mês
 *    corrente), com opção de ver todos.
 * 3. Edição/exclusão restritas a lançamentos ainda disponíveis
 *    (`aporteId === null`) — um já utilizado é imutável (aparece com um
 *    aviso claro e sem os botões de ação).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  editarDividendo,
  excluirDividendo,
  lancarDividendo,
  listarAtivosConhecidos,
  listarDividendos,
  type AtivoConhecido,
} from "@/app/actions/dividendos";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  SortableTableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCentavosParaReais, parseDecimalParaCentavos } from "@/core/money";
import { useSortableRows } from "@/hooks/use-sortable-rows";
import type { DividendoDto } from "@/services/dividendo-service";

type Fase = "carregando" | "erro" | "pronto";

/** "2026-07" — usado como valor padrão do filtro de mês e do lançamento rápido. */
function mesAtualYYYYMM(): string {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, "0");
  return `${ano}-${mes}`;
}

/**
 * Converte centavos para uma string decimal simples ("1234,56"), sem
 * separador de milhar e sem "R$" — usada apenas para popular/editar campos
 * de formulário (o inverso de `parseDecimalParaCentavos`). Mesma função
 * usada em src/app/aporte/page.tsx (formatação de exibição, não lógica de
 * negócio) — duplicada aqui deliberadamente por ser trivial e local a cada
 * tela, aritmética inteira apenas (nunca `parseFloat`).
 */
function centavosParaTextoEditavel(centavos: number): string {
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const reais = Math.trunc(abs / 100);
  const cent = abs % 100;
  return `${negativo ? "-" : ""}${reais},${String(cent).padStart(2, "0")}`;
}

interface EdicaoLinha {
  mesTexto: string;
  valorTexto: string;
}

export default function DividendosPage() {
  const [fase, setFase] = useState<Fase>("carregando");
  const [erro, setErro] = useState<string | null>(null);

  const [ativos, setAtivos] = useState<AtivoConhecido[]>([]);
  const [lancamentos, setLancamentos] = useState<DividendoDto[]>([]);
  const [totalDisponivelCentavos, setTotalDisponivelCentavos] = useState(0);

  const [filtroMes, setFiltroMes] = useState(mesAtualYYYYMM());
  const [verTodos, setVerTodos] = useState(false);

  // Formulário de lançamento rápido.
  const [novoAtivo, setNovoAtivo] = useState("");
  const [novoMes, setNovoMes] = useState(mesAtualYYYYMM());
  const [novoValorTexto, setNovoValorTexto] = useState("");
  const [lancando, setLancando] = useState(false);

  // Edição inline de um lançamento disponível por vez.
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [edicao, setEdicao] = useState<EdicaoLinha>({ mesTexto: "", valorTexto: "" });
  const [processandoId, setProcessandoId] = useState<string | null>(null);

  // Hook chamado incondicionalmente (regra dos hooks), com fallback `[]`
  // antes de carregar. "Status" e "Ações" ficam de fora: status é um badge
  // derivado (sem valor de ordenação além do que Ativo/Mês já oferecem) e
  // ações não têm valor estável.
  const lancamentosOrdenados = useSortableRows(lancamentos, {
    chaveExport: (l) => l.chaveExport,
    mesReferencia: (l) => l.mesReferencia,
    valorCentavos: (l) => l.valorCentavos,
  });

  const carregar = useCallback(async (mes: string | null) => {
    const [respAtivos, respDividendos] = await Promise.all([
      listarAtivosConhecidos(),
      listarDividendos(mes ? { mes } : {}),
    ]);

    if (!respAtivos.ok) {
      setErro(respAtivos.erro);
      setFase("erro");
      return;
    }
    if (!respDividendos.ok) {
      setErro(respDividendos.erro);
      setFase("erro");
      return;
    }

    setAtivos(respAtivos.data);
    setLancamentos(respDividendos.data.lancamentos);
    setTotalDisponivelCentavos(respDividendos.data.totalDisponivelCentavos);
    setNovoAtivo((atual) => atual || respAtivos.data[0]?.chaveExport || "");
    setFase("pronto");
  }, []);

  useEffect(() => {
    void carregar(verTodos ? null : filtroMes);
  }, [carregar, filtroMes, verTodos]);

  async function handleLancar() {
    if (!novoAtivo) {
      toast.error("Selecione um ativo — só é possível lançar dividendo para um ativo já conhecido pelos imports.");
      return;
    }
    if (!novoMes.trim()) {
      toast.error("Informe o mês de referência.");
      return;
    }
    let valorCentavos: number;
    try {
      valorCentavos = parseDecimalParaCentavos(novoValorTexto);
    } catch {
      toast.error("Valor inválido — use um decimal (ex.: 150,00).");
      return;
    }
    if (valorCentavos <= 0) {
      toast.error("Informe um valor de dividendo maior que zero.");
      return;
    }

    setLancando(true);
    try {
      const resp = await lancarDividendo({
        chaveExport: novoAtivo,
        mesReferencia: novoMes,
        valorCentavos,
      });
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      toast.success(`Dividendo de ${formatCentavosParaReais(valorCentavos)} lançado para "${novoAtivo}".`);
      setNovoValorTexto("");
      await carregar(verTodos ? null : filtroMes);
    } finally {
      setLancando(false);
    }
  }

  function iniciarEdicao(l: DividendoDto) {
    setEditandoId(l.id);
    setEdicao({
      mesTexto: l.mesReferencia,
      valorTexto: centavosParaTextoEditavel(l.valorCentavos),
    });
  }

  function cancelarEdicao() {
    setEditandoId(null);
  }

  async function salvarEdicao(id: string) {
    let valorCentavos: number;
    try {
      valorCentavos = parseDecimalParaCentavos(edicao.valorTexto);
    } catch {
      toast.error("Valor inválido — use um decimal (ex.: 150,00).");
      return;
    }
    if (!edicao.mesTexto.trim()) {
      toast.error("Informe o mês de referência.");
      return;
    }

    setProcessandoId(id);
    try {
      const resp = await editarDividendo({
        id,
        mesReferencia: edicao.mesTexto,
        valorCentavos,
      });
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      toast.success("Lançamento atualizado.");
      setEditandoId(null);
      await carregar(verTodos ? null : filtroMes);
    } finally {
      setProcessandoId(null);
    }
  }

  async function excluir(l: DividendoDto) {
    setProcessandoId(l.id);
    try {
      const resp = await excluirDividendo({ id: l.id });
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      toast.success(`Lançamento de "${l.chaveExport}" excluído.`);
      await carregar(verTodos ? null : filtroMes);
    } finally {
      setProcessandoId(null);
    }
  }

  if (fase === "carregando") {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <p className="text-sm text-muted-foreground">Carregando dividendos…</p>
      </div>
    );
  }

  if (fase === "erro") {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <Card>
          <CardHeader>
            <CardTitle>Não foi possível carregar os dividendos</CardTitle>
            <CardDescription>{erro}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Cabecalho />

      <Card>
        <CardHeader>
          <CardTitle>Lançar dividendo</CardTitle>
          <CardDescription>
            Dinheiro novo em caixa — insumo da calculadora de aporte, não relatório de
            performance (isso é papel do MyCapital). Múltiplos lançamentos por ativo/mês são
            permitidos.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Field className="w-auto">
            <FieldLabel htmlFor="novo-ativo">Ativo</FieldLabel>
            <select
              id="novo-ativo"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
              value={novoAtivo}
              onChange={(e) => setNovoAtivo(e.target.value)}
            >
              {ativos.length === 0 && <option value="">Nenhum ativo conhecido ainda</option>}
              {ativos.map((a) => (
                <option key={a.chaveExport} value={a.chaveExport}>
                  {a.chaveExport}
                  {a.rotulo ? ` — ${a.rotulo}` : ""}
                </option>
              ))}
            </select>
          </Field>

          <Field className="w-auto">
            <FieldLabel htmlFor="novo-mes">Mês de referência</FieldLabel>
            <Input
              id="novo-mes"
              type="month"
              className="w-36"
              value={novoMes}
              onChange={(e) => setNovoMes(e.target.value)}
            />
          </Field>

          <Field className="w-auto">
            <FieldLabel htmlFor="novo-valor">Valor (R$)</FieldLabel>
            <Input
              id="novo-valor"
              inputMode="decimal"
              className="w-32"
              placeholder="150,00"
              value={novoValorTexto}
              onChange={(e) => setNovoValorTexto(e.target.value)}
            />
          </Field>

          <Button disabled={lancando || ativos.length === 0} onClick={() => void handleLancar()}>
            {lancando ? "Lançando…" : "Lançar"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Disponível para uso</CardTitle>
          <CardDescription>
            Total GERAL de dividendos ainda não incluídos em nenhum aporte — o mesmo valor que
            a calculadora oferece em &quot;incluir dividendos ainda não utilizados&quot;.
            Independente do filtro de mês da lista abaixo: dividendos de meses anteriores não
            utilizados continuam disponíveis.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-heading font-semibold tracking-tight">
            {formatCentavosParaReais(totalDisponivelCentavos)}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lançamentos</CardTitle>
          <CardDescription>
            Lista filtrada por mês de referência — apenas exibição; não afeta o total
            disponível acima.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field className="w-auto">
              <FieldLabel htmlFor="filtro-mes">Mês</FieldLabel>
              <Input
                id="filtro-mes"
                type="month"
                className="w-36"
                disabled={verTodos}
                value={filtroMes}
                onChange={(e) => setFiltroMes(e.target.value)}
              />
            </Field>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVerTodos((v) => !v)}
            >
              {verTodos ? "Filtrar por mês" : "Ver todos os meses"}
            </Button>
          </div>

          {lancamentos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum lançamento {verTodos ? "" : `em ${filtroMes} `}ainda.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead
                    sortDirection={lancamentosOrdenados.sortDirectionFor("chaveExport")}
                    onSort={() => lancamentosOrdenados.toggleSort("chaveExport")}
                  >
                    Ativo
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={lancamentosOrdenados.sortDirectionFor("mesReferencia")}
                    onSort={() => lancamentosOrdenados.toggleSort("mesReferencia")}
                  >
                    Mês
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={lancamentosOrdenados.sortDirectionFor("valorCentavos")}
                    onSort={() => lancamentosOrdenados.toggleSort("valorCentavos")}
                  >
                    Valor
                  </SortableTableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lancamentosOrdenados.sortedRows.map((l) => {
                  const utilizado = l.aporteId !== null;
                  const editando = editandoId === l.id;
                  const processando = processandoId === l.id;
                  return (
                    <TableRow key={l.id}>
                      <TableCell>{l.chaveExport}</TableCell>
                      <TableCell>
                        {editando ? (
                          <Input
                            type="month"
                            className="w-32"
                            value={edicao.mesTexto}
                            onChange={(e) =>
                              setEdicao((prev) => ({ ...prev, mesTexto: e.target.value }))
                            }
                          />
                        ) : (
                          l.mesReferencia
                        )}
                      </TableCell>
                      <TableCell>
                        {editando ? (
                          <Input
                            inputMode="decimal"
                            className="w-28"
                            value={edicao.valorTexto}
                            onChange={(e) =>
                              setEdicao((prev) => ({ ...prev, valorTexto: e.target.value }))
                            }
                          />
                        ) : (
                          formatCentavosParaReais(l.valorCentavos)
                        )}
                      </TableCell>
                      <TableCell>
                        {utilizado ? (
                          <span className="text-xs text-muted-foreground">
                            Utilizado (aporte {l.aporteId})
                          </span>
                        ) : (
                          <span className="text-xs text-emerald-600">Disponível</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {utilizado ? (
                          <span className="text-xs text-muted-foreground">
                            Utilizado é imutável — não pode ser editado nem excluído.
                          </span>
                        ) : editando ? (
                          <div className="flex flex-wrap gap-1">
                            <Button
                              size="sm"
                              disabled={processando}
                              onClick={() => void salvarEdicao(l.id)}
                            >
                              {processando ? "Salvando…" : "Salvar"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={processando}
                              onClick={cancelarEdicao}
                            >
                              Cancelar
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={processando}
                              onClick={() => iniciarEdicao(l)}
                            >
                              Editar
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={processando}
                              onClick={() => void excluir(l)}
                            >
                              {processando ? "Excluindo…" : "Excluir"}
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
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
      <h1 className="text-2xl font-heading font-semibold tracking-tight">Dividendos</h1>
      <p className="text-sm text-muted-foreground">
        Lance dividendos recebidos para incluí-los como dinheiro novo no próximo aporte.
      </p>
    </div>
  );
}
