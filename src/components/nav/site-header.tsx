/**
 * src/components/nav/site-header.tsx — header estático global (visível em
 * toda navegação, acima da sidebar + conteúdo), com o título do app
 * (mesmo texto de `metadata.title`, src/app/layout.tsx) e o toggle de tema
 * (src/components/theme-toggle.tsx). Server Component puro: o único pedaço
 * client é o próprio toggle.
 */
import { ThemeToggle } from "@/components/theme-toggle";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4 sm:px-6">
      <span className="text-sm font-heading font-semibold tracking-tight">
        Gestão de Aportes
      </span>
      <ThemeToggle />
    </header>
  );
}
