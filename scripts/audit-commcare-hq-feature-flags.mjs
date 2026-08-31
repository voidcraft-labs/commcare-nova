#!/usr/bin/env node

/**
 * Detect upstream lifecycle drift in the private CommCare HQ settings used to
 * prove Nova's semantic project-space compatibility contract.
 *
 * This intentionally reads source instead of importing CommCare HQ: the audit
 * runs in Nova CI without bootstrapping HQ's Python/Django environment. It
 * checks the toggle declaration (symbol, slug, tag, namespaces) plus at least
 * one runtime/authoring gate for each setting. It also pins the exact Case
 * Search readiness path and its separate Mobile App Access permission. A
 * GA/tag change or removed gate therefore becomes an actionable scheduled
 * failure instead of tribal knowledge.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const manifest = JSON.parse(
	readFileSync(
		resolve(repoRoot, "config/commcare-hq-feature-flags.json"),
		"utf8",
	),
);

function argument(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const candidates = [
	argument("--hq-path"),
	process.env.COMMCARE_HQ_PATH,
	resolve(repoRoot, "../commcare-hq"),
	resolve(homedir(), "code/commcare-hq"),
].filter(Boolean);
const hqRoot = candidates.find((candidate) =>
	existsSync(resolve(candidate, manifest.source.toggleRegistryPath)),
);

if (!hqRoot) {
	throw new Error(
		`Could not find a CommCare HQ checkout. Pass --hq-path <path> or set COMMCARE_HQ_PATH. Checked: ${candidates.join(", ")}`,
	);
}

const registryPath = resolve(hqRoot, manifest.source.toggleRegistryPath);
const registry = readFileSync(registryPath, "utf8");
const failures = [];

const probeResourcePath = resolve(hqRoot, manifest.source.probeResourcePath);
if (!existsSync(probeResourcePath)) {
	failures.push(
		`Feature-flag probe resource disappeared: ${manifest.source.probeResourcePath}`,
	);
} else {
	const probeResource = readFileSync(probeResourcePath, "utf8");
	for (const expected of manifest.source.probeEvidence) {
		if (!probeResource.includes(expected)) {
			failures.push(
				`Feature-flag probe behavior changed in ${manifest.source.probeResourcePath}: ${JSON.stringify(expected)}`,
			);
		}
	}
}

const caseSearchProbePath = resolve(
	hqRoot,
	manifest.source.caseSearchProbePath,
);
if (!existsSync(caseSearchProbePath)) {
	failures.push(
		`Case Search compatibility probe disappeared: ${manifest.source.caseSearchProbePath}`,
	);
} else {
	const source = readFileSync(caseSearchProbePath, "utf8");
	for (const expected of manifest.source.caseSearchProbeEvidence) {
		if (!source.includes(expected)) {
			failures.push(
				`Case Search compatibility probe changed in ${manifest.source.caseSearchProbePath}: ${JSON.stringify(expected)}`,
			);
		}
	}
}

for (const [pathKey, evidenceKey, description] of [
	[
		"caseSearchPermissionPath",
		"caseSearchPermissionEvidence",
		"Case Search probe permission",
	],
	[
		"caseSearchPermissionUiPath",
		"caseSearchPermissionUiEvidence",
		"Case Search permission UI",
	],
]) {
	const path = resolve(hqRoot, manifest.source[pathKey]);
	if (!existsSync(path)) {
		failures.push(
			`${description} source disappeared: ${manifest.source[pathKey]}`,
		);
		continue;
	}
	const source = readFileSync(path, "utf8");
	for (const expected of manifest.source[evidenceKey]) {
		if (!source.includes(expected)) {
			failures.push(
				`${description} changed in ${manifest.source[pathKey]}: ${JSON.stringify(expected)}`,
			);
		}
	}
}

const probePaginatorPath = resolve(hqRoot, manifest.source.probePaginatorPath);
if (!existsSync(probePaginatorPath)) {
	failures.push(
		`Feature-flag probe paginator disappeared: ${manifest.source.probePaginatorPath}`,
	);
} else {
	const source = readFileSync(probePaginatorPath, "utf8");
	for (const expected of manifest.source.probePaginatorEvidence) {
		if (!source.includes(expected)) {
			failures.push(
				`Feature-flag probe response shape changed in ${manifest.source.probePaginatorPath}: ${JSON.stringify(expected)}`,
			);
		}
	}
}

for (const flag of manifest.flags) {
	const block = extractStaticToggleBlock(registry, flag.symbol);
	if (!block) {
		failures.push(`${flag.symbol}: StaticToggle declaration disappeared`);
		continue;
	}
	if (!block.includes(`'${flag.slug}'`) && !block.includes(`"${flag.slug}"`)) {
		failures.push(
			`${flag.symbol}: expected slug ${JSON.stringify(flag.slug)} was not found`,
		);
	}
	if (!new RegExp(`\\b${escapeRegExp(flag.expectedTag)}\\b`).test(block)) {
		failures.push(
			`${flag.symbol}: expected lifecycle tag ${flag.expectedTag} was not found (the flag may have graduated or changed lifecycle)`,
		);
	}

	const namespaceMatch = /namespaces\s*=\s*\[([^\]]*)\]/s.exec(block);
	if (!namespaceMatch) {
		failures.push(
			`${flag.symbol}: named namespaces=[...] declaration disappeared`,
		);
	} else {
		const actual = [...namespaceMatch[1].matchAll(/NAMESPACE_[A-Z_]+/g)].map(
			(match) => match[0],
		);
		if (JSON.stringify(actual) !== JSON.stringify(flag.expectedNamespaces)) {
			failures.push(
				`${flag.symbol}: namespaces changed; expected ${JSON.stringify(flag.expectedNamespaces)}, found ${JSON.stringify(actual)}`,
			);
		}
	}

	const actualParents = [
		...block.matchAll(/parent_toggles\s*=\s*\[([^\]]*)\]/gs),
	].flatMap((match) => match[1].match(/[A-Z][A-Z0-9_]+/g) ?? []);
	const expectedParents = flag.expectedParents ?? [];
	if (JSON.stringify(actualParents) !== JSON.stringify(expectedParents)) {
		failures.push(
			`${flag.symbol}: parent toggles changed; expected ${JSON.stringify(expectedParents)}, found ${JSON.stringify(actualParents)}`,
		);
	}

	for (const evidence of flag.upstreamEvidence) {
		const evidencePath = resolve(hqRoot, evidence.path);
		if (!existsSync(evidencePath)) {
			failures.push(
				`${flag.symbol}: evidence file disappeared: ${evidence.path}`,
			);
			continue;
		}
		const source = readFileSync(evidencePath, "utf8");
		if (!source.includes(evidence.contains)) {
			failures.push(
				`${flag.symbol}: gate evidence disappeared from ${evidence.path}: ${JSON.stringify(evidence.contains)}`,
			);
		}
	}
}

if (failures.length > 0) {
	console.error(
		[
			"CommCare HQ project-space compatibility assumptions changed:",
			...failures.map((failure) => `- ${failure}`),
			"",
			"Review the current HQ behavior. Update the private probe plan and semantic capability contract together; never expose the underlying setting names through public surfaces.",
		].join("\n"),
	);
	process.exitCode = 1;
} else {
	console.log(
		`Verified ${manifest.flags.length} private CommCare HQ compatibility setting(s) used by CommCare Nova against ${hqRoot}`,
	);
}

/** Extract one balanced StaticToggle(...) call without depending on Python. */
function extractStaticToggleBlock(source, symbol) {
	const assignment = `${symbol} = StaticToggle(`;
	const start = source.indexOf(assignment);
	if (start === -1) return undefined;
	const open = start + assignment.length - 1;
	let depth = 0;
	let quote;
	let escaped = false;
	for (let index = open; index < source.length; index += 1) {
		const char = source[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "(") depth += 1;
		if (char === ")") {
			depth -= 1;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}
	return undefined;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
