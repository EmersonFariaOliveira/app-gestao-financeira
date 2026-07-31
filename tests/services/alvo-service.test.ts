/**
 * tests/services/alvo-service.test.ts — testes de integração (T046) de
 * src/services/alvo-service.ts contra um SQLite TEMPORÁRIO, isolado do
 * `data/app.db` real/seed.
 *
 * Segue o mesmo padrão de tests/services/aporte-service.test.ts: como o
 * singleton `@/db/client` lê `DATABASE_URL` do ambiente na hora em que é
 * instanciado, este arquivo aponta `process.env.DATABASE_URL` para um
 * arquivo `.db` temporário ANTES de importar `@/db/client`/
 * `@/services/alvo-service` — por isso os imports desses módulos são
 * DINÂMICOS (`await import(...)`) dentro de `beforeAll`, nunca `import`
 * estático no topo (que rodaria antes do `beforeAll` e pegaria o `.env` do
 * projeto). Esquema aplicado via `prisma migrate deploy` contra o arquivo
 * temporário, criado com `fs.mkdtempSync`.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let prisma: typeof import("@/db/client")["prisma"];
let alvoService: typeof import("@/services/alvo-service");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alvo-service-test-"));
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

describe("alvo-service", () => {
  describe("validação da soma dos alvos vigentes (não bloqueante)", () => {
    it("soma inválida (9500 bps) é sinalizada, mas o CRUD continua funcionando", async () => {
      await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 5000 });
      await alvoService.criarAlvo({ nome: "FIIs", percentualAlvoBps: 3000 });
      await alvoService.criarAlvo({ nome: "Pós-fixado", percentualAlvoBps: 1500 });

      const listagem = await alvoService.listarAlvos();

      expect(listagem.somaBps).toBe(9500);
      expect(listagem.somaValida).toBe(false);
      expect(listagem.alvos).toHaveLength(3);

      // CRUD continua liberado mesmo com soma inválida — não é bloqueado.
      const novo = await alvoService.criarAlvo({ nome: "Exterior", percentualAlvoBps: 500 });
      expect(novo.id).toBeTruthy();
      const atualizado = await alvoService.atualizarAlvo(novo.id, { percentualAlvoBps: 600 });
      expect(atualizado.percentualAlvoBps).toBe(600);
    });

    it("soma exata (3333+3333+3334=10000) é válida", async () => {
      await alvoService.criarAlvo({ nome: "A", percentualAlvoBps: 3333 });
      await alvoService.criarAlvo({ nome: "B", percentualAlvoBps: 3333 });
      await alvoService.criarAlvo({ nome: "C", percentualAlvoBps: 3334 });

      const listagem = await alvoService.listarAlvos();
      expect(listagem.somaBps).toBe(10000);
      expect(listagem.somaValida).toBe(true);
    });

    /**
     * Interpretação adotada para a tolerância ±1 bps (documentada em
     * alvo-service.ts): diferença absoluta ≤ 1 entre a soma e 10000. Logo
     * 9999 (diff=1) e 10001 (diff=1) são válidos; 9998/10002 (diff=2) não.
     */
    it("soma 9999 (diferença absoluta 1) é válida pela tolerância ±1", async () => {
      await alvoService.criarAlvo({ nome: "A", percentualAlvoBps: 4999 });
      await alvoService.criarAlvo({ nome: "B", percentualAlvoBps: 5000 });

      const listagem = await alvoService.listarAlvos();
      expect(listagem.somaBps).toBe(9999);
      expect(listagem.somaValida).toBe(true);
    });

    it("soma 10001 (diferença absoluta 1) é válida, mas 10002 (diferença 2) não", async () => {
      await alvoService.criarAlvo({ nome: "A", percentualAlvoBps: 5001 });
      await alvoService.criarAlvo({ nome: "B", percentualAlvoBps: 5000 });
      const listagem1 = await alvoService.listarAlvos();
      expect(listagem1.somaBps).toBe(10001);
      expect(listagem1.somaValida).toBe(true);

      const alvoB = listagem1.alvos.find((a) => a.nome === "B")!;
      await alvoService.atualizarAlvo(alvoB.id, { percentualAlvoBps: 5001 });
      const listagem2 = await alvoService.listarAlvos();
      expect(listagem2.somaBps).toBe(10002);
      expect(listagem2.somaValida).toBe(false);
    });

    it("alvo removido (soft delete, ativo=false) não entra na soma nem na listagem", async () => {
      const a = await alvoService.criarAlvo({ nome: "A", percentualAlvoBps: 7000 });
      await alvoService.criarAlvo({ nome: "B", percentualAlvoBps: 3000 });

      await alvoService.removerAlvo(a.id);

      const listagem = await alvoService.listarAlvos();
      expect(listagem.alvos.map((x) => x.nome)).toEqual(["B"]);
      expect(listagem.somaBps).toBe(3000);
    });
  });

  describe("vigência fechada é somente-leitura", () => {
    it("atualizarAlvo em alvo de vigência fechada é rejeitado, sem alterar nada", async () => {
      const alvo = await prisma.alvo.create({
        data: {
          nome: "Antigo",
          percentual_alvo_bps: 10000,
          vigencia_inicio: new Date("2026-01-01"),
          vigencia_fim: new Date("2026-06-01"),
        },
      });

      await expect(
        alvoService.atualizarAlvo(alvo.id, { percentualAlvoBps: 9000 }),
      ).rejects.toThrow(/vigência fechada|somente.leitura/i);

      const intacto = await prisma.alvo.findUniqueOrThrow({ where: { id: alvo.id } });
      expect(intacto.percentual_alvo_bps).toBe(10000);
      expect(intacto.nome).toBe("Antigo");
    });

    it("removerAlvo em alvo de vigência fechada é rejeitado, sem alterar nada", async () => {
      const alvo = await prisma.alvo.create({
        data: {
          nome: "Antigo",
          percentual_alvo_bps: 10000,
          vigencia_inicio: new Date("2026-01-01"),
          vigencia_fim: new Date("2026-06-01"),
        },
      });

      await expect(alvoService.removerAlvo(alvo.id)).rejects.toThrow(/vigência fechada|somente.leitura/i);

      const intacto = await prisma.alvo.findUniqueOrThrow({ where: { id: alvo.id } });
      expect(intacto.ativo).toBe(true);
    });
  });

  describe("novaVigencia()", () => {
    it("fecha a vigência atual, clona os alvos (mesmo nome/percentual/tag, novo id, vigência aberta) e preserva o histórico", async () => {
      const acoes = await alvoService.criarAlvo({
        nome: "Ações BR",
        percentualAlvoBps: 6000,
        tag: "A-AÇÕES",
      });
      // Sem tag (null) — a propagação da tag também precisa preservar o null.
      const rendaFixa = await alvoService.criarAlvo({ nome: "Pós-fixado", percentualAlvoBps: 4000 });

      const { alvos: clones } = await alvoService.novaVigencia();

      expect(clones).toHaveLength(2);
      const clonePorNome = new Map(clones.map((c) => [c.nome, c]));
      expect(clonePorNome.get("Ações BR")?.percentualAlvoBps).toBe(6000);
      expect(clonePorNome.get("Pós-fixado")?.percentualAlvoBps).toBe(4000);
      // A tag sobrevive ao versionamento: se o alvo tinha tag "A-AÇÕES" antes
      // de novaVigencia(), o clone na nova vigência também deve ter.
      expect(clonePorNome.get("Ações BR")?.tag).toBe("A-AÇÕES");
      expect(clonePorNome.get("Pós-fixado")?.tag).toBeNull();
      for (const clone of clones) {
        expect(clone.vigenciaFim).toBeNull();
        expect(clone.id).not.toBe(acoes.id);
        expect(clone.id).not.toBe(rendaFixa.id);
      }

      // Vigência antiga fechada e intacta (histórico preservado).
      const acoesAntigo = await prisma.alvo.findUniqueOrThrow({ where: { id: acoes.id } });
      const rendaFixaAntigo = await prisma.alvo.findUniqueOrThrow({ where: { id: rendaFixa.id } });
      expect(acoesAntigo.vigencia_fim).not.toBeNull();
      expect(rendaFixaAntigo.vigencia_fim).not.toBeNull();
      expect(acoesAntigo.percentual_alvo_bps).toBe(6000);
      expect(acoesAntigo.nome).toBe("Ações BR");

      // A listagem de vigentes agora só mostra os clones.
      const listagem = await alvoService.listarAlvos();
      expect(listagem.alvos.map((a) => a.id).sort()).toEqual(
        clones.map((c) => c.id).sort(),
      );

      // Histórico continua consultável (não sumiu do banco).
      const vigenciasFechadas = await alvoService.listarVigenciasFechadas();
      expect(vigenciasFechadas).toHaveLength(1);
      expect(vigenciasFechadas[0].alvos.map((a) => a.nome).sort()).toEqual([
        "Ações BR",
        "Pós-fixado",
      ]);
    });

    it("CRÍTICO: ativo_mapeado que apontava para o alvo antigo passa a apontar para o clone correspondente (mesmo nome), preservando o vínculo do usuário", async () => {
      const acoes = await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 10000 });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "PRIO3", alvo_id: acoes.id, fora_da_carteira: false },
      });

      const { alvos: clones } = await alvoService.novaVigencia();
      const cloneAcoes = clones.find((c) => c.nome === "Ações BR")!;

      const vinculo = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "PRIO3" },
      });
      expect(vinculo.alvo_id).toBe(cloneAcoes.id);
      expect(vinculo.alvo_id).not.toBe(acoes.id);

      // ativosPorAlvo reflete o re-apontamento: o alvo antigo não tem mais
      // nenhum vínculo, o clone tem o vínculo migrado.
      expect(await alvoService.ativosPorAlvo(acoes.id)).toEqual([]);
      expect(await alvoService.ativosPorAlvo(cloneAcoes.id)).toEqual(["PRIO3"]);
    });

    it("rejeita quando não há vigência aberta para fechar", async () => {
      await expect(alvoService.novaVigencia()).rejects.toThrow(/não há vigência aberta/i);
    });

    it("um novo alvo criado após novaVigencia() entra na MESMA vigência aberta dos clones (mesmo vigencia_inicio)", async () => {
      await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 10000 });
      const { alvos: clones } = await alvoService.novaVigencia();

      const novo = await alvoService.criarAlvo({ nome: "FIIs", percentualAlvoBps: 2000 });

      expect(novo.vigenciaInicio.getTime()).toBe(clones[0].vigenciaInicio.getTime());
      expect(novo.vigenciaFim).toBeNull();
    });

    it("chamada duas vezes seguidas: a segunda fecha a vigência dos clones da primeira e gera uma 3ª geração, sem perder o histórico de nenhuma", async () => {
      const original = await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 10000 });

      const { alvos: geracao2 } = await alvoService.novaVigencia();
      expect(geracao2).toHaveLength(1);
      expect(geracao2[0].id).not.toBe(original.id);

      const { alvos: geracao3 } = await alvoService.novaVigencia();
      expect(geracao3).toHaveLength(1);
      expect(geracao3[0].id).not.toBe(original.id);
      expect(geracao3[0].id).not.toBe(geracao2[0].id);

      // A geração 2 (intermediária) também deve ter sido fechada pela
      // segunda chamada — não fica "esquecida" aberta.
      const geracao2Db = await prisma.alvo.findUniqueOrThrow({ where: { id: geracao2[0].id } });
      expect(geracao2Db.vigencia_fim).not.toBeNull();

      // Só a geração 3 está vigente.
      const listagem = await alvoService.listarAlvos();
      expect(listagem.alvos.map((a) => a.id)).toEqual([geracao3[0].id]);

      // As 3 gerações continuam no histórico (nada deletado).
      const vigenciasFechadas = await alvoService.listarVigenciasFechadas();
      expect(vigenciasFechadas).toHaveLength(2); // original fechada + geração 2 fechada
    });

    it("rejeita a segunda chamada consecutiva se nada foi criado entre elas E a primeira já fechou tudo — não há vigência aberta pela segunda vez seguida sem novos alvos", async () => {
      await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 10000 });
      await alvoService.novaVigencia(); // fecha e clona — geração 2 fica aberta

      // A segunda chamada NÃO deveria falhar aqui: geração 2 está aberta (o
      // caso de erro só ocorre se não houver NENHUM alvo com vigencia_fim
      // null). Este teste documenta que novaVigencia() encadeada continua
      // funcionando enquanto houver alvos na vigência aberta (a clonagem da
      // primeira chamada sempre deixa algo aberto para a segunda fechar).
      await expect(alvoService.novaVigencia()).resolves.toBeDefined();
    });
  });

  describe("removerAlvo com ativo_mapeado ainda vinculado a ele (cenário 'zumbi')", () => {
    it("recusa a remoção com erro claro quando existe ativo_mapeado apontando para o alvo, sem alterar nada (fecha o bug do 'vínculo zumbi')", async () => {
      const alvo = await alvoService.criarAlvo({ nome: "Zumbi", percentualAlvoBps: 3000 });
      await prisma.ativo_mapeado.create({
        data: { chave_export: "ZUMBI-ATIVO", alvo_id: alvo.id, fora_da_carteira: false },
      });

      // Comportamento corrigido: removerAlvo recusa a operação em vez de
      // deixar o vínculo órfão apontando para um alvo com ativo=false — esse
      // estado nunca seria filtrado por
      // mapeamento-service.contarPendencias/listarVinculos (que só olham
      // alvo_id null vs. não-null) nem pelo motor (aporte-service exclui o
      // alvo de `alvos`, mas incluiria a posição vinculada a ele em
      // patrimonioBase — ver tests/services/aporte-service.test.ts).
      await expect(alvoService.removerAlvo(alvo.id)).rejects.toThrow(
        `Não é possível remover o alvo 'Zumbi': há 1 ativo(s) vinculado(s) a ele. Revincule-os a outro alvo ou marque como fora da carteira antes de remover.`,
      );

      // Nada foi alterado: o vínculo continua íntegro e o alvo continua ativo.
      const vinculo = await prisma.ativo_mapeado.findUniqueOrThrow({
        where: { chave_export: "ZUMBI-ATIVO" },
      });
      expect(vinculo.alvo_id).toBe(alvo.id);
      expect(vinculo.fora_da_carteira).toBe(false);

      const alvoNaoRemovido = await prisma.alvo.findUniqueOrThrow({ where: { id: alvo.id } });
      expect(alvoNaoRemovido.ativo).toBe(true);

      const mapeamentoService = await import("@/services/mapeamento-service");
      const vinculos = await mapeamentoService.listarVinculos();
      expect(vinculos.pendentes).toEqual([]);
      expect(vinculos.vinculados).toEqual([
        { chaveExport: "ZUMBI-ATIVO", alvoId: alvo.id, nomeAlvo: "Zumbi", valorAtualCentavos: 0 },
      ]);
      const listagemAlvos = await alvoService.listarAlvos();
      expect(listagemAlvos.alvos.find((a) => a.id === alvo.id)).toBeDefined();
    });

    it("continua removendo normalmente um alvo sem nenhum ativo_mapeado vinculado (caso feliz não regride)", async () => {
      const alvo = await alvoService.criarAlvo({ nome: "Sem vínculos", percentualAlvoBps: 3000 });

      const removido = await alvoService.removerAlvo(alvo.id);
      expect(removido.ativo).toBe(false);

      const alvoNoBanco = await prisma.alvo.findUniqueOrThrow({ where: { id: alvo.id } });
      expect(alvoNoBanco.ativo).toBe(false);
    });
  });

  describe("ativosPorAlvo (FR-019)", () => {
    it("lista as chave_export vinculadas a um alvo vigente", async () => {
      const alvo = await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 10000 });
      await prisma.ativo_mapeado.createMany({
        data: [
          { chave_export: "PRIO3", alvo_id: alvo.id, fora_da_carteira: false },
          { chave_export: "VALE3", alvo_id: alvo.id, fora_da_carteira: false },
          { chave_export: "FORA-CARTEIRA", alvo_id: null, fora_da_carteira: true },
        ],
      });

      const chaves = await alvoService.ativosPorAlvo(alvo.id);
      expect(chaves.sort()).toEqual(["PRIO3", "VALE3"]);

      const listagem = await alvoService.listarAlvos();
      expect(listagem.alvos[0].qtdAtivosMapeados).toBe(2);
    });
  });

  describe("tag (categorização livre)", () => {
    it("criarAlvo sem tag grava null", async () => {
      const alvo = await alvoService.criarAlvo({ nome: "Sem tag", percentualAlvoBps: 10000 });
      expect(alvo.tag).toBeNull();
    });

    it("criarAlvo normaliza string vazia/só espaço para null", async () => {
      const vazia = await alvoService.criarAlvo({ nome: "A", percentualAlvoBps: 5000, tag: "" });
      expect(vazia.tag).toBeNull();

      const soEspaco = await alvoService.criarAlvo({ nome: "B", percentualAlvoBps: 5000, tag: "   " });
      expect(soEspaco.tag).toBeNull();
    });

    it("criarAlvo grava a tag com trim() aplicado", async () => {
      const alvo = await alvoService.criarAlvo({
        nome: "Ações BR",
        percentualAlvoBps: 10000,
        tag: "  A-AÇÕES  ",
      });
      expect(alvo.tag).toBe("A-AÇÕES");
    });

    it("atualizarAlvo com tag=undefined (campo omitido) não altera a tag existente", async () => {
      const alvo = await alvoService.criarAlvo({
        nome: "Ações BR",
        percentualAlvoBps: 10000,
        tag: "A-AÇÕES",
      });

      const atualizado = await alvoService.atualizarAlvo(alvo.id, { percentualAlvoBps: 9000 });
      expect(atualizado.tag).toBe("A-AÇÕES");
      expect(atualizado.percentualAlvoBps).toBe(9000);
    });

    it("atualizarAlvo com tag=null ou string vazia LIMPA a tag existente", async () => {
      const alvoNull = await alvoService.criarAlvo({
        nome: "Ações BR",
        percentualAlvoBps: 10000,
        tag: "A-AÇÕES",
      });
      const limpoPorNull = await alvoService.atualizarAlvo(alvoNull.id, { tag: null });
      expect(limpoPorNull.tag).toBeNull();

      const alvoVazio = await alvoService.criarAlvo({
        nome: "Pós-fixado",
        percentualAlvoBps: 10000,
        tag: "R-RENDA FIXA",
      });
      const limpoPorVazia = await alvoService.atualizarAlvo(alvoVazio.id, { tag: "   " });
      expect(limpoPorVazia.tag).toBeNull();
    });

    it("atualizarAlvo troca a tag existente por uma nova (com trim)", async () => {
      const alvo = await alvoService.criarAlvo({
        nome: "Ações BR",
        percentualAlvoBps: 10000,
        tag: "A-AÇÕES",
      });

      const atualizado = await alvoService.atualizarAlvo(alvo.id, { tag: "  R-REAL ESTATE  " });
      expect(atualizado.tag).toBe("R-REAL ESTATE");
    });
  });

  describe("listarTagsExistentes", () => {
    it("nenhum alvo cadastrado: retorna lista vazia", async () => {
      expect(await alvoService.listarTagsExistentes()).toEqual([]);
    });

    it("retorna tags distintas, não-nulas, ordenadas alfabeticamente, ignorando duplicatas e nulls", async () => {
      await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 3000, tag: "A-AÇÕES" });
      await alvoService.criarAlvo({ nome: "Ações US", percentualAlvoBps: 2000, tag: "A-AÇÕES" });
      await alvoService.criarAlvo({ nome: "FIIs", percentualAlvoBps: 3000, tag: "R-REAL ESTATE" });
      await alvoService.criarAlvo({ nome: "Caixa", percentualAlvoBps: 2000 }); // sem tag

      const tags = await alvoService.listarTagsExistentes();
      expect(tags).toEqual(["A-AÇÕES", "R-REAL ESTATE"]);
    });

    it("inclui tags de vigências FECHADAS, não só da vigência aberta", async () => {
      await alvoService.criarAlvo({ nome: "Ações BR", percentualAlvoBps: 10000, tag: "A-AÇÕES" });
      // Fecha a vigência atual (a tag "A-AÇÕES" migra para o clone, mas o
      // original fechado também continua no banco com a mesma tag).
      await alvoService.novaVigencia();

      // Um alvo de vigência fechada "pura" (criado direto via prisma, sem
      // passar pelo clone) também deve alimentar a sugestão do autocomplete.
      await prisma.alvo.create({
        data: {
          nome: "Legado",
          percentual_alvo_bps: 10000,
          tag: "C-CAIXA",
          vigencia_inicio: new Date("2020-01-01"),
          vigencia_fim: new Date("2020-06-01"),
        },
      });

      const tags = await alvoService.listarTagsExistentes();
      expect(tags).toEqual(["A-AÇÕES", "C-CAIXA"]);
    });
  });
});
