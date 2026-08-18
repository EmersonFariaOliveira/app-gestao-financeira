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
 *
 * Seção de revisão (6.9, T022, User Story 3 — feature 002): dentro do MESMO
 * card de preview, depois do diff e antes do botão "Confirmar import"
 * (research.md R6 — não é um passo de wizard separado). Lista pré-preenchida
 * (carry-forward, `preview.posicoesManuaisRevisao`/`ajustesRevisao`) com
 * campos editáveis em reais (conversão para/de centavos só na borda, mesmo
 * padrão de `src/app/posicoes-manuais/page.tsx`). Some inteiramente quando
 * não há nenhuma posição manual/ajuste ativo — não quebra o fluxo de import
 * que não usa posições manuais.
 *
 * Destaque de incrementos ambíguos (T027, motor-integracao.md §4.2,
 * server-actions.md §import.ts campo `incrementosAmbiguosPendentes`): um
 * banner âmbar por alvo com pendência ambígua (aporte executado sem fundo
 * específico), listando os destinos elegíveis (`elegiveis`) onde o usuário
 * deve digitar o valor manualmente nas tabelas de posições
 * manuais/ajustes abaixo. Decisão de UX (item 3 da tarefa): NÃO calculamos
 * "quanto já foi distribuído" comparando os valores editados com os
 * sugeridos originais — a derivação exigiria rastrear, por alvo, quais
 * campos de `posicoesManuaisTextos`/`ajustesTextos` pertencem a quais
 * `elegiveis` e qual era o valor sugerido de cada um antes da pendência
 * ambígua ser somada (o valor sugerido já inclui incrementos EXCLUSIVOS
 * daquele item, então a diferença "editado − sugerido" não isola limpamente
 * a fatia ambígua). Optamos pela versão mais simples permitida pela tarefa:
 * mostrar apenas o valor total pendente do alvo — puramente informativo,
 * não bloqueia a confirmação. Por isso `distribuicoesIncrementosAmbiguos`
 * (campo opcional do contrato, só para conferência visual) não é enviado no
 * `confirmarImport` — o servidor não depende dele (sempre retorna
 * `incrementosAmbiguosNaoAlocadosCentavos: 0`, ver import-service.ts).
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCentavosParaReais, parseDecimalParaCentavos } from "@/core/money";
import { useSortableRows } from "@/hooks/use-sortable-rows";
import type { ErroParse } from "@/parser/types";

/** "yyyy-mm-dd" ou "yyyy-mm-ddTHH:mm:ss..." (ISO) → "dd/mm/aaaa" para exibição; falha graciosamente devolvendo o ISO cru. */
function formatDataIsoParaBr(iso: string): string {
  const [ano, mes, dia] = iso.slice(0, 10).split("-");
  if (!ano || !mes || !dia) return iso;
  return `${dia}/${mes}/${ano}`;
}

/** Centavos → texto decimal em reais editável (mesmo padrão de posicoes-manuais/page.tsx); `null` vira campo vazio (FR-009). */
function centavosParaTexto(centavos: number | null): string {
  if (centavos === null) return "";
  return (centavos / 100).toFixed(2).replace(".", ",");
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

  // Seção de revisão (6.9, T022, US3): campos editáveis por
  // `posicaoManualId`/`chaveExport`, pré-preenchidos com o valor sugerido do
  // carry-forward quando o preview chega. Textos em reais (borda de UI) —
  // convertidos para centavos só na hora de montar `posicoesManuaisConfirmadas`/
  // `ajustesConfirmados` (`parseDecimalParaCentavos`).
  const [posicoesManuaisTextos, setPosicoesManuaisTextos] = useState<
    Record<string, { valorInvestido: string; valorAtual: string }>
  >({});
  const [ajustesTextos, setAjustesTextos] = useState<Record<string, string>>({});

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

    // Pré-preenchimento da seção de revisão (6.9, T022) a partir do
    // carry-forward retornado pelo preview — o usuário edita a partir daqui,
    // nada é persistido até "Confirmar import".
    setPosicoesManuaisTextos(
      Object.fromEntries(
        resp.data.posicoesManuaisRevisao.map((item) => [
          item.posicaoManualId,
          {
            valorInvestido: centavosParaTexto(item.valorInvestidoCentavosSugerido),
            valorAtual: centavosParaTexto(item.valorAtualCentavosSugerido),
          },
        ]),
      ),
    );
    setAjustesTextos(
      Object.fromEntries(
        resp.data.ajustesRevisao.map((item) => [
          item.chaveExport,
          centavosParaTexto(item.valorInvestidoCentavosSugerido),
        ]),
      ),
    );
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
    if (!podeConfirmar || !preview) return;

    setErroConfirmacao(null);

    // Monta os payloads da revisão (6.9, T022) a partir dos valores EDITADOS
    // pelo usuário (não necessariamente os sugeridos originais) — validação
    // de formato acontece aqui, na borda, antes de chamar a action.
    let posicoesManuaisConfirmadas: {
      posicaoManualId: string;
      valorInvestidoCentavos: number;
      valorAtualCentavos: number;
    }[];
    let ajustesConfirmados: { chaveExport: string; valorInvestidoCentavosCorrigido: number }[];
    try {
      posicoesManuaisConfirmadas = preview.posicoesManuaisRevisao.map((item) => {
        const textos = posicoesManuaisTextos[item.posicaoManualId] ?? {
          valorInvestido: "",
          valorAtual: "",
        };
        const valorInvestidoCentavos = parseDecimalParaCentavos(textos.valorInvestido || "0");
        const valorAtualCentavos = parseDecimalParaCentavos(textos.valorAtual || "0");
        if (valorInvestidoCentavos < 0 || valorAtualCentavos < 0) {
          throw new Error(`Valores de "${item.descricao}" não podem ser negativos.`);
        }
        return { posicaoManualId: item.posicaoManualId, valorInvestidoCentavos, valorAtualCentavos };
      });

      // Chave ausente aqui = usuário deixou vazio nesta sessão — nenhum
      // ajuste_valor_investido é criado para ela (FR-009, "aviso, não bloqueio").
      ajustesConfirmados = preview.ajustesRevisao.flatMap((item) => {
        const texto = ajustesTextos[item.chaveExport] ?? "";
        if (!texto.trim()) return [];
        const valorInvestidoCentavosCorrigido = parseDecimalParaCentavos(texto);
        if (valorInvestidoCentavosCorrigido < 0) {
          throw new Error(`Valor corrigido de "${item.chaveExport}" não pode ser negativo.`);
        }
        return [{ chaveExport: item.chaveExport, valorInvestidoCentavosCorrigido }];
      });
    } catch (erro) {
      setErroConfirmacao(
        erro instanceof Error
          ? erro.message
          : "Valor inválido na seção de revisão — use um decimal (ex.: 1000,00).",
      );
      return;
    }

    setFaseConfirmacao("confirmando");

    const resp = await confirmarImport(
      construirFormData({
        mesReferencia: mesReferenciaTexto.trim(),
        confirmouInstituicoesFaltantes: confirmouInstituicoesFaltantes ? "true" : "false",
        posicoesManuaisConfirmadas: JSON.stringify(posicoesManuaisConfirmadas),
        ajustesConfirmados: JSON.stringify(ajustesConfirmados),
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

              {preview.movimentacoesNaoExplicadas.length > 0 && (
                <div className="flex flex-col gap-2 rounded-lg border border-amber-400/60 bg-amber-400/10 p-3 text-sm">
                  <p className="font-medium text-amber-700">
                    Atenção: movimentação de valor investido não explicada pelos aportes
                    registrados no app.
                  </p>
                  <p className="text-muted-foreground">
                    O valor investido esperado (posição anterior + aportes registrados) não
                    bate com o valor investido real deste import além da tolerância. Isso não
                    impede a confirmação — apenas confira se corresponde a um aporte ou resgate
                    feito fora do app.
                  </p>
                  <ul className="flex flex-col gap-1">
                    {preview.movimentacoesNaoExplicadas.map((item, idx) => (
                      <li
                        key={`${item.alvoId}-${item.chaveExport ?? item.posicaoManualId ?? idx}`}
                        className="rounded-md border border-amber-400/40 bg-background/40 px-2 py-1.5"
                      >
                        <span className="font-medium">{item.nomeAlvo}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          (
                          {item.granularidade === "ativo"
                            ? `ativo ${item.chaveExport ?? item.posicaoManualId ?? "—"}`
                            : "soma do alvo — múltiplos ativos elegíveis"}
                          )
                        </span>
                        : esperado {formatCentavosParaReais(item.valorInvestidoEsperadoCentavos)},
                        real {formatCentavosParaReais(item.valorInvestidoRealCentavos)} (diferença{" "}
                        {item.diferencaCentavos > 0 ? "+" : ""}
                        {formatCentavosParaReais(item.diferencaCentavos)}).
                      </li>
                    ))}
                  </ul>
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

              {(preview.posicoesManuaisRevisao.length > 0 ||
                preview.ajustesRevisao.length > 0 ||
                preview.incrementosAmbiguosPendentes.length > 0) && (
                <div className="flex flex-col gap-4 border-t pt-4">
                  <div>
                    <p className="font-medium">Revisão de posições manuais e ajustes</p>
                    <p className="text-sm text-muted-foreground">
                      Pré-preenchido com o último valor conhecido — edite antes de confirmar. Só
                      grava quando você confirmar este import.
                    </p>
                  </div>

                  {preview.incrementosAmbiguosPendentes.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {preview.incrementosAmbiguosPendentes.map((item) => (
                        <div
                          key={item.alvoId}
                          className="rounded-lg border border-amber-400/60 bg-amber-400/10 p-3 text-sm"
                        >
                          <p className="font-medium">
                            {formatCentavosParaReais(item.valorPendenteCentavos)} aportados em
                            &quot;{item.nomeAlvo}&quot; sem fundo específico — distribua abaixo.
                          </p>
                          {item.elegiveis.length > 0 && (
                            <p className="mt-1 text-muted-foreground">
                              Destinos possíveis:{" "}
                              {item.elegiveis.map((elegivel) => elegivel.rotulo).join(", ")}.
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {preview.posicoesManuaisRevisao.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm font-medium">Posições manuais</p>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Descrição</TableHead>
                            <TableHead>Alvo</TableHead>
                            <TableHead>Valor investido</TableHead>
                            <TableHead>Valor atual</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {preview.posicoesManuaisRevisao.map((item) => (
                            <TableRow key={item.posicaoManualId}>
                              <TableCell className="max-w-56 whitespace-normal break-words">
                                {item.descricao}
                                <div className="text-xs text-muted-foreground">
                                  {item.instituicao}
                                </div>
                                {item.incrementoPendenteCentavos > 0 && (
                                  <div className="text-xs text-muted-foreground">
                                    + {formatCentavosParaReais(item.incrementoPendenteCentavos)}{" "}
                                    de aporte executado já somado ao sugerido.
                                  </div>
                                )}
                              </TableCell>
                              <TableCell>{item.nomeAlvo}</TableCell>
                              <TableCell>
                                <Input
                                  aria-label={`Valor investido de ${item.descricao}`}
                                  inputMode="decimal"
                                  className="w-32"
                                  value={
                                    posicoesManuaisTextos[item.posicaoManualId]?.valorInvestido ??
                                    ""
                                  }
                                  onChange={(e) =>
                                    setPosicoesManuaisTextos((prev) => ({
                                      ...prev,
                                      [item.posicaoManualId]: {
                                        valorInvestido: e.target.value,
                                        valorAtual: prev[item.posicaoManualId]?.valorAtual ?? "",
                                      },
                                    }))
                                  }
                                />
                              </TableCell>
                              <TableCell>
                                <Input
                                  aria-label={`Valor atual de ${item.descricao}`}
                                  inputMode="decimal"
                                  className="w-32"
                                  value={
                                    posicoesManuaisTextos[item.posicaoManualId]?.valorAtual ?? ""
                                  }
                                  onChange={(e) =>
                                    setPosicoesManuaisTextos((prev) => ({
                                      ...prev,
                                      [item.posicaoManualId]: {
                                        valorInvestido:
                                          prev[item.posicaoManualId]?.valorInvestido ?? "",
                                        valorAtual: e.target.value,
                                      },
                                    }))
                                  }
                                />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}

                  {preview.ajustesRevisao.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm font-medium">Ajustes de fundos</p>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Ativo (chave do export)</TableHead>
                            <TableHead>Alvo</TableHead>
                            <TableHead>Valor investido corrigido</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {preview.ajustesRevisao.map((item) => (
                            <TableRow key={item.chaveExport}>
                              <TableCell className="max-w-56 whitespace-normal break-words">
                                {item.chaveExport}
                                {item.primeiraVez && (
                                  <div className="mt-1 rounded-lg border border-amber-400/60 bg-amber-400/10 px-2 py-1 text-xs">
                                    Primeira vez ajustando este ativo — não há valor anterior
                                    (FR-009). Deixe em branco para não corrigir agora.
                                  </div>
                                )}
                              </TableCell>
                              <TableCell>{item.nomeAlvo ?? "—"}</TableCell>
                              <TableCell>
                                <Input
                                  aria-label={`Valor investido corrigido de ${item.chaveExport}`}
                                  inputMode="decimal"
                                  placeholder="1000,00"
                                  className="w-32"
                                  value={ajustesTextos[item.chaveExport] ?? ""}
                                  onChange={(e) =>
                                    setAjustesTextos((prev) => ({
                                      ...prev,
                                      [item.chaveExport]: e.target.value,
                                    }))
                                  }
                                />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
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
