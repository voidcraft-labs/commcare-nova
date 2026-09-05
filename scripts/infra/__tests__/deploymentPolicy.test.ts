import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import jobs from "@/config/deployment-jobs.json";

const read = (path: string) => readFileSync(path, "utf8");
const cloudBuild = read("cloudbuild.yaml");
const dockerfile = read("Dockerfile");
const ciWorkflow = read(".github/workflows/ci.yml");
const imageBuilder = read("scripts/rollout/build-image.sh");
const dockerignore = read(".dockerignore");
const migrate = read("scripts/migrate.ts");
const cleanup = read("scripts/cleanup-form-attachments.ts");
const policy = read("scripts/rollout/deploy-cloud-run.py");

function step(id: string): string {
	const source = cloudBuild.split(`  - id: ${id}\n`)[1];
	expect(source, `missing Cloud Build step ${id}`).toBeDefined();
	return source.split("  - id: ")[0];
}

describe("deployment artifact and release contracts", () => {
	test("verifies runtime declarations and keeps per-build skew/Sentry identities", () => {
		expect(
			execFileSync(
				"node",
				["scripts/rollout/render-build-config.mjs", "--check"],
				{ encoding: "utf8" },
			),
		).toContain("Runtime capability manifest and build wiring are valid");
		expect(cloudBuild).toContain("nova-server-actions-key/versions/1");
		expect(cloudBuild).not.toContain("app:$COMMIT_SHA");
		expect(cloudBuild).toContain('export NEXT_DEPLOYMENT_ID="$BUILD_ID"');
		expect(dockerfile).toContain(
			`NEXT_PUBLIC_NOVA_BUILD_ID="\${NOVA_BUILD_ID}"`,
		);
		expect(read("next.config.ts")).toContain(
			"release: { name: process.env.NOVA_BUILD_ID }",
		);
		expect(read("instrumentation-client.ts")).toContain(
			"release: process.env.NEXT_PUBLIC_NOVA_BUILD_ID || undefined",
		);
		for (const file of ["sentry.server.config.ts", "sentry.edge.config.ts"]) {
			expect(read(file)).toContain(
				"release: process.env.NOVA_BUILD_ID || undefined",
			);
		}
	});

	test("requires one migration execution before application and worker image updates", () => {
		expect(step("migrate")).toContain(
			"waitFor: [resolve-image, prerequisites]",
		);
		expect(step("deploy")).toContain("waitFor: [migrate]");
		expect(step("capture-cleanup")).toContain("waitFor: [migrate]");
		expect(step("verify")).toContain("waitFor: [deploy, capture-cleanup]");
		expect(cloudBuild.match(/--execute-job/g)).toHaveLength(1);
		expect(step("capture-cleanup")).toContain("--verify-job");
		for (const forbidden of [
			"jobs deploy",
			"scheduler jobs update",
			"add-iam-policy-binding",
			"--enter-maintenance",
			"--update-labels",
			"--execution-arg=--probe-schema",
			"--no-traffic",
			"update-traffic",
		]) {
			expect(cloudBuild).not.toContain(forbidden);
		}
		expect(step("prerequisites")).toContain("manage-deployment.py check");
		expect(step("prerequisites")).toContain("waitFor: ['-']");
		for (const host of [
			"https://commcare.app/",
			"https://docs.commcare.app/",
			"https://mcp.commcare.app/mcp",
		])
			expect(step("verify")).toContain(host);
		expect(step("verify")).toContain("resource_metadata=");
	});

	test("keeps current migrations and the complete runtime probe, but retires recurring historical repairs", () => {
		for (const required of [
			"runCaseStoreMigrationsWithReport",
			"getMigrations",
			"runAuthAppMigrations",
			"drainAllPendingIndexConvergence",
			"convergeDatabasePrivileges",
			"runCanonicalRuntimeDatabaseProbe",
		])
			expect(migrate).toContain(required);
		for (const retired of [
			"runLanguageIdentityRepair",
			"runCaseStatusFilterRepair",
			"runSelectOptionValueRepair",
			"runXPathCarrierCompatibilityVerification",
			"migrateBetterAuthAccountIdentity",
			"migrateBetterAuthOauthClients",
			"terminateAndAssertNoRuntimeDatabaseSessions",
		])
			expect(migrate).not.toContain(retired);
		const worker = cleanup.slice(
			cleanup.indexOf("async function runMaintenance"),
			cleanup.indexOf("async function main"),
		);
		expect(worker.indexOf("runCaptureCleanupSchemaProbe()")).toBeLessThan(
			worker.indexOf("purgeExpiredFormAttachments("),
		);
		expect(cleanup).toContain(
			"withExclusiveCaptureCleanupWorker(runMaintenance)",
		);
	});

	test("retains exact Job authority, database targets, and resource budgets outside deploy", () => {
		expect(jobs["commcare-nova-migrate"]).toMatchObject({
			serviceAccount: "nova-migrate@commcare-nova.iam.gserviceaccount.com",
			args: ["migrate.cjs"],
			tasks: 1,
			parallelism: 1,
			maxRetries: 0,
			vpc: true,
			env: {
				NOVA_DB_WORKLOAD: "migration",
				NOVA_DB_USER: "nova-migrate@commcare-nova.iam",
			},
		});
		expect(jobs["commcare-nova-capture-cleanup"]).toMatchObject({
			serviceAccount:
				"nova-capture-cleanup@commcare-nova.iam.gserviceaccount.com",
			args: ["capture-cleanup.cjs"],
			maxRetries: 0,
			env: {
				NOVA_DB_WORKLOAD: "capture-cleanup",
				NOVA_DB_USER: "nova-capture-cleanup@commcare-nova.iam",
			},
		});
		expect(step("deploy")).toContain(
			"--min=1 --max=4 --min-instances=1 --max-instances=4",
		);
		expect(step("deploy")).toContain("--no-cpu-throttling");
		expect(step("deploy")).toContain(
			"--no-default-url --ingress=internal-and-cloud-load-balancing",
		);
		expect(step("deploy")).toContain("--startup-probe=httpGet.path=/warmup");
		expect(read("scripts/infra/provision-cloud-sql.sh")).toContain(
			`readonly DATABASE_FLAGS="cloudsql.enable_pgaudit=on,cloudsql.iam_authentication=on,max_connections=\${MAX_CONNECTIONS},pgaudit.log=all"`,
		);
	});

	test("rejects wrong images, authority, failed tasks, and extra revisions", () => {
		expect(
			execFileSync(
				"python3",
				["scripts/rollout/deploy-cloud-run.py", "--policy-self-test"],
				{ encoding: "utf8" },
			),
		).toContain("policy self-test passed");
		expect(policy).toContain('"etag": etag');
		expect(policy).toContain('method == "GET"');
		expect(policy).not.toContain("_enter_maintenance_mode");
		expect(policy).not.toContain("_automatic_scaling_update_command");
	});

	test("keeps Java verification and the audited profiler hardener in the production build", () => {
		const scripts = JSON.parse(read("package.json")).scripts;
		expect(scripts.prebuild).toBe(
			"npm run verify:java-pattern-runtime && npm run build:xpath-worker",
		);
		expect(scripts.build).toBe(
			"NEXT_TELEMETRY_DISABLED=1 next build && tsc --noEmit",
		);
		expect(dockerfile).toContain("&& npm run build");
		expect(
			dockerfile.indexOf("RUN node scripts/harden-agent-react-devtools.mjs"),
		).toBeLessThan(dockerfile.indexOf("FROM sources AS builder"));
		expect(dockerfile).toContain(
			"public/third-party/java-pattern-runtime-source.tar.gz",
		);
		expect(
			execFileSync("node", ["scripts/java-pattern-runtime/verify.mjs"], {
				encoding: "utf8",
			}),
		).toContain("java-pattern-runtime pattern_sha256=");
	});

	test("packages maintenance only in its explicit target and keeps every bundle input in Docker context", async () => {
		const entries = [
			...dockerfile.matchAll(/npx esbuild (scripts\/[^\s\\]+)/g),
		].map((match) => match[1]);
		const runner = dockerfile.slice(
			dockerfile.indexOf(`FROM \${NODE_IMAGE} AS runner`),
		);
		expect(runner).toContain("/app/migrate.cjs");
		expect(runner).toContain("/app/capture-cleanup.cjs");
		for (const removed of [
			"media-bucket-policy.cjs",
			"legacy-preplan-repair.cjs",
			"canonical-identity-audit.cjs",
			"schema-drift.cjs",
			"case-parent-relationship-repair.cjs",
		])
			expect(runner).not.toContain(removed);
		expect(dockerfile).toContain("FROM sources AS maintenance-build");
		expect(dockerfile).toContain("FROM scratch AS next-cache-export");
		expect(runner).not.toContain(".next/cache");
		const allowlist = new Set(
			dockerignore
				.split(/\r?\n/)
				.filter((line) => line.startsWith("!"))
				.map((line) => line.slice(1)),
		);
		// Run the operator entrypoints outside the checkout so a missing bundled
		// dependency cannot accidentally resolve from this repo's node_modules.
		const directory = mkdtempSync(join(tmpdir(), "nova-maintenance-contract-"));
		try {
			const bundle = await build({
				entryPoints: entries,
				bundle: true,
				platform: "node",
				target: "node24",
				format: "cjs",
				conditions: ["react-server"],
				tsconfig: "tsconfig.json",
				external: ["pg-native"],
				outdir: directory,
				outbase: "scripts",
				outExtension: { ".js": ".cjs" },
				metafile: true,
				logLevel: "silent",
			});
			expect(
				Object.keys(bundle.metafile.inputs).filter(
					(input) => input.startsWith("scripts/") && !allowlist.has(input),
				),
			).toEqual([]);
			for (const entry of entries.filter((entry) =>
				entry.startsWith("scripts/migrate-"),
			)) {
				const file = entry.replace(/^scripts\//, "").replace(/\.ts$/, ".cjs");
				expect(
					execFileSync(process.execPath, [join(directory, file), "--help"], {
						cwd: directory,
						encoding: "utf8",
						timeout: 10_000,
					}),
				).toContain("Usage:");
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);

	test("CI and Cloud Build use the same final-image command, with ephemeral secrets", () => {
		for (const caller of [ciWorkflow, cloudBuild])
			expect(
				caller.match(/bash scripts\/rollout\/build-image\.sh/g),
			).toHaveLength(1);
		expect(ciWorkflow).not.toContain("docker push");
		expect(imageBuilder).not.toContain("--push");
		for (const secret of [
			"SENTRY_AUTH_TOKEN",
			"NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
		]) {
			expect(dockerfile).not.toContain(`ARG ${secret}`);
			expect(imageBuilder).not.toContain(`--build-arg "${secret}=`);
			expect(dockerfile).toContain(`type=secret,id=${secret},env=${secret}`);
		}
	});

	test("the actual helper cannot bypass the full image or put secrets in Docker arguments", () => {
		const directory = mkdtempSync(join(tmpdir(), "nova-image-contract-"));
		try {
			const log = join(directory, "calls.jsonl");
			writeFileSync(
				join(directory, "docker"),
				`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.NOVA_TEST_DOCKER_LOG, JSON.stringify(process.argv.slice(2))+'\\n');\n`,
				{ mode: 0o700 },
			);
			const env = {
				...process.env,
				PATH: `${directory}:${process.env.PATH}`,
				NOVA_TEST_DOCKER_LOG: log,
				NOVA_IMAGE_TAG: "nova:test",
				NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "synthetic-public",
				NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID: "map",
				SENTRY_AUTH_TOKEN: "synthetic-private-token",
				NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "synthetic-private-key",
				NEXT_DEPLOYMENT_ID: "build-2",
				NOVA_BUILD_ID: "build-2",
				NOVA_CLOUD_RUN_REQUEST_SECONDS: "3600",
				NOVA_EDIT_RUN_LEASE_SECONDS: "900",
				NOVA_BUILD_STALENESS_SECONDS: "600",
				NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH: "hash",
				NOVA_BUILD_CACHE_DIRECTORY: join(directory, "cache"),
				NOVA_EXPORT_NEXT_CACHE: "true",
				NOVA_DOCKER_CACHE_TO: "registry/cache:test",
			};
			execFileSync("bash", ["scripts/rollout/build-image.sh"], { env });
			const calls: string[][] = read(log)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const builds = calls.filter(
				(args) => args[0] === "buildx" && args[1] === "build",
			);
			expect(builds).toHaveLength(3);
			expect(builds[0].slice(-6)).toEqual([
				"--target",
				"runner",
				"--load",
				"--tag",
				"nova:test",
				".",
			]);
			expect(builds[0]).not.toContain("--cache-to");
			expect(builds[1]).toContain("jobs");
			expect(builds[1]).toContain("type=cacheonly");
			expect(builds[2]).toContain("next-cache-export");
			expect(JSON.stringify(calls)).not.toContain("synthetic-private");
			expect(calls.some((args) => args[1] === "use")).toBe(false);
			const bad = spawnSync(
				"bash",
				["scripts/rollout/build-image.sh", "--target", "deps"],
				{ env, encoding: "utf8" },
			);
			expect(bad.status).toBe(2);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
