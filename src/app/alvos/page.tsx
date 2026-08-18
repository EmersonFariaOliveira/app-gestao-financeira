"use client";

/**
 * src/app/alvos/page.tsx — Carteira alvo (tela 6.4,
 * docs/app-gestao-aportes.md seção 6.4).
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * reimplementa CRUD/validação/versionamento — ela apenas chama
 * `src/app/actions/alvos.ts` (que delega a `src/services/alvo-service.ts`) e
 * exibe o resultado. Toda formatação de percentual usa `formatBps`
 * (src/core/money) na borda de exibição; os valores trafegam em bps
 * (1/100 de p.p.) em todo o restante do fluxo.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  listarAlvos,
  listarTagsExistentes,
  novaVigencia,
  removerAlvo,
  salvarAlvo,
  type SalvarAlvoInput,
} from "@/app/actions/alvos";
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
import { TagBadge } from "@/components/ui/tag-badge";
import { formatBps, parseDecimalParaCentavos } from "@/core/money";
import { useSortableRows } from "@/hooks/use-sortable-rows";
import type { AlvoComContagemDto, ListarAlvosOutput } from "@/services/alvo-service";

/**
 * Converte o texto digitado no campo de percentual ("12,5%", "12.5", "12,50")
 * para bps (1/100 de p.p., research.md R4: `10000 bps === 100%`).
 *
 * Reaproveita `parseDecimalParaCentavos` (src/core/money): a conversão de um
 * decimal digitado para um inteiro de "centésimos" é matematicamente idêntica
 * para reais→centavos e para percentual→bps (ambos "valor × 100, truncado a 2
 * casas") — não há aqui nenhuma regra de negócio nova, só reuso do parser de
 * decimal já existente após remover um eventual sufixo "%". Documentado aqui
 * porque `@/core/money` não expõe um helper com o nome "bps" para este caso.
 */
function parsePercentualParaBps(texto: string): number {
  const semSufixo = texto.trim().replace(/%\s*$/, "");
  return parseDecimalParaCentavos(semSufixo);
}

/** Inverso de `parsePercentualParaBps`, para popular o campo de edição (sem o sufixo "%"). */
function bpsParaTextoEditavel(bps: number): string {
  const negativo = bps < 0;
  const abs = Math.abs(bps);
  const parteInteira = Math.trunc(abs / 100);
  const parteDecimal = abs % 100;
  return `${negativo ? "-" : ""}${parteInteira},${String(parteDecimal).padStart(2, "0")}`;
}

type FaseCarregamento = "carregando" | "erro" | "pronto";

export default function AlvosPage() {
  const [fase, setFase] = useState<FaseCarregamento>("carregando");
  const [erroCarregamento, setErroCarregamento] = useState<string | null>(null);
  const [dados, setDados] = useState<ListarAlvosOutput | null>(null);

  // Formulário de criação/edição (T048): `editandoId` null = criando um alvo novo.
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [nomeTexto, setNomeTexto] = useState("");
  const [percentualTexto, setPercentualTexto] = useState("");
  const [tagTexto, setTagTexto] = useState("");
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // Sugestões de tag para o autocomplete do campo "Tag" — tags já usadas em
  // qualquer alvo/vigência (ver src/services/alvo-service.ts
  // listarTagsExistentes). Campo livre: a lista é só sugestão, nunca
  // restringe o que o usuário pode digitar.
  const [tagsSugeridas, setTagsSugeridas] = useState<string[]>([]);

  // Confirmação de remoção (a remoção é soft-delete, mas afeta a soma e pode
  // deixar ativos vinculados "órfãos" de vigência — vale confirmar).
  const [alvoParaRemover, setAlvoParaRemover] = useState<AlvoComContagemDto | null>(null);
  const [removendo, setRemovendo] = useState(false);

  // Confirmação de nova vigência (fecha a vigência atual — ação irreversível
  // no sentido de que os alvos atuais passam a ser somente-leitura).
  const [dialogVigenciaAberto, setDialogVigenciaAberto] = useState(false);
  const [processandoVigencia, setProcessandoVigencia] = useState(false);

  // Hook chamado incondicionalmente (regra dos hooks), com fallback `[]`
  // antes de `dados` carregar. "Ações" fica de fora por não ter valor
  // estável de ordenação.
  const alvosOrdenados = useSortableRows(dados?.alvos ?? [], {
    nome: (a) => a.nome,
    percentualAlvoBps: (a) => a.percentualAlvoBps,
    tag: (a) => a.tag ?? "",
    qtdAtivosMapeados: (a) => a.qtdAtivosMapeados,
  });

  const carregar = useCallback(async () => {
    const [respAlvos, respTags] = await Promise.all([listarAlvos(), listarTagsExistentes()]);
    if (!respAlvos.ok) {
      setErroCarregamento(respAlvos.erro);
      setFase("erro");
      return;
    }
    setDados(respAlvos.data);
    // Falha ao buscar sugestões não impede o uso da tela — o campo de tag
    // continua livre, só sem autocomplete.
    if (respTags.ok) {
      setTagsSugeridas(respTags.data);
    }
    setFase("pronto");
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function limparFormulario() {
    setEditandoId(null);
    setNomeTexto("");
    setPercentualTexto("");
    setTagTexto("");
    setErroForm(null);
  }

  function handleEditar(alvo: AlvoComContagemDto) {
    setEditandoId(alvo.id);
    setNomeTexto(alvo.nome);
    setPercentualTexto(bpsParaTextoEditavel(alvo.percentualAlvoBps));
    setTagTexto(alvo.tag ?? "");
    setErroForm(null);
  }

  async function handleSalvar() {
    if (!nomeTexto.trim()) {
      setErroForm("Informe o nome do alvo.");
      return;
    }

    let percentualAlvoBps: number;
    try {
      percentualAlvoBps = parsePercentualParaBps(percentualTexto);
    } catch {
      setErroForm('Percentual inválido — use um decimal (ex.: "12,5" ou "12,5%").');
      return;
    }
    if (percentualAlvoBps <= 0) {
      setErroForm("O percentual do alvo deve ser maior que zero.");
      return;
    }

    const input: SalvarAlvoInput = {
      id: editandoId ?? undefined,
      nome: nomeTexto.trim(),
      percentualAlvoBps,
      tag: tagTexto.trim(),
    };

    setSalvando(true);
    setErroForm(null);
    try {
      const resp = await salvarAlvo(input);
      if (!resp.ok) {
        setErroForm(resp.erro);
        return;
      }
      setDados(resp.data);
      // Mantém o autocomplete atualizado com uma tag recém-criada, sem
      // precisar de uma nova ida ao servidor (só sugestão local; a fonte da
      // verdade continua sendo `listarTagsExistentes` no próximo `carregar`).
      const tagSalva = tagTexto.trim();
      if (tagSalva && !tagsSugeridas.includes(tagSalva)) {
        setTagsSugeridas([...tagsSugeridas, tagSalva].sort((a, b) => a.localeCompare(b)));
      }
      toast.success(editandoId ? "Alvo atualizado." : "Alvo criado.");
      limparFormulario();
    } finally {
      setSalvando(false);
    }
  }

  async function handleConfirmarRemover() {
    if (!alvoParaRemover) return;
    setRemovendo(true);
    try {
      const resp = await removerAlvo({ alvoId: alvoParaRemover.id });
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      setDados(resp.data);
      toast.success(`Alvo "${alvoParaRemover.nome}" removido.`);
      if (editandoId === alvoParaRemover.id) {
        limparFormulario();
      }
      setAlvoParaRemover(null);
    } finally {
      setRemovendo(false);
    }
  }

  async function handleConfirmarNovaVigencia() {
    setProcessandoVigencia(true);
    try {
      const resp = await novaVigencia();
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      setDados(resp.data);
      limparFormulario();
      toast.success(
        `Nova vigência aberta com ${resp.data.alvos.length} alvo(s) clonado(s) — a vigência anterior fica preservada no histórico.`,
      );
      setDialogVigenciaAberto(false);
    } finally {
      setProcessandoVigencia(false);
    }
  }

  if (fase === "carregando") {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <p className="text-sm text-muted-foreground">Carregando alvos…</p>
      </div>
    );
  }

  if (fase === "erro" || !dados) {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <Card>
          <CardHeader>
            <CardTitle>Não foi possível carregar os alvos</CardTitle>
            <CardDescription>{erroCarregamento}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const diferencaBps = 10000 - dados.somaBps;

  return (
    <div className="flex flex-col gap-6">
      <Cabecalho />

      <Card>
        <CardHeader>
          <CardTitle>Soma dos percentuais vigentes</CardTitle>
          <CardDescription>
            A soma dos alvos vigentes deve fechar em 100% (com tolerância de arredondamento).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p
            className={
              dados.somaValida
                ? "text-lg font-semibold text-emerald-600 dark:text-emerald-400"
                : "text-lg font-semibold text-destructive"
            }
          >
            {formatBps(dados.somaBps)} {dados.somaValida ? "— OK" : "— fora do esperado"}
          </p>
          {!dados.somaValida && (
            <p className="mt-1 text-sm text-muted-foreground">
              {diferencaBps > 0
                ? `Faltam ${formatBps(diferencaBps)} para completar 100%.`
                : `Excede em ${formatBps(Math.abs(diferencaBps))} os 100%.`}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{editandoId ? "Editar alvo" : "Novo alvo"}</CardTitle>
          <CardDescription>
            Nome e percentual do alvo. Só é possível criar/editar alvos da vigência aberta.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <Field className="sm:max-w-xs">
            <FieldLabel htmlFor="alvo-nome">Nome</FieldLabel>
            <Input
              id="alvo-nome"
              placeholder="ex.: WRLD11, Pós-fixado"
              value={nomeTexto}
              onChange={(e) => setNomeTexto(e.target.value)}
            />
          </Field>
          <Field className="sm:max-w-40">
            <FieldLabel htmlFor="alvo-percentual">Percentual alvo</FieldLabel>
            <Input
              id="alvo-percentual"
              inputMode="decimal"
              placeholder="12,50%"
              value={percentualTexto}
              onChange={(e) => setPercentualTexto(e.target.value)}
            />
          </Field>
          <Field className="sm:max-w-52">
            <FieldLabel htmlFor="alvo-tag">Tag</FieldLabel>
            <Input
              id="alvo-tag"
              list="alvo-tags-sugeridas"
              placeholder="ex.: A-AÇÕES, R-REAL ESTATE"
              value={tagTexto}
              onChange={(e) => setTagTexto(e.target.value)}
            />
            {/* Campo livre: `datalist` só sugere as tags já usadas (ver
                `listarTagsExistentes`), nunca restringe o valor digitado. */}
            <datalist id="alvo-tags-sugeridas">
              {tagsSugeridas.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            {/* Preview do pill enquanto digita — mesma cor que a tag terá em
                qualquer outro lugar do app (`corParaTag` é determinística). */}
            {tagTexto.trim() && (
              <div className="pt-1">
                <TagBadge tag={tagTexto.trim()} />
              </div>
            )}
          </Field>
          <div className="flex gap-2">
            <Button onClick={() => void handleSalvar()} disabled={salvando}>
              {salvando ? "Salvando…" : editandoId ? "Salvar edição" : "Criar alvo"}
            </Button>
            {editandoId && (
              <Button variant="outline" onClick={limparFormulario} disabled={salvando}>
                Cancelar
              </Button>
            )}
          </div>
        </CardContent>
        {erroForm && (
          <CardContent className="pt-0">
            <FieldError>{erroForm}</FieldError>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alvos vigentes</CardTitle>
          <CardDescription>
            {dados.alvos.length} alvo(s) nesta vigência.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {dados.alvos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum alvo cadastrado ainda — crie o primeiro acima.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead
                    sortDirection={alvosOrdenados.sortDirectionFor("nome")}
                    onSort={() => alvosOrdenados.toggleSort("nome")}
                  >
                    Nome
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={alvosOrdenados.sortDirectionFor("percentualAlvoBps")}
                    onSort={() => alvosOrdenados.toggleSort("percentualAlvoBps")}
                  >
                    Percentual alvo
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={alvosOrdenados.sortDirectionFor("tag")}
                    onSort={() => alvosOrdenados.toggleSort("tag")}
                  >
                    Tag
                  </SortableTableHead>
                  <SortableTableHead
                    sortDirection={alvosOrdenados.sortDirectionFor("qtdAtivosMapeados")}
                    onSort={() => alvosOrdenados.toggleSort("qtdAtivosMapeados")}
                  >
                    Ativos vinculados
                  </SortableTableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alvosOrdenados.sortedRows.map((alvo) => (
                  <TableRow key={alvo.id}>
                    <TableCell>{alvo.nome}</TableCell>
                    <TableCell>{formatBps(alvo.percentualAlvoBps)}</TableCell>
                    <TableCell>
                      {alvo.tag ? (
                        <TagBadge tag={alvo.tag} />
                      ) : (
                        <span className="text-muted-foreground">Sem tag</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {alvo.qtdAtivosMapeados} ativo(s) vinculado(s)
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" variant="outline" onClick={() => handleEditar(alvo)}>
                          Editar
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setAlvoParaRemover(alvo)}
                        >
                          Remover
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        <CardFooter>
          <Dialog open={dialogVigenciaAberto} onOpenChange={setDialogVigenciaAberto}>
            <Button variant="outline" onClick={() => setDialogVigenciaAberto(true)}>
              A carteira de referência mudou
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Abrir nova vigência de alvos?</DialogTitle>
                <DialogDescription>
                  Isso fecha a vigência atual ({dados.alvos.length} alvo(s), preservada para
                  sempre no histórico) e abre uma nova vigência com uma cópia editável de cada
                  alvo. Os vínculos de ativos existentes são automaticamente re-apontados para
                  os novos alvos.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />} disabled={processandoVigencia}>
                  Cancelar
                </DialogClose>
                <Button
                  onClick={() => void handleConfirmarNovaVigencia()}
                  disabled={processandoVigencia}
                >
                  {processandoVigencia ? "Processando…" : "Confirmar nova vigência"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardFooter>
      </Card>

      <Dialog
        open={alvoParaRemover !== null}
        onOpenChange={(aberto) => {
          if (!aberto) setAlvoParaRemover(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remover alvo?</DialogTitle>
            <DialogDescription>
              {alvoParaRemover && (
                <>
                  Remover &quot;{alvoParaRemover.nome}&quot; ({formatBps(alvoParaRemover.percentualAlvoBps)}).
                  {alvoParaRemover.qtdAtivosMapeados > 0 && (
                    <>
                      {" "}
                      Atenção: {alvoParaRemover.qtdAtivosMapeados} ativo(s) apontam para este
                      alvo hoje — revise os vínculos em{" "}
                      <a href="/vinculos">/vinculos</a> se necessário.
                    </>
                  )}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />} disabled={removendo}>
              Cancelar
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => void handleConfirmarRemover()}
              disabled={removendo}
            >
              {removendo ? "Removendo…" : "Confirmar remoção"}
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
      <h1 className="text-2xl font-heading font-semibold tracking-tight">Carteira alvo</h1>
      <p className="text-sm text-muted-foreground">
        Percentuais da carteira de valorização (Finclass) usados para calcular o déficit de
        cada alvo.
      </p>
    </div>
  );
}
