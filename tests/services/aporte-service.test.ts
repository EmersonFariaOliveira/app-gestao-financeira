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
});
