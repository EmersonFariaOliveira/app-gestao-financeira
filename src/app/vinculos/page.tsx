"use client";

/**
 * src/app/vinculos/page.tsx — Vínculo de ativos (tela 6.3,
 * docs/app-gestao-aportes.md seção 6.3).
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * reimplementa a regra de exclusão mútua alvo/fora-da-carteira — ela apenas
 * chama `src/app/actions/vinculos.ts` (que delega a
 * `src/services/mapeamento-service.ts`/`alvo-service.ts`) e exibe o
 * resultado.
 *
 * Conteúdo (seção 6.3):
 * 1. Pendentes em destaque — chave do export → dropdown de alvo existente,
 *    criar alvo novo na hora, ou marcar "Fora da carteira alvo". É o que
 *    bloqueia a calculadora (FR-015/seção 6.5).
 * 2. Vinculados e Fora-da-carteira, também nesta tela, para revisão/
 *    correção (a tela serve tanto para resolver pendências quanto para
 *    editar vínculos existentes).
 *
 * Percentual do alvo novo: o campo aceita o mesmo formato decimal usado em
 * toda a UI ("12,5" = 12,5%). Como `percentual_alvo_bps` já usa a mesma
 * convenção de 2 casas de `src/core/money` (1% = 100 bps, exatamente como 1
 * real = 100 centavos), reaproveitamos `parseDecimalParaCentavos` para essa
 * conversão sem nenhuma lógica nova — "12,5" → 1250, que é exatamente 1250
 * bps.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBps, formatCentavosParaReais, parseDecimalParaCentavos } from "@/core/money";
import type { ListarVinculosOutput, VincularAtivoInput } from "@/services/mapeamento-service";

type Fase = "carregando" | "erro" | "pronto";

type ModoResolucao = "existente" | "novo" | "fora";

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

export default function VinculosPage() {
  const [fase, setFase] = useState<Fase>("carregando");
  const [erro, setErro] = useState<string | null>(null);
  const [vinculos, setVinculos] = useState<ListarVinculosOutput | null>(null);
  const [alvos, setAlvos] = useState<AlvoParaDropdown[]>([]);

  const [formsPendentes, setFormsPendentes] = useState<Record<string, FormPendente>>({});
  const [salvandoChave, setSalvandoChave] = useState<string | null>(null);

  // Formulários de reatribuição das linhas já resolvidas (vinculados/fora).
  const [reatribuirAlvoId, setReatribuirAlvoId] = useState<Record<string, string>>({});

  const carregar = useCallback(async () => {
    const [respVinculos, respAlvos] = await Promise.all([
      listarVinculos(),
      listarAlvosParaDropdown(),
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

    setVinculos(respVinculos.data);
    setAlvos(respAlvos.data);
    setFormsPendentes((prev) => {
      const novo: Record<string, FormPendente> = {};
      for (const pendente of respVinculos.data.pendentes) {
        novo[pendente.chaveExport] = prev[pendente.chaveExport] ?? formInicial(respAlvos.data);
      }
      return novo;
    });
    setReatribuirAlvoId((prev) => {
      const novo: Record<string, string> = { ...prev };
      for (const v of respVinculos.data.vinculados) {
        if (!novo[v.chaveExport]) novo[v.chaveExport] = v.alvoId;
      }
      for (const f of respVinculos.data.foraDaCarteira) {
        if (!novo[f.chaveExport]) novo[f.chaveExport] = respAlvos.data[0]?.id ?? "";
      }
      return novo;
    });
    setFase("pronto");
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function atualizarFormPendente(chave: string, patch: Partial<FormPendente>) {
    setFormsPendentes((prev) => ({
      ...prev,
      [chave]: { ...(prev[chave] ?? formInicial(alvos)), ...patch },
    }));
  }

  async function executarVinculo(chaveExport: string, input: VincularAtivoInput) {
    setSalvandoChave(chaveExport);
    try {
      const resp = await vincularAtivo(input);
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      toast.success(`"${chaveExport}" vinculado com sucesso.`);
      await carregar();
    } finally {
      setSalvandoChave(null);
    }
  }

  async function handleResolverPendente(chaveExport: string) {
    const form = formsPendentes[chaveExport] ?? formInicial(alvos);

    if (form.modo === "fora") {
      await executarVinculo(chaveExport, { chaveExport, foraDaCarteira: true });
      return;
    }

    if (form.modo === "existente") {
      if (!form.alvoId) {
        toast.error("Selecione um alvo existente.");
        return;
      }
      await executarVinculo(chaveExport, { chaveExport, alvoId: form.alvoId });
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
    await executarVinculo(chaveExport, {
      chaveExport,
      novoAlvo: { nome: form.novoNome.trim(), percentualBps },
    });
  }

  async function handleReatribuir(chaveExport: string) {
    const alvoId = reatribuirAlvoId[chaveExport];
    if (!alvoId) {
      toast.error("Selecione um alvo.");
      return;
    }
    await executarVinculo(chaveExport, { chaveExport, alvoId });
  }

  async function handleMarcarForaDaCarteira(chaveExport: string) {
    await executarVinculo(chaveExport, { chaveExport, foraDaCarteira: true });
  }

  if (fase === "carregando") {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <p className="text-sm text-muted-foreground">Carregando vínculos…</p>
      </div>
    );
  }

  if (fase === "erro" || !vinculos) {
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

  const { pendentes, vinculados, foraDaCarteira } = vinculos;

  return (
    <div className="flex flex-col gap-6">
      <Cabecalho />

      <Card className={pendentes.length > 0 ? "border-amber-400/60" : undefined}>
        <CardHeader>
          <CardTitle>
            Pendentes de vínculo {pendentes.length > 0 && `(${pendentes.length})`}
          </CardTitle>
          <CardDescription>
            {pendentes.length > 0
              ? "Enquanto houver pendências, a calculadora de aporte fica bloqueada — uma pendência distorceria os déficits silenciosamente."
              : "Nenhum ativo pendente de vínculo. A calculadora de aporte está liberada."}
          </CardDescription>
        </CardHeader>
        {pendentes.length > 0 && (
          <CardContent className="flex flex-col gap-4">
            {pendentes.map((pendente) => {
              const form = formsPendentes[pendente.chaveExport] ?? formInicial(alvos);
              const salvando = salvandoChave === pendente.chaveExport;
              return (
                <div
                  key={pendente.chaveExport}
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
                      <FieldLabel htmlFor={`modo-${pendente.chaveExport}`}>Resolução</FieldLabel>
                      <select
                        id={`modo-${pendente.chaveExport}`}
                        className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                        value={form.modo}
                        onChange={(e) =>
                          atualizarFormPendente(pendente.chaveExport, {
                            modo: e.target.value as ModoResolucao,
                          })
                        }
                      >
                        <option value="existente">Vincular a alvo existente</option>
                        <option value="novo">Criar novo alvo</option>
                        <option value="fora">Marcar fora da carteira</option>
                      </select>
                    </Field>

                    {form.modo === "existente" && (
                      <Field className="w-auto">
                        <FieldLabel htmlFor={`alvo-${pendente.chaveExport}`}>Alvo</FieldLabel>
                        <select
                          id={`alvo-${pendente.chaveExport}`}
                          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                          value={form.alvoId}
                          onChange={(e) =>
                            atualizarFormPendente(pendente.chaveExport, { alvoId: e.target.value })
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
                          <FieldLabel htmlFor={`nome-${pendente.chaveExport}`}>
                            Nome do alvo
                          </FieldLabel>
                          <Input
                            id={`nome-${pendente.chaveExport}`}
                            className="w-40"
                            value={form.novoNome}
                            onChange={(e) =>
                              atualizarFormPendente(pendente.chaveExport, {
                                novoNome: e.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field className="w-auto">
                          <FieldLabel htmlFor={`percentual-${pendente.chaveExport}`}>
                            Percentual (%)
                          </FieldLabel>
                          <Input
                            id={`percentual-${pendente.chaveExport}`}
                            className="w-24"
                            inputMode="decimal"
                            placeholder="12,5"
                            value={form.novoPercentualTexto}
                            onChange={(e) =>
                              atualizarFormPendente(pendente.chaveExport, {
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
                      onClick={() => void handleResolverPendente(pendente.chaveExport)}
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
          <CardTitle>Vinculados {vinculados.length > 0 && `(${vinculados.length})`}</CardTitle>
          <CardDescription>
            Ativos já vinculados a um alvo. Revise ou corrija o vínculo se necessário.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {vinculados.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum ativo vinculado ainda.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chave do export</TableHead>
                  <TableHead>Valor atual</TableHead>
                  <TableHead>Alvo atual</TableHead>
                  <TableHead>Reatribuir para</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vinculados.map((v) => {
                  const salvando = salvandoChave === v.chaveExport;
                  return (
                    <TableRow key={v.chaveExport}>
                      <TableCell>{v.chaveExport}</TableCell>
                      <TableCell>{formatCentavosParaReais(v.valorAtualCentavos)}</TableCell>
                      <TableCell>{v.nomeAlvo}</TableCell>
                      <TableCell>
                        <select
                          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                          value={reatribuirAlvoId[v.chaveExport] ?? v.alvoId}
                          onChange={(e) =>
                            setReatribuirAlvoId((prev) => ({
                              ...prev,
                              [v.chaveExport]: e.target.value,
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
                            onClick={() => void handleReatribuir(v.chaveExport)}
                          >
                            Salvar
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={salvando}
                            onClick={() => void handleMarcarForaDaCarteira(v.chaveExport)}
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
          <CardTitle>
            Fora da carteira alvo {foraDaCarteira.length > 0 && `(${foraDaCarteira.length})`}
          </CardTitle>
          <CardDescription>
            Ativos legados reconhecidos mas que não participam dos cálculos nem recebem
            aporte.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {foraDaCarteira.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum ativo marcado como fora da carteira.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chave do export</TableHead>
                  <TableHead>Valor atual</TableHead>
                  <TableHead>Vincular a</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {foraDaCarteira.map((f) => {
                  const salvando = salvandoChave === f.chaveExport;
                  return (
                    <TableRow key={f.chaveExport}>
                      <TableCell>{f.chaveExport}</TableCell>
                      <TableCell>{formatCentavosParaReais(f.valorAtualCentavos)}</TableCell>
                      <TableCell>
                        <select
                          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                          value={reatribuirAlvoId[f.chaveExport] ?? alvos[0]?.id ?? ""}
                          onChange={(e) =>
                            setReatribuirAlvoId((prev) => ({
                              ...prev,
                              [f.chaveExport]: e.target.value,
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
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={salvando || alvos.length === 0}
                          onClick={() => void handleReatribuir(f.chaveExport)}
                        >
                          Vincular
                        </Button>
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
      <h1 className="text-2xl font-heading font-semibold tracking-tight">Vínculo de ativos</h1>
      <p className="text-sm text-muted-foreground">
        Cada ativo do export precisa apontar para um alvo da carteira (ou ser marcado como
        fora da carteira) antes de calcular o aporte.
      </p>
    </div>
  );
}
