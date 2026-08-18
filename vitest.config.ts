import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // tsconfig.json usa "jsx": "preserve" (exigido pelo Next.js/SWC no build
  // real da app). Sem isto, o transformador do Vite (oxc, na v8) herda
  // "preserve" ao ler o tsconfig e falha ao importar qualquer .tsx que
  // contenha JSX de verdade (erro "Failed to parse source for import
  // analysis... make sure to not set jsx to preserve"). Isto só afeta a
  // transformação usada pelos testes — o build de produção continua via
  // Next.js/SWC, inalterado.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    environment: "node",
    // "forks" em vez do default "threads": o pool de worker_threads do
    // Vitest 4 falha nesta máquina (Node 26) com "Vitest failed to find
    // the current suite" em TODO arquivo de teste, mesmo os pré-existentes
    // e já verdes antes desta sessão — regressão de ambiente, não do
    // código. "forks" (child_process) contorna o problema sem mudar
    // nenhuma asserção; reavaliar quando a combinação Vitest/Node estável
    // corrigir o pool de threads.
    pool: "forks",
    coverage: {
      provider: "v8",
    },
    passWithNoTests: true,
  },
});
