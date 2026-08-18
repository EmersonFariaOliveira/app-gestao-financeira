# Contrato — Motor de Aporte (`src/core/motor/`)

**Lógica pura** (seção 3; Princípio II): sem I/O, sem imports de Prisma/Next/fs/services/parser. Determinístico: mesma entrada ⇒ mesma saída. Toda aritmética em inteiros (centavos e bps). As **regras 1–9 da seção 5 + 5.1** são a especificação completa; cada regra tem testes unitários próprios no formato "carteira X + aporte Y ⇒ divisão Z".

## API

```ts
function calcularAporte(input: EntradaMotor): ResultadoMotor

interface EntradaMotor {
  alvos: AlvoVigente[]                    // vigência ativa, soma = 10000 bps (pré-validada fora)
  posicoes: PosicaoConsolidada[]          // já consolidadas por chave e mapeadas (sem pendentes!)
  valorAporteCentavos: number             // valor digitado + dividendos incluídos + troco anterior
  aporteMinimoCentavos: number            // regra 5 (config)
  ajustesUsuario?: AjusteUsuario[]        // regra 6 (veto humano); ausente = sugestão original
  cotacoes?: CotacaoB3[]                  // regra 7 (v1); ausente = sem arredondamento por lote
}

interface AlvoVigente { alvoId: string; nome: string; percentualBps: number; rendaFixa: boolean }
// rendaFixa: alvo que aceita valor quebrado — destino preferencial do troco (regra 7).
// Derivado fora do motor (pelo tipo_grupo dos ativos vinculados: TESOURO_DIRETO/fundos ⇒ true).

interface PosicaoConsolidada {
  chaveExport: string
  alvoId: string | null        // null ⇒ foraDaCarteira obrigatório true
  foraDaCarteira: boolean      // regra 4: excluída da base e nunca recebe aporte
  valorCentavos: number
  tipoGrupo: string
}

interface AjusteUsuario { alvoId: string; valorCentavos: number }  // 0 = linha zerada (veto)

interface CotacaoB3 { alvoId: string; precoCentavos: number }
// Apenas alvos B3 (ações/FIIs/ETFs). EXTERIOR e renda fixa NUNCA entram aqui.

interface ResultadoMotor {
  patrimonioBaseCentavos: number          // consolidado SEM fora-da-carteira (regra 4)
  fila: ItemFila[]                        // regra 2: TODOS os alvos, ordenados por déficit desc
  divisao: LinhaDivisao[]                 // regras 3, 5, 6, 7
  trocoCentavos: number                   // sobra de lote sem destino de renda fixa (regra 7)
  simulacaoDepois: AlocacaoSimulada[]     // "como fica se executar como sugerido"
}

interface ItemFila {
  alvoId: string
  valorAtualCentavos: number
  percentualAtualBps: number              // p/ exibição
  deficitCentavos: number                 // regra 1; negativo = acima do alvo (ignorado na divisão)
}

interface LinhaDivisao {
  alvoId: string
  valorCentavos: number                   // após mínimo/ajustes/arredondamento
  origem: 'DEFICIT' | 'TRANSBORDO' | 'AJUSTE_USUARIO'
  cotas?: number                          // só com arredondamento por lote
  precoCentavos?: number
}

interface AlocacaoSimulada {
  alvoId: string
  percentualAntesBps: number
  percentualDepoisBps: number
  deficitDepoisCentavos: number
}
```

## Semântica por regra (seção 5 — sem alteração)

1. **Déficit (regra 1)**: `deficit = (percentualBps × patrimonioBase) / 10000 − valorAtualDoAlvo`, divisão inteira truncada; `patrimonioBase` exclui `foraDaCarteira`. Déficit negativo nunca gera venda — o alvo apenas não recebe.
2. **Fila (regra 2)**: ordenação por `deficitCentavos` desc; empate desempatado por `percentualBps` desc e depois nome (determinismo).
3. **Divisão + transbordo (regra 3)**: cascata de cima para baixo cobrindo déficits; excedente sobre a soma dos déficits positivos é distribuído proporcionalmente aos `percentualBps` de TODOS os alvos vigentes (divisão inteira; resto de centavos vai ao primeiro da fila para fechar a soma exata — SC-005).
4. **Fora da carteira (regra 4)**: entrada com `foraDaCarteira = true` não entra em `patrimonioBase`, não aparece na fila e nunca recebe valor.
5. **Mínimo por transação (regra 5)**: fatia calculada `0 < fatia < aporteMinimoCentavos` não é criada; o valor volta para o topo da fila (reaplicado em cascata). Garantia: nenhuma `LinhaDivisao` com `0 < valor < mínimo`.
6. **Veto humano (regra 6)**: linhas em `ajustesUsuario` são fixadas (inclusive 0); o restante (`valorAporte − Σ ajustes`) é redistribuído pelas regras 1–5 sobre os alvos não fixados. Soma final continua exata.
7. **Arredondamento por lote (regra 7, v1)**: para alvos presentes em `cotacoes`, `cotas = floor(valor / precoCentavos)`, `valorAjustado = cotas × precoCentavos`; sobras somadas vão para o alvo de renda fixa da fila com maior déficit; se não houver alvo de renda fixa na divisão, sobram em `trocoCentavos` (registrado para o mês seguinte). Não se aplica a EXTERIOR nem renda fixa.
8. **Banda (regra 8)**: NÃO afeta o motor — a fila usa sempre déficit bruto. A banda é aplicada na UI/dashboard (fora deste módulo); o motor apenas fornece os números.
9. **Regra 9**: fora do escopo do motor por construção (ele não escreve nada em lugar nenhum).

**Dividendos (5.1)**: entram somados em `valorAporteCentavos` pela camada de serviço; o motor não conhece dividendos — o controle de utilização é da persistência.

## Invariantes verificados em todos os testes

- `Σ divisao.valorCentavos + trocoCentavos = valorAporteCentavos` (exato, ao centavo — SC-005).
- Nenhuma linha com `0 < valor < aporteMinimo`; nenhuma linha para alvo fora-da-carteira; nenhum valor negativo.
- Sem `cotacoes`, nenhuma linha tem `cotas`.
- Chamada repetida com a mesma entrada ⇒ resultado idêntico (pureza).

## Casos de teste mínimos (tests/motor/)

| Caso | Regras |
|---|---|
| Carteira 3 alvos, 1 déficit grande: aporte inteiro num alvo | 1, 2, 3 |
| Aporte cobre déficit do 1º e sobra pro 2º | 3 |
| Aporte > Σ déficits ⇒ transbordo proporcional aos bps, soma exata | 3 |
| Todos os alvos no alvo ou acima ⇒ 100% transbordo | 1, 3 |
| Fatia abaixo do mínimo realocada ao topo | 5 |
| Aporte total < mínimo ⇒ tudo no topo da fila | 5 |
| Ativo fora-da-carteira não distorce déficits nem recebe | 4 |
| Usuário zera a 1ª linha ⇒ redistribuição pelas mesmas regras | 6 |
| Usuário fixa valor parcial numa linha | 6 |
| Lote B3: cotas inteiras, troco para renda fixa | 7 |
| Lote B3 sem alvo de renda fixa ⇒ trocoCentavos registrado | 7 |
| EXTERIOR ignora lote (valor livre) | 7 |
| Empate de déficit ⇒ ordenação determinística | 2 |
| Arredondamento de centavos no transbordo fecha a soma | 3, invariante |
