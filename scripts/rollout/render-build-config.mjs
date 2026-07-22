#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalRuntimeCapabilityManifest,
	RUNTIME_BUILD_ID_ENV_KEY,
	RUNTIME_BUILD_ID_FILE_PATH,
	RUNTIME_REVISION_LABELS_ENV_KEY,
	requireRuntimeBuildId,
	requireRuntimeCapabilityManifest,
	runtimeCapabilityEnvironmentFromHash,
	runtimeCapabilityRevisionLabelsFromHash,
} from "../../lib/runtimeCapabilities/core.mts";
import { hashCanonicalRuntimeCapabilityManifest } from "../../lib/runtimeCapabilities/serverHash.mts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = path.join(repoRoot, "config/runtime-capabilities.json");

function parseArgs(argv) {
	let check = false;
	let buildId;
	let output;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--check") {
			check = true;
			continue;
		}
		if (arg === "--output") {
			if (output !== undefined)
				throw new Error("--output may be supplied once");
			output = argv[index + 1];
			if (!output || output.startsWith("--")) {
				throw new Error("--output requires a file path");
			}
			index += 1;
			continue;
		}
		if (arg === "--build-id") {
			if (buildId !== undefined)
				throw new Error("--build-id may be supplied once");
			buildId = argv[index + 1];
			if (!buildId || buildId.startsWith("--")) {
				throw new Error("--build-id requires a Cloud Build UUID");
			}
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return {
		buildId: buildId === undefined ? undefined : requireRuntimeBuildId(buildId),
		check,
		output,
	};
}

async function readText(relativePath) {
	return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function loadManifest() {
	let source;
	try {
		source = await readFile(manifestPath, "utf8");
	} catch (error) {
		throw new Error(`Cannot read ${manifestPath}`, { cause: error });
	}

	let raw;
	try {
		raw = JSON.parse(source);
	} catch (error) {
		throw new Error(`Invalid JSON in ${manifestPath}`, { cause: error });
	}
	return { manifest: requireRuntimeCapabilityManifest(raw), source };
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderShellEnvironment(manifest, manifestHash, buildId) {
	const environment = runtimeCapabilityEnvironmentFromHash(
		manifest,
		manifestHash,
	);
	const lines = [
		"# Generated from config/runtime-capabilities.json. Do not edit.",
	];
	for (const [key, value] of Object.entries(environment)) {
		lines.push(`export ${key}=${shellQuote(value)}`);
	}
	if (buildId !== undefined) {
		lines.push(`export ${RUNTIME_BUILD_ID_ENV_KEY}=${shellQuote(buildId)}`);
		const revisionLabels = Object.entries(
			runtimeCapabilityRevisionLabelsFromHash(manifest, manifestHash, buildId),
		)
			.map(([key, value]) => `${key}=${value}`)
			.join(",");
		lines.push(
			`export ${RUNTIME_REVISION_LABELS_ENV_KEY}=${shellQuote(revisionLabels)}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function count(source, needle) {
	return source.split(needle).length - 1;
}

function requireExactlyOnce(source, needle, file, issues) {
	const occurrences = count(source, needle);
	if (occurrences !== 1) {
		issues.push(
			`${file} must contain exactly one ${JSON.stringify(needle)} (found ${occurrences})`,
		);
	}
}

function requireStaticRouteTimeout(source, file, expected, issues) {
	const matches = [
		...source.matchAll(/export const maxDuration = ([0-9][0-9_]*);/g),
	];
	if (matches.length !== 1) {
		issues.push(`${file} must declare exactly one static numeric maxDuration`);
		return;
	}
	const actual = Number(matches[0][1].replaceAll("_", ""));
	if (actual !== expected) {
		issues.push(
			`${file} maxDuration=${actual} differs from manifest cloudRunRequestSeconds=${expected}`,
		);
	}
}

async function checkRepositoryWiring(manifest, manifestHash, manifestSource) {
	const issues = [];
	const canonicalFile = `${JSON.stringify(manifest, null, "\t")}\n`;
	if (manifestSource !== canonicalFile) {
		issues.push(
			"config/runtime-capabilities.json must use the canonical checked-in formatting",
		);
	}

	const [
		cloudBuild,
		dockerfile,
		appStream,
		chatStream,
		writer,
		dbConstants,
		nodeVersion,
	] = await Promise.all([
		readText("cloudbuild.yaml"),
		readText("Dockerfile"),
		readText("app/api/apps/[id]/stream/route.ts"),
		readText("app/api/chat/[streamId]/stream/route.ts"),
		readText("lib/db/lookupReferenceWriter.ts"),
		readText("lib/db/constants.ts"),
		readText(".nvmrc"),
	]);

	requireExactlyOnce(
		cloudBuild,
		"scripts/rollout/render-build-config.mjs",
		"cloudbuild.yaml",
		issues,
	);
	requireExactlyOnce(
		cloudBuild,
		"source /workspace/rollout.env",
		"cloudbuild.yaml",
		issues,
	);
	requireExactlyOnce(
		cloudBuild,
		`name: node:${nodeVersion.trim()}-alpine`,
		"cloudbuild.yaml",
		issues,
	);

	for (const key of Object.keys(
		runtimeCapabilityEnvironmentFromHash(manifest, manifestHash),
	)) {
		requireExactlyOnce(
			cloudBuild,
			`--build-arg ${key}="$$${key}"`,
			"cloudbuild.yaml",
			issues,
		);
		requireExactlyOnce(dockerfile, `ARG ${key}`, "Dockerfile", issues);
		requireExactlyOnce(dockerfile, `${key}="\${${key}}"`, "Dockerfile", issues);
	}
	requireExactlyOnce(
		dockerfile,
		`ARG ${RUNTIME_BUILD_ID_ENV_KEY}`,
		"Dockerfile",
		issues,
	);
	requireExactlyOnce(
		dockerfile,
		`${RUNTIME_BUILD_ID_ENV_KEY}="\${${RUNTIME_BUILD_ID_ENV_KEY}}"`,
		"Dockerfile",
		issues,
	);
	requireExactlyOnce(
		dockerfile,
		`> ${RUNTIME_BUILD_ID_FILE_PATH}`,
		"Dockerfile",
		issues,
	);

	requireStaticRouteTimeout(
		appStream,
		"app/api/apps/[id]/stream/route.ts",
		manifest.cloudRunRequestSeconds,
		issues,
	);
	requireStaticRouteTimeout(
		chatStream,
		"app/api/chat/[streamId]/stream/route.ts",
		manifest.cloudRunRequestSeconds,
		issues,
	);
	requireExactlyOnce(
		writer,
		"RUNTIME_CAPABILITIES.writerVersion",
		"lib/db/lookupReferenceWriter.ts",
		issues,
	);
	if (/CURRENT_LOOKUP_REFERENCE_WRITER_VERSION\s*=\s*[0-9]/.test(writer)) {
		issues.push(
			"lib/db/lookupReferenceWriter.ts must derive its version from the manifest",
		);
	}
	requireExactlyOnce(
		dbConstants,
		"MAX_RUN_MINUTES = EDIT_RUN_LEASE_SECONDS / 60",
		"lib/db/constants.ts",
		issues,
	);
	requireExactlyOnce(
		dbConstants,
		"MAX_GENERATION_MINUTES = BUILD_STALENESS_SECONDS / 60",
		"lib/db/constants.ts",
		issues,
	);

	if (issues.length > 0) {
		throw new Error(
			`Runtime capability wiring drift:\n- ${issues.join("\n- ")}`,
		);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { manifest, source } = await loadManifest();
	const manifestHash = hashCanonicalRuntimeCapabilityManifest(
		canonicalRuntimeCapabilityManifest(manifest),
	);
	const rendered = renderShellEnvironment(manifest, manifestHash, args.buildId);

	if (args.check) await checkRepositoryWiring(manifest, manifestHash, source);
	if (args.output !== undefined) {
		await writeFile(path.resolve(args.output), rendered, {
			encoding: "utf8",
			mode: 0o644,
		});
	}
	if (args.output === undefined && !args.check) process.stdout.write(rendered);
	if (args.check) {
		process.stdout.write(
			`Runtime capability manifest and build wiring are valid (${manifest.cloudRunRequestSeconds}s request, ${manifest.cloudRunRequestSeconds + manifest.streamLeaseGraceSeconds}s stream lease).\n`,
		);
	}
}

main().catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
	process.exitCode = 1;
});
