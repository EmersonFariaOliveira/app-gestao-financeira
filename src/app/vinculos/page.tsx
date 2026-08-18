"use client";

/**
 * src/app/vinculos/page.tsx — Vínculo de ativos (tela 6.3,
 * docs/app-gestao-aportes.md seção 6.3).
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * reimplementa a regra de exclusão mútua alvo/fora-da-carteira — ela apenas
 * chama `src/app/actions/vinculos.ts` (que delega a
 * `src/services/mapeamento-service.ts`/`alvo-service.ts`) e
 * `src/app/actions/posicoes-manuais.ts` (que delega a
 * `src/services/posicao-manual-service.ts`) e exibe o resultado.
 *
 * Unificação (extensão da feature 002-posicoes-manuais-ajustes): posições
 * manuais cadastradas em "+ Nova posição manual" passam pela MESMA máquina
 * de estados pendente → vinculado/fora-da-carteira/reserva-de-emergência que
 * os ativos do CSV — misturadas nas MESMAS seções desta tela (não uma seção
 * separada), com uma marcação visual simples ("Manual") para diferenciar a
 * origem. `chaveExport` (espaço de identidade do CSV) e `posicaoManualId`
 * (espaço de identidade das posições manuais) nunca colidem por construção,
 * mas os `Record<string, ...>` de estado por linha (`formsPendentes`,
 * `reatribuirAlvoId`) são chaveados com prefixo (`csv:`/`manual:`) para
 * deixar essa distinção explícita e evitar qualquer colisão acidental caso
 * os dois espaços um dia compartilhem o mesmo texto.
 *
 * Posições manuais NÃO têm um modo "ignorar" (exclusivo de
 * `ativo_mapeado`/CSV — marca que um ativo do CSV foi substituído por uma
 * posição manual; não se aplica a uma posição manual em si, que já É a
 * substituição) nem um botão "Encerrar" aqui (ação irreversível, exclusiva
 * da tela /posicoes-manuais, para não duplicar o diálogo de confirmação em
 * dois lugares).
 *
 * Conteúdo (seção 6.3):
 * 1. Pendentes em destaque — chave do export/posição manual → dropdown de
 *    alvo existente, criar alvo novo na hora, ou marcar "Fora da carteira
 *    alvo"/"Reserva de emergência". É o que bloqueia a calculadora (FR-015/
 *    seção 6.5).
 * 2. Vinculados, Fora-da-carteira e Reserva de emergência, também nesta
 *    tela, para revisão/correção (a tela serve tanto para resolver
 *    pendências quanto para editar vínculos existentes).
 *
 * Percentual do alvo novo: o campo aceita o mesmo formato decimal usado em
 * toda a UI ("12,5" = 12,5%). Como `percentual_alvo_bps` já usa a mesma
 * convenção de 2 casas de `src/core/money` (1% = 100 bps, exatamente como 1
 * real = 100 centavos), reaproveitamos `parseDecimalParaCentavos` para essa
 * conversão sem nenhuma lógica nova — "12,5" → 1250, que é exatamente 1250
 * bps.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  listarPosicoesManuaisParaVinculo,
  vincularPosicaoManual,
} from "@/app/actions/posicoes-manuais";
import {
  listarAlvosParaDropdown,
  listarVinculos,
  vincularAtivo,
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
import { formatBps, formatCentavosParaReais, parseDecimalParaCentavos } from "@/core/money";
import { useSortableRows } from "@/hooks/use-sortable-rows";
import type { ListarVinculosOutput, VincularAtivoInput } from "@/services/mapeamento-service";
import type {
  ListarPosicoesManuaisParaVinculoOutput,
  VincularPosicaoManualInput,
} from "@/services/posicao-manual-service";

type Fase = "carregando" | "erro" | "pronto";
type Origem = "csv" | "manual";

// "ignorar-existente"/"ignorar-novo" (feature 002, FR-001): mesma escolha de
// alvo dos modos "existente"/"novo" (reaproveitam os campos do form), só que
// gravam `ignorarNoImport: true` — o ativo some da consolidação do CSV
// porque será substituído por uma posição manual. Exclusivos de linhas CSV —
// posições manuais nunca oferecem esses dois modos (ver cabeçalho do
// arquivo).
type ModoResolucao =
  | "existente"
  | "novo"
  | "fora"
  | "reserva"
  | "ignorar-existente"
  | "ignorar-novo";

// Reaproveitado no aviso de "ignorar" tanto em Pendentes quanto nas ações de
// Vinculados/Fora da carteira (feature 002, FR-001) — mesmo texto, sem
// duplicar a explicação.
const AVISO_IGNORAR =
  'Este valor deixa de ser lido do export em imports futuros. Cadastre a posição manual correspondente em seguida, na tela "Posições manuais".';

/** Badge inline para marcar visualmente uma linha como posição manual (não ativo do CSV). */
function BadgeManual() {
  return (
    <span className="ml-1 inline-flex items-center rounded border border-sky-400/60 bg-sky-400/10 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300">
      Manual
    </span>
  );
}

/** Prefixo de chave de estado por linha, para separar os dois espaços de identidade (CSV vs. posição manual). */
function chaveCsv(chaveExport: string): string {
  return `csv:${chaveExport}`;
}
function chaveManualKey(posicaoManualId: string): string {
  return `manual:${posicaoManualId}`;
}

interface FormPendente {
  modo: ModoResolucao;
  alvoId: string;
  novoNome: string;
  novoPercentualTexto: string;
}

function formInicial(alvos: AlvoParaDropdown[]): FormPendente {
  return {
    modo: alvos.length > 0 ? "existente" : "novo",
    alvoId: alvos[0]?.id ?? "",
    novoNome: "",
    novoPercentualTexto: "",
  };
}

/** Linha unificada CSV + posição manual para as seções Vinculados/Fora da carteira/Reserva de emergência. */
interface LinhaSemAlvo {
  key: string;
  rawId: string;
  origem: Origem;
  rotulo: string;
  valorAtualCentavos: number | null;
}

interface LinhaVinculada extends LinhaSemAlvo {
  alvoId: string;
  nomeAlvo: string;
}

export default function VinculosPage() {
  const [fase, setFase] = useState<Fase>("carregando");
  const [erro, setErro] = useState<string | null>(null);
  const [vinculos, setVinculos] = useState<ListarVinculosOutput | null>(null);
  const [posicoesManuais, setPosicoesManuais] =
    useState<ListarPosicoesManuaisParaVinculoOutput | null>(null);
  const [alvos, setAlvos] = useState<AlvoParaDropdown[]>([]);

  const [formsPendentes, setFormsPendentes] = useState<Record<string, FormPendente>>({});
  const [salvandoChave, setSalvandoChave] = useState<string | null>(null);

  // Formulários de reatribuição das linhas já resolvidas (vinculados/fora).
  const [reatribuirAlvoId, setReatribuirAlvoId] = useState<Record<string, string>>({});

  const carregar = useCallback(async () => {
    const [respVinculos, respAlvos, respPosicoesManuais] = await Promise.all([
      listarVinculos(),
      listarAlvosParaDropdown(),
      listarPosicoesManuaisParaVinculo(),
    ]);

    if (!respVinculos.ok) {
      setErro(respVinculos.erro);
      setFase("erro");
      return;
    }
    if (!respAlvos.ok) {
      setErro(respAlvos.erro);
      setFase("erro");
      return;
    }
    if (!respPosicoesManuais.ok) {
      setErro(respPosicoesManuais.erro);
      setFase("erro");
      return;
    }

    setVinculos(respVinculos.data);
    setAlvos(respAlvos.data);
    setPosicoesManuais(respPosicoesManuais.data);
    setFormsPendentes((prev) => {
      const novo: Record<string, FormPendente> = {};
      for (const pendente of respVinculos.data.pendentes) {
        const key = chaveCsv(pendente.chaveExport);
        novo[key] = prev[key] ?? formInicial(respAlvos.data);
      }
      for (const pendente of respPosicoesManuais.data.pendentes) {
        const key = chaveManualKey(pendente.posicaoManualId);
        novo[key] = prev[key] ?? formInicial(respAlvos.data);
      }
      return novo;
    });
    setReatribuirAlvoId((prev) => {
      const novo: Record<string, string> = { ...prev };
      for (const v of respVinculos.data.vinculados) {
        const key = chaveCsv(v.chaveExport);
        if (!novo[key]) novo[key] = v.alvoId;
      }
      for (const f of respVinculos.data.foraDaCarteira) {
        const key = chaveCsv(f.chaveExport);
        if (!novo[key]) novo[key] = respAlvos.data[0]?.id ?? "";
      }
      for (const r of respVinculos.data.reservaEmergencia) {
        const key = chaveCsv(r.chaveExport);
        if (!novo[key]) novo[key] = respAlvos.data[0]?.id ?? "";
      }
      for (const v of respPosicoesManuais.data.vinculadas) {
        const key = chaveManualKey(v.posicaoManualId);
        if (!novo[key]) novo[key] = v.alvoId ?? respAlvos.data[0]?.id ?? "";
      }
      for (const f of respPosicoesManuais.data.foraDaCarteira) {
        const key = chaveManualKey(f.posicaoManualId);
        if (!novo[key]) novo[key] = respAlvos.data[0]?.id ?? "";
      }
      for (const r of respPosicoesManuais.data.reservaEmergencia) {
        const key = chaveManualKey(r.posicaoManualId);
        if (!novo[key]) novo[key] = respAlvos.data[0]?.id ?? "";
      }
      return novo;
    });
    setFase("pronto");
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function atualizarFormPendente(key: string, patch: Partial<FormPendente>) {
    setFormsPendentes((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? formInicial(alvos)), ...patch },
    }));
  }

  async function executarVinculoCsv(
    key: string,
    chaveExport: string,
    input: VincularAtivoInput,
  ) {
    setSalvandoChave(key);
    try {
      const resp = await vincularAtivo(input);
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      if (resp.data.ignorarNoImport) {
        toast.success(
          resp.data.posicaoManualPendente
            ? `"${chaveExport}" marcado como ignorado — cadastre a posição manual correspondente.`
            : `"${chaveExport}" marcado como ignorado.`,
        );
      } else {
        toast.success(`"${chaveExport}" vinculado com sucesso.`);
      }
      await carregar();
    } finally {
      setSalvandoChave(null);
    }
  }

  async function executarVinculoManual(
    key: string,
    rotulo: string,
    input: VincularPosicaoManualInput,
  ) {
    setSalvandoChave(key);
    try {
      const resp = await vincularPosicaoManual(input);
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      toast.success(`"${rotulo}" vinculado com sucesso.`);
      await carregar();
    } finally {
      setSalvandoChave(null);
    }
  }

  async function handleResolverPendenteCsv(chaveExport: string) {
    const key = chaveCsv(chaveExport);
    const form = formsPendentes[key] ?? formInicial(alvos);

    if (form.modo === "fora") {
      await executarVinculoCsv(key, chaveExport, { chaveExport, foraDaCarteira: true });
      return;
    }

    if (form.modo === "reserva") {
      await executarVinculoCsv(key, chaveExport, { chaveExport, reservaEmergencia: true });
      return;
    }

    const ignorarNoImport = form.modo === "ignorar-existente" || form.modo === "ignorar-novo";

    if (form.modo === "existente" || form.modo === "ignorar-existente") {
      if (!form.alvoId) {
        toast.error("Selecione um alvo existente.");
        return;
      }
      await executarVinculoCsv(
        key,
        chaveExport,
        ignorarNoImport
          ? { chaveExport, ignorarNoImport: true, alvoId: form.alvoId }
          : { chaveExport, alvoId: form.alvoId },
      );
      return;
    }

    // modo === "novo" | "ignorar-novo"
    if (!form.novoNome.trim()) {
      toast.error("Informe o nome do novo alvo.");
      return;
    }
    let percentualBps: number;
    try {
      percentualBps = parseDecimalParaCentavos(form.novoPercentualTexto);
    } catch {
      toast.error("Percentual inválido — use um decimal (ex.: 12,5).");
      return;
    }
    if (!(percentualBps > 0)) {
      toast.error("Percentual do novo alvo deve ser maior que zero.");
      return;
    }
    await executarVinculoCsv(
      key,
      chaveExport,
      ignorarNoImport
        ? {
            chaveExport,
            ignorarNoImport: true,
            novoAlvo: { nome: form.novoNome.trim(), percentualBps },
          }
        : { chaveExport, novoAlvo: { nome: form.novoNome.trim(), percentualBps } },
    );
  }

  async function handleResolverPendenteManual(posicaoManualId: string, rotulo: string) {
    const key = chaveManualKey(posicaoManualId);
    const form = formsPendentes[key] ?? formInicial(alvos);

    if (form.modo === "fora") {
      await executarVinculoManual(key, rotulo, { posicaoManualId, foraDaCarteira: true });
      return;
    }

    if (form.modo === "reserva") {
      await executarVinculoManual(key, rotulo, { posicaoManualId, reservaEmergencia: true });
      return;
    }

    if (form.modo === "existente") {
      if (!form.alvoId) {
        toast.error("Selecione um alvo existente.");
        return;
      }
      await executarVinculoManual(key, rotulo, { posicaoManualId, alvoId: form.alvoId });
      return;
    }

    // modo === "novo"
    if (!form.novoNome.trim()) {
      toast.error("Informe o nome do novo alvo.");
      return;
    }
    let percentualBps: number;
    try {
      percentualBps = parseDecimalParaCentavos(form.novoPercentualTexto);
    } catch {
      toast.error("Percentual inválido — use um decimal (ex.: 12,5).");
      return;
    }
    if (!(percentualBps > 0)) {
      toast.error("Percentual do novo alvo deve ser maior que zero.");
      return;
    }
    await executarVinculoManual(key, rotulo, {
      posicaoManualId,
      novoAlvo: { nome: form.novoNome.trim(), percentualBps },
    });
  }

  async function handleReatribuirCsv(chaveExport: string) {
    const key = chaveCsv(chaveExport);
    const alvoId = reatribuirAlvoId[key];
    if (!alvoId) {
      toast.error("Selecione um alvo.");
      return;
    }
    await executarVinculoCsv(key, chaveExport, { chaveExport, alvoId });
  }

  async function handleReatribuirManual(posicaoManualId: string, rotulo: string) {
    const key = chaveManualKey(posicaoManualId);
    const alvoId = reatribuirAlvoId[key];
    if (!alvoId) {
      toast.error("Selecione um alvo.");
      return;
    }
    await executarVinculoManual(key, rotulo, { posicaoManualId, alvoId });
  }

  async function handleMarcarForaDaCarteiraCsv(chaveExport: string) {
    const key = chaveCsv(chaveExport);
    await executarVinculoCsv(key, chaveExport, { chaveExport, foraDaCarteira: true });
  }

  async function handleMarcarForaDaCarteiraManual(posicaoManualId: string, rotulo: string) {
    const key = chaveManualKey(posicaoManualId);
    await executarVinculoManual(key, rotulo, { posicaoManualId, foraDaCarteira: true });
  }

  // Simétrico a `handleMarcarForaDaCarteira*`, para o balde isolado "reserva
  // de emergência" — reaproveitado tanto pelas ações das seções Vinculados/
  // Fora-da-carteira quanto (indiretamente, via `handleResolverPendente*`)
  // pelo modo "reserva" de Pendentes.
  async function handleMarcarReservaEmergenciaCsv(chaveExport: string) {
    const key = chaveCsv(chaveExport);
    await executarVinculoCsv(key, chaveExport, { chaveExport, reservaEmergencia: true });
  }

  async function handleMarcarReservaEmergenciaManual(posicaoManualId: string, rotulo: string) {
    const key = chaveManualKey(posicaoManualId);
    await executarVinculoManual(key, rotulo, { posicaoManualId, reservaEmergencia: true });
  }

  // "Ignorar (substituído por posição manual)" a partir das seções
  // Vinculados/Fora da carteira (feature 002, FR-001) — mesma chamada usada
  // no modo "ignorar-existente" de Pendentes, reaproveitando o dropdown de
  // alvo que já existe na linha. Exclusivo de linhas CSV.
  async function handleIgnorar(chaveExport: string) {
    const key = chaveCsv(chaveExport);
    const alvoId = reatribuirAlvoId[key];
    if (!alvoId) {
      toast.error("Selecione um alvo.");
      return;
    }
    await executarVinculoCsv(key, chaveExport, { chaveExport, ignorarNoImport: true, alvoId });
  }

  // Linhas unificadas CSV + posição manual para as três tabelas de baixo —
  // hooks de ordenação chamados incondicionalmente (regra dos hooks), com
  // fallback `[]` enquanto os dados ainda não carregaram.
  const linhasVinculadas: LinhaVinculada[] = [
    ...(vinculos?.vinculados ?? []).map((v) => ({
      key: chaveCsv(v.chaveExport),
      rawId: v.chaveExport,
      origem: "csv" as const,
      rotulo: v.chaveExport,
      alvoId: v.alvoId,
      nomeAlvo: v.nomeAlvo,
      valorAtualCentavos: v.valorAtualCentavos,
    })),
    ...(posicoesManuais?.vinculadas ?? []).map((p) => ({
      key: chaveManualKey(p.posicaoManualId),
      rawId: p.posicaoManualId,
      origem: "manual" as const,
      rotulo: p.chaveManual,
      alvoId: p.alvoId ?? "",
      nomeAlvo: p.nomeAlvo ?? "",
      valorAtualCentavos: p.valorAtualCentavos,
    })),
  ];
  const linhasForaDaCarteira: LinhaSemAlvo[] = [
    ...(vinculos?.foraDaCarteira ?? []).map((f) => ({
      key: chaveCsv(f.chaveExport),
      rawId: f.chaveExport,
      origem: "csv" as const,
      rotulo: f.chaveExport,
      valorAtualCentavos: f.valorAtualCentavos,
    })),
    ...(posicoesManuais?.foraDaCarteira ?? []).map((p) => ({
      key: chaveManualKey(p.posicaoManualId),
      rawId: p.posicaoManualId,
      origem: "manual" as const,
      rotulo: p.chaveManual,
      valorAtualCentavos: p.valorAtualCentavos,
    })),
  ];
  const linhasReservaEmergencia: LinhaSemAlvo[] = [
    ...(vinculos?.reservaEmergencia ?? []).map((r) => ({
      key: chaveCsv(r.chaveExport),
      rawId: r.chaveExport,
      origem: "csv" as const,
      rotulo: r.chaveExport,
      valorAtualCentavos: r.valorAtualCentavos,
    })),
    ...(posicoesManuais?.reservaEmergencia ?? []).map((p) => ({
      key: chaveManualKey(p.posicaoManualId),
      rawId: p.posicaoManualId,
      origem: "manual" as const,
      rotulo: p.chaveManual,
      valorAtualCentavos: p.valorAtualCentavos,
    })),
  ];

  const vinculadosOrdenados = useSortableRows(linhasVinculadas, {
    rotulo: (v) => v.rotulo,
    valorAtualCentavos: (v) => v.valorAtualCentavos ?? -1,
    nomeAlvo: (v) => v.nomeAlvo,
  });
  const foraDaCarteiraOrdenados = useSortableRows(linhasForaDaCarteira, {
    rotulo: (f) => f.rotulo,
    valorAtualCentavos: (f) => f.valorAtualCentavos ?? -1,
  });
  const reservaEmergenciaOrdenados = useSortableRows(linhasReservaEmergencia, {
    rotulo: (r) => r.rotulo,
    valorAtualCentavos: (r) => r.valorAtualCentavos ?? -1,
  });
  const ignoradosOrdenados = useSortableRows(vinculos?.ignorados ?? [], {
    chaveExport: (i) => i.chaveExport,
    valorAtualCentavos: (i) => i.valorAtualCentavos,
    nomeAlvo: (i) => i.nomeAlvo,
  });

  if (fase === "carregando") {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <p className="text-sm text-muted-foreground">Carregando vínculos…</p>
      </div>
    );
  }

  if (fase === "erro" || !vinculos || !posicoesManuais) {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <Card>
          <CardHeader>
            <CardTitle>Não foi possível carregar os vínculos</CardTitle>
            <CardDescription>{erro}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const { pendentes, ignorados } = vinculos;
  const pendentesManuais = posicoesManuais.pendentes;
  const totalPendentes = pendentes.length + pendentesManuais.length;

  return (
    <div className="flex flex-col gap-6">
      <Cabecalho />

      <Card className={totalPendentes > 0 ? "border-amber-400/60" : undefined}>
        <CardHeader>
          <CardTitle>
            Pendentes de vínculo {totalPendentes > 0 && `(${totalPendentes})`}
          </CardTitle>
          <CardDescription>
            {totalPendentes > 0
              ? "Enquanto houver pendências, a calculadora de aporte fica bloqueada — uma pendência distorceria os déficits silenciosamente."
              : "Nenhum ativo pendente de vínculo. A calculadora de aporte está liberada."}
          </CardDescription>
        </CardHeader>
        {totalPendentes > 0 && (
          <CardContent className="flex flex-col gap-4">
            {pendentes.map((pendente) => {
              const key = chaveCsv(pendente.chaveExport);
              const form = formsPendentes[key] ?? formInicial(alvos);
              const salvando = salvandoChave === key;
              return (
                <div
                  key={key}
                  className="flex flex-col gap-3 rounded-lg border border-amber-400/40 bg-amber-400/5 p-3"
                >
                  <p className="font-medium">
                    {pendente.chaveExport}{" "}
                    <span className="font-normal text-muted-foreground">
                      — {formatCentavosParaReais(pendente.valorAtualCentavos)}
                    </span>
                  </p>

                  <div className="flex flex-wrap items-end gap-3">
                    <Field className="w-auto">
                      <FieldLabel htmlFor={`modo-${key}`}>Resolução</FieldLabel>
                      <select
                        id={`modo-${key}`}
                        className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                        value={form.modo}
                        onChange={(e) =>
                          atualizarFormPendente(key, {
                            modo: e.target.value as ModoResolucao,
                          })
                        }
                      >
                        <option value="existente">Vincular a alvo existente</option>
                        <option value="novo">Criar novo alvo</option>
                        <option value="fora">Marcar fora da carteira</option>
                        <option value="reserva">Marcar como reserva de emergência</option>
                        <option value="ignorar-existente">
                          Ignorar (substituído por posição manual) — alvo existente
                        </option>
                        <option value="ignorar-novo">
                          Ignorar (substituído por posição manual) — criar alvo
                        </option>
                      </select>
                    </Field>

                    {(form.modo === "existente" || form.modo === "ignorar-existente") && (
                      <Field className="w-auto">
                        <FieldLabel htmlFor={`alvo-${key}`}>Alvo</FieldLabel>
                        <select
                          id={`alvo-${key}`}
                          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                          value={form.alvoId}
                          onChange={(e) =>
                            atualizarFormPendente(key, { alvoId: e.target.value })
                          }
                        >
                          {alvos.length === 0 && <option value="">Nenhum alvo cadastrado</option>}
                          {alvos.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.nome} ({formatBps(a.percentualAlvoBps)})
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}

                    {(form.modo === "novo" || form.modo === "ignorar-novo") && (
                      <>
                        <Field className="w-auto">
                          <FieldLabel htmlFor={`nome-${key}`}>
                            Nome do alvo
                          </FieldLabel>
                          <Input
                            id={`nome-${key}`}
                            className="w-40"
                            value={form.novoNome}
                            onChange={(e) =>
                              atualizarFormPendente(key, {
                                novoNome: e.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field className="w-auto">
                          <FieldLabel htmlFor={`percentual-${key}`}>
                            Percentual (%)
                          </FieldLabel>
                          <Input
                            id={`percentual-${key}`}
                            className="w-24"
                            inputMode="decimal"
                            placeholder="12,5"
                            value={form.novoPercentualTexto}
                            onChange={(e) =>
                              atualizarFormPendente(key, {
                                novoPercentualTexto: e.target.value,
                              })
                            }
                          />
                        </Field>
                      </>
                    )}

                    <Button
                      size="sm"
                      disabled={salvando}
                      onClick={() => void handleResolverPendenteCsv(pendente.chaveExport)}
                    >
                      {salvando ? "Salvando…" : "Confirmar"}
                    </Button>
                  </div>
                  {(form.modo === "ignorar-existente" || form.modo === "ignorar-novo") && (
                    <p className="text-xs text-muted-foreground">{AVISO_IGNORAR}</p>
                  )}
                </div>
              );
            })}

            {pendentesManuais.map((pendente) => {
              const key = chaveManualKey(pendente.posicaoManualId);
              const form = formsPendentes[key] ?? formInicial(alvos);
              const salvando = salvandoChave === key;
              return (
                <div
                  key={key}
                  className="flex flex-col gap-3 rounded-lg border border-amber-400/40 bg-amber-400/5 p-3"
                >
                  <p className="font-medium">
                    {pendente.chaveManual}
                    <BadgeManual />{" "}
                    <span className="font-normal text-muted-foreground">
                      — {pendente.descricao} ({pendente.instituicao}) —{" "}
                      {pendente.valorAtualCentavos !== null
                        ? formatCentavosParaReais(pendente.valorAtualCentavos)
                        : "—"}
                    </span>
                  </p>

                  <div className="flex flex-wrap items-end gap-3">
                    <Field className="w-auto">
                      <FieldLabel htmlFor={`modo-${key}`}>Resolução</FieldLabel>
                      <select
                        id={`modo-${key}`}
                        className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                        value={form.modo}
                        onChange={(e) =>
                          atualizarFormPendente(key, {
                            modo: e.target.value as ModoResolucao,
                          })
                        }
                      >
                        <option value="existente">Vincular a alvo existente</option>
                        <option value="novo">Criar novo alvo</option>
                        <option value="fora">Marcar fora da carteira</option>
                        <option value="reserva">Marcar como reserva de emergência</option>
                      </select>
                    </Field>

                    {form.modo === "existente" && (
                      <Field className="w-auto">
                        <FieldLabel htmlFor={`alvo-${key}`}>Alvo</FieldLabel>
                        <select
                          id={`alvo-${key}`}
                          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                          value={form.alvoId}
                          onChange={(e) =>
                            atualizarFormPendente(key, { alvoId: e.target.value })
                          }
                        >
                          {alvos.length === 0 && <option value="">Nenhum alvo cadastrado</option>}
                          {alvos.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.nome} ({formatBps(a.percentualAlvoBps)})
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}

                    {form.modo === "novo" && (
                      <>
                        <Field className="w-auto">
                          <FieldLabel htmlFor={`nome-${key}`}>Nome do alvo</FieldLabel>
                          <Input
                            id={`nome-${key}`}
                            className="w-40"
                            value={form.novoNome}
                            onChange={(e) =>
                              atualizarFormPendente(key, {
                                novoNome: e.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field className="w-auto">
                          <FieldLabel htmlFor={`percentual-${key}`}>Percentual (%)</FieldLabel>
                          <Input
                            id={`percentual-${key}`}
                            className="w-24"
                            inputMode="decimal"
                            placeholder="12,5"
                            value={form.novoPercentualTexto}
                            onChange={(e) =>
                              atualizarFormPendente(key, {
                                novoPercentualTexto: e.target.value,
                              })
                            }
                          />
                        </Field>
                      </>
                    )}

                    <Button
                      size="sm"
                      disabled={salvando}
                      onClick={() =>
                        void handleResolverPendenteManual(
                          pendente.posicaoManualId,
                          pendente.chaveManual,
                        )
                      }
                    >
                      {salvando ? "Salvando…" : "Confirmar"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Vinculados {linhasVinculadas.length > 0 && `(${linhasVinculadas.length})`}
          </CardTitle>
          <CardDescription>
            Ativos já vinculados a um alvo. Revise ou corrija o vínculo se necessário.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {linhasVinculadas.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum ativo vinculado ainda.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead
                    sortDirection={vinculadosOrdenados.sortDirectionFor("rotulo")}
                    onSort={() => vinculadosOrdenados.toggleSort("rotulo")}
                  >
                    Ativo
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={vinculadosOrdenados.sortDirectionFor("valorAtualCentavos")}
                    onSort={() => vinculadosOrdenados.toggleSort("valorAtualCentavos")}
                  >
                    Valor atual
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={vinculadosOrdenados.sortDirectionFor("nomeAlvo")}
                    onSort={() => vinculadosOrdenados.toggleSort("nomeAlvo")}
                  >
                    Alvo atual
                  </SortableTableHead>
                  <TableHead>Reatribuir para</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vinculadosOrdenados.sortedRows.map((v) => {
                  const salvando = salvandoChave === v.key;
                  return (
                    <TableRow key={v.key}>
                      <TableCell className="max-w-48 whitespace-normal break-words">
                        {v.rotulo}
                        {v.origem === "manual" && <BadgeManual />}
                      </TableCell>
                      <TableCell>
                        {v.valorAtualCentavos !== null
                          ? formatCentavosParaReais(v.valorAtualCentavos)
                          : "—"}
                      </TableCell>
                      <TableCell>{v.nomeAlvo}</TableCell>
                      <TableCell>
                        <select
                          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                          value={reatribuirAlvoId[v.key] ?? v.alvoId}
                          onChange={(e) =>
                            setReatribuirAlvoId((prev) => ({
                              ...prev,
                              [v.key]: e.target.value,
                            }))
                          }
                        >
                          {alvos.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.nome}
                            </option>
                          ))}
                        </select>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={salvando}
                            onClick={() =>
                              void (v.origem === "csv"
                                ? handleReatribuirCsv(v.rawId)
                                : handleReatribuirManual(v.rawId, v.rotulo))
                            }
                          >
                            Salvar
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={salvando}
                            onClick={() =>
                              void (v.origem === "csv"
                                ? handleMarcarForaDaCarteiraCsv(v.rawId)
                                : handleMarcarForaDaCarteiraManual(v.rawId, v.rotulo))
                            }
                          >
                            Marcar fora da carteira
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={salvando}
                            onClick={() =>
                              void (v.origem === "csv"
                                ? handleMarcarReservaEmergenciaCsv(v.rawId)
                                : handleMarcarReservaEmergenciaManual(v.rawId, v.rotulo))
                            }
                          >
                            Marcar reserva de emergência
                          </Button>
                          {v.origem === "csv" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={salvando || alvos.length === 0}
                              title={AVISO_IGNORAR}
                              onClick={() => void handleIgnorar(v.rawId)}
                            >
                              Ignorar (substituído por posição manual)
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Fora da carteira alvo{" "}
            {linhasForaDaCarteira.length > 0 && `(${linhasForaDaCarteira.length})`}
          </CardTitle>
          <CardDescription>
            Ativos legados reconhecidos mas que não participam dos cálculos nem recebem
            aporte.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {linhasForaDaCarteira.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum ativo marcado como fora da carteira.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead
                    sortDirection={foraDaCarteiraOrdenados.sortDirectionFor("rotulo")}
                    onSort={() => foraDaCarteiraOrdenados.toggleSort("rotulo")}
                  >
                    Ativo
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={foraDaCarteiraOrdenados.sortDirectionFor("valorAtualCentavos")}
                    onSort={() => foraDaCarteiraOrdenados.toggleSort("valorAtualCentavos")}
                  >
                    Valor atual
                  </SortableTableHead>
                  <TableHead>Vincular a</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {foraDaCarteiraOrdenados.sortedRows.map((f) => {
                  const salvando = salvandoChave === f.key;
                  return (
                    <TableRow key={f.key}>
                      <TableCell className="max-w-48 whitespace-normal break-words">
                        {f.rotulo}
                        {f.origem === "manual" && <BadgeManual />}
                      </TableCell>
                      <TableCell>
                        {f.valorAtualCentavos !== null
                          ? formatCentavosParaReais(f.valorAtualCentavos)
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <select
                          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                          value={reatribuirAlvoId[f.key] ?? alvos[0]?.id ?? ""}
                          onChange={(e) =>
                            setReatribuirAlvoId((prev) => ({
                              ...prev,
                              [f.key]: e.target.value,
                            }))
                          }
                        >
                          {alvos.length === 0 && <option value="">Nenhum alvo cadastrado</option>}
                          {alvos.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.nome}
                            </option>
                          ))}
                        </select>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={salvando || alvos.length === 0}
                            onClick={() =>
                              void (f.origem === "csv"
                                ? handleReatribuirCsv(f.rawId)
                                : handleReatribuirManual(f.rawId, f.rotulo))
                            }
                          >
                            Vincular
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={salvando}
                            onClick={() =>
                              void (f.origem === "csv"
                                ? handleMarcarReservaEmergenciaCsv(f.rawId)
                                : handleMarcarReservaEmergenciaManual(f.rawId, f.rotulo))
                            }
                          >
                            Marcar reserva de emergência
                          </Button>
                          {f.origem === "csv" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={salvando || alvos.length === 0}
                              title={AVISO_IGNORAR}
                              onClick={() => void handleIgnorar(f.rawId)}
                            >
                              Ignorar (substituído por posição manual)
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Reserva de emergência{" "}
            {linhasReservaEmergencia.length > 0 && `(${linhasReservaEmergencia.length})`}
          </CardTitle>
          <CardDescription>
            Ativos reconhecidos do export, mas isolados tanto da carteira alvo quanto do
            balde &quot;Fora da carteira alvo&quot; — não entram nos déficits, na alocação
            nem no aporte.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {linhasReservaEmergencia.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum ativo marcado como reserva de emergência.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead
                    sortDirection={reservaEmergenciaOrdenados.sortDirectionFor("rotulo")}
                    onSort={() => reservaEmergenciaOrdenados.toggleSort("rotulo")}
                  >
                    Ativo
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={reservaEmergenciaOrdenados.sortDirectionFor(
                      "valorAtualCentavos",
                    )}
                    onSort={() => reservaEmergenciaOrdenados.toggleSort("valorAtualCentavos")}
                  >
                    Valor atual
                  </SortableTableHead>
                  <TableHead>Vincular a</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reservaEmergenciaOrdenados.sortedRows.map((r) => {
                  const salvando = salvandoChave === r.key;
                  return (
                    <TableRow key={r.key}>
                      <TableCell className="max-w-48 whitespace-normal break-words">
                        {r.rotulo}
                        {r.origem === "manual" && <BadgeManual />}
                      </TableCell>
                      <TableCell>
                        {r.valorAtualCentavos !== null
                          ? formatCentavosParaReais(r.valorAtualCentavos)
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <select
                          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                          value={reatribuirAlvoId[r.key] ?? alvos[0]?.id ?? ""}
                          onChange={(e) =>
                            setReatribuirAlvoId((prev) => ({
                              ...prev,
                              [r.key]: e.target.value,
                            }))
                          }
                        >
                          {alvos.length === 0 && <option value="">Nenhum alvo cadastrado</option>}
                          {alvos.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.nome}
                            </option>
                          ))}
                        </select>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={salvando || alvos.length === 0}
                            onClick={() =>
                              void (r.origem === "csv"
                                ? handleReatribuirCsv(r.rawId)
                                : handleReatribuirManual(r.rawId, r.rotulo))
                            }
                          >
                            Vincular
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={salvando}
                            onClick={() =>
                              void (r.origem === "csv"
                                ? handleMarcarForaDaCarteiraCsv(r.rawId)
                                : handleMarcarForaDaCarteiraManual(r.rawId, r.rotulo))
                            }
                          >
                            Marcar fora da carteira
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ignorados {ignorados.length > 0 && `(${ignorados.length})`}</CardTitle>
          <CardDescription>
            Ativos lidos do export mas substituídos por uma posição manual — o valor abaixo é
            só referência do CSV, não usado no cálculo (o motor usa a posição manual).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ignorados.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum ativo marcado como ignorado.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead
                    sortDirection={ignoradosOrdenados.sortDirectionFor("chaveExport")}
                    onSort={() => ignoradosOrdenados.toggleSort("chaveExport")}
                  >
                    Chave do export
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={ignoradosOrdenados.sortDirectionFor("valorAtualCentavos")}
                    onSort={() => ignoradosOrdenados.toggleSort("valorAtualCentavos")}
                  >
                    Valor no CSV (não usado no cálculo)
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={ignoradosOrdenados.sortDirectionFor("nomeAlvo")}
                    onSort={() => ignoradosOrdenados.toggleSort("nomeAlvo")}
                  >
                    Alvo
                  </SortableTableHead>
                  <TableHead>Posição manual</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ignoradosOrdenados.sortedRows.map((i) => (
                  <TableRow key={i.chaveExport}>
                    <TableCell className="max-w-48 whitespace-normal break-words">
                      {i.chaveExport}
                    </TableCell>
                    <TableCell>{formatCentavosParaReais(i.valorAtualCentavos)}</TableCell>
                    <TableCell>{i.nomeAlvo}</TableCell>
                    <TableCell>
                      {i.posicaoManualPendente ? (
                        <Button
                          size="sm"
                          variant="outline"
                          render={
                            <Link
                              href={`/posicoes-manuais?alvoId=${encodeURIComponent(i.alvoId)}&descricaoSugerida=${encodeURIComponent(i.chaveExport)}`}
                            />
                          }
                        >
                          + Cadastrar posição manual
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground">Já cadastrada</span>
                      )}
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
      <h1 className="text-2xl font-heading font-semibold tracking-tight">Vínculo de ativos</h1>
      <p className="text-sm text-muted-foreground">
        Cada ativo do export ou posição manual precisa apontar para um alvo da carteira, ou
        ser marcado como fora da carteira ou reserva de emergência, antes de calcular o
        aporte.
      </p>
    </div>
  );
}
