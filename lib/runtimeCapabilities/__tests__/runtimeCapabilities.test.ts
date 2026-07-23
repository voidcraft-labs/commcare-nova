import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawManifest from "../../../config/runtime-capabilities.json";
import { MAX_GENERATION_MINUTES, MAX_RUN_MINUTES } from "../../db/constants";
import {
	BUILD_STALENESS_SECONDS,
	EDIT_RUN_LEASE_SECONDS,
	STREAM_LEASE_TTL_SECONDS,
} from "../../runtimeCapabilities";
import {
	canonicalRuntimeCapabilityManifest,
	parseRevisionCapabilityLabels,
	parseRuntimeCapabilityEnvironment,
	parseRuntimeCapabilityManifest,
	parseRuntimeCapabilityVersion,
	RUNTIME_BUILD_ID_ENV_KEY,
	RUNTIME_CAPABILITY_ENV_KEYS,
	requireRuntimeBuildId,
	requireRuntimeCapabilityManifest,
	runtimeCapabilityEnvironmentFromHash,
	streamLeaseTtlSeconds,
} from "../core.mjs";
import {
	hashRuntimeCapabilityManifest,
	RUNTIME_CAPABILITY_MANIFEST_HASH,
	runtimeCapabilityEnvironment,
	runtimeCapabilityRevisionLabels,
} from "../server";

const manifest = requireRuntimeCapabilityManifest(rawManifest);
const manifestHash = RUNTIME_CAPABILITY_MANIFEST_HASH;
const buildId = "99ae1f72-048b-4515-8652-1f3caa669b99";

describe("runtime capability manifest", () => {
	it("pins S05a lookup support and keeps transport time separate from run liveness", () => {
		expect(manifest).toEqual({
			schemaVersion: 1,
			writerVersion: 1,
			streamReceiverVersion: 2,
			runtimeReaderVersion: 1,
			streamRegistryVersion: 1,
			cloudRunRequestSeconds: 3_600,
			streamLeaseGraceSeconds: 300,
			editRunLeaseSeconds: 900,
			buildStalenessSeconds: 600,
		});
		expect(streamLeaseTtlSeconds(manifest)).toBe(3_900);
		expect(STREAM_LEASE_TTL_SECONDS).toBe(3_900);
		expect(EDIT_RUN_LEASE_SECONDS).toBe(900);
		expect(BUILD_STALENESS_SECONDS).toBe(600);
		expect(MAX_RUN_MINUTES).toBe(15);
		expect(MAX_GENERATION_MINUTES).toBe(10);
		expect(MAX_RUN_MINUTES * 60).toBe(EDIT_RUN_LEASE_SECONDS);
		expect(MAX_GENERATION_MINUTES * 60).toBe(BUILD_STALENESS_SECONDS);
		expect(STREAM_LEASE_TTL_SECONDS).toBe(
			manifest.cloudRunRequestSeconds + manifest.streamLeaseGraceSeconds,
		);
	});

	it("rejects missing, unknown, malformed, and out-of-range declarations", () => {
		const missing = { ...rawManifest } as Record<string, unknown>;
		delete missing.writerVersion;
		const missingResult = parseRuntimeCapabilityManifest(missing);
		expect(missingResult.ok).toBe(false);
		if (!missingResult.ok) {
			expect(missingResult.issues).toContain("missing keys: writerVersion");
		}

		expect(
			parseRuntimeCapabilityManifest({ ...rawManifest, writerVerison: 1 }),
		).toMatchObject({
			ok: false,
			issues: [expect.stringContaining("unknown keys: writerVerison")],
		});
		expect(
			parseRuntimeCapabilityManifest({ ...rawManifest, schemaVersion: 2 }),
		).toMatchObject({ ok: false });
		expect(
			parseRuntimeCapabilityManifest({ ...rawManifest, writerVersion: "1" }),
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
			'{"schemaVersion":1,"writerVersion":1,"streamReceiverVersion":2,"runtimeReaderVersion":1,"streamRegistryVersion":1,"cloudRunRequestSeconds":3600,"streamLeaseGraceSeconds":300,"editRunLeaseSeconds":900,"buildStalenessSeconds":600}',
		);
		expect(manifestHash).toBe(
			"9984bcb5a56862741c80375670d94301f3706dbbbc1b2482935207401ea6a8a0",
		);
		expect(hashRuntimeCapabilityManifest(manifest)).toBe(manifestHash);
	});

	it.each([
		undefined,
		null,
		0,
		1,
		-1,
		1.5,
		Number.NaN,
		2_147_483_648,
		"",
		"-1",
		"+1",
		"01",
		"1.0",
		"1-old",
		"2147483648",
	])("fails a malformed revision declaration %j closed to v0", (value) => {
		expect(parseRuntimeCapabilityVersion(value)).toBe(0);
	});

	it("parses missing and malformed label/env declarations independently as v0", () => {
		expect(parseRevisionCapabilityLabels(undefined)).toEqual({
			writerVersion: 0,
			streamReceiverVersion: 0,
			runtimeReaderVersion: 0,
			streamRegistryVersion: 0,
		});
		expect(
			parseRevisionCapabilityLabels({
				nova_writer: "1-old",
				nova_stream_receiver: "2",
				nova_runtime_reader: 3,
				nova_stream_registry: "01",
			}),
		).toEqual({
			writerVersion: 0,
			streamReceiverVersion: 2,
			runtimeReaderVersion: 0,
			streamRegistryVersion: 0,
		});
		expect(
			parseRuntimeCapabilityEnvironment({
				NOVA_WRITER_VERSION: "0",
				NOVA_STREAM_RECEIVER_VERSION: "1",
				NOVA_RUNTIME_READER_VERSION: "bad",
				NOVA_STREAM_REGISTRY_VERSION: "1",
			}),
		).toEqual({
			writerVersion: 0,
			streamReceiverVersion: 1,
			runtimeReaderVersion: 0,
			streamRegistryVersion: 1,
		});
	});

	it("reads a host environment whose prototype is not Object.prototype", () => {
		// `process.env` is an exotic host object on current Node; a plain-record
		// prototype test would silently zero the deployed declaration and make
		// every serving revision receiver v0 — below the production floor.
		const hostLike = Object.assign(Object.create({}), {
			NOVA_WRITER_VERSION: "1",
			NOVA_STREAM_RECEIVER_VERSION: "2",
			NOVA_RUNTIME_READER_VERSION: "1",
			NOVA_STREAM_REGISTRY_VERSION: "1",
		});
		expect(parseRuntimeCapabilityEnvironment(hostLike)).toEqual({
			writerVersion: 1,
			streamReceiverVersion: 2,
			runtimeReaderVersion: 1,
			streamRegistryVersion: 1,
		});
	});

	it("renders immutable image declarations and capability revision labels", () => {
		const environment = runtimeCapabilityEnvironment(manifest);
		expect(environment).toEqual({
			NOVA_WRITER_VERSION: "1",
			NOVA_STREAM_RECEIVER_VERSION: "2",
			NOVA_RUNTIME_READER_VERSION: "1",
			NOVA_STREAM_REGISTRY_VERSION: "1",
			NOVA_CLOUD_RUN_REQUEST_SECONDS: "3600",
			NOVA_STREAM_LEASE_GRACE_SECONDS: "300",
			NOVA_STREAM_LEASE_TTL_SECONDS: "3900",
			NOVA_EDIT_RUN_LEASE_SECONDS: "900",
			NOVA_BUILD_STALENESS_SECONDS: "600",
			NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH:
				"9984bcb5a56862741c80375670d94301f3706dbbbc1b2482935207401ea6a8a0",
		});
		expect(Object.isFrozen(environment)).toBe(true);
		expect(runtimeCapabilityRevisionLabels(manifest, buildId)).toEqual({
			nova_writer: "1",
			nova_stream_receiver: "2",
			nova_runtime_reader: "1",
			nova_stream_registry: "1",
			nova_manifest: "9984bcb5a5686274",
			nova_build: buildId,
		});
		expect(() =>
			runtimeCapabilityRevisionLabels(manifest, "BAD BUILD"),
		).toThrow("buildId must be one lowercase UUID");
		expect(requireRuntimeBuildId(buildId)).toBe(buildId);
		expect(() => requireRuntimeBuildId("build-123")).toThrow(
			"buildId must be one lowercase UUID",
		);
		expect(() => runtimeCapabilityEnvironmentFromHash(manifest, "bad")).toThrow(
			"manifestHash must be one lowercase SHA-256 hex digest",
		);
		expect(environment[RUNTIME_CAPABILITY_ENV_KEYS.streamLeaseTtlSeconds]).toBe(
			"3900",
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

	it("structurally rejects duplicated build, route, and writer version drift", () => {
		const repoRoot = path.resolve(import.meta.dirname, "../../..");
		const output = execFileSync(
			process.execPath,
			["scripts/rollout/render-build-config.mjs", "--check"],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(output).toContain(
			"Runtime capability manifest and build wiring are valid",
		);
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
