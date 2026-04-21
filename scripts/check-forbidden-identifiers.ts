/**
 * CI gate: fail if forbidden identifiers creep back into the repo.
 *
 * The wire-format vocabulary listed below is banned from production
 * source. If any of these tokens reappears in a real source file, a
 * boundary violation is being reintroduced and the commit must fail.
 *
 * Scope: `lib/`, `app/`, `components/`, `scripts/`. Markdown, test
 * fixtures, and the `lib/commcare/` package itself are excluded because
 * those tokens have legitimate uses there (documentation, wire-format
 * emission, deliberate regression harnesses).
 *
 * Two passes:
 *   1. Wire-format identifiers (`AppBlueprint`, `toBlueprint`, …) —
 *      blanket-banned everywhere outside the exclusion set.
 *   2. The bare word `Question` — banned too, but with a wider exclusion
 *      set that preserves chat-feature files and the agent prompt /
 *      schema surfaces where the CommCare term legitimately surfaces to
 *      users.
 *
 * Uses `rg` (ripgrep) via `execSync`. `rg` exits 1 when there are no
 * matches — we treat that as success and only fail on exit 0 with stdout.
 */

import { execSync } from "node:child_process";

/**
 * Pre-Phase-7 wire-format identifiers. Anything matching these as a
 * whole-word identifier (or, for `case_property_on`, as a bare substring
 * since it's a CommCare wire key) is forbidden outside the shared
 * exclusion set.
 */
const FORBIDDEN_WIRE_IDENTIFIERS = [
	"\\bAppBlueprint\\b",
	"\\bBlueprintForm\\b",
	"\\bBlueprintModule\\b",
	"\\btoBlueprint\\b",
	"\\btoDoc\\b",
	"\\blegacyAppBlueprintToDoc\\b",
	"\\bWireFormLink\\b",
	"\\bWireQuestion\\b",
	"\\bnormalizedState\\b",
	"\\breplaceForm\\b",
	// Substring — a CommCare wire key. Appearing anywhere in application
	// code is a leak of CommCare's vocabulary into domain land.
	"case_property_on",
];

/**
 * Directories to scan. Matches the post-Phase-7 top-level source layout.
 */
const SCAN_DIRS = ["lib", "app", "components", "scripts"];

/**
 * Shared exclusions applied to both passes. Everything in here is a place
 * where these tokens legitimately appear.
 */
const SHARED_EXCLUSIONS = [
	// Test suites may reference old names in comments, fixtures, or
	// regression harnesses that deliberately stress the legacy shapes.
	"--glob",
	"!**/__tests__/**",
	// Markdown is historical record — plans, specs, CLAUDE.md context.
	"--glob",
	"!**/*.md",
	// The CommCare wire boundary itself. This is the ONE place where
	// CommCare vocabulary is allowed — it's the entire purpose of the
	// package.
	"--glob",
	"!lib/commcare/**",
	// This script enumerates the forbidden tokens as data. Scanning it
	// would guarantee a self-referential failure.
	"--glob",
	"!scripts/check-forbidden-identifiers.ts",
];

/**
 * Pass 2 exclusions — `\bQuestion\b` has a wider legitimate surface than
 * the wire identifiers because "question" is the domain-facing CommCare
 * term users see in the UI (the chat card, the SA prompt, the tool
 * schemas, inspection scripts).
 */
const QUESTION_PASS_EXCLUSIONS = [
	...SHARED_EXCLUSIONS,
	// Chat surfaces that ask the user clarifying "questions". The T15
	// sweep deliberately kept these.
	"--glob",
	"!components/chat/AskQuestionsCard.tsx",
	"--glob",
	"!**/askQuestions*",
	"--glob",
	"!lib/chat/**",
	// SA prompt + agent code paths that name the tool "askQuestions" and
	// talk about questions to the user.
	"--glob",
	"!lib/agent/solutionsArchitect.ts",
	"--glob",
	"!lib/agent/prompts.ts",
	// DB and inspection surfaces that reference the historical `Question`
	// shape in persistence layer schemas / read-only inspection tooling.
	"--glob",
	"!lib/db/types.ts",
	"--glob",
	"!scripts/inspect-app.ts",
	// CSS comments aren't code.
	"--glob",
	"!**/*.css",
];

type ScanPass = {
	readonly label: string;
	readonly patterns: readonly string[];
	readonly exclusions: readonly string[];
};

const PASSES: readonly ScanPass[] = [
	{
		label: "wire-format identifiers",
		patterns: FORBIDDEN_WIRE_IDENTIFIERS,
		exclusions: SHARED_EXCLUSIONS,
	},
	{
		label: "bare `Question`",
		patterns: ["\\bQuestion\\b"],
		exclusions: QUESTION_PASS_EXCLUSIONS,
	},
];

/**
 * Run a single rg invocation. Returns matched lines (empty string when no
 * matches). rg exits 1 on zero matches — we catch that and treat it as
 * success; any other failure is a real error and rethrown.
 */
function runRipgrep(pattern: string, exclusions: readonly string[]): string {
	// `--glob` flags must come before the positional paths; pattern goes
	// via `-e` so it isn't parsed as a path if it starts with `-`.
	const argv = ["rg", "-n", ...exclusions, "-e", pattern, ...SCAN_DIRS];
	const cmd = argv.map((arg) => JSON.stringify(arg)).join(" ");
	try {
		return execSync(cmd, { encoding: "utf8" });
	} catch (err) {
		const e = err as { status?: number; stdout?: Buffer | string };
		// rg exit code 1 = no matches (success for us).
		if (e.status === 1) return "";
		// Anything else (including exit code 2 = usage error) is a real
		// problem. Surface it.
		const stdout =
			typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8");
		throw new Error(
			`rg failed for /${pattern}/: status=${e.status}\n${stdout ?? ""}`,
		);
	}
}

let failed = false;

for (const pass of PASSES) {
	for (const pattern of pass.patterns) {
		const out = runRipgrep(pattern, pass.exclusions).trim();
		if (out.length > 0) {
			console.error(
				`✗ forbidden identifier (${pass.label}) /${pattern}/ matches:\n${out}\n`,
			);
			failed = true;
		}
	}
}

if (failed) {
	console.error("Forbidden identifiers detected. Commit blocked.");
	process.exit(1);
}

console.log("✓ no forbidden identifiers");
