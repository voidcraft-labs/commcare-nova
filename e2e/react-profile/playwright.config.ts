import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	outputDir: "../test-results/react-profile",
	reporter: "list",
	use: {
		baseURL: process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3101",
		storageState: "e2e/.auth/state.json",
		headless: false,
		viewport: { width: 1440, height: 900 },
		trace: "retain-on-failure",
	},
});
