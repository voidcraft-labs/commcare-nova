// Prints the digest-pinned Postgres image the test harness and local dev both
// boot, and fails if the two places that name it have drifted apart.
//
// Two consumers need the reference outside TypeScript: CI pre-pulls it before
// vitest starts (`.github/actions/pull-test-image`), and this check runs in the
// `quality` job. Neither can import `globalSetup.ts`, so this reads it as text.
//
// `globalSetup.ts` is the source of truth — it carries the bump instructions
// and the multi-arch manifest-index rationale. `compose.yaml` must name the
// same reference: local dev, CI, and the harness are supposed to exercise one
// engine, and a half-finished bump would silently give local dev a different
// Postgres than the tests that gate the merge. The drift is invisible until a
// version-dependent behavior differs, so it is worth a loud check.
//
// Usage:
//   node scripts/ci/print-test-image.mjs           prints the reference
//   node scripts/ci/print-test-image.mjs --check   verifies only, prints nothing

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const GLOBAL_SETUP = "lib/case-store/sql/__tests__/globalSetup.ts";
const COMPOSE = "compose.yaml";

/** `<repo>:<tag>@sha256:<64 hex>` — the only form either file may name. */
const PINNED_REFERENCE = /[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}/g;

async function pinnedReferencesIn(relativePath) {
	const source = await readFile(join(repoRoot, relativePath), "utf8");
	// Comments in both files quote the tag WITHOUT a digest (navigation aids and
	// bump instructions), which the pattern's mandatory `@sha256:` excludes. A
	// second real pin would be genuine ambiguity, so count rather than take the
	// first.
	return [...source.matchAll(PINNED_REFERENCE)].map((match) => match[0]);
}

async function exactlyOneReferenceIn(relativePath) {
	const found = await pinnedReferencesIn(relativePath);
	if (found.length === 1) return found[0];

	const problem =
		found.length === 0
			? "no digest-pinned image reference"
			: `${found.length} digest-pinned image references:\n  ${found.join("\n  ")}`;
	throw new Error(
		`Expected exactly one digest-pinned image reference in ${relativePath}, but found ${problem}.\n` +
			"This file names the Postgres engine the test harness boots, and the pin has to be unambiguous.\n" +
			`Look at ${relativePath} and leave exactly one \`<repo>:<tag>@sha256:<digest>\` in it.`,
	);
}

const harnessImage = await exactlyOneReferenceIn(GLOBAL_SETUP);
const composeImage = await exactlyOneReferenceIn(COMPOSE);

if (harnessImage !== composeImage) {
	console.error(
		`The test harness and local dev are pinned to different Postgres images.\n` +
			`  ${GLOBAL_SETUP}\n    ${harnessImage}\n` +
			`  ${COMPOSE}\n    ${composeImage}\n\n` +
			"They have to match: `npm run dev` and the suite that gates the merge are supposed to run one engine.\n" +
			`Pick the reference you meant and put it in both. ${GLOBAL_SETUP} carries the bump instructions.`,
	);
	process.exit(1);
}

if (!process.argv.includes("--check")) {
	console.log(harnessImage);
}
