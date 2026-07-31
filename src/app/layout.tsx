import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { SidebarNav } from "@/components/nav/sidebar-nav";
import { SiteHeader } from "@/components/nav/site-header";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Gestão de Aportes",
  description: "Divisão mensal do aporte entre os ativos mais abaixo da carteira alvo.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>
          <div className="flex min-h-screen flex-col">
            <SiteHeader />
            <div className="flex flex-1">
              <aside className="sticky top-14 h-[calc(100vh-3.5rem)] w-60 shrink-0 overflow-y-auto border-r border-border bg-sidebar text-sidebar-foreground">
                <SidebarNav />
              </aside>
              <main className="flex-1 p-6 sm:p-8">{children}</main>
            </div>
          </div>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
