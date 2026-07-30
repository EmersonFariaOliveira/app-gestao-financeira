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
//
// Regra inviolável: nenhum valor monetário como float — tudo em
// *_centavos (Int) e percentuais em *_bps (Int).

const prisma = new PrismaClient();

async function main() {
  console.log("Seed: limpando dados sintéticos anteriores...");
  // Ordem respeita FKs (dividendo -> aporte/ativo_mapeado; posicao/aporte ->
  // sessao_import; ativo_mapeado -> alvo). Seed é o único código com
  // permissão para apagar dados — não usar este padrão em serviços.
  await prisma.dividendo.deleteMany();
  await prisma.aporte.deleteMany();
  await prisma.posicao.deleteMany();
  await prisma.ativo_mapeado.deleteMany();
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
        tipo_grupo: "ETF",
        data_ultima_cotacao: dataExport,
      },
      {
        sessao_import_id: sessao.id,
        chave_export: "WRLD11",
        instituicao: "Nubank",
        quantidade: "30",
        patrimonio_hoje_centavos: 300000,
        tipo_grupo: "ETF",
        data_ultima_cotacao: dataExport,
      },
      {
        sessao_import_id: sessao.id,
        chave_export: "IVVB11",
        instituicao: "Itaú",
        quantidade: "20",
        patrimonio_hoje_centavos: 400000,
        tipo_grupo: "ETF",
        data_ultima_cotacao: dataExport,
      },
      {
        sessao_import_id: sessao.id,
        chave_export: "Tesouro Selic 2029",
        instituicao: "Itaú",
        quantidade: "1000.00",
        patrimonio_hoje_centavos: 600000,
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
        tipo_grupo: "ACOES",
        data_ultima_cotacao: dataExport,
      },
    ],
  });

  console.log("Seed: criando vínculos (sem pendências)...");
  await prisma.ativo_mapeado.createMany({
    data: [
      { chave_export: "WRLD11", alvo_id: alvoWrld11.id, fora_da_carteira: false },
      { chave_export: "IVVB11", alvo_id: alvoIvvb11.id, fora_da_carteira: false },
      {
        chave_export: "Tesouro Selic 2029",
        alvo_id: alvoPosFixado.id,
        fora_da_carteira: false,
      },
      {
        chave_export: "Tesouro IPCA+ 2035",
        alvo_id: alvoIpca.id,
        fora_da_carteira: false,
      },
      { chave_export: "PETR4", alvo_id: null, fora_da_carteira: true },
    ],
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
