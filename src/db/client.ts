import { PrismaClient } from "@prisma/client";

// Singleton do Prisma Client (T008): evita múltiplas instâncias/conexões em
// dev com hot-reload do Next.js. Padrão recomendado pela documentação do
// Prisma para Next.js — guarda a instância em `globalThis` apenas fora de
// produção, onde o módulo pode ser recarregado várias vezes no mesmo processo.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
