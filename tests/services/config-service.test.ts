/**
 * tests/services/config-service.test.ts — testes de integração (T058) de
 * src/services/config-service.ts (export/import de configuração JSON)
 * contra um SQLite TEMPORÁRIO, isolado do `data/app.db` real/seed.
 *
 * Segue o mesmo padrão de tests/services/alvo-service.test.ts: como o
 * singleton `@/db/client` lê `DATABASE_URL` do ambiente na hora em que é
 * instanciado, este arquivo aponta `process.env.DATABASE_URL` para um
 * arquivo `.db` temporário ANTES de importar `@/db/client`/
 * `@/services/config-service` — por isso os imports desses módulos são
 * DINÂMICOS (`await import(...)`) dentro de `beforeAll`, nunca `import`
 * estático no topo.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let configService: typeof import("@/services/config-service");
let alvoService: typeof import("@/services/alvo-service");
let mapeamentoService: typeof import("@/services/mapeamento-service");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-service-test-"));
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
  configService = await import("@/services/config-service");
  alvoService = await import("@/services/alvo-service");
  mapeamentoService = await import("@/services/mapeamento-service");
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

describe("config-service — exportarConfigJson", () => {
  it("produz um JSON com o shape esperado: versão, exportadoEm, settings, alvos (só vigência aberta) e vínculos resolvidos", async () => {
    await configService.setConfig("banda_tolerancia_bps", 200);
    await configService.setConfig("aporte_minimo_centavos", 100000);
    await configService.setConfig("retencao_backups", 6);

    const acoes = await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 6000 });
    await alvoService.criarAlvo({ nome: "FIIs", percentualAlvoBps: 4000 });

    await prisma.ativo_mapeado.create({
      data: { chave_export: "PRIO3", alvo_id: acoes.id, fora_da_carteira: false },
    });
    await prisma.ativo_mapeado.create({
      data: { chave_export: "TESOURO-SELIC", alvo_id: null, fora_da_carteira: true },
    });
    // Vínculo pendente (nem alvo nem fora-da-carteira) — NÃO deve aparecer no export.
    await prisma.ativo_mapeado.create({
      data: { chave_export: "PENDENTE-XYZ", alvo_id: null, fora_da_carteira: false },
    });

    const json = await configService.exportarConfigJson();

    expect(json.versao).toBe(1);
    expect(typeof json.exportadoEm).toBe("string");
    expect(new Date(json.exportadoEm).toString()).not.toBe("Invalid Date");

    expect(json.settings).toEqual({
      banda_tolerancia_bps: 200,
      aporte_minimo_centavos: 100000,
      retencao_backups: 6,
    });

    expect(json.alvos.map((a) => a.nome).sort()).toEqual(["Ações BR", "FIIs"]);
    const acoesExport = json.alvos.find((a) => a.nome === "Ações BR")!;
    expect(acoesExport.percentualAlvoBps).toBe(6000);

    expect(json.vinculos.map((v) => v.chaveExport).sort()).toEqual([
      "PRIO3",
      "TESOURO-SELIC",
    ]);
    const vinculoPrio3 = json.vinculos.find((v) => v.chaveExport === "PRIO3")!;
    expect(vinculoPrio3.alvoNome).toBe("Ações BR");
    expect(vinculoPrio3.foraDaCarteira).toBe(false);
    const vinculoFora = json.vinculos.find((v) => v.chaveExport === "TESOURO-SELIC")!;
    expect(vinculoFora.alvoNome).toBeNull();
    expect(vinculoFora.foraDaCarteira).toBe(true);
  });

  it("não inclui alvos de vigências fechadas (histórico)", async () => {
    await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 10000 });
    await alvoService.novaVigencia();
    await alvoService.criarAlvo({ nome: "FIIs", percentualAlvoBps: 2000 });

    const json = await configService.exportarConfigJson();

    // "Ações BR" existe tanto na geração fechada quanto na clonada aberta —
    // deve aparecer só uma vez (a da vigência aberta).
    expect(json.alvos.filter((a) => a.nome === "Ações BR")).toHaveLength(1);
    expect(json.alvos.map((a) => a.nome).sort()).toEqual(["Ações BR", "FIIs"]);
  });

  it("sem nenhum alvo/vínculo cadastrado, exporta arrays vazios (não lança erro)", async () => {
    const json = await configService.exportarConfigJson();

    expect(json.alvos).toEqual([]);
    expect(json.vinculos).toEqual([]);
    // Settings continuam presentes com os defaults documentados.
    expect(json.settings).toEqual({
      banda_tolerancia_bps: 150,
      aporte_minimo_centavos: 50000,
      retencao_backups: 12,
    });
  });
});

describe("config-service — importarConfigJson", () => {
  it("rejeita JSON de versão não suportada, sem tocar no banco", async () => {
    await alvoService.criarAlvo({ nome: "Original", percentualAlvoBps: 10000 });

    await expect(
      configService.importarConfigJson({
        versao: 999,
        exportadoEm: new Date().toISOString(),
        settings: { banda_tolerancia_bps: 100, aporte_minimo_centavos: 1, retencao_backups: 1 },
        alvos: [],
        vinculos: [],
      }),
    ).rejects.toThrow(/versão.*não suportada/i);

    const listagem = await alvoService.listarAlvos();
    expect(listagem.alvos.map((a) => a.nome)).toEqual(["Original"]);
  });

  it("rejeita JSON com campos obrigatórios ausentes", async () => {
    await expect(configService.importarConfigJson({})).rejects.toThrow(/inválido/i);
    await expect(configService.importarConfigJson(null)).rejects.toThrow(/inválido/i);
    await expect(
      configService.importarConfigJson({ versao: 1, settings: {}, alvos: [], vinculos: [] }),
    ).rejects.toThrow(/settings/i);
  });

  it("rejeita JSON que não é um objeto (array, string, número) sem tocar no banco", async () => {
    await alvoService.criarAlvo({ nome: "Original", percentualAlvoBps: 10000 });

    await expect(configService.importarConfigJson([])).rejects.toThrow(/inválido/i);
    await expect(configService.importarConfigJson("não é json")).rejects.toThrow(/inválido/i);
    await expect(configService.importarConfigJson(42)).rejects.toThrow(/inválido/i);
    await expect(configService.importarConfigJson(true)).rejects.toThrow(/inválido/i);

    const listagem = await alvoService.listarAlvos();
    expect(listagem.alvos.map((a) => a.nome)).toEqual(["Original"]);
  });

  it("importa com sucesso um JSON de ZERO alvos e ZERO vínculos (restaura para um estado vazio)", async () => {
    await alvoService.criarAlvo({ nome: "Antigo", percentualAlvoBps: 10000 });

    const resultado = await configService.importarConfigJson({
      versao: 1,
      exportadoEm: new Date().toISOString(),
      settings: { banda_tolerancia_bps: 150, aporte_minimo_centavos: 50000, retencao_backups: 12 },
      alvos: [],
      vinculos: [],
    });

    expect(resultado.alvosCriados).toBe(0);
    expect(resultado.vinculosCriados).toBe(0);
    expect(resultado.vinculosAtualizados).toBe(0);

    // A vigência antiga foi fechada (mesmo mecanismo de novaVigencia), mas
    // nenhum alvo novo foi criado — a lista de alvos abertos fica vazia.
    const listagem = await alvoService.listarAlvos();
    expect(listagem.alvos).toEqual([]);
  });

  it("aceita alvos cuja soma de percentualAlvoBps não fecha em 10000 (validação de soma é só um alerta visual da UI, não bloqueante aqui)", async () => {
    const resultado = await configService.importarConfigJson({
      versao: 1,
      exportadoEm: new Date().toISOString(),
      settings: { banda_tolerancia_bps: 150, aporte_minimo_centavos: 50000, retencao_backups: 12 },
      alvos: [
        { nome: "Ações BR", percentualAlvoBps: 3000 },
        { nome: "FIIs", percentualAlvoBps: 3000 },
      ],
      vinculos: [],
    });

    expect(resultado.alvosCriados).toBe(2);
    const listagem = await alvoService.listarAlvos();
    expect(listagem.alvos.map((a) => a.percentualAlvoBps).sort()).toEqual([3000, 3000]);
  });

  it("rejeita vínculo que referencia um alvo ausente da lista de alvos do próprio JSON", async () => {
    await expect(
      configService.importarConfigJson({
        versao: 1,
        exportadoEm: new Date().toISOString(),
        settings: { banda_tolerancia_bps: 150, aporte_minimo_centavos: 50000, retencao_backups: 12 },
        alvos: [{ nome: "Ações BR", percentualAlvoBps: 10000 }],
        vinculos: [{ chaveExport: "PRIO3", alvoNome: "Nome Inexistente", foraDaCarteira: false }],
      }),
    ).rejects.toThrow(/não está presente na lista de alvos/i);
  });

  it("restaura settings, substitui os alvos da vigência aberta e recria vínculos por nome", async () => {
    await configService.setConfig("banda_tolerancia_bps", 999);
    const antigo = await alvoService.criarAlvo({ nome: "Antigo", percentualAlvoBps: 10000 });
    await prisma.ativo_mapeado.create({
      data: { chave_export: "ANTIGO-ATIVO", alvo_id: antigo.id, fora_da_carteira: false },
    });

    const json: import("@/services/config-service").ConfigExportJson = {
      versao: 1,
      exportadoEm: new Date().toISOString(),
      settings: { banda_tolerancia_bps: 150, aporte_minimo_centavos: 70000, retencao_backups: 8 },
      alvos: [
        { nome: "Ações BR", percentualAlvoBps: 6000 },
        { nome: "FIIs", percentualAlvoBps: 4000 },
      ],
      vinculos: [
        { chaveExport: "PRIO3", alvoNome: "Ações BR", foraDaCarteira: false },
        { chaveExport: "HGLG11", alvoNome: "FIIs", foraDaCarteira: false },
        { chaveExport: "TESOURO-SELIC", alvoNome: null, foraDaCarteira: true },
      ],
    };

    const resultado = await configService.importarConfigJson(json);

    expect(resultado.alvosCriados).toBe(2);
    expect(resultado.vinculosCriados).toBe(3);
    expect(resultado.vinculosAtualizados).toBe(0);

    // Settings aplicados.
    expect(await configService.getConfig("banda_tolerancia_bps")).toBe(150);
    expect(await configService.getConfig("aporte_minimo_centavos")).toBe(70000);
    expect(await configService.getConfig("retencao_backups")).toBe(8);

    // Alvos da vigência aberta substituídos pelos do JSON.
    const listagem = await alvoService.listarAlvos();
    expect(listagem.alvos.map((a) => a.nome).sort()).toEqual(["Ações BR", "FIIs"]);

    // O alvo antigo NÃO foi deletado — virou histórico (vigência fechada).
    const antigoNoBanco = await prisma.alvo.findUniqueOrThrow({ where: { id: antigo.id } });
    expect(antigoNoBanco.vigencia_fim).not.toBeNull();
    expect(antigoNoBanco.nome).toBe("Antigo");

    // Vínculos recriados apontando para os NOVOS alvos (não para os antigos ids).
    const vinculos = await mapeamentoService.listarVinculos();
    expect(vinculos.vinculados.map((v) => v.chaveExport).sort()).toEqual([
      "ANTIGO-ATIVO",
      "HGLG11",
      "PRIO3",
    ]);
    const acoesNovo = listagem.alvos.find((a) => a.nome === "Ações BR")!;
    const vinculoPrio3 = vinculos.vinculados.find((v) => v.chaveExport === "PRIO3")!;
    expect(vinculoPrio3.alvoId).toBe(acoesNovo.id);
    expect(vinculos.foraDaCarteira.map((v) => v.chaveExport)).toEqual(["TESOURO-SELIC"]);

    // Vínculo "ANTIGO-ATIVO" (não presente no JSON importado) NÃO foi apagado
    // — política de merge: continua existindo, agora apontando para o alvo
    // antigo (histórico), até o usuário revincular manualmente.
    const antigoAtivo = await prisma.ativo_mapeado.findUniqueOrThrow({
      where: { chave_export: "ANTIGO-ATIVO" },
    });
    expect(antigoAtivo.alvo_id).toBe(antigo.id);
  });

  it("upsert de vínculo já existente é contado como 'atualizado', não 'criado'", async () => {
    await prisma.ativo_mapeado.create({
      data: { chave_export: "PRIO3", alvo_id: null, fora_da_carteira: false },
    });

    const resultado = await configService.importarConfigJson({
      versao: 1,
      exportadoEm: new Date().toISOString(),
      settings: { banda_tolerancia_bps: 150, aporte_minimo_centavos: 50000, retencao_backups: 12 },
      alvos: [{ nome: "Ações BR", percentualAlvoBps: 10000 }],
      vinculos: [{ chaveExport: "PRIO3", alvoNome: "Ações BR", foraDaCarteira: false }],
    });

    expect(resultado.vinculosCriados).toBe(0);
    expect(resultado.vinculosAtualizados).toBe(1);
  });

  it("CRÍTICO: nunca toca sessao_import, posicao, aporte ou dividendo", async () => {
    const alvo = await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 10000 });
    const vinculo = await prisma.ativo_mapeado.create({
      data: { chave_export: "PRIO3", alvo_id: alvo.id, fora_da_carteira: false },
    });

    const sessao = await prisma.sessao_import.create({
      data: {
        mes_referencia: "2026-06",
        data_export: new Date("2026-06-30"),
        status: "VIGENTE",
        instituicoes: JSON.stringify(["Corretora X"]),
      },
    });
    await prisma.posicao.create({
      data: {
        sessao_import_id: sessao.id,
        chave_export: "PRIO3",
        instituicao: "Corretora X",
        quantidade: "100",
        patrimonio_hoje_centavos: 500000,
        tipo_grupo: "ACAO",
      },
    });
    const aporte = await prisma.aporte.create({
      data: {
        sessao_import_id: sessao.id,
        valor_total_centavos: 100000,
        valor_dividendos_centavos: 0,
        sugestao: JSON.stringify([]),
        executado: JSON.stringify([]),
        troco_centavos: 0,
      },
    });
    const dividendo = await prisma.dividendo.create({
      data: {
        chave_export: "PRIO3",
        mes_referencia: "2026-06",
        valor_centavos: 1500,
        aporte_id: aporte.id,
      },
    });

    await configService.importarConfigJson({
      versao: 1,
      exportadoEm: new Date().toISOString(),
      settings: { banda_tolerancia_bps: 150, aporte_minimo_centavos: 50000, retencao_backups: 12 },
      alvos: [{ nome: "Nova Config", percentualAlvoBps: 10000 }],
      vinculos: [{ chaveExport: "OUTRO-ATIVO", alvoNome: "Nova Config", foraDaCarteira: false }],
    });

    const sessaoIntacta = await prisma.sessao_import.findUniqueOrThrow({ where: { id: sessao.id } });
    expect(sessaoIntacta.status).toBe("VIGENTE");
    expect(sessaoIntacta.mes_referencia).toBe("2026-06");

    const posicaoIntacta = await prisma.posicao.findFirstOrThrow({
      where: { sessao_import_id: sessao.id },
    });
    expect(posicaoIntacta.patrimonio_hoje_centavos).toBe(500000);

    const aporteIntacto = await prisma.aporte.findUniqueOrThrow({ where: { id: aporte.id } });
    expect(aporteIntacto.valor_total_centavos).toBe(100000);

    const dividendoIntacto = await prisma.dividendo.findUniqueOrThrow({ where: { id: dividendo.id } });
    expect(dividendoIntacto.valor_centavos).toBe(1500);
    expect(dividendoIntacto.aporte_id).toBe(aporte.id);

    // O ativo_mapeado antigo (referenciado pelo dividendo via chave_export)
    // continua existindo — não foi apagado pelo import de config.
    const vinculoIntacto = await prisma.ativo_mapeado.findUniqueOrThrow({
      where: { chave_export: "PRIO3" },
    });
    expect(vinculoIntacto.chave_export).toBe(vinculo.chave_export);
  });

  it("roundtrip export → import preserva o estado configurável (settings, alvos e vínculos)", async () => {
    await configService.setConfig("banda_tolerancia_bps", 175);
    await configService.setConfig("aporte_minimo_centavos", 80000);
    await configService.setConfig("retencao_backups", 10);

    const acoes = await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 5500 });
    const fiis = await alvoService.criarAlvo({ nome: "FIIs", percentualAlvoBps: 2500 });
    await alvoService.criarAlvo({ nome: "Pós-fixado", percentualAlvoBps: 2000 });

    await prisma.ativo_mapeado.create({
      data: { chave_export: "PRIO3", alvo_id: acoes.id, fora_da_carteira: false },
    });
    await prisma.ativo_mapeado.create({
      data: { chave_export: "HGLG11", alvo_id: fiis.id, fora_da_carteira: false },
    });
    await prisma.ativo_mapeado.create({
      data: { chave_export: "TESOURO-SELIC", alvo_id: null, fora_da_carteira: true },
    });

    const exportado = await configService.exportarConfigJson();

    // Roundtrip num banco "limpo" de config (simula restaurar em outra máquina).
    await resetDb();

    const resultado = await configService.importarConfigJson(exportado);
    expect(resultado.alvosCriados).toBe(3);
    expect(resultado.vinculosCriados).toBe(3);

    const reexportado = await configService.exportarConfigJson();

    expect(reexportado.settings).toEqual(exportado.settings);
    expect(reexportado.alvos.map((a) => `${a.nome}:${a.percentualAlvoBps}`).sort()).toEqual(
      exportado.alvos.map((a) => `${a.nome}:${a.percentualAlvoBps}`).sort(),
    );
    expect(
      reexportado.vinculos.map((v) => `${v.chaveExport}:${v.alvoNome}:${v.foraDaCarteira}`).sort(),
    ).toEqual(
      exportado.vinculos.map((v) => `${v.chaveExport}:${v.alvoNome}:${v.foraDaCarteira}`).sort(),
    );
  });
});
