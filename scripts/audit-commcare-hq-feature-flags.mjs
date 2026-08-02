#!/usr/bin/env node

/**
 * Detect upstream lifecycle drift in every CommCare HQ feature flag Nova uses.
 *
 * This intentionally reads source instead of importing CommCare HQ: the audit
 * runs in Nova CI without bootstrapping HQ's Python/Django environment. It
 * checks the toggle declaration (symbol, slug, tag, namespaces) plus at least
 * one runtime/authoring gate for each requirement. A GA/tag change or removed
 * gate therefore becomes an actionable scheduled failure instead of tribal
 * knowledge four months later.
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
			"CommCare HQ feature-flag assumptions changed:",
			...failures.map((failure) => `- ${failure}`),
			"",
			"Review the current HQ behavior. If a feature is now generally available, remove or update its Nova detector, publish notice, docs entry, and manifest row together.",
		].join("\n"),
	);
	process.exitCode = 1;
} else {
	console.log(
		`Verified ${manifest.flags.length} Nova feature-flag requirement(s) against ${hqRoot}`,
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
