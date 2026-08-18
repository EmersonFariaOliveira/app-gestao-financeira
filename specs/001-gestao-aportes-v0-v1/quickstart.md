# Quickstart — Validação da Gestão de Aportes (v0 + v1)

Guia de validação ponta a ponta. Não contém implementação — referencia [data-model.md](./data-model.md) e [contracts/](./contracts/).

## Pré-requisitos

- Node.js 20+ e npm
- Nada mais: sem serviços externos, sem rede em runtime (Princípio VII)
- Os CSVs de `docs/samples/` (Itaú, Nubank, Avenue) são **dados financeiros reais, gitignored** — existem apenas na máquina do usuário. Os testes do parser que dependem deles devem ser pulados (skip com aviso) quando os arquivos não existirem.

## Setup

```bash
npm install
npx prisma migrate dev          # cria data/app.db (gitignored) com o schema do data-model.md
npm run dev                     # http://localhost:3000
```

## Suíte de testes (prioridade: motor e parser)

```bash
npm test                        # vitest run — motor + parser + serviços
npm run lint                    # inclui as regras de isolamento de camadas (research.md R7)
```

**Resultado esperado**: 100% dos casos das regras 1–9 + 5.1 passando (SC-003) — a tabela de casos mínimos está em [contracts/motor.md](./contracts/motor.md); fixtures reais de `docs/samples/` parseando com golden values (SC-002) — casos em [contracts/parser.md](./contracts/parser.md). Testes do motor não tocam banco, rede nem parser (verificável: rodam sem `data/app.db` existir).

## Validação manual — o ritual mensal (~5 min, SC-001)

Cronometrar o fluxo completo com os arquivos reais:

1. **Alvos** (`/alvos`): cadastrar a carteira alvo; a tela deve acusar soma ≠ 100% até fechar em 100%.
2. **Import** (`/import`): arrastar `docs/samples/Itaú.csv`, `Nubank.csv` e `Avenue.csv` juntos.
   - Preview mostra total por instituição, quantidade de ativos e data das cotações; mês de referência proposto vem da data das posições e é editável.
   - Confirmar ⇒ backup datado aparece em `backups/` **antes** da sessão existir.
3. **Vínculos** (`/vinculos`): todos os ativos aparecem pendentes no primeiro import; vincular cada um (incluindo criar alvo na hora e marcar um como "Fora da carteira alvo").
   - Enquanto houver pendência, `/aporte` está bloqueada (SC-008).
4. **Calculadora** (`/aporte`): digitar R$ 2.000,00.
   - Fila ordenada por déficit; divisão concentrada em 1–3 alvos; nenhuma fatia abaixo do mínimo (SC-004); soma exata ao centavo (SC-005).
   - Zerar uma linha ⇒ redistribuição automática; ativos B3 com cotas inteiras e destino do troco visível; simulação do "depois" exibida.
5. **Registrar**: gravar sugerido vs. executado. Conferir que as posições NÃO mudaram (regra 9) — dashboard segue com os valores do import.

## Validações específicas por comportamento crítico (seção 7)

| Cenário | Como validar | Esperado |
|---|---|---|
| Re-import no mesmo mês | Importar os mesmos CSVs de novo, mesmo mês | Aviso de substituição no preview; sessão anterior vira SUBSTITUIDO e permanece visível na auditoria do histórico (SC-007) |
| Instituição faltante | Re-importar só o Itaú.csv | Aviso forte + exigência de confirmação explícita; sem bloqueio |
| Diff entre sessões | Segundo import com um CSV editado (ativo removido/valor alterado) | Preview lista novos/sumidos/variações grandes |
| Aporte amarrado à sessão | Registrar aporte, re-importar o mês, abrir histórico | Aporte segue apontando para a sessão original (substituída) |
| Dividendos sem dupla contagem | Lançar dividendo em `/dividendos`, incluir num aporte registrado, voltar à calculadora | Nunca mais oferecido (SC-006); não utilizado permanece disponível no mês seguinte |
| Erro de parse | Importar um CSV com a coluna `Patrimônio Hoje` renomeada | Erro com arquivo/linha/coluna; nada persistido (SC-009) |
| mes_referencia | Simular export com posições do fim do mês anterior | Preview propõe o mês das posições, editável |
| Retenção de backups | Confirmar 13 imports (ou reduzir retenção na config) | Apenas as N cópias mais recentes em `backups/` |

## Escopo negativo (conferir que NÃO existe)

Nenhuma tela ou código de: cotação em tempo real, preço médio, imposto, rentabilidade/performance, busca automática de proventos, recomendação de ativos, venda/rebalanceamento, autenticação/multi-usuário. Qualquer ocorrência é regressão contra o Princípio I.
