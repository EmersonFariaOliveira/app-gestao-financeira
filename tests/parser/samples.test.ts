import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseArquivoMyCapital } from "@/parser/mycapital";

/**
 * T032 — testes com os arquivos REAIS de docs/samples/ (Itaú.csv,
 * Nubank.csv, Avenue.csv). São dados financeiros reais, gitignored —
 * só existem localmente. CADA suíte abaixo faz skip (com aviso) quando
 * o arquivo correspondente não está presente na máquina.
 *
 * Golden values conferidos manualmente (script Node ad-hoc, sem
 * `parseFloat`/float, replicando `parseDecimalParaCentavos` linha a
 * linha da coluna "Patrimônio Hoje" de cada arquivo) em 2026-07-30:
 * - Itaú.csv:   10 posições, totalCentavos = 5110407,  dataMaisRecente = "2026-07-28T03:00:00.000Z"
 * - Nubank.csv: 17 posições, totalCentavos = 11920751, dataMaisRecente = "2026-07-28T03:00:00.000Z"
 * - Avenue.csv:  2 posições, totalCentavos = 20353,    dataMaisRecente = null (dataUltimaCotacao vem "null" literal nas 2 linhas)
 *
 * Se o layout real do MyCapital mudar, estes golden values precisam ser
 * reconferidos manualmente e atualizados aqui — não há atalho seguro.
 */

const CAMINHO_ITAU = path.join(process.cwd(), "docs", "samples", "Itaú.csv");
const CAMINHO_NUBANK = path.join(process.cwd(), "docs", "samples", "Nubank.csv");
const CAMINHO_AVENUE = path.join(process.cwd(), "docs", "samples", "Avenue.csv");

const temItau = fs.existsSync(CAMINHO_ITAU);
const temNubank = fs.existsSync(CAMINHO_NUBANK);
const temAvenue = fs.existsSync(CAMINHO_AVENUE);

function lerComoArquivoImport(caminho: string, nomeArquivo: string) {
  return { nomeArquivo, conteudo: new Uint8Array(fs.readFileSync(caminho)) };
}

describe.skipIf(!temItau)(
  "parseArquivoMyCapital — docs/samples/Itaú.csv (dado real)",
  () => {
    it("parseia com ok:true e bate com os golden values conferidos manualmente", () => {
      const resultado = parseArquivoMyCapital(
        lerComoArquivoImport(CAMINHO_ITAU, "Itaú.csv"),
      );

      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;

      expect(resultado.arquivo.instituicao).toBe("Itaú");
      expect(resultado.arquivo.linhas).toHaveLength(10);
      expect(resultado.arquivo.totalCentavos).toBe(5110407);
      expect(resultado.arquivo.dataMaisRecente).toBe(
        "2026-07-28T03:00:00.000Z",
      );
    });
  },
);
if (!temItau) {
  console.warn(
    "docs/samples/Itaú.csv não encontrado — pulando teste de dados reais (arquivo é gitignored, só existe localmente).",
  );
}

describe.skipIf(!temNubank)(
  "parseArquivoMyCapital — docs/samples/Nubank.csv (dado real)",
  () => {
    it("parseia com ok:true e bate com os golden values conferidos manualmente", () => {
      const resultado = parseArquivoMyCapital(
        lerComoArquivoImport(CAMINHO_NUBANK, "Nubank.csv"),
      );

      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;

      expect(resultado.arquivo.instituicao).toBe("Nubank");
      expect(resultado.arquivo.linhas).toHaveLength(17);
      expect(resultado.arquivo.totalCentavos).toBe(11920751);
      expect(resultado.arquivo.dataMaisRecente).toBe(
        "2026-07-28T03:00:00.000Z",
      );
    });
  },
);
if (!temNubank) {
  console.warn(
    "docs/samples/Nubank.csv não encontrado — pulando teste de dados reais (arquivo é gitignored, só existe localmente).",
  );
}

describe.skipIf(!temAvenue)(
  "parseArquivoMyCapital — docs/samples/Avenue.csv (dado real, EXTERIOR)",
  () => {
    it("parseia com ok:true e bate com os golden values conferidos manualmente", () => {
      const resultado = parseArquivoMyCapital(
        lerComoArquivoImport(CAMINHO_AVENUE, "Avenue.csv"),
      );

      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;

      expect(resultado.arquivo.instituicao).toBe("Avenue");
      expect(resultado.arquivo.linhas).toHaveLength(2);
      expect(resultado.arquivo.totalCentavos).toBe(20353);
      // dataUltimaCotacao vem "null" literal nas 2 linhas do Avenue.csv
      // real ⇒ nenhuma data disponível para o máximo.
      expect(resultado.arquivo.dataMaisRecente).toBeNull();
    });

    it("preserva quantidade fracionada e tipoAtivoInternacional nas linhas EXTERIOR", () => {
      const resultado = parseArquivoMyCapital(
        lerComoArquivoImport(CAMINHO_AVENUE, "Avenue.csv"),
      );

      expect(resultado.ok).toBe(true);
      if (!resultado.ok) return;

      const [dis, googl] = resultado.arquivo.linhas;

      expect(dis.chaveExport).toBe("DIS");
      expect(dis.tipoGrupo).toBe("EXTERIOR");
      expect(dis.quantidade).toBe("0.14451");
      expect(dis.patrimonioHojeCentavos).toBe(7545);
      expect(dis.tipoAtivoInternacional).toBe("STOCK");
      expect(dis.dataUltimaCotacao).toBeNull();

      expect(googl.chaveExport).toBe("GOOGL");
      expect(googl.tipoGrupo).toBe("EXTERIOR");
      expect(googl.quantidade).toBe("0.072");
      expect(googl.patrimonioHojeCentavos).toBe(12808);
      expect(googl.tipoAtivoInternacional).toBe("STOCK");
    });
  },
);
if (!temAvenue) {
  console.warn(
    "docs/samples/Avenue.csv não encontrado — pulando teste de dados reais (arquivo é gitignored, só existe localmente).",
  );
}
