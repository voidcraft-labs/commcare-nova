import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = [
	"app/api/apps",
	"components/builder",
	"components/chat",
	"components/preview",
	"lib/agent/tools",
	"lib/codemirror",
	"lib/collab",
	"lib/db",
	"lib/doc",
	"lib/mcp",
	"lib/preview",
	"lib/references",
	"lib/routing",
	"lib/session",
] as const;

const UUID_IDENTITY_ASSERTION =
	/\bas\s+(?:Uuid|MediaAssetId|LookupTableId|LookupColumnId|LookupRowId)\b/g;
const EMPTY_AUTHORED_IDENTITY =
	/\b(?:asUuid|canonicalCasePropertyName|sessionUser)\(\s*(?:""|'')\s*\)/g;
const HARDCODED_AUTHORED_UUID =
	/["'`][0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}["'`]/g;

function productionSources(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "__tests__") visit(path);
				continue;
			}
			if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
			if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
			files.push(path);
		}
	};
	visit(join(process.cwd(), root));
	return files;
}

function matches(
	path: string,
	pattern: RegExp,
): readonly { readonly line: number; readonly match: string }[] {
	const source = readFileSync(path, "utf8");
	const results: Array<{ line: number; match: string }> = [];
	for (const match of source.matchAll(pattern)) {
		const offset = match.index ?? 0;
		results.push({
			line: source.slice(0, offset).split("\n").length,
			match: match[0],
		});
	}
	return results;
}

function findings(pattern: RegExp): string[] {
	return SOURCE_ROOTS.flatMap(productionSources).flatMap((path) =>
		matches(path, pattern).map(
			(finding) =>
				`${relative(process.cwd(), path).split(sep).join("/")}:${finding.line} ${finding.match}`,
		),
	);
}

describe("authored identity source tripwire", () => {
	it("requires runtime narrowing instead of UUID-family assertions", () => {
		expect(findings(UUID_IDENTITY_ASSERTION)).toEqual([]);
	});

	it("forbids empty authored identity and reference seeds", () => {
		expect(findings(EMPTY_AUTHORED_IDENTITY)).toEqual([]);
	});

	it("forbids hard-coded authored UUIDs in production editor paths", () => {
		expect(findings(HARDCODED_AUTHORED_UUID)).toEqual([]);
	});
});
