import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("image helper process contracts", () => {
	test("cache export cannot compile the application or require its credentials", () => {
		const directory = mkdtempSync(join(tmpdir(), "nova-cache-export-"));
		try {
			const log = join(directory, "calls.jsonl");
			writeFileSync(
				join(directory, "docker"),
				`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.NOVA_TEST_DOCKER_LOG, JSON.stringify(process.argv.slice(2))+'\\n');\n`,
				{ mode: 0o700 },
			);
			const result = spawnSync(
				"bash",
				["scripts/rollout/export-build-cache.sh"],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${directory}:${process.env.PATH}`,
						NOVA_TEST_DOCKER_LOG: log,
						NOVA_BUILD_ID: "cache-contract",
						NOVA_BUILD_CACHE_DIRECTORY: join(directory, "cache"),
						NOVA_BUILDX_BUILDER: "isolated-contract",
						NOVA_IMAGE_TAG: "",
						NOVA_DOCKER_CACHE_TO: "registry/dependencies:contract",
						NOVA_NEXT_CACHE_TO: "registry/compiler:contract",
						SENTRY_AUTH_TOKEN: "",
						NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "",
						NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "",
					},
				},
			);
			expect(result.status, result.stderr).toBe(0);
			const calls: string[][] = read(log)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const builds = calls.filter(
				(args) => args[0] === "buildx" && args[1] === "build",
			);
			expect(
				builds.map((args) => args[args.indexOf("--target") + 1]).sort(),
			).toEqual(["deps", "next-cache-export"]);
			expect(builds.every((args) => !args.includes("--secret"))).toBe(true);
			expect(builds.flat().some((arg) => arg.includes("mode=min"))).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test.each(["success", "cache-failure", "runner-failure"])(
		"image helper preserves the full build and cache-failure boundary (%s)",
		(mode) => {
			const directory = mkdtempSync(join(tmpdir(), "nova-image-contract-"));
			try {
				const log = join(directory, "calls.jsonl");
				writeFileSync(
					join(directory, "docker"),
					`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.NOVA_TEST_DOCKER_LOG, JSON.stringify(process.argv.slice(2))+'\\n');\nconst args=process.argv.slice(2);\nif (process.env.NOVA_TEST_MODE === 'cache-failure' && args.includes('cache-seed') && args.some(a => a.startsWith('next-cache=docker-image://'))) process.exit(11);\nif (process.env.NOVA_TEST_MODE === 'runner-failure' && args.includes('runner')) process.exit(12);\n`,
					{ mode: 0o700 },
				);
				const env = {
					...process.env,
					PATH: `${directory}:${process.env.PATH}`,
					NOVA_TEST_DOCKER_LOG: log,
					NOVA_TEST_MODE: mode,
					NOVA_NEXT_CACHE_FROM: `registry/cache@sha256:${"1".repeat(64)}`,
					NOVA_IMAGE_TAG: "nova:test",
					NOVA_IMAGE_OUTPUT: "load",
					NOVA_SEPARATE_MIGRATION_BUILD: "false",
					NOVA_BUILDX_BUILDER: "",
					NOVA_DOCKER_CACHE_FROM: "",
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
				const result = spawnSync("bash", ["scripts/rollout/build-image.sh"], {
					env,
					encoding: "utf8",
				});
				expect(result.status, result.stderr).toBe(
					mode === "runner-failure" ? 12 : 0,
				);
				const calls: string[][] = read(log)
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				const builds = calls.filter(
					(args) => args[0] === "buildx" && args[1] === "build",
				);
				expect(builds).toHaveLength(mode === "cache-failure" ? 4 : 3);
				const runner = builds.filter((args) => args.includes("runner"));
				expect(runner).toHaveLength(1);
				if (mode === "cache-failure") {
					expect(builds[2]).toContain(
						`next-cache=${env.NOVA_BUILD_CACHE_DIRECTORY}/input`,
					);
					expect(runner[0]).toContain(
						`next-cache=${env.NOVA_BUILD_CACHE_DIRECTORY}/input`,
					);
				}
				expect(runner[0].slice(-6)).toEqual([
					"--target",
					"runner",
					"--load",
					"--tag",
					"nova:test",
					".",
				]);
				expect(builds[0]).not.toContain("--cache-to");
				expect(builds[0]).toContain("migration");
				expect(builds[1]).toContain("cache-seed");
				expect(builds[1]).toContain("type=cacheonly");
				expect(builds[2]).not.toContain("next-cache-export");
				expect(JSON.stringify(calls)).not.toContain("synthetic-private");
				expect(calls.some((args) => args[1] === "use")).toBe(false);
				expect(calls.filter((args) => args[0] === "run")).toHaveLength(
					mode === "runner-failure" ? 0 : 1,
				);
				expect(calls.at(-1)).toEqual(["buildx", "rm", "nova-build-2"]);

				if (mode === "success") {
					const bad = spawnSync(
						"bash",
						["scripts/rollout/build-image.sh", "--target", "deps"],
						{ env, encoding: "utf8" },
					);
					expect(bad.status).toBe(2);
					expect(
						read(log)
							.trim()
							.split("\n")
							.map((line) => JSON.parse(line)),
					).toEqual(calls);
				}
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
