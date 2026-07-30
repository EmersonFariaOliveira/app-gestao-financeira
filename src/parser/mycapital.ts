/**
 * src/parser/mycapital.ts — parser do export CSV do MyCapital (T034).
 *
 * Contrato: specs/001-gestao-aportes-v0-v1/contracts/parser.md
 *
 * Este é o ÚNICO módulo do sistema que conhece o formato do export do
 * MyCapital (docs/app-gestao-aportes.md, seção 3). Falha alta: qualquer
 * linha inválida invalida o ARQUIVO INTEIRO — todos os erros de todas as
 * linhas são coletados antes de retornar `{ ok: false, erros }` (nunca
 * aborta no primeiro erro, nunca resultado parcial).
 */

import { parseDecimalParaCentavos } from "@/core/money";

import { ErroExtrairInstituicao, extrairInstituicao } from "./instituicao";
import type {
  ArquivoImport,
  ArquivoParseado,
  ErroParse,
  PosicaoParseada,
  ResultadoParse,
} from "./types";

const BOM = "﻿";
const SEPARADOR = ";";

/** Colunas-chave obrigatórias no cabeçalho (contracts/parser.md #3). */
const COLUNAS_OBRIGATORIAS = [
  "Ação",
  "Quantidade",
  "Patrimônio Hoje",
  "Tipo de Grupo",
  "dataUltimaCotacao",
] as const;

/** Coluna opcional (opaca) — presente apenas nas linhas EXTERIOR, mas o
 * schema é idêntico entre instituições, então basta checar se existe. */
const COLUNA_TIPO_ATIVO_INTERNACIONAL = "tipoAtivoInternacional";

/**
 * Decodifica os bytes crus do upload como UTF-8 e remove o BOM inicial
 * (`EF BB BF`), se presente. Funciona igual sem BOM.
 */
function decodificarConteudo(conteudo: Uint8Array): string {
  const texto = new TextDecoder("utf-8").decode(conteudo);
  return texto.startsWith(BOM) ? texto.slice(BOM.length) : texto;
}

/**
 * Quebra o texto em linhas, aceitando `\n` e `\r\n`, e descarta linhas
 * completamente vazias no final do arquivo (trailing newline comum em
 * exports).
 */
function quebrarLinhas(texto: string): string[] {
  return texto.split(/\r\n|\n/);
}

/** `"null"` literal (case sensível, como observado nos exports reais) é tratado como ausente. */
function valorOuNulo(valor: string | undefined): string | null {
  if (valor === undefined) return null;
  const valorTrim = valor.trim();
  if (valorTrim === "null" || valorTrim === "") return null;
  return valorTrim;
}

/** Mapeia nome de coluna -> índice a partir da linha de cabeçalho. */
function mapearCabecalho(headerLinha: string): Map<string, number> {
  const colunas = headerLinha.split(SEPARADOR);
  const mapa = new Map<string, number>();
  colunas.forEach((nomeColuna, indice) => {
    const nome = nomeColuna.trim();
    // Em caso de nomes duplicados, mantém o primeiro índice encontrado
    // (não deveria acontecer no export real, mas evita comportamento
    // silenciosamente errado).
    if (!mapa.has(nome)) {
      mapa.set(nome, indice);
    }
  });
  return mapa;
}

/**
 * Parse de um arquivo de export do MyCapital (uma instituição).
 *
 * `ok: false` ⇒ nada é aproveitado do arquivo; `erros` reúne TODOS os
 * problemas encontrados de uma vez.
 */
export function parseArquivoMyCapital(input: ArquivoImport): ResultadoParse {
  const erros: ErroParse[] = [];
  const nomeArquivo = input.nomeArquivo;

  // Instituição: erro coletado (não aborta o resto do parse), pois o
  // contrato pede erros coletados mesmo quando o nome do arquivo é
  // inválido, junto de eventuais erros de linha.
  let instituicao: string | null = null;
  try {
    instituicao = extrairInstituicao(nomeArquivo);
  } catch (erro) {
    if (erro instanceof ErroExtrairInstituicao) {
      erros.push({
        arquivo: nomeArquivo,
        linha: erro.linha,
        coluna: erro.coluna,
        mensagem: erro.mensagem,
      });
    } else {
      throw erro;
    }
  }

  const texto = decodificarConteudo(input.conteudo);
  const todasLinhas = quebrarLinhas(texto);
  // Remove linhas totalmente vazias (ex.: trailing newline no fim do
  // arquivo) — não contam como cabeçalho nem como dados.
  const linhasNaoVazias = todasLinhas.filter((linha) => linha.trim().length > 0);

  if (linhasNaoVazias.length === 0) {
    erros.push({
      arquivo: nomeArquivo,
      linha: 1,
      coluna: "<arquivo>",
      mensagem: "arquivo sem posições",
    });
    return { ok: false, erros };
  }

  const [headerLinha, ...linhasDados] = linhasNaoVazias;
  const mapaColunas = mapearCabecalho(headerLinha);

  const errosCabecalho: ErroParse[] = [];
  for (const coluna of COLUNAS_OBRIGATORIAS) {
    if (!mapaColunas.has(coluna)) {
      errosCabecalho.push({
        arquivo: nomeArquivo,
        linha: 1,
        coluna,
        mensagem: `Coluna obrigatória "${coluna}" ausente do cabeçalho do arquivo. O layout do export do MyCapital pode ter mudado.`,
      });
    }
  }

  // Sem as colunas-chave, não há como parsear as linhas de dados de
  // forma confiável: reporta o(s) erro(s) de cabeçalho junto com
  // quaisquer outros erros já coletados (ex.: instituição inválida),
  // mas sem tentar inferir posição de coluna nem parsear linhas.
  if (errosCabecalho.length > 0) {
    return { ok: false, erros: [...erros, ...errosCabecalho] };
  }

  if (linhasDados.length === 0) {
    erros.push({
      arquivo: nomeArquivo,
      linha: 1,
      coluna: "<arquivo>",
      mensagem: "arquivo sem posições",
    });
    return { ok: false, erros };
  }

  const indiceAcao = mapaColunas.get("Ação")!;
  const indiceQuantidade = mapaColunas.get("Quantidade")!;
  const indicePatrimonioHoje = mapaColunas.get("Patrimônio Hoje")!;
  const indiceTipoGrupo = mapaColunas.get("Tipo de Grupo")!;
  const indiceDataUltimaCotacao = mapaColunas.get("dataUltimaCotacao")!;
  const indiceTipoAtivoInternacional = mapaColunas.get(
    COLUNA_TIPO_ATIVO_INTERNACIONAL,
  );

  const linhasParseadas: PosicaoParseada[] = [];

  linhasDados.forEach((linhaTexto, indiceLinhaDados) => {
    // Linha 1 é o cabeçalho; a primeira linha de dados é a linha 2.
    const numeroLinha = indiceLinhaDados + 2;
    const campos = linhaTexto.split(SEPARADOR);

    const acao = valorOuNulo(campos[indiceAcao]);
    const quantidade = valorOuNulo(campos[indiceQuantidade]);
    const patrimonioHojeRaw = valorOuNulo(campos[indicePatrimonioHoje]);
    const tipoGrupo = valorOuNulo(campos[indiceTipoGrupo]);
    const dataUltimaCotacao = valorOuNulo(campos[indiceDataUltimaCotacao]);
    const tipoAtivoInternacional =
      indiceTipoAtivoInternacional !== undefined
        ? valorOuNulo(campos[indiceTipoAtivoInternacional])
        : null;

    let patrimonioHojeCentavos: number | null = null;
    if (patrimonioHojeRaw === null) {
      erros.push({
        arquivo: nomeArquivo,
        linha: numeroLinha,
        coluna: "Patrimônio Hoje",
        mensagem: `"Patrimônio Hoje" ausente ou nulo na linha ${numeroLinha}.`,
      });
    } else {
      try {
        const centavos = parseDecimalParaCentavos(patrimonioHojeRaw);
        if (centavos < 0) {
          erros.push({
            arquivo: nomeArquivo,
            linha: numeroLinha,
            coluna: "Patrimônio Hoje",
            mensagem: `"Patrimônio Hoje" negativo (${patrimonioHojeRaw}) na linha ${numeroLinha}.`,
          });
        } else {
          patrimonioHojeCentavos = centavos;
        }
      } catch {
        erros.push({
          arquivo: nomeArquivo,
          linha: numeroLinha,
          coluna: "Patrimônio Hoje",
          mensagem: `"Patrimônio Hoje" não é um valor numérico válido: "${patrimonioHojeRaw}" (linha ${numeroLinha}).`,
        });
      }
    }

    if (patrimonioHojeCentavos === null) {
      // Erro já coletado acima — segue para a próxima linha sem
      // adicionar esta posição (falhar alto: o arquivo inteiro já será
      // rejeitado, então não é preciso validar mais campos desta linha).
      return;
    }

    linhasParseadas.push({
      chaveExport: acao ?? "",
      quantidade: quantidade ?? "",
      patrimonioHojeCentavos,
      tipoGrupo: tipoGrupo ?? "",
      tipoAtivoInternacional,
      dataUltimaCotacao,
    });
  });

  if (erros.length > 0) {
    return { ok: false, erros };
  }

  const totalCentavos = linhasParseadas.reduce(
    (soma, linha) => soma + linha.patrimonioHojeCentavos,
    0,
  );

  const dataMaisRecente = linhasParseadas.reduce<string | null>(
    (maxAtual, linha) => {
      if (linha.dataUltimaCotacao === null) return maxAtual;
      if (maxAtual === null) return linha.dataUltimaCotacao;
      return linha.dataUltimaCotacao > maxAtual ? linha.dataUltimaCotacao : maxAtual;
    },
    null,
  );

  const arquivo: ArquivoParseado = {
    instituicao: instituicao ?? "",
    linhas: linhasParseadas,
    totalCentavos,
    dataMaisRecente,
  };

  return { ok: true, arquivo };
}
