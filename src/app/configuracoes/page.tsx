"use client";

/**
 * src/app/configuracoes/page.tsx — Configurações (tela 6.8,
 * docs/app-gestao-aportes.md seção 6.8).
 *
 * Regras de camada (CLAUDE.md): esta página NUNCA acessa o banco nem
 * reimplementa validação/persistência — ela apenas chama
 * `src/app/actions/config.ts` (que delega a `src/services/config-service.ts`)
 * e exibe o resultado. Valores monetários chegam em centavos inteiros e bps
 * inteiros; a conversão para/de texto digitado (`parseDecimalParaCentavos`,
 * `formatBps`) acontece só nesta borda de exibição.
 *
 * Conteúdo (seção 6.8):
 * 1. Formulário de settings: banda de tolerância, aporte mínimo, retenção
 *    de backups.
 * 2. Exibição (não editável) dos caminhos do `.db` e da pasta `backups/`,
 *    com lembrete de que copiar esses caminhos é o backup completo do app
 *    (local-first, sem sync na nuvem).
 * 3. Exportar configuração: JSON exibido num `<pre>` (com botão de copiar)
 *    e também disponível para download via Blob + `<a download>` — cobre
 *    tanto quem quer só copiar/colar quanto quem quer guardar o arquivo.
 * 4. Importar configuração: colar/upload de um arquivo `.json`, com
 *    confirmação explícita antes de aplicar (a operação fecha a vigência
 *    aberta de alvos e abre uma nova — ver config-service.ts), e exibição
 *    clara do resumo (alvos/vínculos afetados) ou do erro de validação.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  exportarConfigJson,
  importarConfigJson,
  lerConfig,
  salvarConfig,
  type ConfigAtualDto,
} from "@/app/actions/config";
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
import { Textarea } from "@/components/ui/textarea";
import { formatBps, formatCentavosParaReais, parseDecimalParaCentavos } from "@/core/money";
import type { ImportarConfigResultado } from "@/services/config-service";

/** Igual a `parsePercentualParaBps` de src/app/alvos/page.tsx — reuso de `parseDecimalParaCentavos` após remover o sufixo "%". */
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

/** Igual a `centavosParaTextoEditavel` de src/app/dividendos/page.tsx. */
function centavosParaTextoEditavel(centavos: number): string {
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const reais = Math.trunc(abs / 100);
  const cent = abs % 100;
  return `${negativo ? "-" : ""}${reais},${String(cent).padStart(2, "0")}`;
}

type Fase = "carregando" | "erro" | "pronto";

export default function ConfiguracoesPage() {
  const [fase, setFase] = useState<Fase>("carregando");
  const [erroCarregamento, setErroCarregamento] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigAtualDto | null>(null);

  // Formulário de settings.
  const [bandaTexto, setBandaTexto] = useState("");
  const [aporteMinimoTexto, setAporteMinimoTexto] = useState("");
  const [retencaoTexto, setRetencaoTexto] = useState("");
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // Export.
  const [jsonExportado, setJsonExportado] = useState<string | null>(null);
  const [exportando, setExportando] = useState(false);

  // Import.
  const [jsonParaImportar, setJsonParaImportar] = useState("");
  const [dialogImportarAberto, setDialogImportarAberto] = useState(false);
  const [importando, setImportando] = useState(false);
  const [resultadoImport, setResultadoImport] = useState<ImportarConfigResultado | null>(null);
  const [erroImport, setErroImport] = useState<string | null>(null);
  const inputArquivoRef = useRef<HTMLInputElement>(null);

  const carregar = useCallback(async () => {
    const resp = await lerConfig();
    if (!resp.ok) {
      setErroCarregamento(resp.erro);
      setFase("erro");
      return;
    }
    setConfig(resp.data);
    setBandaTexto(bpsParaTextoEditavel(resp.data.bandaToleranciaBps));
    setAporteMinimoTexto(centavosParaTextoEditavel(resp.data.aporteMinimoCentavos));
    setRetencaoTexto(String(resp.data.retencaoBackups));
    setFase("pronto");
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function handleSalvar() {
    let bandaToleranciaBps: number;
    let aporteMinimoCentavos: number;

    try {
      bandaToleranciaBps = parsePercentualParaBps(bandaTexto);
    } catch {
      setErroForm('Banda de tolerância inválida — use um decimal (ex.: "1,5" ou "1,5%").');
      return;
    }
    if (bandaToleranciaBps < 0) {
      setErroForm("A banda de tolerância não pode ser negativa.");
      return;
    }

    try {
      aporteMinimoCentavos = parseDecimalParaCentavos(aporteMinimoTexto);
    } catch {
      setErroForm('Aporte mínimo inválido — use um decimal (ex.: "500,00").');
      return;
    }
    if (aporteMinimoCentavos < 0) {
      setErroForm("O aporte mínimo não pode ser negativo.");
      return;
    }

    const retencaoNum = Number(retencaoTexto);
    if (!Number.isInteger(retencaoNum) || retencaoNum < 0 || retencaoTexto.trim() === "") {
      setErroForm("Retenção de backups deve ser um número inteiro de cópias (0 ou mais).");
      return;
    }
    const retencaoBackups = retencaoNum;

    setSalvando(true);
    setErroForm(null);
    try {
      const resp = await salvarConfig({ bandaToleranciaBps, aporteMinimoCentavos, retencaoBackups });
      if (!resp.ok) {
        setErroForm(resp.erro);
        return;
      }
      setConfig(resp.data);
      toast.success("Configurações salvas.");
    } finally {
      setSalvando(false);
    }
  }

  async function handleExportar() {
    setExportando(true);
    try {
      const resp = await exportarConfigJson();
      if (!resp.ok) {
        toast.error(resp.erro);
        return;
      }
      setJsonExportado(JSON.stringify(resp.data, null, 2));
    } finally {
      setExportando(false);
    }
  }

  function handleBaixarArquivo() {
    if (!jsonExportado) return;
    const blob = new Blob([jsonExportado], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `config-aportes-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleCopiar() {
    if (!jsonExportado) return;
    try {
      await navigator.clipboard.writeText(jsonExportado);
      toast.success("JSON copiado para a área de transferência.");
    } catch {
      toast.error("Não foi possível copiar automaticamente — selecione o texto manualmente.");
    }
  }

  function handleArquivoSelecionado(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivo = e.target.files?.[0];
    if (!arquivo) return;
    const reader = new FileReader();
    reader.onload = () => {
      setJsonParaImportar(String(reader.result ?? ""));
    };
    reader.readAsText(arquivo);
    e.target.value = "";
  }

  async function handleConfirmarImportar() {
    if (!jsonParaImportar.trim()) {
      setErroImport("Cole o JSON ou selecione um arquivo antes de importar.");
      return;
    }
    setImportando(true);
    setErroImport(null);
    setResultadoImport(null);
    try {
      const resp = await importarConfigJson(jsonParaImportar);
      if (!resp.ok) {
        setErroImport(resp.erro);
        return;
      }
      setResultadoImport(resp.data);
      toast.success("Configuração importada — nova vigência de alvos aberta.");
      setDialogImportarAberto(false);
      await carregar();
    } finally {
      setImportando(false);
    }
  }

  if (fase === "carregando") {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <p className="text-sm text-muted-foreground">Carregando configurações…</p>
      </div>
    );
  }

  if (fase === "erro" || !config) {
    return (
      <div className="flex flex-col gap-6">
        <Cabecalho />
        <Card>
          <CardHeader>
            <CardTitle>Não foi possível carregar as configurações</CardTitle>
            <CardDescription>{erroCarregamento}</CardDescription>
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
          <CardTitle>Parâmetros</CardTitle>
          <CardDescription>
            Banda de tolerância (dashboard), aporte mínimo por transação (calculadora) e
            quantas cópias de backup automático manter em <code>backups/</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end sm:flex-wrap">
          <Field className="sm:max-w-40">
            <FieldLabel htmlFor="cfg-banda">Banda de tolerância</FieldLabel>
            <Input
              id="cfg-banda"
              inputMode="decimal"
              placeholder="1,50%"
              value={bandaTexto}
              onChange={(e) => setBandaTexto(e.target.value)}
            />
          </Field>
          <Field className="sm:max-w-40">
            <FieldLabel htmlFor="cfg-aporte-minimo">Aporte mínimo (R$)</FieldLabel>
            <Input
              id="cfg-aporte-minimo"
              inputMode="decimal"
              placeholder="500,00"
              value={aporteMinimoTexto}
              onChange={(e) => setAporteMinimoTexto(e.target.value)}
            />
          </Field>
          <Field className="sm:max-w-40">
            <FieldLabel htmlFor="cfg-retencao">Retenção de backups</FieldLabel>
            <Input
              id="cfg-retencao"
              inputMode="numeric"
              placeholder="12"
              value={retencaoTexto}
              onChange={(e) => setRetencaoTexto(e.target.value)}
            />
          </Field>
          <Button onClick={() => void handleSalvar()} disabled={salvando}>
            {salvando ? "Salvando…" : "Salvar"}
          </Button>
        </CardContent>
        {erroForm && (
          <CardContent className="pt-0">
            <FieldError>{erroForm}</FieldError>
          </CardContent>
        )}
        <CardFooter>
          <p className="text-xs text-muted-foreground">
            Atualmente: banda {formatBps(config.bandaToleranciaBps)} · aporte mínimo{" "}
            {formatCentavosParaReais(config.aporteMinimoCentavos)} · retenção{" "}
            {config.retencaoBackups} cópia(s).
          </p>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Armazenamento local</CardTitle>
          <CardDescription>
            Este app é local-first: todos os dados vivem num único arquivo SQLite, sem
            sincronização na nuvem. Faça backup COMPLETO destes caminhos periodicamente por
            fora do app (ex.: copiar para um pendrive/nuvem pessoal) — é a única forma de
            recuperar os dados em caso de perda do computador.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div>
            <span className="font-medium">Arquivo do banco (.db): </span>
            <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">
              {config.caminhoDb}
            </code>
          </div>
          <div>
            <span className="font-medium">Pasta de backups automáticos: </span>
            <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">
              {config.caminhoBackups}
            </code>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exportar configuração</CardTitle>
          <CardDescription>
            Gera um JSON portável com os alvos da vigência aberta, os vínculos resolvidos e os
            parâmetros acima — não inclui sessões de import, aportes nem dividendos (esses são
            histórico transacional, não configuração).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void handleExportar()} disabled={exportando}>
              {exportando ? "Gerando…" : "Gerar JSON"}
            </Button>
            {jsonExportado && (
              <>
                <Button variant="outline" onClick={() => void handleCopiar()}>
                  Copiar
                </Button>
                <Button variant="outline" onClick={handleBaixarArquivo}>
                  Baixar arquivo
                </Button>
              </>
            )}
          </div>
          {jsonExportado && (
            <Textarea readOnly rows={10} className="font-mono text-xs" value={jsonExportado} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Importar configuração</CardTitle>
          <CardDescription>
            Cole o JSON exportado anteriormente ou selecione o arquivo. Isso fecha a vigência
            de alvos aberta atualmente (preservada no histórico) e abre uma nova vigência com os
            alvos do JSON — vínculos existentes não listados no JSON não são apagados.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <input
            ref={inputArquivoRef}
            type="file"
            accept="application/json,.json"
            className="text-sm"
            onChange={handleArquivoSelecionado}
          />
          <Textarea
            rows={8}
            className="font-mono text-xs"
            placeholder='{"versao": 1, "settings": {...}, "alvos": [...], "vinculos": [...]}'
            value={jsonParaImportar}
            onChange={(e) => {
              setJsonParaImportar(e.target.value);
              setErroImport(null);
              setResultadoImport(null);
            }}
          />
          {erroImport && <FieldError>{erroImport}</FieldError>}
          {resultadoImport && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              Importado: {resultadoImport.alvosCriados} alvo(s) criado(s),{" "}
              {resultadoImport.vinculosCriados} vínculo(s) novo(s),{" "}
              {resultadoImport.vinculosAtualizados} vínculo(s) atualizado(s).
            </p>
          )}
        </CardContent>
        <CardFooter>
          <Dialog open={dialogImportarAberto} onOpenChange={setDialogImportarAberto}>
            <Button
              variant="destructive"
              onClick={() => setDialogImportarAberto(true)}
              disabled={!jsonParaImportar.trim()}
            >
              Importar configuração
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Confirmar importação de configuração?</DialogTitle>
                <DialogDescription>
                  A vigência de alvos aberta atualmente será fechada (preservada no histórico) e
                  substituída pelos alvos deste JSON. Vínculos de ativos serão criados/atualizados
                  conforme o JSON; vínculos existentes não mencionados nele permanecem como
                  estão. Sessões de import, aportes e dividendos não são afetados.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />} disabled={importando}>
                  Cancelar
                </DialogClose>
                <Button
                  variant="destructive"
                  onClick={() => void handleConfirmarImportar()}
                  disabled={importando}
                >
                  {importando ? "Importando…" : "Confirmar importação"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardFooter>
      </Card>
    </div>
  );
}

function Cabecalho() {
  return (
    <div>
      <h1 className="text-2xl font-heading font-semibold tracking-tight">Configurações</h1>
      <p className="text-sm text-muted-foreground">
        Parâmetros do motor de aporte, caminhos de armazenamento local e backup portável de
        configuração.
      </p>
    </div>
  );
}
