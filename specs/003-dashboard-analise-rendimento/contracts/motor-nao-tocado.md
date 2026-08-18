# Contrato — Motor de Aporte não é tocado por esta feature

Referência: `research.md` R1, R11.

**`src/core/motor/**` não sofre nenhuma alteração.** Nenhum tipo de `src/core/motor/types.ts` (`PosicaoConsolidada`, `EntradaMotor`, `ResultadoMotor`, `LinhaDivisao`, etc.) ganha campo novo. Nenhuma regra de `deficit.ts`, `fila.ts`, `divisao.ts`, `arredondamento.ts` muda de comportamento.

## Por quê

`PosicaoConsolidada` é a única porta de entrada de dado de posição para o motor:

```ts
export interface PosicaoConsolidada {
  chaveExport: string;
  alvoId: string | null;
  foraDaCarteira: boolean;
  valorCentavos: number;
  tipoGrupo: string;
}
```

Não existe (e não é adicionado) nenhum campo `valorInvestidoCentavos` aqui — o motor estruturalmente não pode ler valor investido, porque o tipo que ele recebe não o carrega. FR-019 ("nunca usado no cálculo de déficit") é satisfeito por construção, não por uma checagem em runtime — mesma técnica já usada pela feature 002 para `valor_investido`/`valor_investido_corrigido`.

## Onde a lógica de rendimento vive

Inteiramente em `src/services/rendimento-service.ts` (novo, camada de I/O — pode ler `prisma` livremente, nunca é importado por `src/core/**`), no mesmo padrão de `dashboard-service.ts`. Nenhuma função deste serviço é chamada por `aporte-service.ts` nem por `src/core/motor/**`; a única integração com o fluxo de aporte é de leitura (R7: somar `aporte.executado` para calcular o "valor investido esperado" de FR-011/FR-011a — leitura do resultado já persistido de um aporte, não uma chamada ao motor).

## Verificação

`git diff` de `src/core/motor/**` deve ficar vazio ao final da implementação — mesma checagem de conformidade já usada pela feature 002 (`guardiao-spec` deve validar isto explicitamente na revisão pós-implementação).
