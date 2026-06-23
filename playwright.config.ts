import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright smoke configuration.
 *
 * Two ways to run, switched by `SMOKE_BASE_URL`:
 *
 *   • LOCAL / CI (default) — `scripts/smoke.sh` boots the Firestore emulator +
 *     a local Postgres, seeds data, and Playwright starts `next dev` itself
 *     (the `webServer` block). Both projects run. This is the full gate.
 *
 *   • AGAINST A LIVE URL — `SMOKE_BASE_URL=https://commcare.app npm run
 *     test:smoke:url` skips the local server and the seeded-session project,
 *     running only the credential-free `public` checks (home loads, sign-in
 *     button wired, /api/auth/* healthy). This is the post-deploy prod probe —
 *     the cheapest thing that would have caught every auth outage we've shipped.
 *
 * Auth is bypassed entirely — no Google account, no real OAuth. The `authed`
 * project consumes `e2e/.auth/state.json`, a storageState carrying a
 * forged-but-valid session cookie minted by `e2e/seed.ts`.
 */
const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const isCI = !!process.env.CI;
// Parse the host rather than substring-match the URL (a substring check is both
// imprecise and a CodeQL js/incomplete-url-substring-sanitization finding).
const isLocalTarget = ((): boolean => {
	try {
		const host = new URL(BASE_URL).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "::1";
	} catch {
		return false;
	}
})();

/**
 * Env handed to the `next dev` the suite manages. `scripts/smoke.sh` already
 * exports these into the process env (so the emulator/seed and the server agree
 * on the secret + project), but forwarding them explicitly here guarantees they
 * win over any `.env` the dev server would otherwise load.
 */
const webServerEnv: Record<string, string> = {};
for (const key of [
	"GOOGLE_CLOUD_PROJECT",
	"FIRESTORE_EMULATOR_HOST",
	"BETTER_AUTH_SECRET",
	"BETTER_AUTH_URL",
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"NOVA_MEDIA_BUCKET",
	"NOVA_DB_LOCAL_URL",
]) {
	const value = process.env[key];
	if (value) webServerEnv[key] = value;
}

export default defineConfig({
	testDir: "./e2e/tests",
	// Generated artifacts live under e2e/.auth and e2e/test-results — kept out of git.
	outputDir: "./e2e/test-results",
	fullyParallel: true,
	forbidOnly: isCI,
	retries: isCI ? 2 : 0,
	// One worker: the suite shares a single emulator + seeded dataset; the delete
	// test mutates app rows, so parallel workers could race the app list.
	workers: 1,
	// Generous: the suite drives `next dev`, which compiles each route on first
	// hit. CI retries reuse the already-compiled server, so a retry is fast.
	timeout: 90_000,
	expect: { timeout: 15_000 },
	reporter: isCI
		? [
				["github"],
				["html", { open: "never", outputFolder: "e2e/playwright-report" }],
				["list"],
			]
		: [
				["list"],
				["html", { open: "never", outputFolder: "e2e/playwright-report" }],
			],
	use: {
		baseURL: BASE_URL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [
		{
			name: "public",
			testMatch: /public\.spec\.ts/,
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "authed",
			testMatch: /authed\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "e2e/.auth/state.json",
			},
		},
	],
	// Only manage a server when pointing at localhost. Against a deployed URL we
	// test what's already running.
	webServer: isLocalTarget
		? {
				command: "next dev",
				url: BASE_URL,
				reuseExistingServer: !isCI,
				// Next 16 + Turbopack cold compile of the first route is slow.
				timeout: 180_000,
				stdout: "pipe",
				stderr: "pipe",
				env: webServerEnv,
			}
		: undefined,
});
