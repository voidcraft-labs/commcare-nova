/**
 * Structural isolation guards for the change-set runtime.
 *
 * A private change set is a CANDIDATE: it holds staged intent that no one
 * outside its owner may observe and that touches no external system until the
 * one all-or-nothing commit. Everything that could leak it — the run event
 * log, the chat SSE host, the multiplayer frames, the realtime notify
 * channel — or that could give it a second write path — the canonical commit
 * kernel, object storage, HQ deployment, the lookup writers — is banned at
 * source level here, where a stray import fails loudly instead of quietly
 * publishing a draft.
 *
 * The one deliberate exception is the commit itself: `commit.ts` is where a
 * change set stops being private, so it alone reaches the canonical writer.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const CHANGE_SET_ROOT = join(__dirname, "..");

/** Every non-test .ts file under lib/agent/change-set/. */
function changeSetSourceFiles(dir = CHANGE_SET_ROOT): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__tests__") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...changeSetSourceFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Every module specifier a source reaches — static `import`/`export from`,
 *  dynamic `import("...")`, and `require("...")`, so a runtime-loaded writer
 *  cannot slip past the ban. */
function importedSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const pattern =
		/from\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|\brequire\(\s*"([^"]+)"\s*\)/g;
	for (const match of source.matchAll(pattern)) {
		const specifier = match[1] ?? match[2] ?? match[3];
		if (specifier !== undefined) specifiers.push(specifier);
	}
	return specifiers;
}

interface ForbiddenImportRule {
	/** Human name for the failure message. */
	readonly what: string;
	readonly matches: (specifier: string) => boolean;
	/** Files (relative to lib/agent/change-set) allowed to hold this import. */
	readonly allowedFiles: readonly string[];
}

/** The type-level lookup leaves a read set may name. Anything else in
 *  `lib/lookup` is a writer or a service call. */
const LOOKUP_TYPE_LEAVES = ["lookup/types", "lookup/definitionSnapshot"];

const RULES: readonly ForbiddenImportRule[] = [
	{
		/* The run event log is an operator-visible stream; a staged step is
		 * private until commit and must not narrate itself into it. */
		what: "the event-log writer",
		matches: (s) => s.includes("log/writer"),
		allowedFiles: [],
	},
	{
		/* GenerationContext is the chat SSE + usage host. Staging runs under
		 * the executor, not a chat turn, and never emits to a browser. */
		what: "the chat SSE / event host (generationContext)",
		matches: (s) => s.includes("generationContext"),
		allowedFiles: [],
	},
	{
		/* The stream dispatcher publishes mutations to connected clients —
		 * exactly what an uncommitted candidate must never do. */
		what: "the generation stream dispatcher",
		matches: (s) => s.includes("streamDispatcher"),
		allowedFiles: [],
	},
	{
		/* Multiplayer frames broadcast document state to every Project member;
		 * a private candidate has no peers. */
		what: "the multiplayer collab modules",
		matches: (s) => s.includes("lib/collab"),
		allowedFiles: [],
	},
	{
		/* Place rows live outside the Blueprint, so an external writer inside
		 * staging would escape the all-or-nothing commit. */
		what: "the organization row service (external writer)",
		matches: (s) => s.includes("organization/service"),
		allowedFiles: [],
	},
	{
		/* Media deletion destroys Postgres rows and GCS bytes — irreversible,
		 * and never part of a candidate that may be abandoned. */
		what: "the media deletion service",
		matches: (s) => s.includes("db/mediaDeletion"),
		allowedFiles: [],
	},
	{
		/* Object storage is the same irreversibility one level down. */
		what: "the object store",
		matches: (s) => s.includes("lib/storage"),
		allowedFiles: [],
	},
	{
		/* Deployment writes reach CommCare HQ. A staged candidate has no
		 * business touching a remote project space. */
		what: "the HQ deployment writers",
		matches: (s) => s.includes("lib/deployment"),
		allowedFiles: [],
	},
	{
		/* Lookup data is Project-scoped app state with its own persistence
		 * boundary. Read sets may name its TYPES; nothing here may call it. */
		what: "a lib/lookup module beyond its type-level leaves",
		matches: (s) =>
			s.includes("lookup/") &&
			!LOOKUP_TYPE_LEAVES.some((leaf) => s.endsWith(leaf)),
		allowedFiles: [],
	},
	{
		/* The canonical commit kernel is the shared-tool write path. Staging
		 * commits through `applyBlueprintChange` in commit.ts and nowhere
		 * else, so no change-set file reaches the kernel directly. */
		what: "the canonical commit kernel",
		matches: (s) => s.includes("db/canonicalCommitKernel"),
		allowedFiles: [],
	},
	{
		/* The one authorized crossing: commit.ts is where the candidate stops
		 * being private and becomes canonical history. */
		what: "applyBlueprintChange (the canonical writer)",
		matches: (s) => s.includes("db/applyBlueprintChange"),
		allowedFiles: ["commit.ts"],
	},
	{
		/* LISTEN/NOTIFY fan-out wakes every connected client. Private staging
		 * has nothing to announce until its commit does it for real. */
		what: "the app-change realtime notify helpers",
		matches: (s) => s.includes("appChangeStream"),
		allowedFiles: [],
	},
];

/** Realtime pokes that need no import — a raw channel name or a hand-rolled
 *  `pg_notify` would bypass every rule above. */
const FORBIDDEN_TOKENS = ["notifyAppStream", "pg_notify"];

describe("change-set source guards", () => {
	const files = changeSetSourceFiles();

	it("finds the change-set sources", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	for (const rule of RULES) {
		it(`no undeclared change-set module imports ${rule.what}`, () => {
			const offenders: string[] = [];
			for (const file of files) {
				const rel = relative(CHANGE_SET_ROOT, file).replaceAll("\\", "/");
				if (rule.allowedFiles.includes(rel)) continue;
				const source = readFileSync(file, "utf8");
				if (importedSpecifiers(source).some(rule.matches)) offenders.push(rel);
			}
			expect(offenders).toEqual([]);
		});
	}

	it("commit.ts really does hold the one authorized canonical-writer import", () => {
		const source = readFileSync(join(CHANGE_SET_ROOT, "commit.ts"), "utf8");
		expect(
			importedSpecifiers(source).some((s) =>
				s.includes("db/applyBlueprintChange"),
			),
		).toBe(true);
	});

	for (const token of FORBIDDEN_TOKENS) {
		it(`no change-set source mentions ${token}`, () => {
			const offenders = files
				.filter((file) => readFileSync(file, "utf8").includes(token))
				.map((file) => relative(CHANGE_SET_ROOT, file).replaceAll("\\", "/"));
			expect(offenders).toEqual([]);
		});
	}
});
