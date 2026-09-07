import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import rawManifest from "../../../config/runtime-capabilities.json";
import {
	canonicalRuntimeCapabilityManifest,
	parseRuntimeCapabilityManifest,
	RUNTIME_BUILD_ID_ENV_KEY,
	requireRuntimeBuildId,
	requireRuntimeCapabilityManifest,
	runtimeCapabilityEnvironmentFromHash,
} from "../core.mjs";
import {
	hashRuntimeCapabilityManifest,
	RUNTIME_CAPABILITY_MANIFEST_HASH,
	runtimeCapabilityEnvironment,
} from "../server";

const manifest = requireRuntimeCapabilityManifest(rawManifest);
const manifestHash = RUNTIME_CAPABILITY_MANIFEST_HASH;
const buildId = "99ae1f72-048b-4515-8652-1f3caa669b99";

describe("runtime capability manifest", () => {
	it("rejects missing, unknown, malformed, and out-of-range declarations", () => {
		const missing = { ...rawManifest } as Record<string, unknown>;
		delete missing.cloudRunRequestSeconds;
		const missingResult = parseRuntimeCapabilityManifest(missing);
		expect(missingResult.ok).toBe(false);
		if (!missingResult.ok) {
			expect(missingResult.issues).toContain(
				"missing keys: cloudRunRequestSeconds",
			);
		}

		expect(
			parseRuntimeCapabilityManifest({ ...rawManifest, wrongKey: 1 }),
		).toMatchObject({
			ok: false,
			issues: [expect.stringContaining("unknown keys: wrongKey")],
		});
		expect(
			parseRuntimeCapabilityManifest({ ...rawManifest, schemaVersion: 2 }),
		).toMatchObject({ ok: false });
		expect(
			parseRuntimeCapabilityManifest({
				...rawManifest,
				cloudRunRequestSeconds: "1",
			}),
		).toMatchObject({ ok: false });
		expect(
			parseRuntimeCapabilityManifest({
				...rawManifest,
				cloudRunRequestSeconds: 3_601,
			}),
		).toMatchObject({ ok: false });
		expect(
			parseRuntimeCapabilityManifest({
				...rawManifest,
				editRunLeaseSeconds: 901,
			}),
		).toMatchObject({ ok: false });
		expect(() => requireRuntimeCapabilityManifest(null)).toThrow(
			"Invalid runtime capability manifest",
		);
	});

	it.each([
		{
			cloudRunRequestSeconds: 1,
			editRunLeaseSeconds: 60,
			buildStalenessSeconds: 86_400,
		},
		{
			cloudRunRequestSeconds: 3_600,
			editRunLeaseSeconds: 86_400,
			buildStalenessSeconds: 60,
		},
	])(
		"accepts independent timing boundaries $cloudRunRequestSeconds/$editRunLeaseSeconds/$buildStalenessSeconds",
		(timings) => {
			const parsed = requireRuntimeCapabilityManifest({
				schemaVersion: 1,
				...timings,
			});
			expect(parsed).toEqual({ schemaVersion: 1, ...timings });
			expect(Object.isFrozen(parsed)).toBe(true);
		},
	);

	it("canonicalizes in schema order and hashes exact canonical bytes", () => {
		const canonical = canonicalRuntimeCapabilityManifest({
			buildStalenessSeconds: 120,
			editRunLeaseSeconds: 60,
			cloudRunRequestSeconds: 300,
			schemaVersion: 1,
		});
		expect(canonical).toBe(
			'{"schemaVersion":1,"cloudRunRequestSeconds":300,"editRunLeaseSeconds":60,"buildStalenessSeconds":120}',
		);
		expect(manifestHash).toBe(
			createHash("sha256")
				.update(canonicalRuntimeCapabilityManifest(manifest))
				.digest("hex"),
		);
		expect(
			hashRuntimeCapabilityManifest({
				buildStalenessSeconds: 120,
				editRunLeaseSeconds: 60,
				cloudRunRequestSeconds: 300,
				schemaVersion: 1,
			}),
		).toBe(createHash("sha256").update(canonical).digest("hex"));
	});

	it("renders immutable image declarations with timing environment variables", () => {
		const environment = runtimeCapabilityEnvironment(manifest);
		expect(environment).toEqual({
			NOVA_CLOUD_RUN_REQUEST_SECONDS: "3600",
			NOVA_EDIT_RUN_LEASE_SECONDS: "900",
			NOVA_BUILD_STALENESS_SECONDS: "600",
			NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH: manifestHash,
		});
		expect(Object.isFrozen(environment)).toBe(true);
		expect(requireRuntimeBuildId(buildId)).toBe(buildId);
		expect(() => requireRuntimeBuildId("build-123")).toThrow(
			"buildId must be one lowercase UUID",
		);
		expect(() => runtimeCapabilityEnvironmentFromHash(manifest, "bad")).toThrow(
			"manifestHash must be one lowercase SHA-256 hex digest",
		);
	});

	it("bundles and executes browser capability access without Node globals", async () => {
		const result = await build({
			entryPoints: [
				path.resolve(import.meta.dirname, "../../runtimeCapabilities.ts"),
			],
			bundle: true,
			platform: "browser",
			format: "iife",
			globalName: "NovaRuntime",
			write: false,
			logLevel: "silent",
		});
		const output = result.outputFiles[0];
		if (output === undefined) throw new Error("expected a browser bundle");
		expect(
			runInNewContext(`${output.text}\nNovaRuntime.RUNTIME_CAPABILITIES`, {}),
		).toEqual(rawManifest);
	});

	it("renders a deterministic shell-safe build identity", () => {
		const repoRoot = path.resolve(import.meta.dirname, "../../..");
		const args = [
			"scripts/rollout/render-build-config.mjs",
			"--build-id",
			buildId,
		];
		const first = execFileSync(process.execPath, args, {
			cwd: repoRoot,
			encoding: "utf8",
		});
		const second = execFileSync(process.execPath, args, {
			cwd: repoRoot,
			encoding: "utf8",
		});
		expect(second).toBe(first);
		expect(first).toContain(`export ${RUNTIME_BUILD_ID_ENV_KEY}='${buildId}'`);
		expect(() =>
			execFileSync(
				process.execPath,
				[
					"scripts/rollout/render-build-config.mjs",
					"--build-id",
					"bad'; touch /tmp/not-safe; #",
				],
				{ cwd: repoRoot, stdio: "pipe" },
			),
		).toThrow();
	});
});
