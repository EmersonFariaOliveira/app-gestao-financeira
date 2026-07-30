# App de Gestão de Aportes

App local (Next.js + Prisma + SQLite) que divide o aporte mensal entre os ativos mais abaixo da carteira alvo. **`docs/app-gestao-aportes.md` é a fonte da verdade** para toda decisão de produto e arquitetura.

## Delegação obrigatória

Antes de implementar qualquer coisa, delegue ao subagente da camada:

| Domínio | Subagente |
|---|---|
| Formato/parse dos CSVs do MyCapital | `especialista-csv` |
| Déficit, fila de prioridade, divisão do aporte, transbordo, mínimo, arredondamento, dividendos | `calculista-aporte` |
| Schema Prisma, migrations, SQLite, backups do banco | `arquiteto-dados` |
| Telas, componentes, App Router, server actions | `desenvolvedor-ui` |

É **proibido implementar lógica do motor no thread principal** — qualquer regra de cálculo vai para `calculista-aporte`.

## Pós-implementação (sempre, em ordem)

1. Acionar **engenheiro-testes** — rodar a suíte completa e cobrir lacunas de teste.
2. Acionar **guardiao-spec** — revisar o diff contra a spec (escopo negativo, regras intencionais, camadas).
3. Acionar **gerente-release** — propor os commits (Conventional Commits). Apresentar cada proposta ao usuário e perguntar explicitamente **"Quer que eu commite?"** — NUNCA commitar sem um sim explícito. Se o usuário recusar, não insistir.

## Regras invioláveis

- **Centavos inteiros:** valores monetários sempre como inteiro em centavos; nunca float.
- **Imports imutáveis:** sessões de import nunca são deletadas nem sobrescritas — apenas marcadas SUBSTITUIDO.
- **Posições só mudam via import** (regra 9 da seção 5): registrar aporte executado NÃO atualiza posições — não "corrigir".
- **Camadas isoladas:** UI não acessa banco nem calcula; motor não faz I/O; só o parser conhece o formato do CSV.
- **Escopo negativo da seção 1:** sem cotações em tempo real, sem preço médio/imposto, sem rentabilidade/proventos automáticos, sem recomendação de ativos.

> Este fluxo (delegação + pós-implementação) vale tanto para pedidos diretos quanto para os comandos/skills do Spec Kit (`speckit-implement`, etc.).
