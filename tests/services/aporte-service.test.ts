/**
 * tests/services/aporte-service.test.ts — testes de integração (T027) de
 * src/services/aporte-service.ts contra um SQLite TEMPORÁRIO, isolado do
 * `data/app.db` real/seed.
 *
 * Estratégia (documentada, pois é a única forma sã de testar um módulo que
 * usa o singleton `@/db/client` sem tocar no banco real): o singleton lê
 * `DATABASE_URL` do ambiente na hora em que é instanciado. Este arquivo
 * define `process.env.DATABASE_URL` para um arquivo `.db` temporário ANTES
 * de importar `@/db/client`/`@/services/aporte-service` — por isso os
 * imports desses módulos são DINÂMICOS (`await import(...)`) dentro de
 * `beforeAll`, nunca `import` estático no topo do arquivo (que rodaria
 * antes do `beforeAll` e pegaria o `.env` do projeto). Esquema aplicado via
 * `prisma migrate deploy` (mesmas migrations do projeto) contra o arquivo
 * temporário, criado com `fs.mkdtempSync`.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let aporteService: typeof import("@/services/aporte-service");
let alvoService: typeof import("@/services/alvo-service");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aporte-service-test-"));
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
  alvoService = await import("@/services/alvo-service");
}, 30_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Limpa todas as tabelas (ordem respeita FKs, igual a prisma/seed.ts).
 * Inclui as tabelas da feature 002 (posicao_manual e afins) mesmo que ainda
 * não sejam usadas por todos os testes deste arquivo, para manter o reset
 * simétrico ao schema completo.
 */
async function resetDb() {
  await prisma.incremento_valor_investido_pendente.deleteMany();
  await prisma.ajuste_valor_investido.deleteMany();
  await prisma.posicao_manual_valor.deleteMany();
  await prisma.dividendo.deleteMany();
  await prisma.aporte.deleteMany();
  await prisma.posicao.deleteMany();
  await prisma.posicao_manual.deleteMany();
  await prisma.ativo_mapeado.deleteMany();
  await prisma.sessao_import.deleteMany();
  await prisma.alvo.deleteMany();
  await prisma.config.deleteMany();
}

beforeEach(async () => {
  await resetDb();
});

/**
 * Cenário-base sem pendências: 2 alvos (bps 6000/4000, um deles renda
 * fixa), 1 sessão VIGENTE com 2 posições totalmente vinculadas.
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

/**
 * Sessão VIGENTE mínima, sem posições — suficiente para satisfazer a FK
 * `aporte.sessao_import_id`. Os testes do algoritmo de elegibilidade
 * (T023) chamam `registrarAporte` diretamente com um `executado[]`
 * sintético; eles não passam por `montarContextoEntradaMotor` (que exige
 * posições/vínculos completos), porque a geração de
 * `incremento_valor_investido_pendente` é resolvida inteiramente a partir
 * de `posicao_manual`/`ativo_mapeado`/`ajuste_valor_investido`, no estado
 * ATUAL do banco (motor-integracao.md §3.1) — não depende de posições.
 */
async function criarSessaoMinima(mesReferencia = "2026-07") {
  return prisma.sessao_import.create({
    data: {
      mes_referencia: mesReferencia,
      data_export: new Date("2026-07-28"),
      status: "VIGENTE",
      instituicoes: JSON.stringify(["Itaú"]),
    },
  });
}

/** `LinhaAporte` sintética mínima para os testes de elegibilidade. */
function linhaAporteExecutada(alvoId: string, nomeAlvo: string, valorCentavos: number) {
  return {
    alvo_id: alvoId,
    nome_alvo: nomeAlvo,
    valor_centavos: valorCentavos,
    origem: "DEFICIT" as const,
  };
}

describe("aporte-service", () => {
  describe("bloqueio por pendência (FR-015)", () => {
    it("prepararCalculadora retorna bloqueada=true com a chave pendente listada", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });

      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "ATIVO-NOVO",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 50_000,
          tipo_grupo: "ACOES",
        },
      });

      // Pendente: alvo_id=null e fora_da_carteira=false (data-model.md).
      await prisma.ativo_mapeado.create({
        data: { chave_export: "ATIVO-NOVO", alvo_id: null, fora_da_carteira: false },
      });

      const preparo = await aporteService.prepararCalculadora();

      expect(preparo.bloqueada).toBe(true);
      expect(preparo.pendencias).toEqual(["ATIVO-NOVO"]);
    });

    it("calcular() recusa calcular enquanto houver pendência", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "ATIVO-NOVO",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 50_000,
          tipo_grupo: "ACOES",
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "ATIVO-NOVO", alvo_id: null, fora_da_carteira: false },
      });

      await expect(
        aporteService.calcular({
          valorCentavos: 100_000,
          incluirDividendos: false,
          incluirTroco: false,
          aporteMinimoCentavos: 50_000,
        }),
      ).rejects.toThrow(/pendente/i);
    });

    it("posição com reserva_emergencia=true é excluída de posicoes[]/base do motor e NÃO é listada como pendência bloqueando a calculadora", async () => {
      const alvoAcoes = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 10000, vigencia_inicio: new Date("2026-01-01") },
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
            patrimonio_hoje_centavos: 100_000,
            tipo_grupo: "ACOES",
            data_ultima_cotacao: new Date("2026-07-28"),
          },
          {
            sessao_import_id: sessao.id,
            chave_export: "RESERVA-CDB",
            instituicao: "Itaú",
            quantidade: "1",
            patrimonio_hoje_centavos: 80_000,
            tipo_grupo: "OUTROS_FUNDOS",
            data_ultima_cotacao: new Date("2026-07-28"),
          },
        ],
      });
      await prisma.ativo_mapeado.createMany({
        data: [
          { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
          { chave_export: "RESERVA-CDB", alvo_id: null, reserva_emergencia: true },
        ],
      });

      const preparo = await aporteService.prepararCalculadora();
      expect(preparo.bloqueada).toBe(false);
      expect(preparo.pendencias).toEqual([]);

      const calculo = await aporteService.calcular({
        valorCentavos: 50_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 100,
      });

      // Base do motor não inclui os 80_000 da reserva de emergência.
      expect(calculo.resultado.patrimonioBaseCentavos).toBe(100_000);
    });

    it("uma chave sem NENHUM ativo_mapeado também bloqueia (equivalente a pendente)", async () => {
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "SEM-MAPEAMENTO",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 50_000,
          tipo_grupo: "ACOES",
        },
      });
      // Nenhum ativo_mapeado criado para "SEM-MAPEAMENTO".

      const preparo = await aporteService.prepararCalculadora();
      expect(preparo.bloqueada).toBe(true);
      expect(preparo.pendencias).toContain("SEM-MAPEAMENTO");
    });
  });

  describe("amarração permanente à sessão do cálculo", () => {
    it("aporte.sessao_import_id continua apontando para a sessão original mesmo depois dela virar SUBSTITUIDO", async () => {
      const { sessao: sessaoOriginal } = await criarCenarioSemPendencia();

      const calculo = await aporteService.calcular({
        valorCentavos: 100_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 50_000,
      });

      expect(calculo.sessaoImportId).toBe(sessaoOriginal.id);

      const { aporteId } = await aporteService.registrarAporte({
        sessaoImportId: calculo.sessaoImportId,
        sugestao: calculo.sugestao,
        executado: calculo.sugestao,
        valorTotalCentavos: calculo.valorTotalCentavos,
        valorDividendosCentavos: calculo.valorDividendosCentavos,
        trocoCentavos: calculo.resultado.trocoCentavos,
        dividendosIncluidosIds: calculo.dividendosIncluidosIds,
      });

      // Simula (sem depender de import-service, que ainda não existe) uma
      // nova sessão VIGENTE do mês seguinte substituindo a anterior — a
      // transição real seria feita pela confirmação de import, mas a regra
      // testada aqui é puramente sobre `aporte`, que nunca é re-vinculado.
      const novaSessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-08",
          data_export: new Date("2026-08-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.sessao_import.update({
        where: { id: sessaoOriginal.id },
        data: { status: "SUBSTITUIDO" },
      });

      const aportePersistido = await prisma.aporte.findUniqueOrThrow({ where: { id: aporteId } });
      const sessaoOriginalAtualizada = await prisma.sessao_import.findUniqueOrThrow({
        where: { id: sessaoOriginal.id },
      });

      expect(aportePersistido.sessao_import_id).toBe(sessaoOriginal.id);
      expect(sessaoOriginalAtualizada.status).toBe("SUBSTITUIDO");
      expect(aportePersistido.sessao_import_id).not.toBe(novaSessao.id);
    });
  });

  describe("regra 9 — posições nunca são escritas por registrarAporte", () => {
    it("o snapshot de posicao antes/depois de registrarAporte é idêntico", async () => {
      const { sessao } = await criarCenarioSemPendencia();

      const antes = await prisma.posicao.findMany({ orderBy: { id: "asc" } });

      const calculo = await aporteService.calcular({
        valorCentavos: 50_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 50_000,
      });

      await aporteService.registrarAporte({
        sessaoImportId: calculo.sessaoImportId,
        sugestao: calculo.sugestao,
        executado: calculo.sugestao,
        valorTotalCentavos: calculo.valorTotalCentavos,
        valorDividendosCentavos: calculo.valorDividendosCentavos,
        trocoCentavos: calculo.resultado.trocoCentavos,
      });

      const depois = await prisma.posicao.findMany({ orderBy: { id: "asc" } });

      expect(JSON.parse(JSON.stringify(depois))).toEqual(JSON.parse(JSON.stringify(antes)));
      expect(depois).toHaveLength(2);
      // Sanity extra: a sessão usada no cálculo é a criada no cenário.
      expect(calculo.sessaoImportId).toBe(sessao.id);
    });
  });

  describe("dividendos — controle de utilização (5.1)", () => {
    it("dividendo já utilizado (aporte_id preenchido) nunca é oferecido de novo, mesmo com incluirDividendos=true", async () => {
      const { sessao } = await criarCenarioSemPendencia();

      // Dividendo JÁ utilizado num aporte anterior (aporte_id preenchido) —
      // precisa de um `aporte` existente para satisfazer a FK.
      const aporteAnterior = await prisma.aporte.create({
        data: {
          sessao_import_id: sessao.id,
          valor_total_centavos: 10_000,
          valor_dividendos_centavos: 10_000,
          sugestao: "[]",
          executado: "[]",
          troco_centavos: 0,
        },
      });
      await prisma.dividendo.create({
        data: {
          chave_export: "PRIO3",
          mes_referencia: "2026-06",
          valor_centavos: 10_000,
          aporte_id: aporteAnterior.id,
        },
      });

      // Dividendo NÃO utilizado (aporte_id null) — este sim deve aparecer.
      await prisma.dividendo.create({
        data: { chave_export: "PRIO3", mes_referencia: "2026-07", valor_centavos: 4_000 },
      });

      const preparo = await aporteService.prepararCalculadora();
      // Só o dividendo não-utilizado (4000) entra na soma oferecida.
      expect(preparo.dividendosDisponiveisCentavos).toBe(4_000);

      const calculo = await aporteService.calcular({
        valorCentavos: 100_000,
        incluirDividendos: true,
        incluirTroco: false,
        aporteMinimoCentavos: 50_000,
      });

      // valorTotalCentavos soma só o dividendo disponível (4000), nunca o
      // já utilizado (10000) — 100_000 + 4_000 = 104_000.
      expect(calculo.valorDividendosCentavos).toBe(4_000);
      expect(calculo.valorTotalCentavos).toBe(104_000);
      expect(calculo.dividendosIncluidosIds).toHaveLength(1);

      // O dividendo já utilizado permanece intocado (continua vinculado ao
      // aporte anterior, nunca é re-oferecido nem re-marcado).
      const dividendoAntigo = await prisma.dividendo.findFirstOrThrow({
        where: { mes_referencia: "2026-06" },
      });
      expect(dividendoAntigo.aporte_id).toBe(aporteAnterior.id);
    });

    it("registrarAporte marca o dividendo incluído como utilizado; ele não aparece mais em prepararCalculadora", async () => {
      const { sessao } = await criarCenarioSemPendencia();

      const dividendo = await prisma.dividendo.create({
        data: { chave_export: "PRIO3", mes_referencia: "2026-07", valor_centavos: 7_500 },
      });

      const preparoAntes = await aporteService.prepararCalculadora();
      expect(preparoAntes.dividendosDisponiveisCentavos).toBe(7_500);

      const calculo = await aporteService.calcular({
        valorCentavos: 50_000,
        incluirDividendos: true,
        incluirTroco: false,
        aporteMinimoCentavos: 50_000,
      });
      expect(calculo.dividendosIncluidosIds).toEqual([dividendo.id]);

      await aporteService.registrarAporte({
        sessaoImportId: calculo.sessaoImportId,
        sugestao: calculo.sugestao,
        executado: calculo.sugestao,
        valorTotalCentavos: calculo.valorTotalCentavos,
        valorDividendosCentavos: calculo.valorDividendosCentavos,
        trocoCentavos: calculo.resultado.trocoCentavos,
        dividendosIncluidosIds: calculo.dividendosIncluidosIds,
      });

      const dividendoDepois = await prisma.dividendo.findUniqueOrThrow({ where: { id: dividendo.id } });
      expect(dividendoDepois.aporte_id).not.toBeNull();

      const preparoDepois = await aporteService.prepararCalculadora();
      expect(preparoDepois.dividendosDisponiveisCentavos).toBe(0);
      // Referência à sessão criada no cenário evita "unused var" e reforça
      // que o dividendo pertence ao mesmo contexto usado no cálculo.
      expect(calculo.sessaoImportId).toBe(sessao.id);
    });
  });

  describe("aporte_minimo lembrado na config", () => {
    it("calcular() grava aporte_minimo_centavos na config para a próxima vez", async () => {
      await criarCenarioSemPendencia();

      const configAntes = await prisma.config.findUnique({
        where: { chave: "aporte_minimo_centavos" },
      });
      expect(configAntes).toBeNull();

      await aporteService.calcular({
        valorCentavos: 100_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 77_000,
      });

      const configDepois = await prisma.config.findUniqueOrThrow({
        where: { chave: "aporte_minimo_centavos" },
      });
      expect(JSON.parse(configDepois.valor)).toBe(77_000);

      const preparo = await aporteService.prepararCalculadora();
      expect(preparo.aporteMinimoCentavos).toBe(77_000);
    });
  });

  describe("nomesPorAlvoId — mapa completo de nomes (fix do bug de ID exposto na UI)", () => {
    it("calcular() retorna nomesPorAlvoId com TODOS os alvos vigentes, inclusive um com déficit <= 0 que não recebe fatia em sugestao/divisao", async () => {
      // alvoAcima já está muito acima do seu próprio alvo percentual (déficit
      // negativo) — regra 1: fica na fila, mas nunca recebe fatia da divisão.
      // alvoAbaixo está bem abaixo do seu alvo e recebe toda a divisão.
      const alvoAcima = await prisma.alvo.create({
        data: { nome: "WRLD11", percentual_alvo_bps: 2000, vigencia_inicio: new Date("2026-01-01") },
      });
      const alvoAbaixo = await prisma.alvo.create({
        data: { nome: "Pós-fixado", percentual_alvo_bps: 8000, vigencia_inicio: new Date("2026-01-01") },
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
            chave_export: "WRLD11-CHAVE",
            instituicao: "Itaú",
            quantidade: "100",
            patrimonio_hoje_centavos: 900_000,
            tipo_grupo: "ETF",
            data_ultima_cotacao: new Date("2026-07-28"),
          },
          {
            sessao_import_id: sessao.id,
            chave_export: "Tesouro Selic 2029",
            instituicao: "Itaú",
            quantidade: "1000.00",
            patrimonio_hoje_centavos: 100_000,
            tipo_grupo: "TESOURO_DIRETO",
            data_ultima_cotacao: new Date("2026-07-28"),
          },
        ],
      });

      await prisma.ativo_mapeado.createMany({
        data: [
          { chave_export: "WRLD11-CHAVE", alvo_id: alvoAcima.id, fora_da_carteira: false },
          { chave_export: "Tesouro Selic 2029", alvo_id: alvoAbaixo.id, fora_da_carteira: false },
        ],
      });

      const calculo = await aporteService.calcular({
        valorCentavos: 50_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 100,
      });

      // Sanity: alvoAcima de fato tem déficit negativo e não aparece em sugestao.
      const itemFilaAcima = calculo.resultado.fila.find((f) => f.alvoId === alvoAcima.id);
      expect(itemFilaAcima?.deficitCentavos).toBeLessThan(0);
      expect(calculo.sugestao.some((l) => l.alvo_id === alvoAcima.id)).toBe(false);

      // nomesPorAlvoId, ainda assim, resolve o nome de AMBOS os alvos vigentes.
      expect(calculo.nomesPorAlvoId).toEqual({
        [alvoAcima.id]: "WRLD11",
        [alvoAbaixo.id]: "Pós-fixado",
      });

      // Shape serializável: objeto plano (não Map) — precisa atravessar a
      // borda server action → client component via JSON.
      expect(calculo.nomesPorAlvoId).not.toBeInstanceOf(Map);
      expect(calculo.nomesPorAlvoId.constructor).toBe(Object);
      expect(JSON.parse(JSON.stringify(calculo.nomesPorAlvoId))).toEqual(calculo.nomesPorAlvoId);
    });
  });

  describe("alvo removido (zumbi): removerAlvo recusa a remoção enquanto houver ativo_mapeado vinculado, fechando o bug que corrompia o déficit dos alvos ativos", () => {
    it("removerAlvo lança erro e o vínculo permanece intacto — patrimonioBaseCentavos e a fila nunca chegam a ser corrompidos por um 'vínculo zumbi'", async () => {
      const alvoAcoes = await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 5000 });
      const alvoZumbi = await alvoService.criarAlvo({ nome: "Zumbi", percentualAlvoBps: 5000 });

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
            patrimonio_hoje_centavos: 100_000,
            tipo_grupo: "ACOES",
          },
          {
            sessao_import_id: sessao.id,
            chave_export: "ZUMBI-ATIVO",
            instituicao: "Itaú",
            quantidade: "500",
            patrimonio_hoje_centavos: 50_000,
            tipo_grupo: "TESOURO_DIRETO",
          },
        ],
      });

      await prisma.ativo_mapeado.createMany({
        data: [
          { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
          { chave_export: "ZUMBI-ATIVO", alvo_id: alvoZumbi.id, fora_da_carteira: false },
        ],
      });

      // Comportamento corrigido (alvo-service.removerAlvo): a remoção é
      // recusada enquanto ZUMBI-ATIVO ainda apontar para alvoZumbi — nunca
      // chega a existir um alvo com ativo=false e um vínculo órfão apontando
      // para ele, então patrimonioBaseCentavos nunca é inflado por uma
      // posição que não seria creditada a nenhum alvo real (regra 4).
      await expect(alvoService.removerAlvo(alvoZumbi.id)).rejects.toThrow(
        `Não é possível remover o alvo 'Zumbi': há 1 ativo(s) vinculado(s) a ele. Revincule-os a outro alvo ou marque como fora da carteira antes de remover.`,
      );

      const alvoZumbiNoBanco = await prisma.alvo.findUniqueOrThrow({ where: { id: alvoZumbi.id } });
      expect(alvoZumbiNoBanco.ativo).toBe(true);

      const preparo = await aporteService.prepararCalculadora();
      expect(preparo.bloqueada).toBe(false);
      expect(preparo.pendencias).toEqual([]);

      const calculo = await aporteService.calcular({
        valorCentavos: 100_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 100,
      });

      // Com alvoZumbi ainda vigente (remoção recusada), os 50_000 de
      // ZUMBI-ATIVO seguem legitimamente na base — creditados ao próprio
      // alvoZumbi, não "perdidos". patrimonioBaseCentavos continua 150_000,
      // mas agora AMBOS os alvos aparecem na fila/divisão.
      expect(calculo.resultado.patrimonioBaseCentavos).toBe(150_000);
      expect(calculo.resultado.fila.map((f) => f.alvoId).sort()).toEqual(
        [alvoAcoes.id, alvoZumbi.id].sort(),
      );
    });
  });

  describe("posições manuais e ignorar_no_import — contracts/motor-integracao.md §2 (T006, TDD: montarContextoEntradaMotor ainda não foi estendido — falhas aqui são esperadas até T008)", () => {
    it("posição manual ativa com posicao_manual_valor na sessão vigente entra no cálculo com valorCentavos = valor_atual, NUNCA valor_investido (§2.2, FR-006)", async () => {
      const alvoAcoes = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });
      const alvoRendaFixa = await prisma.alvo.create({
        data: { nome: "Pós-fixado", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });

      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });

      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 300_000,
          tipo_grupo: "ACOES",
          data_ultima_cotacao: new Date("2026-07-28"),
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
      });

      const posicaoManual = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-ITAU-2029",
          instituicao: "Itaú",
          alvo_id: alvoRendaFixa.id,
          descricao: "CDB Itaú 120% CDI 2029",
        },
      });
      // valor_investido propositalmente bem diferente (e muito menor) de
      // valor_atual: se montarContextoEntradaMotor por engano lesse
      // valor_investido, patrimonioBaseCentavos ficaria ~300_001 em vez de
      // 820_000 — a asserção abaixo comprova que o campo lido é valor_atual.
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManual.id,
          sessao_import_id: sessao.id,
          valor_investido_centavos: 1,
          valor_atual_centavos: 520_000,
        },
      });

      const calculo = await aporteService.calcular({
        valorCentavos: 50_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 100,
      });

      // 300_000 (PRIO3/CSV) + 520_000 (manual, valor_atual) = 820_000.
      expect(calculo.resultado.patrimonioBaseCentavos).toBe(820_000);

      const itemFilaRendaFixa = calculo.resultado.fila.find((f) => f.alvoId === alvoRendaFixa.id);
      expect(itemFilaRendaFixa?.valorAtualCentavos).toBe(520_000);
    });

    it("chave_export marcado ignorar_no_import=true é excluído inteiramente da consolidação do CSV, mesmo vinculado a um alvo (§2.1)", async () => {
      const alvoAcoes = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });
      const alvoRendaFixa = await prisma.alvo.create({
        data: { nome: "Pós-fixado", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
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
            // Ignorado: nunca deveria contribuir com 999_000 ao alvo
            // Pós-fixado, mesmo estando vinculado a ele.
            sessao_import_id: sessao.id,
            chave_export: "TESOURO-IGNORADO",
            instituicao: "Itaú",
            quantidade: "1000.00",
            patrimonio_hoje_centavos: 999_000,
            tipo_grupo: "TESOURO_DIRETO",
            data_ultima_cotacao: new Date("2026-07-28"),
          },
        ],
      });

      await prisma.ativo_mapeado.createMany({
        data: [
          { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
          {
            chave_export: "TESOURO-IGNORADO",
            alvo_id: alvoRendaFixa.id,
            fora_da_carteira: false,
            ignorar_no_import: true,
          },
        ],
      });

      const calculo = await aporteService.calcular({
        valorCentavos: 50_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 100,
      });

      // Sem TESOURO-IGNORADO (999_000): só PRIO3 (300_000) entra na base.
      expect(calculo.resultado.patrimonioBaseCentavos).toBe(300_000);
      const itemFilaRendaFixa = calculo.resultado.fila.find((f) => f.alvoId === alvoRendaFixa.id);
      expect(itemFilaRendaFixa?.valorAtualCentavos ?? 0).toBe(0);
    });

    it("colisão entre chave_manual de uma posicao_manual e um chave_export já consolidado do CSV lança erro explícito (fail loud, research.md R8, §2.2)", async () => {
      const alvoAcoes = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });
      const alvoRendaFixa = await prisma.alvo.create({
        data: { nome: "Pós-fixado", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });

      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });

      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 300_000,
          tipo_grupo: "ACOES",
          data_ultima_cotacao: new Date("2026-07-28"),
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
      });

      // Colisão de identidade: chave_manual igual a uma chave_export real
      // já consolidada do CSV — nunca deve ser somada silenciosamente.
      const posicaoManualColidente = await prisma.posicao_manual.create({
        data: {
          chave_manual: "PRIO3",
          instituicao: "Itaú",
          alvo_id: alvoRendaFixa.id,
          descricao: "Posição manual colidente (erro de cadastro do usuário)",
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManualColidente.id,
          sessao_import_id: sessao.id,
          valor_investido_centavos: 500_000,
          valor_atual_centavos: 520_000,
        },
      });

      await expect(
        aporteService.calcular({
          valorCentavos: 50_000,
          incluirDividendos: false,
          incluirTroco: false,
          aporteMinimoCentavos: 100,
        }),
      ).rejects.toThrow(/PRIO3/);
    });

    it("posicao_manual ativa SEM posicao_manual_valor na sessão vigente não entra no cálculo (pré-condição §2.3) nem quebra o cálculo", async () => {
      const alvoAcoes = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });
      const alvoRendaFixa = await prisma.alvo.create({
        data: { nome: "Pós-fixado", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
      });

      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });

      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 300_000,
          tipo_grupo: "ACOES",
          data_ultima_cotacao: new Date("2026-07-28"),
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
      });

      // posicao_manual ativa, mas sem NENHUM posicao_manual_valor criado
      // (nem nesta sessão, nem em qualquer outra).
      await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-SEM-SNAPSHOT",
          instituicao: "Itaú",
          alvo_id: alvoRendaFixa.id,
          descricao: "CDB cadastrado mas sem snapshot ainda",
        },
      });

      const calculo = await aporteService.calcular({
        valorCentavos: 50_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 100,
      });

      expect(calculo.resultado.patrimonioBaseCentavos).toBe(300_000);
      const itemFilaRendaFixa = calculo.resultado.fila.find((f) => f.alvoId === alvoRendaFixa.id);
      expect(itemFilaRendaFixa?.valorAtualCentavos ?? 0).toBe(0);
    });
  });

  describe("posicao_manual com máquina de estados de ativo_mapeado (alvo_id null | fora_da_carteira | reserva_emergencia)", () => {
    it("posicao_manual pendente (alvo_id null, fora_da_carteira=false, reserva_emergencia=false) bloqueia calcular(), citando a chave_manual na mensagem de erro", async () => {
      const { sessao } = await criarCenarioSemPendencia();

      const posicaoManualPendente = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-PENDENTE-VINCULO",
          instituicao: "Itaú",
          alvo_id: null,
          descricao: "CDB recém-cadastrado, ainda sem vínculo",
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManualPendente.id,
          sessao_import_id: sessao.id,
          valor_investido_centavos: 10_000,
          valor_atual_centavos: 10_000,
        },
      });

      const preparo = await aporteService.prepararCalculadora();
      expect(preparo.bloqueada).toBe(true);
      expect(preparo.pendencias).toContain("CDB-PENDENTE-VINCULO");

      await expect(
        aporteService.calcular({
          valorCentavos: 100_000,
          incluirDividendos: false,
          incluirTroco: false,
          aporteMinimoCentavos: 50_000,
        }),
      ).rejects.toThrow(/CDB-PENDENTE-VINCULO/);
    });

    it("posicao_manual pendente bloqueia prepararCalculadora MESMO sem nenhuma sessão de import vigente (pendência independente de sessão)", async () => {
      // Nenhuma sessao_import criada neste teste — listarPendencias() ainda
      // assim deve enxergar a pendência de posicao_manual.
      await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-SEM-SESSAO",
          instituicao: "Itaú",
          alvo_id: null,
          descricao: "CDB cadastrado antes de qualquer import",
        },
      });

      const preparo = await aporteService.prepararCalculadora();
      expect(preparo.bloqueada).toBe(true);
      expect(preparo.pendencias).toEqual(["CDB-SEM-SESSAO"]);
    });

    it("posicao_manual com fora_da_carteira=true entra em posicoes[] (não bloqueia, checagem de colisão continua ativa) mas é excluída da base de déficit", async () => {
      const alvoAcoes = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 10000, vigencia_inicio: new Date("2026-01-01") },
      });
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 100_000,
          tipo_grupo: "ACOES",
          data_ultima_cotacao: new Date("2026-07-28"),
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
      });

      const posicaoManualForaCarteira = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-LEGADO-FORA-CARTEIRA",
          instituicao: "Itaú",
          alvo_id: null,
          fora_da_carteira: true,
          descricao: "CDB legado que não faz parte da carteira alvo",
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManualForaCarteira.id,
          sessao_import_id: sessao.id,
          valor_investido_centavos: 1,
          valor_atual_centavos: 200_000,
        },
      });

      const preparo = await aporteService.prepararCalculadora();
      expect(preparo.bloqueada).toBe(false);
      expect(preparo.pendencias).toEqual([]);

      const calculo = await aporteService.calcular({
        valorCentavos: 50_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 100,
      });

      // Base do motor não inclui os 200_000 fora-da-carteira (regra 4).
      expect(calculo.resultado.patrimonioBaseCentavos).toBe(100_000);
    });

    it("posicao_manual com reserva_emergencia=true é excluída de posicoes[]/base do motor e NÃO bloqueia a calculadora", async () => {
      const alvoAcoes = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 10000, vigencia_inicio: new Date("2026-01-01") },
      });
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 100_000,
          tipo_grupo: "ACOES",
          data_ultima_cotacao: new Date("2026-07-28"),
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
      });

      const posicaoManualReserva = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-RESERVA-EMERGENCIA",
          instituicao: "Itaú",
          alvo_id: null,
          reserva_emergencia: true,
          descricao: "CDB dedicado à reserva de emergência",
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManualReserva.id,
          sessao_import_id: sessao.id,
          valor_investido_centavos: 1,
          valor_atual_centavos: 300_000,
        },
      });

      const preparo = await aporteService.prepararCalculadora();
      expect(preparo.bloqueada).toBe(false);
      expect(preparo.pendencias).toEqual([]);

      const calculo = await aporteService.calcular({
        valorCentavos: 50_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 100,
      });

      // Base do motor não inclui os 300_000 da reserva de emergência.
      expect(calculo.resultado.patrimonioBaseCentavos).toBe(100_000);
    });

    it("colisão de identidade continua sendo checada para posicao_manual fora_da_carteira=true (não-pendente), antes do continue de estado", async () => {
      const alvoAcoes = await prisma.alvo.create({
        data: { nome: "Ações BR", percentual_alvo_bps: 10000, vigencia_inicio: new Date("2026-01-01") },
      });
      const sessao = await prisma.sessao_import.create({
        data: {
          mes_referencia: "2026-07",
          data_export: new Date("2026-07-28"),
          status: "VIGENTE",
          instituicoes: JSON.stringify(["Itaú"]),
        },
      });
      // PRIO3 vinculado normalmente (não pendente) — isola a asserção na
      // checagem de COLISÃO, sem que a pendência de ativo_mapeado dispare
      // primeiro (o que tornaria a asserção sobre a mensagem ambígua).
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "PRIO3",
          instituicao: "Itaú",
          quantidade: "100",
          patrimonio_hoje_centavos: 300_000,
          tipo_grupo: "ACOES",
          data_ultima_cotacao: new Date("2026-07-28"),
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: alvoAcoes.id, fora_da_carteira: false },
      });

      // Colisão: chave_manual igual a um chave_export já consolidado do
      // CSV. `fora_da_carteira: true` (em vez de pendente) garante que
      // NENHUMA pendência é disparada antes — a única falha possível é a
      // colisão de identidade, checada antes do `continue` de estado.
      const posicaoManualColidenteForaCarteira = await prisma.posicao_manual.create({
        data: {
          chave_manual: "PRIO3",
          instituicao: "Itaú",
          alvo_id: null,
          fora_da_carteira: true,
          descricao: "Posição manual colidente, fora da carteira",
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManualColidenteForaCarteira.id,
          sessao_import_id: sessao.id,
          valor_investido_centavos: 500_000,
          valor_atual_centavos: 520_000,
        },
      });

      await expect(
        aporteService.calcular({
          valorCentavos: 50_000,
          incluirDividendos: false,
          incluirTroco: false,
          aporteMinimoCentavos: 100,
        }),
      ).rejects.toThrow(/Colisão de identidade.*PRIO3/);
    });

    it("pendência de ativo_mapeado E de posicao_manual ao mesmo tempo: prepararCalculadora combina as duas em pendencias[], e calcular() cita ambas na mensagem", async () => {
      const { sessao } = await criarCenarioSemPendencia();

      // Segunda pendência: um ativo_mapeado novo, sem vínculo (CSV).
      await prisma.posicao.create({
        data: {
          sessao_import_id: sessao.id,
          chave_export: "ATIVO-NOVO-CSV",
          instituicao: "Itaú",
          quantidade: "10",
          patrimonio_hoje_centavos: 10_000,
          tipo_grupo: "ACOES",
          data_ultima_cotacao: new Date("2026-07-28"),
        },
      });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "ATIVO-NOVO-CSV", alvo_id: null, fora_da_carteira: false },
      });

      // Terceira pendência: uma posicao_manual ainda sem vínculo.
      const posicaoManualPendente = await prisma.posicao_manual.create({
        data: {
          chave_manual: "CDB-PENDENTE-COMBINADO",
          instituicao: "Itaú",
          alvo_id: null,
          descricao: "CDB recém-cadastrado, ainda sem vínculo",
        },
      });
      await prisma.posicao_manual_valor.create({
        data: {
          posicao_manual_id: posicaoManualPendente.id,
          sessao_import_id: sessao.id,
          valor_investido_centavos: 10_000,
          valor_atual_centavos: 10_000,
        },
      });

      const preparo = await aporteService.prepararCalculadora();
      expect(preparo.bloqueada).toBe(true);
      expect(preparo.pendencias.sort()).toEqual(
        ["ATIVO-NOVO-CSV", "CDB-PENDENTE-COMBINADO"].sort(),
      );

      await expect(
        aporteService.calcular({
          valorCentavos: 100_000,
          incluirDividendos: false,
          incluirTroco: false,
          aporteMinimoCentavos: 50_000,
        }),
      ).rejects.toThrow(/ATIVO-NOVO-CSV/);
      await expect(
        aporteService.calcular({
          valorCentavos: 100_000,
          incluirDividendos: false,
          incluirTroco: false,
          aporteMinimoCentavos: 50_000,
        }),
      ).rejects.toThrow(/CDB-PENDENTE-COMBINADO/);
    });
  });

  describe("ajuste_valor_investido — nunca lido por montarContextoEntradaMotor (T014, US2, SC-004/FR-006)", () => {
    it("calcular() produz resultado IDÊNTICO antes e depois de um ajuste_valor_investido sobre a mesma posição", async () => {
      const { sessao } = await criarCenarioSemPendencia();

      const input = {
        valorCentavos: 100_000,
        incluirDividendos: false,
        incluirTroco: false,
        aporteMinimoCentavos: 50_000,
      };

      const calculoAntes = await aporteService.calcular(input);

      // ajuste_valor_investido para PRIO3 (chave_export já vinculada e usada
      // no cenário-base), com valor propositalmente absurdo/diferente de
      // patrimonio_hoje_centavos (300_000): se fosse lido por engano por
      // montarContextoEntradaMotor, patrimonioBaseCentavos e a divisão
      // mudariam de forma óbvia. valor_investido_corrigido_centavos NÃO
      // existe hoje em nenhuma leitura de aporte-service.ts — este teste é
      // a prova estrutural de que isso continua assim (análogo a T006 para
      // posicao_manual.valor_investido_centavos).
      await prisma.ajuste_valor_investido.create({
        data: {
          chave_export: "PRIO3",
          sessao_import_id: sessao.id,
          valor_investido_corrigido_centavos: 999_999_999,
        },
      });

      const calculoDepois = await aporteService.calcular(input);

      expect(JSON.parse(JSON.stringify(calculoDepois))).toEqual(
        JSON.parse(JSON.stringify(calculoAntes)),
      );
      // Sanity explícita, além do deep-equal acima: o valor absurdo do
      // ajuste não vazou para a base de cálculo.
      expect(calculoDepois.resultado.patrimonioBaseCentavos).toBe(
        calculoAntes.resultado.patrimonioBaseCentavos,
      );
      expect(calculoDepois.resultado.patrimonioBaseCentavos).not.toBe(999_999_999);
    });
  });

  describe(
    "incremento_valor_investido_pendente — algoritmo de mapeamento exclusivo " +
      "(T023, US4, contracts/motor-integracao.md §3; TDD: registrarAporte ainda " +
      "NÃO gera incrementos — as falhas abaixo são esperadas até T025)",
    () => {
      it("0 elegíveis: nenhum incremento_valor_investido_pendente é criado para o alvo (§3.2, decisão de julgamento §5.2)", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "Multimercado", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        const sessao = await criarSessaoMinima();

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 50_000)],
          executado: [linhaAporteExecutada(alvo.id, alvo.nome, 50_000)],
          valorTotalCentavos: 50_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(0);
      });

      it("1 elegível via posição manual ativa: cria 1 incremento com posicao_manual_id preenchido e chave_export null (§3.2)", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "Pós-fixado", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        const posicaoManual = await prisma.posicao_manual.create({
          data: {
            chave_manual: "CDB-UNICO-2029",
            instituicao: "Itaú",
            alvo_id: alvo.id,
            descricao: "CDB Itaú único elegível",
          },
        });
        const sessao = await criarSessaoMinima();

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 75_000)],
          executado: [linhaAporteExecutada(alvo.id, alvo.nome, 75_000)],
          valorTotalCentavos: 75_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(1);
        expect(incrementos[0]).toMatchObject({
          alvo_id: alvo.id,
          chave_export: null,
          posicao_manual_id: posicaoManual.id,
          valor_incremento_centavos: 75_000,
          aplicado: false,
        });
      });

      it("1 elegível via ajuste ativo (chave_export com ajuste_valor_investido histórico): cria 1 incremento com chave_export preenchido e posicao_manual_id null (§3.2)", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "Fundos", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        await prisma.ativo_mapeado.create({
          data: {
            chave_export: "FUNDO-UNICO-X",
            alvo_id: alvo.id,
            fora_da_carteira: false,
            ignorar_no_import: false,
          },
        });
        const sessaoHistorica = await criarSessaoMinima("2026-06");
        // "Ajuste ativo" exige apenas que o histórico exista — não precisa
        // ser da sessão vigente no momento do aporte (motor-integracao.md
        // §3.1: "não precisa ser da sessão vigente, só existir historicamente").
        await prisma.ajuste_valor_investido.create({
          data: {
            chave_export: "FUNDO-UNICO-X",
            sessao_import_id: sessaoHistorica.id,
            valor_investido_corrigido_centavos: 100_000,
          },
        });
        const sessao = await criarSessaoMinima("2026-07");

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 60_000)],
          executado: [linhaAporteExecutada(alvo.id, alvo.nome, 60_000)],
          valorTotalCentavos: 60_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(1);
        expect(incrementos[0]).toMatchObject({
          alvo_id: alvo.id,
          chave_export: "FUNDO-UNICO-X",
          posicao_manual_id: null,
          valor_incremento_centavos: 60_000,
          aplicado: false,
        });
      });

      it("chave_export vinculado ao alvo mas SEM nenhum ajuste_valor_investido histórico não é elegível (decisão de julgamento §5.1) — 0 elegíveis", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "Fundos sem ajuste", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        // Vinculado ao alvo, mas NUNCA "promovido" a ajuste — não é elegível.
        await prisma.ativo_mapeado.create({
          data: {
            chave_export: "FUNDO-SEM-AJUSTE",
            alvo_id: alvo.id,
            fora_da_carteira: false,
            ignorar_no_import: false,
          },
        });
        const sessao = await criarSessaoMinima();

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 30_000)],
          executado: [linhaAporteExecutada(alvo.id, alvo.nome, 30_000)],
          valorTotalCentavos: 30_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(0);
      });

      it("≥2 elegíveis (2 posições manuais ativas no mesmo alvo): cria 1 incremento ambíguo com alvo_id só, chave_export e posicao_manual_id ambos null (FR-012, §3.2)", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "Multimercado ambíguo", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        await prisma.posicao_manual.create({
          data: {
            chave_manual: "CDB-AMBIGUO-1",
            instituicao: "Itaú",
            alvo_id: alvo.id,
            descricao: "CDB A",
          },
        });
        await prisma.posicao_manual.create({
          data: {
            chave_manual: "CDB-AMBIGUO-2",
            instituicao: "Nubank",
            alvo_id: alvo.id,
            descricao: "CDB B",
          },
        });
        const sessao = await criarSessaoMinima();

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 90_000)],
          executado: [linhaAporteExecutada(alvo.id, alvo.nome, 90_000)],
          valorTotalCentavos: 90_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(1);
        expect(incrementos[0]).toMatchObject({
          alvo_id: alvo.id,
          chave_export: null,
          posicao_manual_id: null,
          valor_incremento_centavos: 90_000,
          aplicado: false,
        });
      });

      it("≥2 elegíveis mistos (1 posição manual + 1 ajuste ativo no mesmo alvo): também gera incremento ambíguo, não escolhe um dos dois (§3.2, união a+b)", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "Misto ambíguo", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        await prisma.posicao_manual.create({
          data: {
            chave_manual: "CDB-MISTO-1",
            instituicao: "Itaú",
            alvo_id: alvo.id,
            descricao: "CDB misto",
          },
        });
        await prisma.ativo_mapeado.create({
          data: {
            chave_export: "FUNDO-MISTO-1",
            alvo_id: alvo.id,
            fora_da_carteira: false,
            ignorar_no_import: false,
          },
        });
        const sessaoHistorica = await criarSessaoMinima("2026-06");
        await prisma.ajuste_valor_investido.create({
          data: {
            chave_export: "FUNDO-MISTO-1",
            sessao_import_id: sessaoHistorica.id,
            valor_investido_corrigido_centavos: 50_000,
          },
        });
        const sessao = await criarSessaoMinima("2026-07");

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 120_000)],
          executado: [linhaAporteExecutada(alvo.id, alvo.nome, 120_000)],
          valorTotalCentavos: 120_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(1);
        expect(incrementos[0]).toMatchObject({
          alvo_id: alvo.id,
          chave_export: null,
          posicao_manual_id: null,
          valor_incremento_centavos: 120_000,
          aplicado: false,
        });
      });

      it("FR-015: posição manual ENCERRADA (ativo=false) nunca entra em elegíveis — sozinha, produz 0 elegíveis", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "CDB encerrado", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        await prisma.posicao_manual.create({
          data: {
            chave_manual: "CDB-ENCERRADO",
            instituicao: "Itaú",
            alvo_id: alvo.id,
            descricao: "CDB vencido",
            ativo: false,
          },
        });
        const sessao = await criarSessaoMinima();

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 40_000)],
          executado: [linhaAporteExecutada(alvo.id, alvo.nome, 40_000)],
          valorTotalCentavos: 40_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(0);
      });

      it("FR-015: posição manual ENCERRADA não conta na contagem — 1 encerrada + 1 ativa no mesmo alvo ainda é n=1 (exclusiva), não ambígua", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "CDB parcialmente encerrado", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        await prisma.posicao_manual.create({
          data: {
            chave_manual: "CDB-ENCERRADO-2",
            instituicao: "Itaú",
            alvo_id: alvo.id,
            descricao: "CDB vencido",
            ativo: false,
          },
        });
        const posicaoAtiva = await prisma.posicao_manual.create({
          data: {
            chave_manual: "CDB-AINDA-ATIVO",
            instituicao: "Itaú",
            alvo_id: alvo.id,
            descricao: "CDB vigente",
          },
        });
        const sessao = await criarSessaoMinima();

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 45_000)],
          executado: [linhaAporteExecutada(alvo.id, alvo.nome, 45_000)],
          valorTotalCentavos: 45_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(1);
        expect(incrementos[0]).toMatchObject({
          alvo_id: alvo.id,
          chave_export: null,
          posicao_manual_id: posicaoAtiva.id,
          valor_incremento_centavos: 45_000,
          aplicado: false,
        });
      });

      it("FR-015: ajuste cujo chave_export foi DESVINCULADO do alvo (alvo_id mudou) não entra em elegíveis para o alvo original — 0 elegíveis", async () => {
        const alvoOriginal = await prisma.alvo.create({
          data: { nome: "Alvo original", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        const alvoNovo = await prisma.alvo.create({
          data: { nome: "Alvo novo (desvinculado para cá)", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        // Vínculo ATUAL aponta para alvoNovo — o ajuste histórico não muda
        // o fato de que hoje o ativo pertence a outro alvo (§3.1: "usa o
        // vínculo ATUAL, não o vínculo no momento em que o ajuste foi criado").
        await prisma.ativo_mapeado.create({
          data: {
            chave_export: "FUNDO-DESVINCULADO",
            alvo_id: alvoNovo.id,
            fora_da_carteira: false,
            ignorar_no_import: false,
          },
        });
        const sessaoHistorica = await criarSessaoMinima("2026-06");
        await prisma.ajuste_valor_investido.create({
          data: {
            chave_export: "FUNDO-DESVINCULADO",
            sessao_import_id: sessaoHistorica.id,
            valor_investido_corrigido_centavos: 70_000,
          },
        });
        const sessao = await criarSessaoMinima("2026-07");

        // Aporte executado no alvo ORIGINAL — o ajuste não deveria contar
        // para ele, já que hoje o vínculo do chave_export é com alvoNovo.
        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvoOriginal.id, alvoOriginal.nome, 20_000)],
          executado: [linhaAporteExecutada(alvoOriginal.id, alvoOriginal.nome, 20_000)],
          valorTotalCentavos: 20_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(0);
      });

      it("FR-015: ajuste cujo chave_export está fora_da_carteira=true não entra em elegíveis, mesmo com alvo_id e histórico de ajuste corretos", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "Alvo com fundo fora da carteira", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        await prisma.ativo_mapeado.create({
          data: {
            chave_export: "FUNDO-FORA-CARTEIRA",
            alvo_id: alvo.id,
            fora_da_carteira: true,
            ignorar_no_import: false,
          },
        });
        const sessaoHistorica = await criarSessaoMinima("2026-06");
        await prisma.ajuste_valor_investido.create({
          data: {
            chave_export: "FUNDO-FORA-CARTEIRA",
            sessao_import_id: sessaoHistorica.id,
            valor_investido_corrigido_centavos: 80_000,
          },
        });
        const sessao = await criarSessaoMinima("2026-07");

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 25_000)],
          executado: [linhaAporteExecutada(alvo.id, alvo.nome, 25_000)],
          valorTotalCentavos: 25_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(0);
      });

      it("FR-015: ajuste cujo chave_export está ignorar_no_import=true não entra em elegíveis (a posição manual substituta é que conta, não o ajuste do CSV ignorado)", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "Alvo com CSV ignorado", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        await prisma.ativo_mapeado.create({
          data: {
            chave_export: "CDB-IGNORADO-NO-IMPORT",
            alvo_id: alvo.id,
            fora_da_carteira: false,
            ignorar_no_import: true,
          },
        });
        const sessaoHistorica = await criarSessaoMinima("2026-06");
        await prisma.ajuste_valor_investido.create({
          data: {
            chave_export: "CDB-IGNORADO-NO-IMPORT",
            sessao_import_id: sessaoHistorica.id,
            valor_investido_corrigido_centavos: 90_000,
          },
        });
        const sessao = await criarSessaoMinima("2026-07");

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 35_000)],
          executado: [linhaAporteExecutada(alvo.id, alvo.nome, 35_000)],
          valorTotalCentavos: 35_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        expect(incrementos).toHaveLength(0);
      });

      it("linhas de executado com valor_centavos = 0 não geram incremento, mesmo com 1 elegível (§3, gatilho: 'valor_centavos > 0')", async () => {
        const alvo = await prisma.alvo.create({
          data: { nome: "Alvo sem execução", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        await prisma.posicao_manual.create({
          data: {
            chave_manual: "CDB-SEM-EXECUCAO",
            instituicao: "Itaú",
            alvo_id: alvo.id,
            descricao: "CDB elegível, mas não recebeu aporte",
          },
        });
        const outroAlvo = await prisma.alvo.create({
          data: { nome: "Alvo com execução", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        const sessao = await criarSessaoMinima();

        const { aporteId } = await aporteService.registrarAporte({
          sessaoImportId: sessao.id,
          sugestao: [
            linhaAporteExecutada(alvo.id, alvo.nome, 0),
            linhaAporteExecutada(outroAlvo.id, outroAlvo.nome, 100_000),
          ],
          executado: [
            linhaAporteExecutada(alvo.id, alvo.nome, 0),
            linhaAporteExecutada(outroAlvo.id, outroAlvo.nome, 100_000),
          ],
          valorTotalCentavos: 100_000,
          valorDividendosCentavos: 0,
          trocoCentavos: 0,
        });

        const incrementos = await prisma.incremento_valor_investido_pendente.findMany({
          where: { aporte_id: aporteId },
        });
        // Nenhuma linha para `alvo` (valor_centavos=0), nenhuma para
        // `outroAlvo` (0 elegíveis lá) — total 0.
        expect(incrementos).toHaveLength(0);
      });

      it("atomicidade: toda a geração de incrementos roda na mesma transação de registrarAporte — se a transação falhar, nem o aporte nem nenhum incremento persistem", async () => {
        const { sessao } = await criarCenarioSemPendencia();
        const alvo = await prisma.alvo.create({
          data: { nome: "Alvo elegível numa transação que vai falhar", percentual_alvo_bps: 5000, vigencia_inicio: new Date("2026-01-01") },
        });
        await prisma.posicao_manual.create({
          data: {
            chave_manual: "CDB-TRANSACAO-FALHA",
            instituicao: "Itaú",
            alvo_id: alvo.id,
            descricao: "CDB único elegível, mas o aporte vai falhar por outro motivo",
          },
        });

        const aportesAntes = await prisma.aporte.count();
        const incrementosAntes = await prisma.incremento_valor_investido_pendente.count();

        // Força falha da transação por um motivo já validado hoje
        // (dividendosIncluidosIds apontando para um id inexistente/já
        // utilizado — mesma guarda "Falhar Alto, Nunca em Silêncio" já
        // testada em "dividendos — controle de utilização"): a transação
        // inteira deve reverter, inclusive qualquer incremento que teria
        // sido gerado para `alvo` (1 elegível, geraria incremento se a
        // transação tivesse sucesso).
        await expect(
          aporteService.registrarAporte({
            sessaoImportId: sessao.id,
            sugestao: [linhaAporteExecutada(alvo.id, alvo.nome, 55_000)],
            executado: [linhaAporteExecutada(alvo.id, alvo.nome, 55_000)],
            valorTotalCentavos: 55_000,
            valorDividendosCentavos: 0,
            trocoCentavos: 0,
            dividendosIncluidosIds: ["id-de-dividendo-inexistente"],
          }),
        ).rejects.toThrow(/dividendo/i);

        const aportesDepois = await prisma.aporte.count();
        const incrementosDepois = await prisma.incremento_valor_investido_pendente.count();
        expect(aportesDepois).toBe(aportesAntes);
        expect(incrementosDepois).toBe(incrementosAntes);
      });
    },
  );
});
