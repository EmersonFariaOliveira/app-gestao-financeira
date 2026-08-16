"use client";

/**
 * src/app/posicoes-manuais/page.tsx — Posições manuais (tela 6.9, acesso
 * dedicado — FR-014, feature 002-posicoes-manuais-ajustes).
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * reimplementa CRUD/imutabilidade/sessão-vigente — ela apenas chama
 * `src/app/actions/posicoes-manuais.ts` (que delega a
 * `src/services/posicao-manual-service.ts`) e exibe o resultado.
 *
 * Escopo desta task (T012, User Story 1): listagem de posições manuais
 * ATIVAS, criação ("+ Nova posição manual", pré-preenchida por querystring
 * quando chega do CTA de /vinculos — T010) e encerramento. A seção "Ajustes
 * de fundos" (User Story 2, T017) e a revisão de carry-forward dentro do
 * import (User Story 3) NÃO fazem parte desta task.
 *
 * `alvoId`/`descricaoSugerida` na querystring (contracts/server-actions.md,
 * nota de design 2): vêm do CTA "+ Cadastrar posição manual" da tela de
 * vínculos, quando um ativo é marcado "Ignorar (substituído por posição
 * manual)" mas nenhuma posição manual ativa aponta para o mesmo alvo ainda.
 * `useSearchParams` exige um limite de Suspense (Next.js App Router) — daí o
 * componente ser dividido em `PosicoesManuaisPage` (Suspense) +
 * `PosicoesManuaisContent` (conteúdo real).
 */
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import {
  criarPosicaoManual,
  encerrarPosicaoManual,
  listarPosicoesManuaisAtivas,
} from "@/app/actions/posicoes-manuais";
import { listarAlvosParaDropdown, type AlvoParaDropdown } from "@/app/actions/vinculos";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
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
import type { PosicaoManualListItem } from "@/services/posicao-manual-service";

type Fase = "carregando" | "erro" | "pronto";

export default function PosicoesManuaisPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-6">
          <Cabecalho />
          <p className="text-sm text-muted-foreground">Carregando…</p>
        </div>
      }
    >
      <PosicoesManuaisContent />
    </Suspense>
  );
}

function PosicoesManuaisContent() {
  const searchParams = useSearchParams();
  const alvoIdSugerido = searchParams.get("alvoId") ?? "";
  const descricaoSugerida = searchParams.get("descricaoSugerida") ?? "";

  const [fase, setFase] = useState<Fase>("carregando");
  const [erro, setErro] = useState<string | null>(null);
  const [posicoes, setPosicoes] = useState<PosicaoManualListItem[]>([]);
  const [alvos, setAlvos] = useState<AlvoParaDropdown[]>([]);

  const [mostrarForm, setMostrarForm] = useState(false);
  const [chaveManualTexto, setChaveManualTexto] = useState("");
  const [instituicaoTexto, setInstituicaoTexto] = useState("");
  const [descricaoTexto, setDescricaoTexto] = useState("");
  const [alvoIdSelecionado, setAlvoIdSelecionado] = useState("");
  const [valorInvestidoTexto, setValorInvestidoTexto] = useState("");
  const [valorAtualTexto, setValorAtualTexto] = useState("");
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const [posicaoParaEncerrar, setPosicaoParaEncerrar] = useState<PosicaoManualListItem | null>(
    null,
  );
  const [encerrando, setEncerrando] = useState(false);

  const carregar = useCallback(async () => {
    const [respPosicoes, respAlvos] = await Promise.all([
      listarPosicoesManuaisAtivas(),
      listarAlvosParaDropdown(),
    ]);
    if (!respPosicoes.ok) {
      setErro(respPosicoes.erro);
      setFase("erro");
      return;
    }
    if (!respAlvos.ok) {
      setErro(respAlvos.erro);
      setFase("erro");
      return;
    }
    setPosicoes(respPosicoes.data);
    setAlvos(respAlvos.data);
    setFase("pronto");
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Pré-preenchimento a partir da querystring do CTA de /vinculos (T010):
  // abre o formulário já com o alvo e a descrição sugeridos. Roda uma única
  // vez (na chegada via link) — não reabre o form se o usuário já o fechou.
  useEffect(() => {
    if (alvoIdSugerido || descricaoSugerida) {
      setMostrarForm(true);
      setAlvoIdSelecionado((atual) => atual || alvoIdSugerido);
      setDescricaoTexto((atual) => atual || descricaoSugerida);
    }
  }, [alvoIdSugerido, descricaoSugerida]);

  const posicoesOrdenadas = useSortableRows(posicoes, {
    chaveManual: (p) => p.chaveManual,
    instituicao: (p) => p.instituicao,
    descricao: (p) => p.descricao,
    nomeAlvo: (p) => p.nomeAlvo,
    valorInvestidoCentavos: (p) => p.valorInvestidoCentavos ?? 0,
    valorAtualCentavos: (p) => p.valorAtualCentavos ?? 0,
  });

  function limparFormulario() {
    setChaveManualTexto("");
    setInstituicaoTexto("");
    setDescricaoTexto("");
    setAlvoIdSelecionado("");
    setValorInvestidoTexto("");
    setValorAtualTexto("");
    setErroForm(null);
    setMostrarForm(false);
  }

  async function handleCriar() {
    if (!chaveManualTexto.trim()) {
      setErroForm("Informe a chave manual (identificador único, ex.: CDB-ITAU-2029).");
      return;
    }
    if (!instituicaoTexto.trim()) {
      setErroForm("Informe a instituição.");
      return;
    }
    if (!descricaoTexto.trim()) {
      setErroForm("Informe a descrição.");
      return;
    }
    if (!alvoIdSelecionado) {
      setErroForm("Selecione o alvo desta posição.");
      return;
    }

    let valorInvestidoCentavos: number;
    let valorAtualCentavos: number;
    try {
      valorInvestidoCentavos = parseDecimalParaCentavos(valorInvestidoTexto);
    } catch {
      setErroForm("Valor investido inválido — use um decimal (ex.: 1000,00).");
      return;
    }
    try {
      valorAtualCentavos = parseDecimalParaCentavos(valorAtualTexto);
    } catch {
      setErroForm("Valor atual inválido — use um decimal (ex.: 1050,00).");
      return;
    }
    if (valorInvestidoCentavos < 0 || valorAtualCentavos < 0) {
      setErroForm("Valores não podem ser negativos.");
      return;
    }

    setSalvando(true);
    setErroForm(null);
    try {
      const resp = await criarPosicaoManual({
        chaveManual: chaveManualTexto.trim(),
        instituicao: instituicaoTexto.trim(),
        descricao: descricaoTexto.trim(),
        alvoId: alvoIdSelecionado,
        valorInvestidoCentavos,
        valorAtualCentavos,
      });
      if (!resp.ok) {
        setErroForm(resp.erro);
        return;
      }
      toast.success(`Posição manual "${resp.data.descricao}" criada.`);
      limparFormulario();
      await carregar();
    } finally {
      setSalvando(false);
    }
  }

  async function handleConfirmarEncerrar() {
    if (!posicaoParaEncerrar) return;
    setEncerrando(true);
    try {
      const resp = await encerrarPosicaoManual({ posicaoManualId: posicaoParaEncerrar.id });
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      toast.success(`Posição manual "${posicaoParaEncerrar.descricao}" encerrada.`);
      setPosicaoParaEncerrar(null);
      await carregar();
    } finally {
      setEncerrando(false);
    }
  }

  if (fase === "carregando") {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <p className="text-sm text-muted-foreground">Carregando posições manuais…</p>
      </div>
    );
  }

  if (fase === "erro") {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <Card>
          <CardHeader>
            <CardTitle>Não foi possível carregar as posições manuais</CardTitle>
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
          <CardTitle>Nova posição manual</CardTitle>
          <CardDescription>
            Registra um ativo que não vem (ou não deve vir) corretamente do CSV — tipicamente
            um CDB. Passa a compor o déficit do alvo exatamente como uma posição do CSV.
          </CardDescription>
        </CardHeader>
        {!mostrarForm ? (
          <CardContent>
            <Button onClick={() => setMostrarForm(true)}>+ Nova posição manual</Button>
          </CardContent>
        ) : (
          <>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-4">
                <Field className="w-48">
                  <FieldLabel htmlFor="pm-chave">Chave manual</FieldLabel>
                  <Input
                    id="pm-chave"
                    placeholder="ex.: CDB-ITAU-2029"
                    value={chaveManualTexto}
                    onChange={(e) => setChaveManualTexto(e.target.value)}
                  />
                </Field>
                <Field className="w-40">
                  <FieldLabel htmlFor="pm-instituicao">Instituição</FieldLabel>
                  <Input
                    id="pm-instituicao"
                    value={instituicaoTexto}
                    onChange={(e) => setInstituicaoTexto(e.target.value)}
                  />
                </Field>
                <Field className="w-64">
                  <FieldLabel htmlFor="pm-descricao">Descrição</FieldLabel>
                  <Input
                    id="pm-descricao"
                    placeholder="ex.: CDB Itaú 120% CDI 2029"
                    value={descricaoTexto}
                    onChange={(e) => setDescricaoTexto(e.target.value)}
                  />
                </Field>
                <Field className="w-48">
                  <FieldLabel htmlFor="pm-alvo">Alvo</FieldLabel>
                  <select
                    id="pm-alvo"
                    className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                    value={alvoIdSelecionado}
                    onChange={(e) => setAlvoIdSelecionado(e.target.value)}
                  >
                    <option value="">Selecione…</option>
                    {alvos.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.nome}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field className="w-36">
                  <FieldLabel htmlFor="pm-valor-investido">Valor investido</FieldLabel>
                  <Input
                    id="pm-valor-investido"
                    inputMode="decimal"
                    placeholder="1000,00"
                    value={valorInvestidoTexto}
                    onChange={(e) => setValorInvestidoTexto(e.target.value)}
                  />
                </Field>
                <Field className="w-36">
                  <FieldLabel htmlFor="pm-valor-atual">Valor atual</FieldLabel>
                  <Input
                    id="pm-valor-atual"
                    inputMode="decimal"
                    placeholder="1050,00"
                    value={valorAtualTexto}
                    onChange={(e) => setValorAtualTexto(e.target.value)}
                  />
                </Field>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => void handleCriar()} disabled={salvando}>
                  {salvando ? "Salvando…" : "Criar posição manual"}
                </Button>
                <Button variant="outline" onClick={limparFormulario} disabled={salvando}>
                  Cancelar
                </Button>
              </div>
            </CardContent>
            {erroForm && (
              <CardContent className="pt-0">
                <FieldError>{erroForm}</FieldError>
              </CardContent>
            )}
          </>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Posições manuais ativas {posicoes.length > 0 && `(${posicoes.length})`}</CardTitle>
          <CardDescription>
            Só o valor atual compõe o cálculo de déficit — o valor investido é só referência
            (nunca entra no motor de aporte).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {posicoes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma posição manual cadastrada ainda.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead
                    sortDirection={posicoesOrdenadas.sortDirectionFor("chaveManual")}
                    onSort={() => posicoesOrdenadas.toggleSort("chaveManual")}
                  >
                    Chave manual
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={posicoesOrdenadas.sortDirectionFor("instituicao")}
                    onSort={() => posicoesOrdenadas.toggleSort("instituicao")}
                  >
                    Instituição
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={posicoesOrdenadas.sortDirectionFor("descricao")}
                    onSort={() => posicoesOrdenadas.toggleSort("descricao")}
                  >
                    Descrição
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={posicoesOrdenadas.sortDirectionFor("nomeAlvo")}
                    onSort={() => posicoesOrdenadas.toggleSort("nomeAlvo")}
                  >
                    Alvo
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={posicoesOrdenadas.sortDirectionFor("valorInvestidoCentavos")}
                    onSort={() => posicoesOrdenadas.toggleSort("valorInvestidoCentavos")}
                  >
                    Valor investido
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={posicoesOrdenadas.sortDirectionFor("valorAtualCentavos")}
                    onSort={() => posicoesOrdenadas.toggleSort("valorAtualCentavos")}
                  >
                    Valor atual
                  </SortableTableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {posicoesOrdenadas.sortedRows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="max-w-40 whitespace-normal break-words">
                      {p.chaveManual}
                    </TableCell>
                    <TableCell>{p.instituicao}</TableCell>
                    <TableCell className="max-w-56 whitespace-normal break-words">
                      {p.descricao}
                    </TableCell>
                    <TableCell>{p.nomeAlvo}</TableCell>
                    <TableCell>
                      {p.valorInvestidoCentavos !== null
                        ? formatCentavosParaReais(p.valorInvestidoCentavos)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {p.valorAtualCentavos !== null
                        ? formatCentavosParaReais(p.valorAtualCentavos)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setPosicaoParaEncerrar(p)}
                      >
                        Encerrar
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={posicaoParaEncerrar !== null}
        onOpenChange={(aberto) => {
          if (!aberto) setPosicaoParaEncerrar(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Encerrar posição manual?</DialogTitle>
            <DialogDescription>
              {posicaoParaEncerrar && (
                <>
                  Encerrar &quot;{posicaoParaEncerrar.descricao}&quot; ({posicaoParaEncerrar.instituicao}
                  ). Ação irreversível — a posição some do carry-forward e do cálculo de déficit,
                  mas o histórico é preservado.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />} disabled={encerrando}>
              Cancelar
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => void handleConfirmarEncerrar()}
              disabled={encerrando}
            >
              {encerrando ? "Encerrando…" : "Confirmar encerramento"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Cabecalho() {
  return (
    <div>
      <h1 className="text-2xl font-heading font-semibold tracking-tight">Posições manuais</h1>
      <p className="text-sm text-muted-foreground">
        Ativos que não vêm corretamente do CSV (ex.: CDBs) — cadastrados aqui, entram no
        cálculo de déficit como qualquer posição do export.
      </p>
    </div>
  );
}
