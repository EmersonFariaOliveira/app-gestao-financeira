"use client";

/**
 * src/components/theme-provider.tsx — wireia o `next-themes` (já era
 * dependência do projeto, mas nunca tinha um provider montado — ver
 * `src/components/ui/sonner.tsx`, que sempre recebia `theme = "system"` por
 * falta de contexto).
 *
 * `attribute={["class", "data-theme"]}`: os tokens shadcn (`--background`
 * etc., src/app/globals.css) alternam via `.dark` num ancestral
 * (`@custom-variant dark (&:is(.dark *));`), enquanto os tokens de gráfico
 * (`--chart-surface-1` etc.) alternam via `:root[data-theme="dark"]` — um
 * único toggle precisa manter os dois mecanismos sincronizados, por isso o
 * `attribute` é um array (next-themes 0.3+ aceita ambos ao mesmo tempo).
 */
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute={["class", "data-theme"]}
      defaultTheme="system"
      enableSystem
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
