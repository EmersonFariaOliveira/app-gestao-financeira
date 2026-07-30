# app-gestao-financeira

App local (Next.js + Prisma + SQLite), single-user, que divide o aporte mensal entre os ativos mais abaixo da carteira alvo. Sem cotação em tempo real, sem autenticação, sem serviços externos — tudo roda na sua máquina.

`docs/app-gestao-aportes.md` é a fonte da verdade de produto/arquitetura; `specs/001-gestao-aportes-v0-v1/` tem a especificação, o plano e os contratos técnicos completos.

## Pré-requisitos

- Node.js 20+ e npm
- Nada mais — sem banco externo, sem chaves de API, sem rede em runtime

## Setup

```bash
npm install
npx prisma migrate dev      # cria data/app.db (gitignored) com o schema completo
npx prisma db seed          # opcional: popula com dados sintéticos para explorar o app sem CSVs reais
npm run dev                 # http://localhost:3000
```

O banco SQLite fica em `data/app.db` e os backups datados em `backups/` — ambos gitignored, ambos locais. Não há sincronização na nuvem: faça backup desses dois caminhos por conta própria periodicamente (a tela **Configurações** do app mostra os caminhos exatos).

## Uso com dados reais

Os exports do MyCapital (CSV por instituição) vão em `docs/samples/` — são dados financeiros reais e **nunca são versionados** (já estão no `.gitignore`). Sem eles, o app funciona normalmente com o seed sintético; os testes do parser que dependem desses arquivos fazem skip automático com aviso quando não os encontram.

## Scripts disponíveis

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe o app em modo desenvolvimento |
| `npm run build` | Build de produção (`next build`) |
| `npm run start` | Roda o build de produção |
| `npm run lint` | ESLint, incluindo as regras de isolamento de camadas |
| `npm run test` | Suíte completa (Vitest) |
| `npm run test:watch` | Testes em modo watch |
| `npm run test:coverage` | Testes com relatório de cobertura |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:studio` | Abre o Prisma Studio para inspecionar o banco |
| `npm run db:seed` | Repopula o banco com os dados sintéticos de `prisma/seed.ts` |

## O ritual mensal (~5 min)

1. **Alvos** (`/alvos`) — cadastre a carteira de referência (a soma deve fechar em 100%).
2. **Import** (`/import`) — arraste os CSVs do mês; confira o preview e confirme.
3. **Vínculos** (`/vinculos`) — resolva qualquer ativo novo (vincular a um alvo, criar alvo na hora, ou marcar fora da carteira).
4. **Aporte** (`/aporte`) — digite o valor, ajuste se quiser, registre o que foi executado.
5. **Dashboard** (`/`) e **Histórico** (`/historico`) — acompanhe a alocação atual vs. alvo e a evolução patrimonial.

Guia completo de validação em [specs/001-gestao-aportes-v0-v1/quickstart.md](specs/001-gestao-aportes-v0-v1/quickstart.md).

## Estrutura do projeto

```text
src/
├── app/            # Next.js App Router — 8 telas + server actions (src/app/actions/)
├── components/     # componentes React (shadcn/ui + próprios)
├── core/            # lógica pura: motor de aporte (src/core/motor/) e dinheiro em centavos (src/core/money/)
├── parser/          # único módulo que conhece o formato do export MyCapital
├── services/        # orquestração com I/O (usa parser, motor e Prisma)
└── db/              # cliente Prisma
prisma/              # schema, migrations e seed
tests/               # motor (puro), parser (fixtures), services (integração)
```

As camadas são isoladas e a fronteira é reforçada por lint: o motor (`src/core/**`) e o parser (`src/parser/**`) não podem importar Prisma/Next/fs; a UI só acessa dados via `src/app/actions/` → `src/services/`.
