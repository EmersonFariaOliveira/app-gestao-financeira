"use client";

/**
 * src/app/import/page.tsx — Import mensal (tela 6.2,
 * docs/app-gestao-aportes.md seção 6.2).
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * interpreta o CSV — ela apenas chama `src/app/actions/import.ts` (que
 * delega a `src/services/import-service.ts` → `src/parser/**`) e exibe o
 * resultado. Toda formatação monetária usa `formatCentavosParaReais`
 * (src/core/money) na borda de exibição; os valores trafegam em centavos
 * inteiros em todo o restante do fluxo.
 *
 * Escolha de UX (drag-and-drop vs. input nativo): implementamos
 * drag-and-drop HTML5 completo (dragover/drop) SOBRE um `<input
 * type="file" multiple accept=".csv">` que também funciona por clique —
 * cobre tanto quem prefere arrastar quanto quem prefere o seletor nativo do
 * SO, sem exigir biblioteca extra.
 *
 * Bloqueios obrigatórios (seção 6.2):
 * - Erros de parse (linha/coluna) impedem qualquer confirmação — mostrados
 *   em lista clara, nunca falha silenciosa.
 * - Instituição faltante vs. sessão anterior: aviso FORTE + checkbox de
 *   confirmação explícita habilita o botão "Confirmar" (sem bloquear a
 *   operação em si — apenas exige o reconhecimento do usuário).
 * - Aviso de substituição de sessão do mesmo mês: exibido claramente antes
 *   de confirmar.
 */
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  confirmarImport,
  previewImport,
  type ConfirmarImportOutput,
  type PreviewImportOutput,
} from "@/app/actions/import";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  SortableTableHead,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCentavosParaReais } from "@/core/money";
import { useSortableRows } from "@/hooks/use-sortable-rows";
import type { ErroParse } from "@/parser/types";

/** "yyyy-mm-dd" ou "yyyy-mm-ddTHH:mm:ss..." (ISO) → "dd/mm/aaaa" para exibição; falha graciosamente devolvendo o ISO cru. */
function formatDataIsoParaBr(iso: string): string {
  const [ano, mes, dia] = iso.slice(0, 10).split("-");
  if (!ano || !mes || !dia) return iso;
  return `${dia}/${mes}/${ano}`;
}

type FaseAnalise = "idle" | "analisando" | "erro" | "pronto";
type FaseConfirmacao = "idle" | "confirmando" | "sucesso";

export default function ImportPage() {
  const inputRef = useRef<HTMLInputElement>(null);

  const [arquivos, setArquivos] = useState<File[]>([]);
  const [arrastando, setArrastando] = useState(false);

  const [faseAnalise, setFaseAnalise] = useState<FaseAnalise>("idle");
  const [erroAnalise, setErroAnalise] = useState<string | null>(null);
  const [errosParse, setErrosParse] = useState<ErroParse[] | null>(null);
  const [preview, setPreview] = useState<PreviewImportOutput | null>(null);

  const [mesReferenciaTexto, setMesReferenciaTexto] = useState("");
  const [confirmouInstituicoesFaltantes, setConfirmouInstituicoesFaltantes] = useState(false);

  const [faseConfirmacao, setFaseConfirmacao] = useState<FaseConfirmacao>("idle");
  const [erroConfirmacao, setErroConfirmacao] = useState<string | null>(null);
  const [resultadoConfirmacao, setResultadoConfirmacao] = useState<ConfirmarImportOutput | null>(
    null,
  );

  function adicionarArquivos(lista: FileList | File[]) {
    const novos = Array.from(lista).filter((f) => f.name.toLowerCase().endsWith(".csv"));
    if (novos.length === 0) return;
    setArquivos((prev) => {
      const nomesExistentes = new Set(prev.map((f) => f.name));
      const semDuplicata = novos.filter((f) => !nomesExistentes.has(f.name));
      return [...prev, ...semDuplicata];
    });
    // Nova seleção de arquivos invalida qualquer preview/confirmação anteriores.
    setPreview(null);
    setFaseAnalise("idle");
    setErroAnalise(null);
    setErrosParse(null);
    setFaseConfirmacao("idle");
    setErroConfirmacao(null);
    setResultadoConfirmacao(null);
  }

  function removerArquivo(nome: string) {
    setArquivos((prev) => prev.filter((f) => f.name !== nome));
    setPreview(null);
    setFaseAnalise("idle");
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setArrastando(false);
    if (e.dataTransfer.files.length > 0) adicionarArquivos(e.dataTransfer.files);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setArrastando(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setArrastando(false);
  }

  const construirFormData = useCallback(
    (extra?: Record<string, string>): FormData => {
      const fd = new FormData();
      for (const arquivo of arquivos) fd.append("arquivos", arquivo);
      if (extra) {
        for (const [chave, valor] of Object.entries(extra)) fd.append(chave, valor);
      }
      return fd;
    },
    [arquivos],
  );

  const analisarArquivos = useCallback(async () => {
    if (arquivos.length === 0) {
      setErroAnalise("Selecione ao menos um arquivo CSV para importar.");
      setFaseAnalise("erro");
      return;
    }

    setFaseAnalise("analisando");
    setErroAnalise(null);
    setErrosParse(null);
    setPreview(null);

    const resp = await previewImport(construirFormData());
    if (!resp.ok) {
      setErroAnalise(resp.erro);
      setErrosParse((resp.detalhes as ErroParse[] | undefined) ?? null);
      setFaseAnalise("erro");
      return;
    }

    setPreview(resp.data);
    setMesReferenciaTexto(resp.data.mesReferenciaProposto);
    setConfirmouInstituicoesFaltantes(false);
    setFaseAnalise("pronto");
  }, [arquivos, construirFormData]);

  // "Cotação mais recente" pode ser `null` (dataMaisRecente não observada) —
  // ordenado como string vazia (fica no início/fim conforme a direção).
  const arquivosOrdenados = useSortableRows(preview?.arquivos ?? [], {
    instituicao: (a) => a.instituicao,
    qtdAtivos: (a) => a.qtdAtivos,
    totalCentavos: (a) => a.totalCentavos,
    dataMaisRecente: (a) => a.dataMaisRecente ?? "",
  });

  const temInstituicoesFaltantes = (preview?.instituicoesFaltantes?.length ?? 0) > 0;
  const podeConfirmar = useMemo(() => {
    if (!preview) return false;
    if (!mesReferenciaTexto.trim()) return false;
    if (temInstituicoesFaltantes && !confirmouInstituicoesFaltantes) return false;
    return true;
  }, [preview, mesReferenciaTexto, temInstituicoesFaltantes, confirmouInstituicoesFaltantes]);

  async function handleConfirmar() {
    if (!podeConfirmar) return;

    setFaseConfirmacao("confirmando");
    setErroConfirmacao(null);

    const resp = await confirmarImport(
      construirFormData({
        mesReferencia: mesReferenciaTexto.trim(),
        confirmouInstituicoesFaltantes: confirmouInstituicoesFaltantes ? "true" : "false",
      }),
    );

    if (!resp.ok) {
      setErroConfirmacao(resp.erro);
      setFaseConfirmacao("idle");
      toast.error(resp.erro);
      return;
    }

    setResultadoConfirmacao(resp.data);
    setFaseConfirmacao("sucesso");
    if (resp.data.pendenciasVinculo.length > 0) {
      toast.success(
        `Import confirmado. ${resp.data.pendenciasVinculo.length} ativo(s) novo(s) aguardando vínculo.`,
      );
    } else {
      toast.success("Import confirmado com sucesso.");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Cabecalho />

      <Card>
        <CardHeader>
          <CardTitle>Arraste os CSVs do MyCapital</CardTitle>
          <CardDescription>
            Um arquivo por instituição (ex.: <code>Extrato_Itaú.csv</code>). Todos os
            arquivos soltos aqui formam uma única sessão de import.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center text-sm transition-colors ${
              arrastando
                ? "border-primary bg-primary/5 text-foreground"
                : "border-input text-muted-foreground hover:bg-muted/50"
            }`}
          >
            <p>Arraste os arquivos CSV aqui, ou clique para selecionar.</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) adicionarArquivos(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {arquivos.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {arquivos.map((arquivo) => (
                <li
                  key={arquivo.name}
                  className="flex items-center justify-between rounded-md border px-3 py-1.5"
                >
                  <span>{arquivo.name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      removerArquivo(arquivo.name);
                    }}
                  >
                    Remover
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {erroAnalise && (
            <FieldError>
              {erroAnalise}
              {errosParse && errosParse.length > 0 && (
                <ul className="mt-2 list-inside list-disc">
                  {errosParse.map((erro, idx) => (
                    <li key={idx}>
                      <strong>{erro.arquivo}</strong> — linha {erro.linha}, coluna &quot;
                      {erro.coluna}&quot;: {erro.mensagem}
                    </li>
                  ))}
                </ul>
              )}
            </FieldError>
          )}
        </CardContent>
        <CardFooter>
          <Button
            onClick={() => void analisarArquivos()}
            disabled={faseAnalise === "analisando" || arquivos.length === 0}
          >
            {faseAnalise === "analisando" ? "Analisando…" : "Analisar arquivos"}
          </Button>
        </CardFooter>
      </Card>

      {preview && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Preview do import</CardTitle>
              <CardDescription>
                Posições de {formatDataIsoParaBr(preview.dataExport)}. Confira antes de
                confirmar.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableTableHead
                      sortDirection={arquivosOrdenados.sortDirectionFor("instituicao")}
                      onSort={() => arquivosOrdenados.toggleSort("instituicao")}
                    >
                      Instituição
                    </SortableTableHead>
                    <SortableTableHead
                      sortDirection={arquivosOrdenados.sortDirectionFor("qtdAtivos")}
                      onSort={() => arquivosOrdenados.toggleSort("qtdAtivos")}
                    >
                      Ativos
                    </SortableTableHead>
                    <SortableTableHead
                      sortDirection={arquivosOrdenados.sortDirectionFor("totalCentavos")}
                      onSort={() => arquivosOrdenados.toggleSort("totalCentavos")}
                    >
                      Total
                    </SortableTableHead>
                    <SortableTableHead
                      sortDirection={arquivosOrdenados.sortDirectionFor("dataMaisRecente")}
                      onSort={() => arquivosOrdenados.toggleSort("dataMaisRecente")}
                    >
                      Cotação mais recente
                    </SortableTableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {arquivosOrdenados.sortedRows.map((resumo) => (
                    <TableRow key={resumo.instituicao}>
                      <TableCell>{resumo.instituicao}</TableCell>
                      <TableCell>{resumo.qtdAtivos}</TableCell>
                      <TableCell>{formatCentavosParaReais(resumo.totalCentavos)}</TableCell>
                      <TableCell>
                        {resumo.dataMaisRecente
                          ? formatDataIsoParaBr(resumo.dataMaisRecente)
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <Field>
                <FieldLabel htmlFor="mes-referencia">Mês de referência</FieldLabel>
                <Input
                  id="mes-referencia"
                  placeholder="AAAA-MM"
                  value={mesReferenciaTexto}
                  onChange={(e) => setMesReferenciaTexto(e.target.value)}
                  className="w-40"
                />
                <FieldDescription>
                  Derivado da data das posições (não da data do upload) — edite se
                  necessário antes de confirmar.
                </FieldDescription>
              </Field>

              {preview.avisoSubstituicao && (
                <div className="rounded-lg border border-amber-400/60 bg-amber-400/10 p-3 text-sm">
                  Já existe uma sessão vigente para {preview.avisoSubstituicao.mes} (posições
                  de {formatDataIsoParaBr(preview.avisoSubstituicao.dataAnterior)}). Confirmar
                  este import fará com que ele passe a ser o vigente — a sessão anterior fica
                  preservada como substituída, acessível na auditoria do histórico.
                </div>
              )}

              {temInstituicoesFaltantes && (
                <div className="flex flex-col gap-2 rounded-lg border border-destructive/60 bg-destructive/10 p-3 text-sm">
                  <p className="font-medium text-destructive">
                    Atenção: instituições presentes no import anterior e ausentes deste
                    import: {preview.instituicoesFaltantes!.join(", ")}.
                  </p>
                  <p className="text-muted-foreground">
                    Isso é esperado se você encerrou conta em alguma corretora — mas confira
                    antes de confirmar.
                  </p>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 rounded border-input"
                      checked={confirmouInstituicoesFaltantes}
                      onChange={(e) => setConfirmouInstituicoesFaltantes(e.target.checked)}
                    />
                    Confirmo que a ausência dessas instituições é esperada.
                  </label>
                </div>
              )}

              {preview.diff && (
                <div className="flex flex-col gap-2 text-sm">
                  <p className="font-medium">Diferenças em relação à sessão anterior</p>
                  {preview.diff.novos.length === 0 &&
                  preview.diff.sumiram.length === 0 &&
                  preview.diff.variacoesGrandes.length === 0 ? (
                    <p className="text-muted-foreground">Nenhuma diferença relevante.</p>
                  ) : (
                    <>
                      {preview.diff.novos.length > 0 && (
                        <div>
                          <span className="text-muted-foreground">Ativos novos: </span>
                          {preview.diff.novos.join(", ")}
                        </div>
                      )}
                      {preview.diff.sumiram.length > 0 && (
                        <div>
                          <span className="text-muted-foreground">Ativos que sumiram: </span>
                          {preview.diff.sumiram.join(", ")}
                        </div>
                      )}
                      {preview.diff.variacoesGrandes.length > 0 && (
                        <ul className="list-inside list-disc">
                          {preview.diff.variacoesGrandes.map((v) => (
                            <li key={v.chaveExport}>
                              {v.chaveExport}: {formatCentavosParaReais(v.valorAnteriorCentavos)}
                              {" → "}
                              {formatCentavosParaReais(v.valorNovoCentavos)} (
                              {v.variacaoPercentual > 0 ? "+" : ""}
                              {(v.variacaoPercentual / 100).toFixed(2)}%)
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}

              {erroConfirmacao && <FieldError>{erroConfirmacao}</FieldError>}
            </CardContent>
            <CardFooter>
              <Button
                onClick={() => void handleConfirmar()}
                disabled={!podeConfirmar || faseConfirmacao === "confirmando"}
              >
                {faseConfirmacao === "confirmando" ? "Confirmando…" : "Confirmar import"}
              </Button>
            </CardFooter>
          </Card>

          {resultadoConfirmacao && (
            <Card>
              <CardHeader>
                <CardTitle>Import confirmado</CardTitle>
                <CardDescription>
                  Sessão {resultadoConfirmacao.sessaoId} criada como vigente.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm">
                {resultadoConfirmacao.pendenciasVinculo.length > 0 ? (
                  <p>
                    {resultadoConfirmacao.pendenciasVinculo.length} ativo(s) novo(s) sem
                    vínculo:{" "}
                    <span className="text-muted-foreground">
                      {resultadoConfirmacao.pendenciasVinculo.join(", ")}
                    </span>
                    . Vincule antes de calcular o aporte.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Nenhuma pendência de vínculo — todos os ativos já eram conhecidos.
                  </p>
                )}
              </CardContent>
              <CardFooter>
                <Button render={<Link href="/vinculos" />}>Ir para vínculos</Button>
              </CardFooter>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Cabecalho() {
  return (
    <div>
      <h1 className="text-2xl font-heading font-semibold tracking-tight">Import mensal</h1>
      <p className="text-sm text-muted-foreground">
        Arraste os exports do MyCapital (um CSV por instituição) para formar a sessão de
        import deste mês.
      </p>
    </div>
  );
}
