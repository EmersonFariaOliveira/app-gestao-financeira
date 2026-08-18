# Contrato — Server Actions (`src/app/actions/`) — Posições Manuais e Ajustes

Extensão do contrato da feature 001 (`specs/001-gestao-aportes-v0-v1/contracts/server-actions.md`) — mesmo
formato e regras de borda: actions **não contêm lógica de negócio** (validam input, chamam
`src/services/`, retornam DTOs serializáveis), sem API route pública, valores monetários em
centavos até a UI formatar. Retorno padrão: `{ ok: true, data } | { ok: false, erro: string, detalhes?: unknown }`.

Referências: `docs/app-gestao-aportes.md` §6.3, §6.2, §6.5, §6.9, §4.1, §5.2; `specs/002-posicoes-manuais-ajustes/spec.md` (FR-001..FR-015).

---

## vinculos.ts (tela 6.3) — extensão

`vincularAtivo` ganha uma 4ª forma (união discriminada, mesmo padrão das 3 existentes —
nenhuma das formas atuais muda):

```ts
export type VincularAtivoInput =
  | { chaveExport: string; alvoId: string }
  | { chaveExport: string; foraDaCarteira: true }
  | { chaveExport: string; novoAlvo: { nome: string; percentualBps: number } }
  // NOVO — FR-001. Ação de um clique, sem sub-modo de escolha de alvo (mesmo
  // padrão de `{chaveExport, foraDaCarteira: true}`).
  | { chaveExport: string; ignorarNoImport: true };
```

**Nota de design (revisada):** "Ignorar" NÃO exige alvo — é uma forma "sem alvo" própria, mesmo
padrão de `foraDaCarteira`/`reservaEmergencia`. `ativo_mapeado.alvo_id` é sempre zerado (`null`)
ao marcar `ignorar_no_import = true`, mantendo a invariante de exclusão mútua consistente entre os
4 estados de `ativo_mapeado` (nenhuma exceção). Não há valor do CSV a atribuir a um alvo neste
estado — quem tem um alvo é a `posicao_manual` substituta, via seu próprio `alvo_id` (resolvido
pela tela 6.9, mesmo fluxo de vínculo dos ativos do CSV).
>
> Versão anterior deste documento (revertida): "Ignorar" exigia escolher um alvo (reaproveitando os
> sub-modos `alvoId`/`novoAlvo`) e preservava `ativo_mapeado.alvo_id` preenchido, para alimentar a
> heurística por-alvo de `posicaoManualPendente` (nota #2 abaixo, também revertida). Essa exceção
> causava vínculos incorretos: obrigava escolher um alvo só para "Ignorar", mesmo quando a
> `posicao_manual` substituta ainda nem existia, e podia deixar `ativo_mapeado` apontando para um
> alvo errado (não relacionado à posição manual real). Revertido para o design original de
> `data-model.md` ("`alvo_id` pode ficar `null` nesse estado — não há valor do CSV a atribuir a um
> alvo").

| Action | Input | Output (`data`) | Regras |
|---|---|---|---|
| `listarVinculos` | — | `{ pendentes: [], vinculados: [], foraDaCarteira: [], ignorados: IgnoradoRow[] }` — `IgnoradoRow = { chaveExport, alvoId: string \| null, nomeAlvo: string \| null, valorAtualCentavos, posicaoManualPendente: boolean }` | Novo balde `ignorados` (FR-001). `valorAtualCentavos` é o valor bruto do CSV — exibido só como referência, rotulado "não usado no cálculo" (o motor usa a `posicao_manual`, não este valor). `alvoId`/`nomeAlvo` vêm do alvo da `posicao_manual` substituta (NÃO de `ativo_mapeado.alvo_id`, que é sempre `null` aqui) — match EXATO via `posicao_manual.chave_export_origem = chaveExport`; são `null` quando ainda não existe nenhuma `posicao_manual` ativa com esse `chave_export_origem`, que é exatamente quando `posicaoManualPendente = true` |
| `vincularAtivo` | ver união acima | `VinculoAtualizado` `+ { ignorarNoImport: boolean; posicaoManualPendente: boolean }` | Ao resolver com `ignorarNoImport: true`, a linha some do balde "pendentes" e some do alarme de "ativo novo" em imports futuros (FR-001). `alvoId`/`nomeAlvo` da resposta seguem a mesma regra de `IgnoradoRow` acima (derivados da `posicao_manual` substituta, `null` quando ainda não existe). Se `posicaoManualPendente` vier `true`, a UI exibe CTA **"+ Cadastrar posição manual"** linkando para `/posicoes-manuais?descricaoSugerida=<chaveExport>` (sem `alvoId` na querystring, já que não há alvo a pré-preencher neste ponto — navegação client-side, não é uma nova action) |

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
| `criarPosicaoManual` | `{ chaveManual, instituicao, descricao, alvoId?, valorInvestidoCentavos, valorAtualCentavos }` | posição criada | FR-002. `alvoId` agora é **opcional** (extensão desta task): quando omitido, a posição nasce pendente de vínculo (`alvo_id = null`) — mesma máquina de estados de `ativo_mapeado`, resolvida depois em `/vinculos` via `vincularPosicaoManual`. Se existir sessão VIGENTE no momento do cadastro, grava também o primeiro `posicao_manual_valor` **nessa mesma sessão**, para que o valor componha o déficit imediatamente na calculadora (SC-001) assim que vinculada, sem esperar um novo import. Sem sessão VIGENTE ainda, só o cadastro é criado (Assumption spec.md linha 129) |
| `editarPosicaoManual` | `{ posicaoManualId, instituicao?, descricao? }` | posição atualizada | Só dados cadastrais. **`alvoId` removido do input desta action** (extensão desta task): toda transição de `alvo_id`/`fora_da_carteira`/`reserva_emergencia` passa exclusivamente por `vincularPosicaoManual`, mesma separação de responsabilidade que `vinculos.ts`/`vincularAtivo` já impõe para `ativo_mapeado`. Valores (`valor_investido`/`valor_atual`) mudam por `atualizarValoresPosicaoManual` (fora do import) ou pela revisão de import (6.9-dentro-do-import) |
| `encerrarPosicaoManual` | `{ posicaoManualId }` | posição atualizada (`ativo = false`) | FR-004. Some do carry-forward e do cálculo de déficit sem apagar histórico; bloqueia geração de incremento pendente futuro para essa posição (FR-015) |
| `criarOuAtualizarAjuste` | `{ chaveExport, valorInvestidoCentavosCorrigido }` | ajuste criado/atualizado | FR-005. `valor_atual` nunca é tocado por esta action (sempre vem do CSV); grava um `ajuste_valor_investido` associado à sessão VIGENTE mais recente, se houver — mesmo racional de "efeito imediato" de `criarPosicaoManual` |
| `vincularPosicaoManual` **(novo)** | União discriminada, mesmo padrão de `vincularAtivo`/`vinculos.ts`, mas com só 4 formas (sem "ignorar" — conceito exclusivo de `ativo_mapeado`/CSV, não se aplica a uma posição manual): `{ posicaoManualId, alvoId }` \| `{ posicaoManualId, foraDaCarteira: true }` \| `{ posicaoManualId, reservaEmergencia: true }` \| `{ posicaoManualId, novoAlvo: { nome, percentualBps } }` | `{ posicaoManualId, alvoId: string \| null, nomeAlvo: string \| null, foraDaCarteira: boolean, reservaEmergencia: boolean }` | Único ponto de escrita de `alvo_id`/`fora_da_carteira`/`reserva_emergencia` de `posicao_manual` — mesma exclusividade mútua de `ativo_mapeado`. Consumida pela tela `/vinculos`, unificada na mesma seção/tabela dos ativos do CSV (ver nota de design abaixo) |
| `listarPosicoesManuaisParaVinculo` **(novo)** | — | `{ pendentes, vinculadas, foraDaCarteira, reservaEmergencia }: PosicaoManualParaVinculo[]` cada — `PosicaoManualParaVinculo = { posicaoManualId, chaveManual, descricao, instituicao, alvoId: string \| null, nomeAlvo: string \| null, valorAtualCentavos: number \| null }` | Mesmos quatro baldes de `listarVinculos`, só que para `posicao_manual` (`ativo = true`). Consumida por `/vinculos` em paralelo com `listarVinculos` para unificar as seções |
| `atualizarValoresPosicaoManual` **(novo)** | `{ posicaoManualId, valorInvestidoCentavos, valorAtualCentavos }` | `{ posicaoManualId, valorInvestidoCentavos, valorAtualCentavos }` | Upsert do `posicao_manual_valor` da sessão VIGENTE mais recente (mesmo padrão de `criarOuAtualizarAjuste`) — exige sessão VIGENTE, mesma mensagem de erro já usada nas demais actions deste arquivo. Usada pelo diálogo "Editar" da tela `/posicoes-manuais` (junto com `editarPosicaoManual`, para os campos cadastrais) |

**Nota de design — unificação com `/vinculos` (extensão desta task):** a tela `/vinculos` (6.3)
passou a consumir `listarPosicoesManuaisParaVinculo` além de `listarVinculos`, misturando as
posições manuais pendentes/vinculadas/fora-da-carteira/reserva-de-emergência nas MESMAS
seções/tabelas que os ativos do CSV — não uma seção separada. Cada linha de posição manual leva
uma marcação visual ("Manual") para diferenciar a origem; ações equivalentes às do CSV
(reatribuir alvo, marcar fora da carteira, marcar reserva de emergência) chamam
`vincularPosicaoManual` em vez de `vincularAtivo`. O botão "Ignorar (substituído por posição
manual)" e o botão "Encerrar" **não** aparecem para linhas de posição manual em `/vinculos`
("Ignorar" não se aplica — a posição manual já É a substituição; "Encerrar" continua exclusivo de
`/posicoes-manuais`, evitando duplicar a ação irreversível com diálogo de confirmação em dois
lugares).

---

## aporte.ts (tela 6.5) — sem alteração de contrato de UI

`registrarAporte` mantém input/output idênticos aos da 001. A geração de
`incremento_valor_investido_pendente` (FR-010/FR-011/FR-012/FR-015) acontece **dentro do serviço**
(`src/services/aporte-service.ts`), na mesma transação de `registrarAporte`, sem exigir nenhum
campo novo vindo da UI — o botão "registrar como executado" continua exatamente como está. A tela
de revisão (6.9) é quem consome essas pendências no próximo `previewImport`.

---

## Notas de design (defaults escolhidos por consistência, sem inventar regra nova)

1. **"Ignorar" NÃO exige alvo (revertido):** ação de um clique, mesmo padrão de `foraDaCarteira`/
   `reservaEmergencia` — ver nota na seção `vinculos.ts` acima. Versão anterior deste documento
   exigia escolher um alvo (reaproveitando `alvoId`/`novoAlvo`); revertida por causar vínculos
   incorretos (alvo escolhido só para satisfazer a UI, sem relação com a `posicao_manual`
   substituta real).
2. **Pendência de posição manual após "Ignorar" (revertido para match exato):** antes havia uma
   heurística por-alvo (existe pelo menos uma `posicao_manual` ativa com o mesmo `alvoId` de
   `ativo_mapeado`?), documentada como limitação conhecida. Como `ativo_mapeado.alvo_id` agora é
   sempre `null` no estado "ignorado", essa heurística deixou de fazer sentido — substituída por um
   match EXATO via `posicao_manual.chave_export_origem = chaveExport` (campo já existente em
   `data-model.md`, desenhado precisamente para isto: "esta posição manual substitui ESTE
   `chave_export`"). Não é mais uma limitação conhecida: o aviso ("ainda não tem posição manual
   cadastrada") passa a ser exato, não heurístico.
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
