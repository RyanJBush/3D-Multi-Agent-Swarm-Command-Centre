import { defineConfig, type Plugin } from "vitest/config";

/** Dev server only: allow Vite's hot-reload websocket. Built output keeps connect-src 'none'. */
const devCsp: Plugin = {
  name: "dev-csp",
  apply: "serve",
  transformIndexHtml: (html) => html.replace("connect-src 'none'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:*"),
};

export default defineConfig({
  base: "./",
  plugins: [devCsp],
  build: { outDir: "dist", sourcemap: true },
  test: { include: ["tests/**/*.test.ts"] },
});
