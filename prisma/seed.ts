import { PrismaClient } from "@prisma/client";

// Seed sintético (T013): habilita testar a calculadora (US1) de ponta a
// ponta antes de US2 (import real) e US3 (vínculos) existirem.
//
// Cenário:
// - 4 alvos vigentes somando exatamente 10000 bps.
// - 1 sessão de import VIGENTE com posições de 2 instituições, incluindo
//   uma chave (WRLD11) repetida em instituições diferentes para exercitar
//   a consolidação por chave_export.
// - Vínculos completos para todas as chaves das posições — nenhuma
//   pendência, para não bloquear a calculadora no teste do MVP.
// - 1 ativo (PETR4) marcado fora_da_carteira=true, para exercitar a
//   exclusão da base de percentuais/déficits.
// - Feature 002 (specs/002-posicoes-manuais-ajustes): 1 ativo_mapeado
//   existente marcado ignorar_no_import=true ("Tesouro Selic 2029"), 1
//   posicao_manual ativa (CDB) que o substitui, com posicao_manual_valor
//   na sessão VIGENTE, e 1 ajuste_valor_investido sobre um chave_export
//   já vinculado a um alvo ("Tesouro IPCA+ 2035").
// - Feature 003 (specs/003-dashboard-analise-rendimento): a sessão
//   2026-07 tem patrimonio_investido_centavos preenchido em todas as
//   posições, exceto "Tesouro IPCA+ 2035" (cujo valor investido é
//   resolvido via ajuste_valor_investido, não via posicao) — isso, junto
//   com a 2ª sessão VIGENTE (2026-08, ver bloco abaixo), habilita testar
//   variação de rendimento entre as duas sessões semeadas sem depender de
//   import manual.
//
// Regra inviolável: nenhum valor monetário como float — tudo em
// *_centavos (Int) e percentuais em *_bps (Int).

const prisma = new PrismaClient();

async function main() {
  console.log("Seed: limpando dados sintéticos anteriores...");
  // Ordem respeita FKs (dividendo -> aporte/ativo_mapeado; posicao/aporte ->
  // sessao_import; ativo_mapeado -> alvo; entidades da feature 002 são
  // filhas de alvo/ativo_mapeado/posicao_manual/sessao_import/aporte,
  // por isso são apagadas primeiro). Seed é o único código com permissão
  // para apagar dados — não usar este padrão em serviços.
  await prisma.incremento_valor_investido_pendente.deleteMany();
  await prisma.dividendo.deleteMany();
  await prisma.posicao_manual_valor.deleteMany();
  await prisma.ajuste_valor_investido.deleteMany();
  await prisma.aporte.deleteMany();
  await prisma.posicao.deleteMany();
  await prisma.ativo_mapeado.deleteMany();
  await prisma.posicao_manual.deleteMany();
  await prisma.sessao_import.deleteMany();
  await prisma.alvo.deleteMany();

  console.log("Seed: criando alvos vigentes (soma = 10000 bps)...");
  const vigenciaInicio = new Date("2026-01-01T00:00:00.000Z");

  const alvoWrld11 = await prisma.alvo.create({
    data: {
      nome: "WRLD11",
      percentual_alvo_bps: 3000,
      vigencia_inicio: vigenciaInicio,
    },
  });
  const alvoIvvb11 = await prisma.alvo.create({
    data: {
      nome: "IVVB11",
      percentual_alvo_bps: 2000,
      vigencia_inicio: vigenciaInicio,
    },
  });
  const alvoPosFixado = await prisma.alvo.create({
    data: {
      nome: "Pós-fixado",
      percentual_alvo_bps: 3000,
      vigencia_inicio: vigenciaInicio,
    },
  });
  const alvoIpca = await prisma.alvo.create({
    data: {
      nome: "Tesouro IPCA+",
      percentual_alvo_bps: 2000,
      vigencia_inicio: vigenciaInicio,
    },
  });

  const somaBps =
    alvoWrld11.percentual_alvo_bps +
    alvoIvvb11.percentual_alvo_bps +
    alvoPosFixado.percentual_alvo_bps +
    alvoIpca.percentual_alvo_bps;
  if (somaBps !== 10000) {
    throw new Error(`Seed inválido: soma dos alvos = ${somaBps}, esperado 10000`);
  }

  console.log("Seed: criando sessão de import VIGENTE...");
  const dataExport = new Date("2026-07-28T00:00:00.000Z");
  const sessao = await prisma.sessao_import.create({
    data: {
      mes_referencia: "2026-07",
      data_export: dataExport,
      status: "VIGENTE",
      instituicoes: JSON.stringify(["Itaú", "Nubank"]),
    },
  });

  console.log("Seed: criando posições (algumas consolidáveis por chave)...");
  await prisma.posicao.createMany({
    data: [
      // WRLD11 em duas instituições -> consolida em uma posição por chave
      {
        sessao_import_id: sessao.id,
        chave_export: "WRLD11",
        instituicao: "Itaú",
        quantidade: "50",
        patrimonio_hoje_centavos: 500000,
        patrimonio_investido_centavos: 460000,
        tipo_grupo: "ETF",
        data_ultima_cotacao: dataExport,
      },
      {
        sessao_import_id: sessao.id,
        chave_export: "WRLD11",
        instituicao: "Nubank",
        quantidade: "30",
        patrimonio_hoje_centavos: 300000,
        patrimonio_investido_centavos: 276000,
        tipo_grupo: "ETF",
        data_ultima_cotacao: dataExport,
      },
      {
        sessao_import_id: sessao.id,
        chave_export: "IVVB11",
        instituicao: "Itaú",
        quantidade: "20",
        patrimonio_hoje_centavos: 400000,
        patrimonio_investido_centavos: 380000,
        tipo_grupo: "ETF",
        data_ultima_cotacao: dataExport,
      },
      {
        sessao_import_id: sessao.id,
        chave_export: "Tesouro Selic 2029",
        instituicao: "Itaú",
        quantidade: "1000.00",
        patrimonio_hoje_centavos: 600000,
        patrimonio_investido_centavos: 580000,
        tipo_grupo: "TESOURO_DIRETO",
        data_ultima_cotacao: dataExport,
      },
      {
        sessao_import_id: sessao.id,
        chave_export: "Tesouro IPCA+ 2035",
        instituicao: "Nubank",
        quantidade: "500.00",
        patrimonio_hoje_centavos: 400000,
        tipo_grupo: "TESOURO_DIRETO",
        data_ultima_cotacao: dataExport,
      },
      // Fora da carteira alvo — excluída da base de percentuais/déficits
      {
        sessao_import_id: sessao.id,
        chave_export: "PETR4",
        instituicao: "Itaú",
        quantidade: "100",
        patrimonio_hoje_centavos: 250000,
        patrimonio_investido_centavos: 235000,
        tipo_grupo: "ACOES",
        data_ultima_cotacao: dataExport,
      },
    ],
  });

  console.log("Seed: criando vínculos (sem pendências)...");
  // "Tesouro Selic 2029" é marcado ignorar_no_import=true (feature 002):
  // simula um ativo que vem torto do CSV (ex.: CDB classificado errado) e
  // é substituído por uma posicao_manual — ver bloco abaixo.
  await prisma.ativo_mapeado.createMany({
    data: [
      { chave_export: "WRLD11", alvo_id: alvoWrld11.id, fora_da_carteira: false },
      { chave_export: "IVVB11", alvo_id: alvoIvvb11.id, fora_da_carteira: false },
      {
        chave_export: "Tesouro Selic 2029",
        alvo_id: alvoPosFixado.id,
        fora_da_carteira: false,
        ignorar_no_import: true,
      },
      {
        chave_export: "Tesouro IPCA+ 2035",
        alvo_id: alvoIpca.id,
        fora_da_carteira: false,
      },
      { chave_export: "PETR4", alvo_id: null, fora_da_carteira: true },
    ],
  });

  console.log(
    "Seed: criando posição manual (feature 002) que substitui 'Tesouro Selic 2029'...",
  );
  const posicaoManualCdb = await prisma.posicao_manual.create({
    data: {
      chave_manual: "CDB-ITAU-2029",
      instituicao: "Itaú",
      alvo_id: alvoPosFixado.id,
      descricao: "CDB Itaú 120% CDI 2029",
      chave_export_origem: "Tesouro Selic 2029",
      ativo: true,
    },
  });
  await prisma.posicao_manual_valor.create({
    data: {
      posicao_manual_id: posicaoManualCdb.id,
      sessao_import_id: sessao.id,
      valor_investido_centavos: 500000,
      valor_atual_centavos: 520000,
    },
  });

  console.log(
    "Seed: criando ajuste de valor investido (feature 002) para 'Tesouro IPCA+ 2035'...",
  );
  await prisma.ajuste_valor_investido.create({
    data: {
      chave_export: "Tesouro IPCA+ 2035",
      sessao_import_id: sessao.id,
      valor_investido_corrigido_centavos: 405000,
    },
  });

  // Feature 003 (specs/003-dashboard-analise-rendimento): 2ª sessão VIGENTE,
  // mês seguinte (2026-08), para exercitar variação de rendimento entre duas
  // sessões sem precisar de import manual. A sessão de 2026-07 acima
  // permanece intocada — nenhuma sessão é substituída, pois cada uma é
  // VIGENTE em seu próprio mes_referencia (só há no máximo uma VIGENTE por
  // mês — data-model.md). `patrimonio_investido_centavos` preenchido na
  // maioria das posições; "Tesouro IPCA+ 2035" fica com `null` de propósito
  // (FR-010: "sem histórico suficiente" para essa chave nesta sessão).
  console.log("Seed: criando 2ª sessão de import VIGENTE (2026-08, feature 003)...");
  const dataExport2 = new Date("2026-08-28T00:00:00.000Z");
  const sessao2 = await prisma.sessao_import.create({
    data: {
      mes_referencia: "2026-08",
      data_export: dataExport2,
      status: "VIGENTE",
      instituicoes: JSON.stringify(["Itaú", "Nubank"]),
    },
  });

  console.log(
    "Seed: criando posições da 2ª sessão (patrimonio_investido_centavos preenchido, exceto 1)...",
  );
  await prisma.posicao.createMany({
    data: [
      {
        sessao_import_id: sessao2.id,
        chave_export: "WRLD11",
        instituicao: "Itaú",
        quantidade: "50",
        patrimonio_hoje_centavos: 520000,
        patrimonio_investido_centavos: 480000,
        tipo_grupo: "ETF",
        data_ultima_cotacao: dataExport2,
      },
      {
        sessao_import_id: sessao2.id,
        chave_export: "WRLD11",
        instituicao: "Nubank",
        quantidade: "30",
        patrimonio_hoje_centavos: 312000,
        patrimonio_investido_centavos: 288000,
        tipo_grupo: "ETF",
        data_ultima_cotacao: dataExport2,
      },
      {
        sessao_import_id: sessao2.id,
        chave_export: "IVVB11",
        instituicao: "Itaú",
        quantidade: "22",
        patrimonio_hoje_centavos: 440000,
        patrimonio_investido_centavos: 420000,
        tipo_grupo: "ETF",
        data_ultima_cotacao: dataExport2,
      },
      {
        sessao_import_id: sessao2.id,
        chave_export: "Tesouro Selic 2029",
        instituicao: "Itaú",
        quantidade: "1000.00",
        patrimonio_hoje_centavos: 608000,
        patrimonio_investido_centavos: 600000,
        tipo_grupo: "TESOURO_DIRETO",
        data_ultima_cotacao: dataExport2,
      },
      // Sem histórico suficiente (FR-010): patrimonio_investido_centavos
      // permanece null nesta sessão, propositalmente, para cobrir o caso de
      // ausência de dado ao calcular rendimento.
      {
        sessao_import_id: sessao2.id,
        chave_export: "Tesouro IPCA+ 2035",
        instituicao: "Nubank",
        quantidade: "500.00",
        patrimonio_hoje_centavos: 415000,
        patrimonio_investido_centavos: null,
        tipo_grupo: "TESOURO_DIRETO",
        data_ultima_cotacao: dataExport2,
      },
      {
        sessao_import_id: sessao2.id,
        chave_export: "PETR4",
        instituicao: "Itaú",
        quantidade: "100",
        patrimonio_hoje_centavos: 260000,
        patrimonio_investido_centavos: 245000,
        tipo_grupo: "ACOES",
        data_ultima_cotacao: dataExport2,
      },
    ],
  });

  console.log(
    "Seed: carregando posicao_manual_valor da 2ª sessão para o CDB (feature 002)...",
  );
  await prisma.posicao_manual_valor.create({
    data: {
      posicao_manual_id: posicaoManualCdb.id,
      sessao_import_id: sessao2.id,
      valor_investido_centavos: 500000,
      valor_atual_centavos: 535000,
    },
  });

  console.log("Seed concluído.");
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
