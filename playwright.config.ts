import { defineConfig, devices } from "@playwright/test";
import { SMOKE_RETRIES } from "./e2e/lib/config";
import { urlHost } from "./e2e/lib/url";

/**
 * Playwright smoke configuration.
 *
 * Two ways to run, switched by `SMOKE_BASE_URL`:
 *
 *   • LOCAL / CI (default) — `scripts/smoke.sh` boots the Firestore emulator +
 *     a local Postgres, seeds data, and Playwright builds + serves the
 *     production server itself (the `webServer` block — `next build && next
 *     start`, not dev, for prod fidelity). Both projects run. This is the full gate.
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
const localHost = urlHost(BASE_URL);
const isLocalTarget =
	localHost === "localhost" || localHost === "127.0.0.1" || localHost === "::1";
// Only manage our own server when scripts/smoke.sh is driving (it exports this).
// Otherwise — e.g. `test:smoke:url` probing an already-running URL, even a
// localhost one — don't spin up a server (and don't require the emulator env).
const manageServer = process.env.SMOKE_MANAGE_SERVER === "1";

/**
 * Env handed to the production server the suite builds + runs, forwarded
 * explicitly so it wins over any `.env` the server would otherwise load.
 * `scripts/smoke.sh`
 * exports all of these; the REQUIRED ones must be present, or the seed and the
 * server silently disagree on the Firestore namespace / signing secret and the
 * authed tests fail with a confusing "no data" instead of a clear cause.
 */
const REQUIRED_SERVER_ENV = [
	"GOOGLE_CLOUD_PROJECT",
	"FIRESTORE_EMULATOR_HOST",
	"BETTER_AUTH_SECRET",
	"BETTER_AUTH_URL",
	"NOVA_DB_LOCAL_URL",
] as const;
const OPTIONAL_SERVER_ENV = [
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"NOVA_MEDIA_BUCKET",
	// Suppresses google-auth's GCE metadata probe (a noisy MetadataLookupWarning)
	// — the smoke env is not on GCP. See scripts/smoke.sh.
	"METADATA_SERVER_DETECTION",
] as const;

/** Build the managed-server env, failing loud if a required var is missing. */
function smokeWebServerEnv(): Record<string, string> {
	const missing = REQUIRED_SERVER_ENV.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Smoke web server is missing required env: ${missing.join(", ")}. ` +
				"Run the suite via `npm run test:smoke` (scripts/smoke.sh sets these and boots the emulator), not `playwright test` directly.",
		);
	}
	const env: Record<string, string> = {};
	for (const key of [...REQUIRED_SERVER_ENV, ...OPTIONAL_SERVER_ENV]) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

export default defineConfig({
	testDir: "./e2e/tests",
	// Generated artifacts live under e2e/.auth and e2e/test-results — kept out of git.
	outputDir: "./e2e/test-results",
	fullyParallel: true,
	forbidOnly: isCI,
	// Single-sourced with the seed's throwaway-app count (e2e/lib/config.ts).
	retries: SMOKE_RETRIES,
	// One worker: the suite shares a single emulator + seeded dataset; the delete
	// test mutates app rows, so parallel workers could race the app list.
	workers: 1,
	// Generous headroom for a full page load + assertions. `next start` serves
	// pre-compiled routes, so this isn't covering a cold compile.
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
		{
			// Two-user real-time co-editing acceptance. NO project-level
			// storageState — the spec opens its own `browser.newContext({
			// storageState })` per user (Ada + Grace), each carrying that user's
			// seeded session cookie (`e2e/.auth/state-mp-{a,b}.json`).
			name: "multiplayer",
			testMatch: /multiplayer\.spec\.ts/,
			use: { ...devices["Desktop Chrome"] },
		},
	],
	// Manage our own server only when smoke.sh is driving a localhost run.
	// Against a deployed URL (or any already-running server) we test what's there.
	webServer:
		manageServer && isLocalTarget
			? {
					// Build + serve the PRODUCTION artifact, not `next dev`. Two reasons:
					// (1) fidelity — the smoke then exercises what actually deploys
					// (minified, prod React), so a build-only break is caught here; and
					// (2) `next dev` forwards SERVER console output into the BROWSER
					// console, where the error guard would catch benign server logs —
					// `next start` doesn't. `fumadocs-mdx` first generates the
					// `@/.source/server` import `next build` needs (as typecheck does).
					command: "npx fumadocs-mdx && next build && next start",
					url: BASE_URL,
					// Never reuse a stray server: a dev's own `npm run dev` on :3000
					// points at REAL Firestore with a different secret, so reusing it
					// would run the authed tests against the wrong backend (the forged
					// emulator cookie fails to validate) — a confusing red. Always start
					// the suite's own emulator-wired server.
					reuseExistingServer: false,
					// Covers the production build (~2 min) + boot. `next start` serves
					// pre-compiled routes, so per-test requests are fast after this.
					timeout: 300_000,
					stdout: "pipe",
					stderr: "pipe",
					env: smokeWebServerEnv(),
				}
			: undefined,
});
