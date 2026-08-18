/**
 * tests/components/tag-badge.test.ts — cobre `corParaTag`
 * (`src/components/ui/tag-badge.tsx`), a função pura (hash FNV-1a de 32
 * bits, módulo 8) que escolhe a cor decorativa do pill de tag.
 *
 * Puramente visual (nenhuma regra da seção 5 da spec envolvida), mas a
 * função é pura (string -> string, sem I/O/JSX) e usada em pelo menos duas
 * telas — vale um teste rápido de determinismo, já que a promessa central
 * do componente (doc-comment do arquivo) é "mesma tag sempre com a mesma
 * cor em qualquer tela".
 *
 * Não precisa de ambiente jsdom (não renderiza nada, só chama a função) —
 * roda no ambiente "node" padrão do projeto (ver vitest.config.ts).
 */
import { describe, expect, it } from "vitest";
import { corParaTag } from "@/components/ui/tag-badge";

const MATIZES_ESPERADOS = Array.from({ length: 8 }, (_, i) => `var(--tag-hue-${i + 1})`);

describe("corParaTag", () => {
  it("é determinística: a mesma tag sempre devolve a mesma cor, em qualquer chamada", () => {
    const tag = "A-AÇÕES";
    const primeira = corParaTag(tag);

    for (let i = 0; i < 20; i++) {
      expect(corParaTag(tag)).toBe(primeira);
    }
  });

  it("é determinística entre tags distintas com o mesmo conteúdo (nova instância de string)", () => {
    const a = "R-REAL ESTATE";
    const b = `R-REAL` + ` ESTATE`; // concatenada em runtime, mas com o mesmo conteúdo
    expect(corParaTag(a)).toBe(corParaTag(b));
  });

  it("sempre devolve um dos 8 valores --tag-hue-1..8 (nunca fora do intervalo)", () => {
    const tags = [
      "A-AÇÕES",
      "R-REAL ESTATE",
      "C-CAIXA",
      "F-FIIS",
      "I-INTERNACIONAL",
      "P-PREVIDÊNCIA",
      "",
      "x",
      "tag com espaço e Ç, ã, é",
      "TAG_MUITO_LONGA_PARA_TESTAR_O_HASH_1234567890",
    ];

    for (const tag of tags) {
      expect(MATIZES_ESPERADOS).toContain(corParaTag(tag));
    }
  });

  it("string vazia também produz uma cor válida e determinística (não lança, não é undefined)", () => {
    expect(MATIZES_ESPERADOS).toContain(corParaTag(""));
    expect(corParaTag("")).toBe(corParaTag(""));
  });

  it("tags diferentes tendem a distribuir entre matizes distintos (sanity check, não colisão garantida)", () => {
    // Não é uma garantia de design (o próprio doc-comment do componente
    // admite colisão quando há mais de 8 tags distintas) — só um sanity
    // check de que o hash não está "travado" sempre no mesmo matiz.
    const tags = ["A-AÇÕES", "R-REAL ESTATE", "C-CAIXA", "F-FIIS", "I-INTERNACIONAL"];
    const cores = new Set(tags.map(corParaTag));
    expect(cores.size).toBeGreaterThan(1);
  });
});
