import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
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
