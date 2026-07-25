import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
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

	it("canonicalizes in schema order and hashes exact canonical bytes", () => {
		const canonical = canonicalRuntimeCapabilityManifest(manifest);
		expect(canonical).toBe(
			'{"schemaVersion":1,"cloudRunRequestSeconds":3600,"editRunLeaseSeconds":900,"buildStalenessSeconds":600}',
		);
		expect(manifestHash).toMatch(/^[a-f0-9]{64}$/);
		expect(hashRuntimeCapabilityManifest(manifest)).toBe(manifestHash);
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

	it("keeps validated browser access free of Node hashing", () => {
		const repoRoot = path.resolve(import.meta.dirname, "../../..");
		const clientSafeSources = [
			readFileSync(path.join(repoRoot, "lib/runtimeCapabilities.ts"), "utf8"),
			readFileSync(
				path.join(repoRoot, "lib/runtimeCapabilities/core.mts"),
				"utf8",
			),
		];
		expect(clientSafeSources.join("\n")).not.toContain('from "node:crypto"');
		expect(
			readFileSync(
				path.join(repoRoot, "lib/runtimeCapabilities/serverHash.mts"),
				"utf8",
			),
		).toContain('from "node:crypto"');
		expect(
			readFileSync(
				path.join(repoRoot, "lib/runtimeCapabilities/server.ts"),
				"utf8",
			),
		).toContain('import "server-only"');
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
