import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import jobs from "@/config/deployment-jobs.json";

const config = z
	.object({
		steps: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				entrypoint: z.string(),
				args: z.array(z.string()),
				waitFor: z.array(z.string()).optional(),
				secretEnv: z.array(z.string()).optional(),
			}),
		),
		options: z.object({ machineType: z.string().optional() }),
		availableSecrets: z.object({
			secretManager: z.array(
				z.object({ versionName: z.string(), env: z.string() }),
			),
		}),
	})
	.parse(parse(readFileSync("cloudbuild.yaml", "utf8")));

const buildId = "00000000-0000-4000-8000-000000000001";
const ci = z
	.object({
		jobs: z.object({
			build: z.object({
				steps: z.array(
					z.object({
						name: z.string().optional(),
						run: z.string().optional(),
					}),
				),
			}),
		}),
	})
	.parse(parse(readFileSync(".github/workflows/ci.yml", "utf8")));

function step(id: string) {
	const found = config.steps.find((item) => item.id === id);
	if (!found) throw new Error(`Missing Cloud Build step: ${id}`);
	return found;
}

/** Execute the authored step shell. Only the container mount and Cloud Build
 * substitutions are adapted locally; process boundaries never reach Google. */
function runStep(id: string, mode = "success") {
	const directory = mkdtempSync(join(tmpdir(), "nova-cloud-step-"));
	const log = join(directory, "calls.jsonl");
	const digest =
		"us-central1-docker.pkg.dev/commcare-nova/repo/app@sha256:" +
		"a".repeat(64);
	const shim = `${[
		`#!${process.execPath}`,
		"const fs = require('node:fs');",
		"const name = require('node:path').basename(process.argv[1]);",
		"const args = process.argv.slice(2);",
		"fs.appendFileSync(process.env.NOVA_TEST_LOG, JSON.stringify({name,args}) + '\\n');",
		"if (name === 'python3' && args[0].endsWith('image-metadata.py')) {",
		" if(process.env.NOVA_TEST_MODE === 'metadata-failure') process.exit(17);",
		" fs.writeFileSync(args.find(a=>a.startsWith('--output=')).slice(9), 'export NOVA_IMMUTABLE_IMAGE=' + process.env.NOVA_TEST_IMAGE + '\\n');",
		"}",
		"if (name === 'python3' && args.includes('check') && process.env.NOVA_TEST_MODE === 'prerequisite-failure') process.exit(18);",
		"if (name === 'curl') {",
		" const header = args.indexOf('--dump-header');",
		" if(header >= 0) {",
		"  fs.writeFileSync(args[header+1], process.env.NOVA_TEST_MODE === 'missing-challenge' ? 'HTTP/2 401\\r\\n' : 'HTTP/2 401\\r\\nWWW-Authenticate: Bearer resource_metadata=\"https://mcp.commcare.app/.well-known/oauth-protected-resource\"\\r\\n');",
		"  process.stdout.write(process.env.NOVA_TEST_MODE === 'wrong-status' ? '200' : '401');",
		" } else if(process.env.NOVA_TEST_MODE === 'public-failure') process.exit(22);",
		"}",
	].join("\n")}\n`;
	try {
		writeFileSync(log, "");
		for (const name of ["python3", "curl", "sleep", "docker"]) {
			writeFileSync(join(directory, name), shim, { mode: 0o700 });
		}
		execFileSync(
			process.execPath,
			[
				"scripts/rollout/render-build-config.mjs",
				"--build-id",
				buildId,
				"--output",
				join(directory, "rollout.env"),
			],
			{ encoding: "utf8" },
		);
		writeFileSync(join(directory, "cache.env"), "");
		writeFileSync(
			join(directory, "image.env"),
			`export NOVA_IMMUTABLE_IMAGE=${digest}\n`,
		);
		const ciBuild = ci.jobs.build.steps.find(
			({ name }) => name === "Build deployable image",
		)?.run;
		if (id === "ci-build" && !ciBuild)
			throw new Error("Missing CI final image build");
		const item =
			id === "ci-build"
				? {
						entrypoint: "bash",
						args: ["-e", "-o", "pipefail", "-c", ciBuild ?? ""],
					}
				: step(id);
		const result = spawnSync(
			item.entrypoint,
			item.args.map((arg) =>
				arg
					.replaceAll("$PROJECT_ID", "commcare-nova")
					.replaceAll("$BUILD_ID", buildId)
					.replaceAll("$$", "$")
					.replaceAll("/workspace", directory),
			),
			{
				encoding: "utf8",
				timeout: 10_000,
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH}`,
					NOVA_TEST_LOG: log,
					NOVA_TEST_MODE: mode,
					NOVA_TEST_IMAGE: digest,
					RUNNER_TEMP: directory,
					GITHUB_SHA: "commit-identity",
					NOVA_CI_BUILD_ID: buildId,
					NOVA_BUILD_CACHE_DIRECTORY: join(directory, "cache"),
					NOVA_NEXT_CACHE_FROM: "",
					NOVA_DOCKER_CACHE_FROM: "",
					NOVA_SEPARATE_MIGRATION_BUILD: "",
					NOVA_BUILDX_BUILDER: "",
					NOVA_IMAGE_OUTPUT: "load",
					SENTRY_AUTH_TOKEN:
						id === "ci-build" ? "" : "synthetic-private-sentry",
					NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "synthetic-private-actions",
					NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "synthetic-public-maps",
				},
			},
		);
		const calls = z
			.array(z.object({ name: z.string(), args: z.array(z.string()) }))
			.parse(
				readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line)),
			);
		return { result, calls, digest };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("application release admission and authority", () => {
	test.each(["build", "ci-build"])(
		"the actual %s caller compiles the runner with a unique release identity and ephemeral credentials",
		(id) => {
			const { result, calls } = runStep(id);
			expect(result.status, result.stderr).toBe(0);
			const builds = calls.filter(
				({ name, args }) =>
					name === "docker" && args[0] === "buildx" && args[1] === "build",
			);
			expect(
				builds.map(({ args }) => args[args.indexOf("--target") + 1]),
			).toEqual(
				id === "build"
					? ["cache-seed", "runner"]
					: ["migration", "cache-seed", "runner"],
			);
			const runner = builds.at(-1)?.args ?? [];
			expect(runner).toContain(`NOVA_BUILD_ID=${buildId}`);
			expect(runner).toContain(`NEXT_DEPLOYMENT_ID=${buildId}`);
			expect(runner).toContain(
				"id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
			);
			expect(JSON.stringify(calls)).not.toContain("synthetic-private");
			if (id === "build") {
				expect(runner).toContain(
					`type=image,name=us-central1-docker.pkg.dev/commcare-nova/cloud-run-source-deploy/commcare-nova/app:${buildId},push=true`,
				);
				expect(runner).toContain("--metadata-file");
				expect(runner).not.toContain("--load");
			} else {
				expect(runner).toContain("--load");
				expect(runner).toContain("commcare-nova:ci-commit-identity");
				expect(
					calls.filter(
						({ name, args }) => name === "docker" && args[0] === "run",
					),
				).toHaveLength(1);
				expect(
					calls
						.flatMap(({ args }) => args)
						.some((arg) => arg.includes("push=true")),
				).toBe(false);
			}
		},
	);

	test("deployment depends on migration success and the immutable app image; cache publication is independent", () => {
		expect(new Set(config.steps.map(({ id }) => id)).size).toBe(
			config.steps.length,
		);
		const dependencies = new Map(
			config.steps.map((item, index) => [
				item.id,
				item.waitFor?.includes("-")
					? []
					: (item.waitFor ?? config.steps.slice(0, index).map(({ id }) => id)),
			]),
		);
		function ancestors(id: string, path: string[] = []): Set<string> {
			if (path.includes(id))
				throw new Error(`Cyclic build graph: ${[...path, id].join(" -> ")}`);
			const parents = dependencies.get(id);
			if (!parents) throw new Error(`Unknown build step: ${id}`);
			return new Set(
				parents.flatMap((parent) => [
					parent,
					...ancestors(parent, [...path, id]),
				]),
			);
		}
		for (const item of config.steps) ancestors(item.id);
		expect(ancestors("deploy")).toEqual(
			new Set([
				"migrate",
				"migration-image",
				"prepare-builder",
				"restore-cache",
				"prerequisites",
				"resolve-image",
				"build",
				"runtime-capabilities",
			]),
		);
		expect(ancestors("verify")).toContain("deploy");
		expect(ancestors("build")).not.toContain("migrate");
		expect(ancestors("prerequisites")).toEqual(new Set());
		expect(ancestors("publish-cache")).toContain("export-cache");
		expect(ancestors("deploy")).not.toContain("publish-cache");
		expect(config.options.machineType).toBeUndefined();
	});

	test("the Action encryption key is pinned and available only to the application build", () => {
		expect(
			config.availableSecrets.secretManager.find(
				({ env }) => env === "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
			),
		).toEqual({
			env: "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
			versionName:
				"projects/$PROJECT_ID/secrets/nova-server-actions-key/versions/1",
		});
		expect(
			config.steps
				.filter(({ secretEnv }) => secretEnv?.length)
				.map(({ id }) => id),
		).toEqual(["build"]);
		expect(new Set(step("build").secretEnv)).toEqual(
			new Set([
				"SENTRY_AUTH_TOKEN",
				"NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
				"NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
			]),
		);
	});

	test("prerequisites only inspect infrastructure and failed checks stop the remaining step", () => {
		const success = runStep("prerequisites");
		expect(success.result.status, success.result.stderr).toBe(0);
		expect(success.calls.map(({ args }) => args.slice(0, 2))).toEqual([
			["scripts/infra/manage-deployment.py", "check"],
			["scripts/rollout/deploy-cloud-run.py", "--read-scaling-prestate"],
		]);
		const failed = runStep("prerequisites", "prerequisite-failure");
		expect(failed.result.status).toBe(18);
		expect(failed.calls).toHaveLength(1);
	});

	test("the migration gate receives the resolved digest and never runs after metadata failure", () => {
		const success = runStep("migrate");
		expect(success.result.status, success.result.stderr).toBe(0);
		expect(success.calls.map(({ args }) => basename(args[0]))).toEqual([
			"image-metadata.py",
			"migration-gate.py",
		]);
		expect(success.calls[1].args).toEqual([
			"scripts/rollout/migration-gate.py",
			"--project=commcare-nova",
			"--region=us-central1",
			"--job=commcare-nova-migrate",
			`--image=${success.digest}`,
		]);
		const failed = runStep("migrate", "metadata-failure");
		expect(failed.result.status).toBe(17);
		expect(failed.calls).toHaveLength(1);
	});

	test("deployment passes immutable identity, ordinary service authority, scaling and startup admission", () => {
		const { result, calls, digest } = runStep("deploy");
		expect(result.status, result.stderr).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			name: "python3",
			args: [
				"scripts/rollout/deploy-cloud-run.py",
				"--project=commcare-nova",
				"--region=us-central1",
				"--service=commcare-nova",
				`--image=${digest}`,
				"--expected-min=1",
				"--expected-max=4",
				"--",
				"--service-account=commcare-nova@commcare-nova.iam.gserviceaccount.com",
				"--network=default",
				"--subnet=default",
				"--vpc-egress=private-ranges-only",
				"--update-env-vars=NOVA_DB_WORKLOAD=service,NOVA_DB_USER=commcare-nova@commcare-nova.iam,NOVA_DB_INSTANCE_CONNECTION_NAME=commcare-nova:us-central1:nova-cases,NOVA_DB_NAME=nova_cases,NOVA_MEDIA_BUCKET=nova-multimedia-prod",
				"--no-default-url",
				"--ingress=internal-and-cloud-load-balancing",
				"--min=1",
				"--max=4",
				"--min-instances=1",
				"--max-instances=4",
				"--timeout=3600s",
				"--no-cpu-throttling",
				"--update-secrets=OPENAI_API_KEY=nova-openai-api-key:latest",
				"--startup-probe=httpGet.path=/warmup,httpGet.port=8080,initialDelaySeconds=0,timeoutSeconds=10,periodSeconds=10,failureThreshold=24",
			],
		});
	});

	test.each(["success", "public-failure", "missing-challenge", "wrong-status"])(
		"public probes require reachable hosts and an MCP discovery challenge (%s)",
		(mode) => {
			const { result, calls } = runStep("verify", mode);
			expect(result.status, result.stderr).toBe(
				mode === "success" ? 0 : mode === "public-failure" ? 22 : 1,
			);
			const urls = calls
				.filter(({ name }) => name === "curl")
				.map(({ args }) => args.at(-1));
			if (mode === "success")
				expect(urls).toEqual([
					"https://commcare.app/",
					"https://docs.commcare.app/",
					"https://mcp.commcare.app/mcp",
				]);
			if (mode === "wrong-status")
				expect(
					urls.filter((url) => url === "https://mcp.commcare.app/mcp"),
				).toHaveLength(12);
			if (mode === "public-failure")
				expect(urls).toEqual(["https://commcare.app/"]);
		},
	);

	test("permanent migration and cleanup Jobs retain separate authority and bounded execution", () => {
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
			tasks: 1,
			parallelism: 1,
			maxRetries: 0,
			env: {
				NOVA_DB_WORKLOAD: "capture-cleanup",
				NOVA_DB_USER: "nova-capture-cleanup@commcare-nova.iam",
			},
		});
	});
});
