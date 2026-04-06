import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5001",
    extraHTTPHeaders: {
      "Content-Type": "application/json",
    },
  },
  reporter: [["list"], ["html", { outputFolder: "test-results/playwright", open: "never" }]],
});
