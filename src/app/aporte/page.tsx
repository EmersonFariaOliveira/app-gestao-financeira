"use client";

/**
 * src/app/aporte/page.tsx — Calculadora de aporte (tela 6.5, a "tela-coração"
 * do app, docs/app-gestao-aportes.md seção 6.5).
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * reimplementa déficit/fila/divisão/transbordo/mínimo/arredondamento — ela
 * apenas chama `src/app/actions/aporte.ts` (que delega a
 * `src/services/aporte-service.ts` → `src/core/motor`) e exibe o resultado.
 * Toda formatação monetária usa `formatCentavosParaReais`/`formatBps`
 * (src/core/money) na borda de exibição; os valores trafegam em centavos
 * inteiros em todo o restante do fluxo.
 *
 * Bloqueio obrigatório (seção 6.3/6.5): enquanto houver ativos pendentes de
 * vínculo, a calculadora fica bloqueada — não renderiza o formulário, só a
 * lista de pendências com link para /vinculos.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  calcular,
  prepararCalculadora,
  registrarAporte,
  type CalcularActionInput,
} from "@/app/actions/aporte";
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
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
import { formatBps, formatCentavosParaReais, parseDecimalParaCentavos } from "@/core/money";
import { useSortableRows } from "@/hooks/use-sortable-rows";
import type { AjusteUsuario, LinhaDivisao } from "@/core/motor";
import type { CalcularOutput, LinhaAporte, PrepararCalculadoraOutput } from "@/services/aporte-service";

/**
 * Converte centavos para uma string decimal simples ("1234,56"), sem
 * separador de milhar e sem "R$" — usada apenas para popular/editar campos
 * de formulário (o inverso de `parseDecimalParaCentavos`). Aritmética
 * inteira apenas (nunca `parseFloat`), consistente com a regra de
 * centavos inteiros.
 */
function centavosParaTextoEditavel(centavos: number): string {
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const reais = Math.trunc(abs / 100);
  const cent = abs % 100;
  return `${negativo ? "-" : ""}${reais},${String(cent).padStart(2, "0")}`;
}

/** Linha combinada de exibição: fila (déficit/ordem) + divisão sugerida (valor editável) por alvo. */
interface LinhaCombinada {
  alvoId: string;
  nome: string;
  valorAtualCentavos: number;
  percentualAtualBps: number;
  deficitCentavos: number;
  valorSugeridoCentavos: number;
  origem: LinhaDivisao["origem"] | undefined;
  cotas: number | undefined;
  precoCentavos: number | undefined;
}

type FaseCarregamento = "carregando" | "erro" | "pronto";

export default function AportePage() {
  const [fase, setFase] = useState<FaseCarregamento>("carregando");
  const [erroPreparo, setErroPreparo] = useState<string | null>(null);
  const [prep, setPrep] = useState<PrepararCalculadoraOutput | null>(null);

  // Formulário de entrada.
  const [valorAporteTexto, setValorAporteTexto] = useState("");
  const [aporteMinimoTexto, setAporteMinimoTexto] = useState("");
  const [incluirDividendos, setIncluirDividendos] = useState(false);
  const [incluirTroco, setIncluirTroco] = useState(false);

  // Resultado do cálculo + veto humano (regra 6).
  const [resultado, setResultado] = useState<CalcularOutput | null>(null);
  const [ajustes, setAjustes] = useState<Record<string, number>>({});
  const [linhaTextos, setLinhaTextos] = useState<Record<string, string>>({});
  const [calculando, setCalculando] = useState(false);
  const [erroCalculo, setErroCalculo] = useState<string | null>(null);

  // Registro (sugerido vs. executado).
  const [dialogAberto, setDialogAberto] = useState(false);
  const [executadoTextos, setExecutadoTextos] = useState<Record<string, string>>({});
  const [registrando, setRegistrando] = useState(false);
  const [registrado, setRegistrado] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const resp = await prepararCalculadora();
      if (cancelado) return;
      if (!resp.ok) {
        setErroPreparo(resp.erro);
        setFase("erro");
        return;
      }
      setPrep(resp.data);
      setAporteMinimoTexto(centavosParaTextoEditavel(resp.data.aporteMinimoCentavos));
      setIncluirDividendos(resp.data.dividendosDisponiveisCentavos > 0);
      setIncluirTroco(resp.data.trocoAnteriorCentavos > 0);
      setFase("pronto");
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  const linhasCombinadas: LinhaCombinada[] = useMemo(() => {
    if (!resultado) return [];
    // Usa o mapa COMPLETO de nomes (todos os alvos vigentes, mesmo os que
    // ficam só na fila sem receber fatia — déficit <= 0) em vez de derivar de
    // `resultado.sugestao`, que só cobre os alvos presentes em
    // `resultado.resultado.divisao`. Ver `CalcularOutput.nomesPorAlvoId`
    // (src/services/aporte-service.ts) para o porquê.
    const nomePorAlvoId = new Map(Object.entries(resultado.nomesPorAlvoId));
    const divisaoPorAlvoId = new Map(resultado.resultado.divisao.map((l) => [l.alvoId, l]));
    return resultado.resultado.fila.map((item) => {
      const linhaDivisao = divisaoPorAlvoId.get(item.alvoId);
      return {
        alvoId: item.alvoId,
        nome: nomePorAlvoId.get(item.alvoId) ?? item.alvoId,
        valorAtualCentavos: item.valorAtualCentavos,
        percentualAtualBps: item.percentualAtualBps,
        deficitCentavos: item.deficitCentavos,
        valorSugeridoCentavos: linhaDivisao?.valorCentavos ?? 0,
        origem: linhaDivisao?.origem,
        cotas: linhaDivisao?.cotas,
        precoCentavos: linhaDivisao?.precoCentavos,
      };
    });
  }, [resultado]);

  // Mantém os campos de edição sincronizados sempre que um novo resultado chega.
  useEffect(() => {
    if (linhasCombinadas.length === 0) return;
    setLinhaTextos(
      Object.fromEntries(
        linhasCombinadas.map((l) => [l.alvoId, centavosParaTextoEditavel(l.valorSugeridoCentavos)]),
      ),
    );
  }, [linhasCombinadas]);

  const executarCalculo = useCallback(
    async (novosAjustes: Record<string, number>) => {
      let aporteMinimoCentavos: number;
      try {
        aporteMinimoCentavos = parseDecimalParaCentavos(aporteMinimoTexto);
      } catch {
        setErroCalculo("Aporte mínimo por transação inválido — use um valor decimal (ex.: 500,00).");
        return;
      }

      const ajustesUsuario: AjusteUsuario[] = Object.entries(novosAjustes).map(
        ([alvoId, valorCentavos]) => ({ alvoId, valorCentavos }),
      );

      const input: CalcularActionInput = {
        valorCentavos: valorAporteTexto,
        incluirDividendos,
        incluirTroco,
        aporteMinimoCentavos,
        ajustesUsuario: ajustesUsuario.length > 0 ? ajustesUsuario : undefined,
      };

      setCalculando(true);
      setErroCalculo(null);
      try {
        const resp = await calcular(input);
        if (!resp.ok) {
          setErroCalculo(resp.erro);
          return;
        }
        setResultado(resp.data);
        setAjustes(novosAjustes);
        setRegistrado(null);
      } finally {
        setCalculando(false);
      }
    },
    [aporteMinimoTexto, valorAporteTexto, incluirDividendos, incluirTroco],
  );

  function handleCalcularClick() {
    if (!valorAporteTexto.trim()) {
      setErroCalculo("Informe o valor do aporte do mês.");
      return;
    }
    void executarCalculo(ajustes);
  }

  function handleFixarLinha(alvoId: string) {
    const texto = linhaTextos[alvoId];
    try {
      const centavos = parseDecimalParaCentavos(texto ?? "");
      void executarCalculo({ ...ajustes, [alvoId]: centavos });
    } catch {
      setErroCalculo(`Valor inválido para o alvo "${alvoId}" — use um decimal (ex.: 500,00).`);
    }
  }

  function handleZerarLinha(alvoId: string) {
    void executarCalculo({ ...ajustes, [alvoId]: 0 });
  }

  function handleLimparAjuste(alvoId: string) {
    const copia = { ...ajustes };
    delete copia[alvoId];
    void executarCalculo(copia);
  }

  function handleLimparTodosAjustes() {
    void executarCalculo({});
  }

  function abrirDialogRegistro() {
    if (!resultado) return;
    setExecutadoTextos(
      Object.fromEntries(
        resultado.sugestao.map((l) => [l.alvo_id, centavosParaTextoEditavel(l.valor_centavos)]),
      ),
    );
    setDialogAberto(true);
  }

  async function handleConfirmarRegistro() {
    if (!resultado) return;
    if (resultado.sugestao.length === 0) {
      toast.error("Nenhuma linha sugerida para registrar — recalcule antes de registrar.");
      return;
    }

    let executado: LinhaAporte[];
    try {
      executado = resultado.sugestao.map((linha) => {
        const texto = executadoTextos[linha.alvo_id] ?? centavosParaTextoEditavel(linha.valor_centavos);
        return { ...linha, valor_centavos: parseDecimalParaCentavos(texto) };
      });
    } catch {
      toast.error("Há um valor inválido no registro do executado — confira os campos.");
      return;
    }

    setRegistrando(true);
    try {
      const resp = await registrarAporte({
        sessaoImportId: resultado.sessaoImportId,
        sugestao: resultado.sugestao,
        executado,
        valorTotalCentavos: resultado.valorTotalCentavos,
        valorDividendosCentavos: resultado.valorDividendosCentavos,
        trocoCentavos: resultado.resultado.trocoCentavos,
        dividendosIncluidosIds: resultado.dividendosIncluidosIds,
      });
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      toast.success(`Aporte registrado com sucesso (ID ${resp.data.aporteId}).`);
      setRegistrado(resp.data.aporteId);
      setDialogAberto(false);
    } finally {
      setRegistrando(false);
    }
  }

  // Hooks de ordenação chamados incondicionalmente (regra dos hooks), antes
  // dos early returns abaixo — aceitam array vazio sem problema. "Sugestão"
  // (Input editável) e "Ações" ficam de fora da primeira tabela por não
  // terem valor estável para ordenar; "Cotas/Preço" combina dois valores
  // (cotas × preço) num único texto, também fora.
  const filaOrdenada = useSortableRows(linhasCombinadas, {
    nome: (l) => l.nome,
    percentualAtualBps: (l) => l.percentualAtualBps,
    deficitCentavos: (l) => l.deficitCentavos,
    origem: (l) => l.origem ?? "",
  });
  const simulacaoOrdenada = useSortableRows(resultado?.resultado.simulacaoDepois ?? [], {
    nome: (l) =>
      linhasCombinadas.find((c) => c.alvoId === l.alvoId)?.nome ?? l.alvoId,
    percentualAntesBps: (l) => l.percentualAntesBps,
    percentualDepoisBps: (l) => l.percentualDepoisBps,
    deficitDepoisCentavos: (l) => l.deficitDepoisCentavos,
  });

  if (fase === "carregando") {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <p className="text-sm text-muted-foreground">Carregando calculadora…</p>
      </div>
    );
  }

  if (fase === "erro" || !prep) {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <Card>
          <CardHeader>
            <CardTitle>Não foi possível carregar a calculadora</CardTitle>
            <CardDescription>{erroPreparo}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (prep.bloqueada) {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <Card>
          <CardHeader>
            <CardTitle>Calculadora bloqueada</CardTitle>
            <CardDescription>
              Há {prep.pendencias.length} ativo(s) pendente(s) de vínculo. Uma pendência de
              vínculo distorceria os déficits silenciosamente — resolva-as antes de calcular
              o aporte.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc text-sm">
              {prep.pendencias.map((chave) => (
                <li key={chave}>{chave}</li>
              ))}
            </ul>
          </CardContent>
          <CardFooter>
            <Button render={<Link href="/vinculos" />}>Resolver vínculos pendentes</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Cabecalho />

      <Card>
        <CardHeader>
          <CardTitle>Aporte do mês</CardTitle>
          <CardDescription>
            Digite o valor disponível para aportar. A calculadora concentra o aporte nos
            ativos mais abaixo do alvo.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="valor-aporte">Valor do aporte do mês (R$)</FieldLabel>
            <Input
              id="valor-aporte"
              inputMode="decimal"
              placeholder="2.000,00"
              value={valorAporteTexto}
              onChange={(e) => setValorAporteTexto(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="aporte-minimo">Aporte mínimo por transação (R$)</FieldLabel>
            <Input
              id="aporte-minimo"
              inputMode="decimal"
              value={aporteMinimoTexto}
              onChange={(e) => setAporteMinimoTexto(e.target.value)}
            />
            <FieldDescription>
              Fatias abaixo deste valor não são criadas — o dinheiro volta ao topo da fila.
              Lembrado da última vez.
            </FieldDescription>
          </Field>

          {prep.dividendosDisponiveisCentavos > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                checked={incluirDividendos}
                onChange={(e) => setIncluirDividendos(e.target.checked)}
              />
              Incluir {formatCentavosParaReais(prep.dividendosDisponiveisCentavos)} de
              dividendos ainda não utilizados
            </label>
          )}

          {prep.trocoAnteriorCentavos > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                checked={incluirTroco}
                onChange={(e) => setIncluirTroco(e.target.checked)}
              />
              Incluir {formatCentavosParaReais(prep.trocoAnteriorCentavos)} de troco do
              arredondamento por lote do mês anterior
            </label>
          )}

          {erroCalculo && <FieldError>{erroCalculo}</FieldError>}
        </CardContent>
        <CardFooter>
          <Button onClick={handleCalcularClick} disabled={calculando}>
            {calculando ? "Calculando…" : "Calcular"}
          </Button>
        </CardFooter>
      </Card>

      {resultado && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Fila de prioridade e divisão sugerida</CardTitle>
              <CardDescription>
                Ordenada pelo maior déficit. Edite qualquer linha (zerar ou fixar outro
                valor) — o restante é redistribuído automaticamente pelas mesmas regras.
                Aporte total considerado:{" "}
                {formatCentavosParaReais(resultado.valorTotalCentavos)}
                {resultado.valorDividendosCentavos > 0 &&
                  ` (inclui ${formatCentavosParaReais(resultado.valorDividendosCentavos)} de dividendos)`}
                .
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead
                      sortDirection={filaOrdenada.sortDirectionFor("nome")}
                      onSort={() => filaOrdenada.toggleSort("nome")}
                    >
                      Alvo
                    </SortableTableHead>
                    <SortableTableHead
                      sortDirection={filaOrdenada.sortDirectionFor("percentualAtualBps")}
                      onSort={() => filaOrdenada.toggleSort("percentualAtualBps")}
                    >
                      % atual
                    </SortableTableHead>
                    <SortableTableHead
                      sortDirection={filaOrdenada.sortDirectionFor("deficitCentavos")}
                      onSort={() => filaOrdenada.toggleSort("deficitCentavos")}
                    >
                      Déficit
                    </SortableTableHead>
                    <TableHead>Sugestão (R$)</TableHead>
                    <SortableTableHead
                      sortDirection={filaOrdenada.sortDirectionFor("origem")}
                      onSort={() => filaOrdenada.toggleSort("origem")}
                    >
                      Origem
                    </SortableTableHead>
                    <TableHead>Cotas/Preço</TableHead>
                    <TableHead>Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filaOrdenada.sortedRows.map((linha) => {
                    const ajustada = ajustes[linha.alvoId] !== undefined;
                    return (
                      <TableRow key={linha.alvoId}>
                        <TableCell>
                          {linha.nome}
                          {ajustada && (
                            <span className="ml-1 text-xs text-muted-foreground">
                              (ajustado)
                            </span>
                          )}
                        </TableCell>
                        <TableCell>{formatBps(linha.percentualAtualBps)}</TableCell>
                        <TableCell>{formatCentavosParaReais(linha.deficitCentavos)}</TableCell>
                        <TableCell>
                          <Input
                            inputMode="decimal"
                            className="w-28"
                            value={linhaTextos[linha.alvoId] ?? ""}
                            onChange={(e) =>
                              setLinhaTextos((prev) => ({
                                ...prev,
                                [linha.alvoId]: e.target.value,
                              }))
                            }
                          />
                        </TableCell>
                        <TableCell>{linha.origem ?? "—"}</TableCell>
                        <TableCell>
                          {linha.cotas !== undefined && linha.precoCentavos !== undefined
                            ? `${linha.cotas} cota(s) × ${formatCentavosParaReais(linha.precoCentavos)}`
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={calculando}
                              onClick={() => handleFixarLinha(linha.alvoId)}
                            >
                              Fixar
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={calculando}
                              onClick={() => handleZerarLinha(linha.alvoId)}
                            >
                              Zerar
                            </Button>
                            {ajustada && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={calculando}
                                onClick={() => handleLimparAjuste(linha.alvoId)}
                              >
                                Limpar ajuste
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              {resultado.resultado.trocoCentavos > 0 && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Troco de arredondamento por lote sem alvo de renda fixa para receber:{" "}
                  {formatCentavosParaReais(resultado.resultado.trocoCentavos)} (fica
                  registrado para oferecer no próximo aporte).
                </p>
              )}

              {Object.keys(ajustes).length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  disabled={calculando}
                  onClick={handleLimparTodosAjustes}
                >
                  Limpar todos os ajustes
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Simulação: como fica depois</CardTitle>
              <CardDescription>
                Alocação estimada se o aporte for executado exatamente como sugerido.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead
                      sortDirection={simulacaoOrdenada.sortDirectionFor("nome")}
                      onSort={() => simulacaoOrdenada.toggleSort("nome")}
                    >
                      Alvo
                    </SortableTableHead>
                    <SortableTableHead
                      sortDirection={simulacaoOrdenada.sortDirectionFor("percentualAntesBps")}
                      onSort={() => simulacaoOrdenada.toggleSort("percentualAntesBps")}
                    >
                      % antes
                    </SortableTableHead>
                    <SortableTableHead
                      sortDirection={simulacaoOrdenada.sortDirectionFor("percentualDepoisBps")}
                      onSort={() => simulacaoOrdenada.toggleSort("percentualDepoisBps")}
                    >
                      % depois
                    </SortableTableHead>
                    <SortableTableHead
                      sortDirection={simulacaoOrdenada.sortDirectionFor("deficitDepoisCentavos")}
                      onSort={() => simulacaoOrdenada.toggleSort("deficitDepoisCentavos")}
                    >
                      Déficit depois
                    </SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {simulacaoOrdenada.sortedRows.map((linha) => {
                    const nome =
                      linhasCombinadas.find((l) => l.alvoId === linha.alvoId)?.nome ??
                      linha.alvoId;
                    return (
                      <TableRow key={linha.alvoId}>
                        <TableCell>{nome}</TableCell>
                        <TableCell>{formatBps(linha.percentualAntesBps)}</TableCell>
                        <TableCell>{formatBps(linha.percentualDepoisBps)}</TableCell>
                        <TableCell>
                          {formatCentavosParaReais(linha.deficitDepoisCentavos)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
            <CardFooter className="flex items-center gap-3">
              {registrado ? (
                <p className="text-sm text-muted-foreground">
                  Aporte já registrado nesta sessão (ID {registrado}), total{" "}
                  {formatCentavosParaReais(resultado.valorTotalCentavos)}
                  {resultado.valorDividendosCentavos > 0 &&
                    ` (dos quais ${formatCentavosParaReais(resultado.valorDividendosCentavos)} vieram de dividendos incluídos)`}
                  . Calcule novamente para registrar outro.
                </p>
              ) : (
                <Dialog open={dialogAberto} onOpenChange={setDialogAberto}>
                  <DialogTrigger render={<Button />} onClick={abrirDialogRegistro}>
                    Registrar como executado
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Confirmar execução do aporte</DialogTitle>
                      <DialogDescription>
                        Ajuste os valores para o que foi de fato executado na ordem (a
                        cotação do export pode estar defasada). Sugerido vs. executado fica
                        registrado para auditoria. Total considerado:{" "}
                        {formatCentavosParaReais(resultado.valorTotalCentavos)}
                        {resultado.valorDividendosCentavos > 0 &&
                          `, dos quais ${formatCentavosParaReais(resultado.valorDividendosCentavos)} vieram de dividendos incluídos`}
                        .
                      </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                      {resultado.sugestao.map((linha) => (
                        <Field key={linha.alvo_id}>
                          <FieldLabel htmlFor={`executado-${linha.alvo_id}`}>
                            {linha.nome_alvo} — sugerido{" "}
                            {formatCentavosParaReais(linha.valor_centavos)}
                          </FieldLabel>
                          <Input
                            id={`executado-${linha.alvo_id}`}
                            inputMode="decimal"
                            value={executadoTextos[linha.alvo_id] ?? ""}
                            onChange={(e) =>
                              setExecutadoTextos((prev) => ({
                                ...prev,
                                [linha.alvo_id]: e.target.value,
                              }))
                            }
                          />
                        </Field>
                      ))}
                      {resultado.sugestao.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          Nenhuma linha sugerida — todas as fatias foram zeradas.
                        </p>
                      )}
                    </div>
                    <DialogFooter>
                      <DialogClose render={<Button variant="outline" />}>Cancelar</DialogClose>
                      <Button onClick={handleConfirmarRegistro} disabled={registrando}>
                        {registrando ? "Registrando…" : "Confirmar registro"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </CardFooter>
          </Card>
        </>
      )}
    </div>
  );
}

function Cabecalho() {
  return (
    <div>
      <h1 className="text-2xl font-heading font-semibold tracking-tight">
        Calculadora de aporte
      </h1>
      <p className="text-sm text-muted-foreground">
        Em quais ativos colocar o aporte deste mês, e quanto em cada um.
      </p>
    </div>
  );
}
