/**
 * Container-kind tripwire.
 *
 * Three field kinds are containers (`group`, `repeat`, `section`), and the
 * ONE way a site asks "is this a container" is the registry
 * (`isContainer` / `isContainerKindName` / `fieldRegistry[kind].isContainer`).
 * A site that spells the kinds out (`kind === "group" || kind === "repeat"`)
 * silently excludes the newest container, and the consequence is not a type
 * error: an empty section hydrates as a leaf, a reducer refuses a child's
 * anchor, a tree walker stops recursing. This test lists every literal
 * spelling that remains on purpose, so the next container kind never needs
 * a sweep.
 *
 * The frozen migration under `lib/case-store/migrations/` is immutable by
 * contract (it must still build a fresh database years later), so it keeps
 * the two-kind spelling of its era and is excluded from the scan.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["lib", "components", "app"] as const;

/** Sites that still spell the kinds out, each justified. The engine's
 *  tree walkers DISPATCH rather than test membership: `group` and
 *  `section` share the DATA-group arm (recurse under the id) while
 *  `repeat` has its own instance arm, so the registry predicate cannot
 *  replace the spelling — a fourth container kind must visit each of
 *  these walkers and choose its arm. Everything else asks the registry
 *  (the row model asks `isContainer` after handling the section row, and
 *  the type picker's Structure submenu offers the page gestures beside
 *  the two boxed kinds). */
const ALLOWED_LITERAL_SITES: ReadonlySet<string> = new Set<string>([
	"lib/preview/engine/dataInstance.ts",
	"lib/preview/engine/formEngine.ts",
	"lib/preview/engine/triggerDag.ts",
]);

const LITERAL_PATTERNS = [
	// Any pairwise comparison chain over the container names — positive or
	// negated, in any order, any two of the three. A dispatch that names two
	// kinds is complete today and still misses the next container kind, so
	// it lives on the allowlist with its justification, never invisibly.
	/kind [!=]== "(?:group|repeat|section)"\s*(?:\|\||&&)\s*[\w.?]*kind [!=]== "(?:group|repeat|section)"/,
	/\["group", "repeat"(?:, "section")?\]/,
	/"group" \| "repeat"(?! \| "section")/,
];

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "__tests__") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (full.includes(join("lib", "case-store", "migrations"))) continue;
			out.push(...sourceFiles(full));
		} else if (
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".test.tsx") &&
			!entry.name.endsWith(".d.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

describe("container-kind sites", () => {
	it("spell the kinds out only where the allowlist says so", () => {
		const offenders = new Set<string>();
		for (const root of SCAN_ROOTS) {
			for (const file of sourceFiles(join(REPO_ROOT, root))) {
				const source = readFileSync(file, "utf8");
				if (LITERAL_PATTERNS.some((pattern) => pattern.test(source))) {
					offenders.add(relative(REPO_ROOT, file));
				}
			}
		}
		expect([...offenders].sort()).toEqual([...ALLOWED_LITERAL_SITES].sort());
	});
});
