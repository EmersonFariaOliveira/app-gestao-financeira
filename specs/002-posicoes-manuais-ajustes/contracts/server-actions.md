# Contrato — Server Actions (`src/app/actions/`) — Posições Manuais e Ajustes

Extensão do contrato da feature 001 (`specs/001-gestao-aportes-v0-v1/contracts/server-actions.md`) — mesmo
formato e regras de borda: actions **não contêm lógica de negócio** (validam input, chamam
`src/services/`, retornam DTOs serializáveis), sem API route pública, valores monetários em
centavos até a UI formatar. Retorno padrão: `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.

Referências: `docs/app-gestao-aportes.md` §6.3, §6.2, §6.5, §6.9, §4.1, §5.2; `specs/002-posicoes-manuais-ajustes/spec.md` (FR-001..FR-015).

---

## vinculos.ts (tela 6.3) — extensão

`vincularAtivo` ganha uma 4ª e 5ª forma (união discriminada, mesmo padrão das 3 existentes —
nenhuma das formas atuais muda):

```ts
export type VincularAtivoInput =
  | { chaveExport: string; alvoId: string }
  | { chaveExport: string; foraDaCarteira: true }
  | { chaveExport: string; novoAlvo: { nome: string; percentualBps: number } }
  // NOVO — FR-001
  | { chaveExport: string; ignorarNoImport: true; alvoId: string }
  | { chaveExport: string; ignorarNoImport: true; novoAlvo: { nome: string; percentualBps: number } };
```

**Nota de design:** "Ignorar" exige escolher um alvo (existente ou novo), reaproveitando os
mesmos dois sub-modos já usados por "vincular a alvo existente"/"criar alvo novo" — não é um
modo sem alvo. O `alvo_id` gravado em `ativo_mapeado` não é descartado ao marcar
`ignorar_no_import = true`; ele é o "mesmo alvo" citado na seção 4.1 para a `posicao_manual`
substituta, preservando a exibição do ativo em "quais ativos apontam para este alvo" (tela 6.4)
mesmo estando fora da consolidação. `fora_da_carteira` permanece `false` (o ativo faz parte da
carteira, só não vem representado pelo CSV).

| Action | Input | Output (`data`) | Regras |
|---|---|---|---|
| `listarVinculos` | — | `{ pendentes: [], vinculados: [], foraDaCarteira: [], ignorados: IgnoradoRow[] }` — `IgnoradoRow = { chaveExport, alvoId, nomeAlvo, valorAtualCentavos, posicaoManualPendente: boolean }` | Novo balde `ignorados` (FR-001). `valorAtualCentavos` é o valor bruto do CSV — exibido só como referência, rotulado "não usado no cálculo" (o motor usa a `posicao_manual`, não este valor). `posicaoManualPendente = true` quando não existe nenhuma `posicao_manual` ativa com o mesmo `alvoId` — heurística de UX (não há FK direta `ativo_mapeado` ↔ `posicao_manual`; ver Edge Case do spec.md linha 80) |
| `vincularAtivo` | ver união acima | `VinculoAtualizado` `+ { ignorarNoImport: boolean; posicaoManualPendente: boolean }` | Ao resolver com `ignorarNoImport: true`, a linha some do balde "pendentes" e some do alarme de "ativo novo" em imports futuros (FR-001). Se `posicaoManualPendente` vier `true` na resposta, a UI exibe CTA **"+ Cadastrar posição manual"** linkando para `/posicoes-manuais?alvoId=<alvoId>&descricaoSugerida=<chaveExport>` (navegação client-side com querystring pré-preenchendo o formulário da tela 6.9 — não é uma nova action, é apenas leitura de `searchParams` pela página) |

---

## import.ts (tela 6.2) — extensão para US3/US4

**Onde a revisão (tela 6.9) entra no fluxo:** dentro do MESMO card de preview já existente
(`previewImport` → um único payload), como mais uma seção — **depois do diff contra a sessão
anterior e antes do botão "Confirmar import"** (mesmo card, não é um passo/wizard separado). Isso
casa com a redação da spec ("mesmo momento da checagem de completude") e com o padrão já usado
para o aviso de substituição/completude/diff: tudo é decidido a partir de um único `previewImport`
em memória, e nada persiste até `confirmarImport`. Se o usuário abandonar o import nesta etapa
(fecha a aba, navega para outra tela), **nada foi gravado** — na próxima tentativa
`previewImport` recalcula os valores sugeridos do zero a partir da sessão VIGENTE mais recente e
das pendências ainda não aplicadas, sem nenhum resquício da tentativa abandonada (mesma garantia
de atomicidade que já vale para posições/diff).

`PreviewImportOutput` ganha três campos novos:

```ts
posicoesManuaisRevisao: {
  posicaoManualId: string;
  chaveManual: string;
  instituicao: string;
  descricao: string;
  alvoId: string;
  nomeAlvo: string;
  valorInvestidoCentavosAnterior: number;
  incrementoPendenteCentavos: number;       // 0 se não houver pendência aplicável (FR-011)
  valorInvestidoCentavosSugerido: number;   // anterior + incremento — editável na UI
  valorAtualCentavosSugerido: number;       // = anterior, sem cálculo (FR-008) — editável
}[];

ajustesRevisao: {
  chaveExport: string;
  alvoId: string | null;
  nomeAlvo: string | null;
  valorAtualCentavosCsv: number;                 // desta própria sessão em preview — nunca editável aqui
  primeiraVez: boolean;                          // true = nenhum ajuste anterior (FR-009)
  valorInvestidoCentavosAnterior: number | null; // null quando primeiraVez
  incrementoPendenteCentavos: number;            // 0 se não houver
  valorInvestidoCentavosSugerido: number | null; // null quando primeiraVez sem incremento — UI mostra vazio + aviso visual
}[];

incrementosAmbiguosPendentes: {
  alvoId: string;
  nomeAlvo: string;
  valorPendenteCentavos: number;
  elegiveis: { tipo: "posicaoManual" | "ajuste"; id: string; rotulo: string }[]; // popula os destinos possíveis de distribuição
}[];
```

`ConfirmarImportInput` ganha:

```ts
posicoesManuaisConfirmadas: {
  posicaoManualId: string;
  valorInvestidoCentavos: number;
  valorAtualCentavos: number;
}[];

ajustesConfirmados: {
  chaveExport: string;
  valorInvestidoCentavosCorrigido: number;
}[]; // uma chave ausente aqui = "usuário deixou vazio" — nenhum ajuste_valor_investido é criado
     // nesta sessão para ela; continua "sem correção", oferecida de novo no próximo import
     // (FR-009 não força preenchimento — mesma filosofia de "aviso, não bloqueio" da §6.2)

distribuicoesIncrementosAmbiguos: {
  alvoId: string;
  alocacoes: { tipo: "posicaoManual" | "ajuste"; id: string; valorCentavos: number }[];
}[]; // ANOTAÇÃO da UI para o usuário conferir a soma enquanto edita — não é o que persiste a
     // distribuição em si (isso já acontece via `posicoesManuaisConfirmadas`/`ajustesConfirmados`,
     // onde o usuário digita o valor final de cada campo). Ver reconciliação abaixo.
```

**Reconciliação com `contracts/motor-integracao.md` §5.3:** o design inicial deste contrato previa
que a soma das `alocacoes` pudesse ser menor que `valorPendenteCentavos`, com o restante permanecendo
pendente para o próximo import. `motor-integracao.md` (camada `calculista-aporte`) decidiu de forma
diferente e este documento foi ajustado para ficar consistente: **todo `incremento_valor_investido_pendente`
ambíguo exibido na revisão desta sessão é marcado `aplicado = true` na confirmação, integralmente,
independentemente de quanto o usuário de fato somou aos campos de `valor_investido` dos ativos daquele
alvo.** Mesmo padrão binário "oferecida uma vez, nunca mais" já usado para dividendos
(`dividendo.aporte_id`) — sem rastreio fracionário de centavo residual. `distribuicoesIncrementosAmbiguos`
é opcional e serve só para a UI ajudar o usuário a conferir a soma antes de confirmar; não há schema
para "resto pendente" e nenhum é necessário — se o usuário não distribuir o valor total nos campos, a
diferença simplesmente não é rastreada (mesmo risco já aceito para dividendos ignorados).

`ConfirmarImportOutput` ganha `incrementosAmbiguosNaoAlocadosCentavos: number` (soma informativa,
calculada no client a partir de `distribuicoesIncrementosAmbiguos` vs. `incrementosAmbiguosPendentes`
do preview — para o toast de sucesso avisar "R$ X não foram claramente alocados", se > 0; puramente
cosmético, não bloqueia a confirmação nem afeta o que é persistido).

| Action | Input | Output (`data`) | Regras |
|---|---|---|---|
| `previewImport` | (igual à 001) | (001) `+ posicoesManuaisRevisao, ajustesRevisao, incrementosAmbiguosPendentes` | Tudo em memória/leitura — nenhuma escrita. Carry-forward a partir da sessão VIGENTE mais recente (FR-008); incremento aplicado ao sugerido vem de `incremento_valor_investido_pendente` com `aplicado = false` (FR-011/012) |
| `confirmarImport` | (igual à 001) `+ posicoesManuaisConfirmadas, ajustesConfirmados, distribuicoesIncrementosAmbiguos?` | (001) `+ incrementosAmbiguosNaoAlocadosCentavos` | Mesma transação da 001 (backup → cria sessão + posições + pendências de vínculo) **também**: grava um `posicao_manual_valor` por item de `posicoesManuaisConfirmadas`, um `ajuste_valor_investido` por item (não vazio) de `ajustesConfirmados`, e marca `aplicado = true` em TODO `incremento_valor_investido_pendente` (exclusivo ou ambíguo) exibido nesta revisão — FR-013, motor-integracao.md §4.3/§5.3 |

---

## posicoes-manuais.ts (tela 6.9, acesso dedicado — FR-014)

Mesma tela também renderizada fora do fluxo de import, para cadastro/revisão a qualquer momento
(botão **"+ Nova posição manual"** e ação **"Encerrar"**, §6.9).

| Action | Input | Output (`data`) | Regras |
|---|---|---|---|
| `listarPosicoesManuaisEAjustes` | — | `{ posicoesManuais: PosicaoManualRow[], ajustes: AjusteRow[] }` (mesmos shapes de `posicoesManuaisRevisao`/`ajustesRevisao` acima, sem o campo `incrementoPendenteCentavos` calculado sobre uma sessão em preview — aqui reflete os valores da sessão VIGENTE mais recente) | Leitura fora do import; só posições `ativo = true` e ajustes cujo `chave_export` ainda está vinculado a um alvo ativo (FR-014) |
| `criarPosicaoManual` | `{ chaveManual, instituicao, descricao, alvoId, valorInvestidoCentavos, valorAtualCentavos }` | posição criada | FR-002. Se existir sessão VIGENTE no momento do cadastro, grava também o primeiro `posicao_manual_valor` **nessa mesma sessão**, para que o valor componha o déficit imediatamente na calculadora (SC-001), sem esperar um novo import. Sem sessão VIGENTE ainda, só o cadastro é criado (Assumption spec.md linha 129) |
| `editarPosicaoManual` | `{ posicaoManualId, instituicao?, descricao?, alvoId? }` | posição atualizada | Só dados cadastrais — valores (`valor_investido`/`valor_atual`) mudam exclusivamente pela revisão de import (6.9-dentro-do-import) ou, no cadastro inicial, por `criarPosicaoManual` |
| `encerrarPosicaoManual` | `{ posicaoManualId }` | posição atualizada (`ativo = false`) | FR-004. Some do carry-forward e do cálculo de déficit sem apagar histórico; bloqueia geração de incremento pendente futuro para essa posição (FR-015) |
| `criarOuAtualizarAjuste` | `{ chaveExport, valorInvestidoCentavosCorrigido }` | ajuste criado/atualizado | FR-005. `valor_atual` nunca é tocado por esta action (sempre vem do CSV); grava um `ajuste_valor_investido` associado à sessão VIGENTE mais recente, se houver — mesmo racional de "efeito imediato" de `criarPosicaoManual` |

---

## aporte.ts (tela 6.5) — sem alteração de contrato de UI

`registrarAporte` mantém input/output idênticos aos da 001. A geração de
`incremento_valor_investido_pendente` (FR-010/FR-011/FR-012/FR-015) acontece **dentro do serviço**
(`src/services/aporte-service.ts`), na mesma transação de `registrarAporte`, sem exigir nenhum
campo novo vindo da UI — o botão "registrar como executado" continua exatamente como está. A tela
de revisão (6.9) é quem consome essas pendências no próximo `previewImport`.

---

## Notas de design (defaults escolhidos por consistência, sem inventar regra nova)

1. **"Ignorar" exige alvo:** ver nota na seção `vinculos.ts` acima — reaproveita os dois sub-modos
   já existentes (`alvoId` / `novoAlvo`) em vez de criar um terceiro fluxo de seleção de alvo do
   zero.
2. **Pendência de posição manual após "Ignorar":** como não há FK direta entre `ativo_mapeado` e
   `posicao_manual`, o aviso ("ainda não tem posição manual cadastrada") é heurístico — existe
   pelo menos uma `posicao_manual` ativa com o mesmo `alvoId`. Suficiente para o caso de uso comum
   (1 CDB ignorado ↔ 1 posição manual), documentado como limitação conhecida.
3. **Ponto de entrada da revisão no import:** mesmo card do `previewImport`, seção final antes do
   botão "Confirmar import" — não é uma etapa de wizard separada. Preserva a atomicidade já
   garantida hoje (nada persiste antes de `confirmarImport`).
4. **Ajuste deixado vazio na primeira vez (FR-009):** confirmar a sessão sem preencher não bloqueia
   nem força um valor — simplesmente não cria `ajuste_valor_investido` para aquela chave nesta
   sessão; ela volta a aparecer como `primeiraVez: true` no próximo import. Mesma filosofia de
   "aviso, não bloqueio" já usada na checagem de completude de instituições (§6.2).
5. **Distribuição parcial de incremento ambíguo:** reconciliado com `motor-integracao.md` §5.3 —
   o incremento ambíguo é marcado `aplicado = true` integralmente na confirmação, sem rastreio de
   resto não alocado (mesmo padrão binário dos dividendos). Ver bloco de reconciliação na seção
   `import.ts` acima.
6. **`criarPosicaoManual`/`criarOuAtualizarAjuste` fora do fluxo de import:** anexam o valor
   informado à sessão VIGENTE mais recente (se existir) para que o efeito seja imediato na
   calculadora (SC-001), em vez de esperar o próximo import — extrapolação mínima e consistente
   com "posições manuais participam do cálculo de déficit como qualquer posição do CSV" (§4.1).
