"use client";

/**
 * src/components/theme-toggle.tsx — botão sol/lua do header global
 * (src/components/nav/site-header.tsx) que alterna claro/escuro via
 * `next-themes` (src/components/theme-provider.tsx).
 *
 * `mounted` evita mismatch de hidratação: no primeiro render do servidor
 * `resolvedTheme` é sempre indefinido (o tema real só é conhecido no
 * cliente, via localStorage/`prefers-color-scheme`) — até montar, o ícone
 * fica em um estado neutro fixo em vez de arriscar um valor que diverge do
 * que o `next-themes` decide no cliente.
 */
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const escuro = mounted && resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Alternar tema claro/escuro"
      onClick={() => setTheme(escuro ? "light" : "dark")}
    >
      {mounted ? (
        escuro ? <Sun className="size-4" /> : <Moon className="size-4" />
      ) : (
        <Sun className="size-4 opacity-0" aria-hidden />
      )}
    </Button>
  );
}
