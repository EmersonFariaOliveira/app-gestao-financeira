import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  // Isolamento de camadas (CLAUDE.md): "UI não acessa banco nem calcula;
  // motor não faz I/O; só o parser conhece o formato do CSV."
  {
    // Motor de Aporte (src/core/**): lógica pura, sem I/O, sem framework,
    // sem conhecimento de persistência, parser ou UI.
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              message:
                "O motor é lógica pura e não deve depender do Prisma/banco. Passe os dados já carregados pela camada de serviços.",
            },
            {
              name: "next",
              message: "O motor não deve depender do Next.js (framework é da camada de UI).",
            },
            {
              name: "fs",
              message: "O motor não faz I/O de arquivos.",
            },
            {
              name: "path",
              message: "O motor não faz I/O de arquivos.",
            },
          ],
          patterns: [
            {
              group: ["@prisma/*"],
              message:
                "O motor é lógica pura e não deve depender do Prisma/banco. Passe os dados já carregados pela camada de serviços.",
            },
            {
              group: ["next/*"],
              message: "O motor não deve depender do Next.js (framework é da camada de UI).",
            },
            {
              group: ["@/db/*"],
              message:
                "O motor não acessa a camada de dados diretamente. Só recebe dados já resolvidos como parâmetros.",
            },
            {
              group: ["@/services/*"],
              message:
                "O motor não acessa a camada de serviços diretamente. Só recebe dados já resolvidos como parâmetros.",
            },
            {
              group: ["@/parser/*"],
              message: "O motor não deve depender do parser de CSV.",
            },
            {
              group: ["@/app/*"],
              message: "O motor não deve depender da camada de UI.",
            },
          ],
        },
      ],
    },
  },
  {
    // Parser CSV MyCapital (src/parser/**): único ponto que conhece o
    // formato do export; não deve conhecer persistência nem framework.
    files: ["src/parser/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              message: "O parser não deve conhecer persistência.",
            },
            {
              name: "next",
              message: "O parser não deve depender do Next.js.",
            },
          ],
          patterns: [
            {
              group: ["@prisma/*"],
              message: "O parser não deve conhecer persistência.",
            },
            {
              group: ["next/*"],
              message: "O parser não deve depender do Next.js.",
            },
            {
              group: ["@/db/*"],
              message: "O parser não deve conhecer persistência.",
            },
            {
              group: ["@/services/*"],
              message: "O parser não deve conhecer persistência.",
            },
          ],
        },
      ],
    },
  },
  {
    // UI (src/app/**): nunca acessa o banco diretamente — passa sempre por
    // src/app/actions/* -> src/services/*.
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/*"],
              message:
                "A UI não acessa o banco diretamente — passe por @/app/actions/* que chama @/services/*.",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
