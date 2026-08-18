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
 * Escopo original (T012, User Story 1): listagem de posições manuais ATIVAS,
 * criação ("+ Nova posição manual", pré-preenchida por querystring quando
 * chega do CTA de /vinculos — T010) e encerramento.
 *
 * T017 (User Story 2, FR-005/FR-009) acrescenta a seção "Ajustes de fundos":
 * correção pontual do `valor_investido` de um `chave_export` que continua
 * vindo do CSV (ex.: fundo) — nunca toca `valor_atual`/déficit (FR-006). A
 * revisão de carry-forward dentro do import (User Story 3) NÃO faz parte
 * desta task.
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
  criarOuAtualizarAjuste,
  criarPosicaoManual,
  encerrarPosicaoManual,
  listarAjustesAtivos,
  listarPosicoesManuaisAtivas,
} from "@/app/actions/posicoes-manuais";
import {
  listarAlvosParaDropdown,
  listarVinculos,
  type AlvoParaDropdown,
} from "@/app/actions/vinculos";
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
import type { VinculoForaDaCarteira, VinculoVinculado } from "@/services/mapeamento-service";
import type { AjusteAtivoListItem, PosicaoManualListItem } from "@/services/posicao-manual-service";

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

  // Seção "Ajustes de fundos" (T017, User Story 2): correção pontual do
  // valor investido de um chave_export que continua vindo do CSV — nunca
  // toca valor_atual/déficit (FR-006). `vinculados` + `foraDaCarteira`
  // populam o dropdown de "qual ativo ajustar" — pendentes/ignorados/reserva
  // de emergência não fazem sentido aqui (pendentes ainda não têm alvo
  // definido e distorceriam o vínculo; reserva/ignorados não entram no
  // motor de aporte).
  const [ajustes, setAjustes] = useState<AjusteAtivoListItem[]>([]);
  const [vinculados, setVinculados] = useState<VinculoVinculado[]>([]);
  const [foraDaCarteira, setForaDaCarteira] = useState<VinculoForaDaCarteira[]>([]);
  const [mostrarFormAjuste, setMostrarFormAjuste] = useState(false);
  const [chaveExportSelecionada, setChaveExportSelecionada] = useState("");
  const [valorAjusteTexto, setValorAjusteTexto] = useState("");
  const [erroFormAjuste, setErroFormAjuste] = useState<string | null>(null);
  const [salvandoAjuste, setSalvandoAjuste] = useState(false);

  const carregar = useCallback(async () => {
    const [respPosicoes, respAlvos, respAjustes, respVinculos] = await Promise.all([
      listarPosicoesManuaisAtivas(),
      listarAlvosParaDropdown(),
      listarAjustesAtivos(),
      listarVinculos(),
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
    if (!respAjustes.ok) {
      setErro(respAjustes.erro);
      setFase("erro");
      return;
    }
    if (!respVinculos.ok) {
      setErro(respVinculos.erro);
      setFase("erro");
      return;
    }
    setPosicoes(respPosicoes.data);
    setAlvos(respAlvos.data);
    setAjustes(respAjustes.data);
    setVinculados(respVinculos.data.vinculados);
    setForaDaCarteira(respVinculos.data.foraDaCarteira);
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

  const ajustesOrdenados = useSortableRows(ajustes, {
    chaveExport: (a) => a.chaveExport,
    nomeAlvo: (a) => a.nomeAlvo ?? "",
    valorInvestidoCentavosCorrigido: (a) => a.valorInvestidoCentavosCorrigido ?? -1,
  });

  /**
   * chave_export vinculados ou fora-da-carteira ainda sem nenhum ajuste
   * cadastrado — evita repetir no dropdown quem já está na tabela abaixo (a
   * edição de quem já tem ajuste é feita pelo botão "Editar" da linha).
   * Normaliza as duas fontes (`vinculados`/`foraDaCarteira`, shapes
   * diferentes — só o primeiro tem `nomeAlvo`) numa lista única com rótulo
   * pronto para exibição.
   */
  const chavesSemAjusteAinda = [
    ...vinculados.map((v) => ({ chaveExport: v.chaveExport, rotulo: `${v.chaveExport} (${v.nomeAlvo})` })),
    ...foraDaCarteira.map((f) => ({
      chaveExport: f.chaveExport,
      rotulo: `${f.chaveExport} (fora da carteira)`,
    })),
  ].filter((v) => !ajustes.some((a) => a.chaveExport === v.chaveExport));

  function limparFormularioAjuste() {
    setChaveExportSelecionada("");
    setValorAjusteTexto("");
    setErroFormAjuste(null);
    setMostrarFormAjuste(false);
  }

  function handleEditarAjuste(ajuste: AjusteAtivoListItem) {
    setChaveExportSelecionada(ajuste.chaveExport);
    setValorAjusteTexto(
      ajuste.valorInvestidoCentavosCorrigido !== null
        ? (ajuste.valorInvestidoCentavosCorrigido / 100).toFixed(2).replace(".", ",")
        : "",
    );
    setErroFormAjuste(null);
    setMostrarFormAjuste(true);
  }

  async function handleSalvarAjuste() {
    if (!chaveExportSelecionada) {
      setErroFormAjuste("Selecione o ativo (chave do export) a ajustar.");
      return;
    }

    let valorInvestidoCentavosCorrigido: number;
    try {
      valorInvestidoCentavosCorrigido = parseDecimalParaCentavos(valorAjusteTexto);
    } catch {
      setErroFormAjuste("Valor corrigido inválido — use um decimal (ex.: 1000,00).");
      return;
    }
    if (valorInvestidoCentavosCorrigido < 0) {
      setErroFormAjuste("Valor não pode ser negativo.");
      return;
    }

    setSalvandoAjuste(true);
    setErroFormAjuste(null);
    try {
      const resp = await criarOuAtualizarAjuste({
        chaveExport: chaveExportSelecionada,
        valorInvestidoCentavosCorrigido,
      });
      if (!resp.ok) {
        setErroFormAjuste(resp.erro);
        return;
      }
      toast.success(`Ajuste de "${resp.data.chaveExport}" salvo.`);
      limparFormularioAjuste();
      await carregar();
    } finally {
      setSalvandoAjuste(false);
    }
  }

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

      <Card>
        <CardHeader>
          <CardTitle>Ajustes de fundos</CardTitle>
          <CardDescription>
            Corrige o valor investido de um ativo que continua vindo do CSV (ex.: um fundo) —
            o valor atual e o cálculo de déficit nunca mudam por causa deste ajuste (FR-006).
          </CardDescription>
        </CardHeader>
        {!mostrarFormAjuste ? (
          <CardContent>
            <Button onClick={() => setMostrarFormAjuste(true)}>+ Novo ajuste</Button>
          </CardContent>
        ) : (
          <>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-4">
                <Field className="w-64">
                  <FieldLabel htmlFor="aj-chave-export">Ativo (chave do export)</FieldLabel>
                  <select
                    id="aj-chave-export"
                    className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                    value={chaveExportSelecionada}
                    onChange={(e) => setChaveExportSelecionada(e.target.value)}
                  >
                    <option value="">Selecione…</option>
                    {chaveExportSelecionada &&
                      !chavesSemAjusteAinda.some((v) => v.chaveExport === chaveExportSelecionada) && (
                        <option value={chaveExportSelecionada}>{chaveExportSelecionada}</option>
                      )}
                    {chavesSemAjusteAinda.map((v) => (
                      <option key={v.chaveExport} value={v.chaveExport}>
                        {v.rotulo}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field className="w-36">
                  <FieldLabel htmlFor="aj-valor">Valor investido corrigido</FieldLabel>
                  <Input
                    id="aj-valor"
                    inputMode="decimal"
                    placeholder="1000,00"
                    value={valorAjusteTexto}
                    onChange={(e) => setValorAjusteTexto(e.target.value)}
                  />
                </Field>
              </div>
              {chaveExportSelecionada &&
                !ajustes.some((a) => a.chaveExport === chaveExportSelecionada) && (
                  <div className="rounded-lg border border-amber-400/60 bg-amber-400/10 p-3 text-sm">
                    Primeira vez ajustando &quot;{chaveExportSelecionada}&quot; — não há valor
                    anterior cadastrado para este ativo (FR-009).
                  </div>
                )}
              <div className="flex gap-2">
                <Button onClick={() => void handleSalvarAjuste()} disabled={salvandoAjuste}>
                  {salvandoAjuste ? "Salvando…" : "Salvar ajuste"}
                </Button>
                <Button variant="outline" onClick={limparFormularioAjuste} disabled={salvandoAjuste}>
                  Cancelar
                </Button>
              </div>
            </CardContent>
            {erroFormAjuste && (
              <CardContent className="pt-0">
                <FieldError>{erroFormAjuste}</FieldError>
              </CardContent>
            )}
          </>
        )}
        <CardContent>
          {ajustes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum ajuste cadastrado ainda.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead
                    sortDirection={ajustesOrdenados.sortDirectionFor("chaveExport")}
                    onSort={() => ajustesOrdenados.toggleSort("chaveExport")}
                  >
                    Chave do export
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={ajustesOrdenados.sortDirectionFor("nomeAlvo")}
                    onSort={() => ajustesOrdenados.toggleSort("nomeAlvo")}
                  >
                    Alvo
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={ajustesOrdenados.sortDirectionFor("valorInvestidoCentavosCorrigido")}
                    onSort={() => ajustesOrdenados.toggleSort("valorInvestidoCentavosCorrigido")}
                  >
                    Valor investido corrigido
                  </SortableTableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ajustesOrdenados.sortedRows.map((a) => (
                  <TableRow key={a.chaveExport}>
                    <TableCell className="max-w-56 whitespace-normal break-words">
                      {a.chaveExport}
                    </TableCell>
                    <TableCell>{a.nomeAlvo ?? "Fora da carteira"}</TableCell>
                    <TableCell>
                      {a.valorInvestidoCentavosCorrigido !== null ? (
                        formatCentavosParaReais(a.valorInvestidoCentavosCorrigido)
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded border border-amber-400/60 bg-amber-400/10 px-1.5 py-0.5 text-xs">
                          Primeira vez — ainda sem valor corrigido
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" onClick={() => handleEditarAjuste(a)}>
                        {a.valorInvestidoCentavosCorrigido !== null ? "Editar" : "Preencher"}
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
