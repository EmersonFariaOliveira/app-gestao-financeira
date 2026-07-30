"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Upload,
  Link2,
  Target,
  Calculator,
  Coins,
  History,
  Settings,
} from "lucide-react";

import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/import", label: "Import mensal", icon: Upload },
  { href: "/vinculos", label: "Vínculos", icon: Link2 },
  { href: "/alvos", label: "Carteira alvo", icon: Target },
  { href: "/aporte", label: "Aporte", icon: Calculator },
  { href: "/dividendos", label: "Dividendos", icon: Coins },
  { href: "/historico", label: "Histórico", icon: History },
  { href: "/configuracoes", label: "Configurações", icon: Settings },
];

/**
 * Rota é considerada ativa em correspondência exata para "/" e por prefixo
 * para as demais (ex.: futuras sub-rotas de /aporte continuam destacadas).
 */
function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navegação principal"
      className="flex h-full flex-col gap-1 p-3"
    >
      <div className="px-2 py-3">
        <span className="text-sm font-heading font-semibold tracking-tight">
          Gestão de Aportes
        </span>
      </div>
      <ul className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
