/**
 * tests/services/dividendos-aporte-integracao.test.ts — teste de integração
 * PONTA A PONTA (checkpoint pós-Phase 7 / T050) entre
 * src/services/dividendo-service.ts e src/services/aporte-service.ts.
 *
 * Cobre o ciclo completo descrito na seção 5.1 da spec (dividendos), algo
 * que antes só existia validado manualmente (script ad hoc) e em pedaços
 * separados nos dois arquivos de teste unitários de cada serviço:
 *
 *   lançar dividendo (dividendo-service)
 *     → aparece disponível (dividendo-service.listarDividendos/totalDisponivelCentavos)
 *     → incluído no cálculo (aporte-service.calcular)
 *     → registrado (aporte-service.registrarAporte)
 *     → marcado como utilizado (aporte_id preenchido)
 *     → não aparece mais disponível (dividendo-service)
 *     → não pode mais ser editado/excluído (dividendo-service)
 *
 * Mesma estratégia de banco temporário dos demais testes de serviço:
 * `DATABASE_URL` aponta para um SQLite temporário ANTES de importar
 * `@/db/client`/os serviços (imports dinâmicos dentro de `beforeAll`).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let aporteService: typeof import("@/services/aporte-service");
let dividendoService: typeof import("@/services/dividendo-service");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dividendos-aporte-integracao-test-"));
  const dbPath = path.join(tmpDir, "test.db").split(path.sep).join("/");
  const databaseUrl = `file:${dbPath}`;
  process.env.DATABASE_URL = databaseUrl;

  try {
    execSync("npx prisma migrate deploy", {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
  } catch (erro) {
    console.error((erro as { stdout?: Buffer }).stdout?.toString());
    throw erro;
  }

  const dbModule = await import("@/db/client");
  prisma = dbModule.prisma;
  aporteService = await import("@/services/aporte-service");
  dividendoService = await import("@/services/dividendo-service");
}, 30_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Limpa todas as tabelas (ordem respeita FKs, igual a prisma/seed.ts). */
async function resetDb() {
  await prisma.dividendo.deleteMany();
  await prisma.aporte.deleteMany();
  await prisma.posicao.deleteMany();
  await prisma.ativo_mapeado.deleteMany();
  await prisma.sessao_import.deleteMany();
  await prisma.alvo.deleteMany();
  await prisma.config.deleteMany();
}

beforeEach(async () => {
  await resetDb();
});

/**
 * Cenário-base sem pendências: 2 alvos, 1 sessão VIGENTE com 2 posições
 * totalmente vinculadas — suficiente para `aporteService.calcular` funcionar
 * de ponta a ponta (idêntico ao cenário de aporte-service.test.ts).
 */
async function criarCenarioSemPendencia() {
  const alvoAcoes = await prisma.alvo.create({
    data: { nome: "Ações BR", percentual_alvo_bps: 6000, vigencia_inicio: new Date("2026-01-01") },
  });
  const alvoRendaFixa = await prisma.alvo.create({
    data: { nome: "Pós-fixado", percentual_alvo_bps: 4000, vigencia_inicio: new Date("2026-01-01") },
  });

  const sessao = await prisma.sessao_import.create({
    data: {
      mes_referencia: "2026-07",
      data_export: new Date("2026-07-28"),
      status: "VIGENTE",
      instituicoes: JSON.stringify(["Itaú"]),
    },
  });

  await prisma.posicao.createMany({
    data: [
      {
        sessao_import_id: sessao.id,
        chave_export: "PRIO3",
        instituicao: "Itaú",
        quantidade: "100",
        patrimonio_hoje_centavos: 300_000,
        tipo_grupo: "ACOES",
        data_ultima_cotacao: new Date("2026-07-28"),
      },
      {
        sessao_import_id: sessao.id,
        chave_export: "Tesouro Selic 2029",
        instituicao: "Itaú",
        quantidade: "1000.00",
        patrimonio_hoje_centavos: 200_000,
        tipo_grupo: "TESOURO_DIRETO",
        data_ultima_cotacao: new Date("2026-07-28"),
      },
    ],
  });

  await prisma.ativo_mapeado.createMany({
    data: [
      { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
      { chave_export: "Tesouro Selic 2029", alvo_id: alvoRendaFixa.id, fora_da_carteira: false },
    ],
  });

  return { alvoAcoes, alvoRendaFixa, sessao };
}

describe("integração dividendo-service + aporte-service (ciclo completo, 5.1)", () => {
  it("lançar → disponível → incluído no cálculo → registrado → utilizado → some da oferta → não pode mais ser editado/excluído", async () => {
    await criarCenarioSemPendencia();

    // 1. Lançar via a API pública do serviço (não prisma.dividendo.create
    // direto) — cobre o caminho real usado pela tela 6.6.
    const lancado = await dividendoService.lancarDividendo({
      chaveExport: "PRIO3",
      mesReferencia: "2026-07",
      valorCentavos: 6_000,
    });
    expect(lancado.aporteId).toBeNull();

    // 2. Aparece disponível — mesmo número nos dois pontos de consumo
    // (tela de dividendos e abertura da calculadora).
    const listagemAntes = await dividendoService.listarDividendos({ mes: "2026-07" });
    expect(listagemAntes.totalDisponivelCentavos).toBe(6_000);

    const preparo = await aporteService.prepararCalculadora();
    expect(preparo.dividendosDisponiveisCentavos).toBe(6_000);

    // 3. Incluído no cálculo.
    const calculo = await aporteService.calcular({
      valorCentavos: 50_000,
      incluirDividendos: true,
      incluirTroco: false,
      aporteMinimoCentavos: 50_000,
    });
    expect(calculo.valorDividendosCentavos).toBe(6_000);
    expect(calculo.valorTotalCentavos).toBe(56_000);
    expect(calculo.dividendosIncluidosIds).toEqual([lancado.id]);

    // 4. Registrado.
    const { aporteId } = await aporteService.registrarAporte({
      sessaoImportId: calculo.sessaoImportId,
      sugestao: calculo.sugestao,
      executado: calculo.sugestao,
      valorTotalCentavos: calculo.valorTotalCentavos,
      valorDividendosCentavos: calculo.valorDividendosCentavos,
      trocoCentavos: calculo.resultado.trocoCentavos,
      dividendosIncluidosIds: calculo.dividendosIncluidosIds,
    });

    // 5. Marcado como utilizado.
    const dividendoDepois = await prisma.dividendo.findUniqueOrThrow({
      where: { id: lancado.id },
    });
    expect(dividendoDepois.aporte_id).toBe(aporteId);

    // 6. Não aparece mais disponível (nem na listagem, nem na calculadora).
    const listagemDepois = await dividendoService.listarDividendos({ mes: "2026-07" });
    expect(listagemDepois.totalDisponivelCentavos).toBe(0);
    expect(listagemDepois.lancamentos[0].aporteId).toBe(aporteId);

    const preparoDepois = await aporteService.prepararCalculadora();
    expect(preparoDepois.dividendosDisponiveisCentavos).toBe(0);

    // 7. Não pode mais ser editado/excluído.
    await expect(
      dividendoService.editarDividendo({ id: lancado.id, valorCentavos: 1 }),
    ).rejects.toThrow(/utilizado/i);
    await expect(dividendoService.excluirDividendo(lancado.id)).rejects.toThrow(/utilizado/i);

    // E, se um novo cálculo for feito (mês seguinte), o dividendo já
    // utilizado nunca mais é oferecido nem recontabilizado.
    const calculoSeguinte = await aporteService.calcular({
      valorCentavos: 10_000,
      incluirDividendos: true,
      incluirTroco: false,
      aporteMinimoCentavos: 5_000,
    });
    expect(calculoSeguinte.valorDividendosCentavos).toBe(0);
    expect(calculoSeguinte.dividendosIncluidosIds).toEqual([]);
  });

  describe("condição de corrida teórica: dois cálculos 'quase simultâneos' incluindo o mesmo dividendo", () => {
    it("registrarAporte VALIDA, no momento do registro, que os dividendos ainda estão disponíveis — o segundo registro é recusado e NADA é persistido", async () => {
      // Cenário: `calcular()` é uma simulação pura de leitura — não marca
      // nada (só `registrarAporte` marca `aporte_id`, ver comentário em
      // dividendo-service.ts). Isso é intencional e correto para a
      // simulação em si. A pergunta é o que acontece se, na sequência, DOIS
      // `registrarAporte` forem chamados com a MESMA lista de
      // `dividendosIncluidosIds` — cenário artificial neste app
      // single-user/local (não há concorrência real esperada), mas útil
      // para documentar o comportamento exato.
      await criarCenarioSemPendencia();

      const dividendo = await dividendoService.lancarDividendo({
        chaveExport: "PRIO3",
        mesReferencia: "2026-07",
        valorCentavos: 5_000,
      });

      // Dois cálculos "quase simultâneos": ambos leem o dividendo como
      // disponível porque nenhum `registrarAporte` rodou ainda entre eles.
      const calculo1 = await aporteService.calcular({
        valorCentavos: 20_000,
        incluirDividendos: true,
        incluirTroco: false,
        aporteMinimoCentavos: 5_000,
      });
      const calculo2 = await aporteService.calcular({
        valorCentavos: 30_000,
        incluirDividendos: true,
        incluirTroco: false,
        aporteMinimoCentavos: 5_000,
      });
      expect(calculo1.dividendosIncluidosIds).toEqual([dividendo.id]);
      expect(calculo2.dividendosIncluidosIds).toEqual([dividendo.id]);
      expect(calculo1.valorTotalCentavos).toBe(25_000);
      expect(calculo2.valorTotalCentavos).toBe(35_000);

      // Primeiro registro: marca o dividendo normalmente.
      const { aporteId: aporteId1 } = await aporteService.registrarAporte({
        sessaoImportId: calculo1.sessaoImportId,
        sugestao: calculo1.sugestao,
        executado: calculo1.sugestao,
        valorTotalCentavos: calculo1.valorTotalCentavos,
        valorDividendosCentavos: calculo1.valorDividendosCentavos,
        trocoCentavos: calculo1.resultado.trocoCentavos,
        dividendosIncluidosIds: calculo1.dividendosIncluidosIds,
      });

      // Segundo registro: usa a MESMA lista de ids, já não mais disponível
      // (consumida pelo aporte #1). Comportamento ATUAL: `registrarAporte`
      // conta, DENTRO da transação e ANTES de criar o `aporte`, quantos dos
      // `dividendosIncluidosIds` ainda têm `aporte_id: null`; como o total é
      // diferente do tamanho da lista recebida, a chamada lança um erro
      // claro e a transação inteira reverte — nada é persistido (nem o novo
      // `aporte`, nem qualquer alteração no dividendo já utilizado).
      await expect(
        aporteService.registrarAporte({
          sessaoImportId: calculo2.sessaoImportId,
          sugestao: calculo2.sugestao,
          executado: calculo2.sugestao,
          valorTotalCentavos: calculo2.valorTotalCentavos,
          valorDividendosCentavos: calculo2.valorDividendosCentavos,
          trocoCentavos: calculo2.resultado.trocoCentavos,
          dividendosIncluidosIds: calculo2.dividendosIncluidosIds,
        }),
      ).rejects.toThrow(
        "Um ou mais dividendos incluídos já foram utilizados em outro aporte — recalcule antes de registrar.",
      );

      const dividendoFinal = await prisma.dividendo.findUniqueOrThrow({
        where: { id: dividendo.id },
      });
      // O dividendo continua vinculado apenas ao aporte #1 — a tentativa de
      // registro #2 não alterou nada nele.
      expect(dividendoFinal.aporte_id).toBe(aporteId1);

      // Nenhum segundo `aporte` foi criado: só existe o do primeiro
      // registro — a transação recusada não deixou rastro.
      const aportesPersistidos = await prisma.aporte.findMany();
      expect(aportesPersistidos).toHaveLength(1);
      expect(aportesPersistidos[0].id).toBe(aporteId1);
    });
  });
});
