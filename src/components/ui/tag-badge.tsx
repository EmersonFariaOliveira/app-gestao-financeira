/**
 * src/components/ui/tag-badge.tsx — "pill" (badge arredondado) para exibir a
 * tag livre de um alvo (ver `docs/app-gestao-aportes.md` seção 6.4/6.1: campo
 * de categorização livre do usuário, ex.: A-AÇÕES, R-REAL ESTATE, C-CAIXA).
 *
 * Usado em pelo menos dois lugares (`src/app/alvos/page.tsx` e
 * `src/components/dashboard/alocacao-por-tag.tsx`) — mesma tag sempre com a
 * mesma cor em qualquer tela, via `corParaTag` (hash determinístico da string
 * da tag, nunca `Math.random`).
 *
 * Acessibilidade (regra da paleta categórica, `src/app/globals.css`
 * `--tag-hue-1..8`): 3 dos 8 matizes ficam abaixo de 3:1 de contraste no tema
 * claro, então nunca são usados como cor de TEXTO — "text wears text tokens,
 * never the series color". A cor da tag aqui é só decorativa (uma bolinha ao
 * lado do texto); o texto do nome da tag sempre usa `text-foreground`, nunca
 * a cor do matiz. Com isso a cor nunca é a única pista (o texto da tag já
 * desambigua, inclusive quando duas tags diferentes caem no mesmo matiz por
 * haver mais de 8 tags distintas — aceitável, documentado na task).
 */
import { cn } from "@/lib/utils";

const QTD_MATIZES = 8;

/**
 * Hash determinístico (FNV-1a de 32 bits) da string da tag, módulo 8, para
 * escolher um dos slots `--tag-hue-1..8`. Determinístico e estável: a mesma
 * string sempre produz o mesmo índice, em qualquer render/página/sessão.
 */
export function corParaTag(tag: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32 bits)
  for (let i = 0; i < tag.length; i++) {
    hash ^= tag.charCodeAt(i);
    // FNV prime (32 bits), via shifts para evitar overflow de precisão do JS.
    hash = Math.imul(hash, 0x01000193);
  }
  // `>>> 0` normaliza para unsigned antes do módulo (hash pode vir negativo).
  const indice = (hash >>> 0) % QTD_MATIZES;
  return `var(--tag-hue-${indice + 1})`;
}

export function TagBadge({ tag, className }: { tag: string; className?: string }) {
  const cor = corParaTag(tag);
  return (
    <span
      data-slot="tag-badge"
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs font-medium text-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: cor }}
      />
      <span className="truncate">{tag}</span>
    </span>
  );
}
