/**
 * Order-sequence sweep tripwire.
 *
 * The storage arrays (`moduleOrder` / `formOrder[m]` / `fieldOrder[p]` and the
 * `columns` / `searchInputs` / `options` arrays) are MEMBERSHIP sets — their
 * internal position is NOT the authoritative sequence. Display / wire / preview
 * / SA order is derived as `sort-by-(order, uuid)` (`bySortKey`). A consumer
 * that iterates one of those arrays AS A SEQUENCE must therefore sort it
 * through `bySortKey` (or the `ordered{Field,Form,Module}Uuids` helpers, or
 * `readOptions`/`sortedOrderKeys`, which sort internally), or a same-parent
 * reorder — which leaves the array untouched and only changes an entity's
 * `order` — would be invisible.
 *
 * This guard fails if one of the enumerated sequence consumers loses its sort,
 * so a missed/regressed site fails the build rather than prod. A NEW emitter or
 * walk that consumes an order array as a sequence must be added here (forcing a
 * decision: sort it, or justify that it reads membership only).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Files that walk an order array AS A SEQUENCE and so must sort. This list is
 *  EXHAUSTIVE — every sequence consumer belongs here, so a NEW one that skips
 *  the sort (or a regression that drops it) fails the build, not prod. */
const SEQUENCE_CONSUMERS = [
	// The two field-tree walks (SA path + validator/preview path).
	"lib/doc/fieldWalk.ts",
	"lib/preview/engine/fieldTree.ts",
	// Wire emitters that walk `fieldOrder` / `options`.
	"lib/commcare/xform/builder.ts",
	"lib/commcare/deriveCaseConfig.ts",
	"lib/commcare/formActions.ts",
	// The HQ-JSON + suite menu emitters (module/form menu order — expander
	// emits, compiler walks in lockstep).
	"lib/commcare/expander.ts",
	"lib/commcare/compiler.ts",
	// Case-list column / search-input emitters.
	"lib/commcare/suite/case-list/shortDetail.ts",
	"lib/commcare/suite/case-list/longDetail.ts",
	"lib/commcare/suite/case-list/sortKeys.ts",
	"lib/commcare/hqJson/caseList.ts",
	"lib/commcare/suite/case-search/searchSession.ts",
	// SA-facing renderers + positional resolvers.
	"lib/agent/summarizeBlueprint.ts",
	"lib/agent/blueprintHelpers.ts",
	// Blueprint search — the SA `search_blueprint` tool + the builder's
	// AppTree filter both report DISPLAY-order module/form indices.
	"lib/doc/searchBlueprint.ts",
	"lib/doc/hooks/useSearchFilter.ts",
	// The diff's internal walks.
	"lib/doc/diffDocsToMutations.ts",
	// Retirement reference placement.
	"lib/doc/caseTypeRetirement.ts",
	// Close-field-ref resolution (must agree with the wire emitter's findField).
	"lib/doc/expressionText.ts",
	// Keyboard / inspector move-target resolution.
	"lib/doc/navigation.ts",
	// The builder render hooks (module / form / field sequences).
	"lib/doc/hooks/useOrderedFields.ts",
	"lib/doc/hooks/useModuleIds.ts",
	// The preview engine's case-store sort tie-break.
	"lib/preview/engine/caseDataBindingHelpers.ts",
	// The chat signal-grid: flat field index + SA scope module/form
	// resolution + the DISPLAY-ordered slices it hands `computeEditFocus`.
	"components/chat/SignalGrid.tsx",
	// Drag-and-drop "as first child" resolution in the preview form canvas.
	"components/preview/form/virtual/useDragIntent.ts",
	// The running-preview screens + form widgets.
	"components/preview/screens/CaseListScreen.tsx",
	"components/preview/shared/SearchInputForm.tsx",
	"components/preview/form/fields/SelectOneField.tsx",
	"components/preview/form/fields/SelectMultiField.tsx",
	"components/preview/form/virtual/rowModel.ts",
	// The builder case-list canvases + workspace (render + drag indices).
	"components/builder/case-list-config/canvas/CaseListCanvas.tsx",
	"components/builder/case-list-config/canvas/SearchCanvas.tsx",
	"components/builder/case-list-config/canvas/DetailCanvas.tsx",
	"components/builder/case-list-config/CaseListConfigWorkspace.tsx",
	// The close-condition value dropdown (a select field's option values).
	"components/builder/detail/formSettings/CloseConditionSection.tsx",
] as const;

const SORTS =
	/bySortKey|ordered(?:Field|Form|Module)Uuids|readOptions|sortedOrderKeys/;

describe("order-sequence sweep", () => {
	it.each(
		SEQUENCE_CONSUMERS,
	)("%s derives its sequence through bySortKey, not array position", (relativePath) => {
		const source = readFileSync(join(process.cwd(), relativePath), "utf8");
		expect(source).toMatch(SORTS);
	});
});

/**
 * PER-SITE strengthening of the presence-check above. That check passes a file
 * that sorts in ONE function even when ANOTHER site in it reads a raw order
 * array — proven insufficient (round-1 `walkFieldRefs`, round-4 drag-no-op
 * guard, both in files that sort elsewhere). Two complementary mechanisms:
 *
 * MECHANISM 1 — a GLOBAL ban on `.indexOf` applied to a raw order array
 * (`moduleOrder` / `formOrder[m]` / `fieldOrder[p]`), directly or via a local
 * bound from one. A genuine membership test is `.includes`/`.has`, so `.indexOf`
 * on an order array is a POSITION read. Reducer array-maintenance
 * (`lib/doc/mutations/`) and the diff's non-authoritative `addModule.index`
 * slot (`diffDocsToMutations`) legitimately `.indexOf` the array, so those are
 * excluded; a specific opaque-key read is allowlisted by line.
 *
 * MECHANISM 2 — for the KNOWN pure-consumer files (where iteration order
 * matters and a raw read a static scan can't distinguish from a set-walk is a
 * bug), assert ZERO raw positional read at all: no raw `.indexOf`, no raw
 * `for (… of <raw>)`, no raw BIND (`const x = <expr>.fieldOrder[p]`, unless
 * sorted on the same line). A genuine set-semantic raw read is allowlisted by
 * line with a reason, so the default stays "must sort".
 */
// `.indexOf` on a raw order array, tolerating the `(x ?? []).indexOf` idiom.
const RAW_INDEXOF =
	/\b(?:moduleOrder|formOrder\[[^\]]*\]|fieldOrder\[[^\]]*\])\s*(?:\?\?\s*\[\]\s*\))?\.indexOf\b/;
// A DIRECT `for (… of <chain>.moduleOrder / .formOrder[…] / .fieldOrder[…])`.
const RAW_FOR_OF = /\bof\s+[\w.]*\.(?:moduleOrder\b|formOrder\[|fieldOrder\[)/;
// A raw order array BOUND to a local — the later `x[i]` / `for (… of x)` read
// is a raw positional read, caught at the bind (immune to a rename).
const RAW_BIND =
	/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^=;]*\.(?:moduleOrder\b|formOrder\[[^\]]*\]|fieldOrder\[[^\]]*\])/;
// A bind/read that SORTS the raw array (`[...x].sort(…)`, `ordered*Uuids(…)`) is
// a display-ordered local — not a raw read.
const SORTS_INLINE = /\.sort\(|bySortKey|ordered(?:Field|Form|Module)Uuids/;

/** Genuine non-position raw reads, allowlisted by an exact substring of the
 *  line with the reason it isn't a display-sequence read. Default is "must
 *  sort"; every entry is a deliberate exception. */
const RAW_READ_ALLOWLIST: ReadonlyArray<{ file: string; needle: string }> = [
	// PreviewShell's `moduleIndex` / `formIndex` are OPAQUE Activity-boundary
	// screen-identity keys — never resolved back to an entity (the preview
	// renders from `loc.moduleUuid` / `loc.formUuid` directly), so a raw
	// round-trip index is a stable per-uuid cache key, not a display position.
	{
		file: "components/preview/PreviewShell.tsx",
		needle: "moduleOrder.indexOf(loc.moduleUuid)",
	},
	{
		file: "components/preview/PreviewShell.tsx",
		needle: "formIds.indexOf(loc.formUuid)",
	},
];

/** Files where reducer/diff array-maintenance legitimately `.indexOf`s a raw
 *  order array (splice-out, legacy `toIndex` replay, the non-authoritative
 *  `addModule.index` slot). Order display is the entity's `order` key. */
const INDEXOF_EXEMPT = (relativePath: string): boolean =>
	relativePath.startsWith("lib/doc/mutations/") ||
	relativePath === "lib/doc/diffDocsToMutations.ts";

/** Mechanism 1 — a raw `.indexOf` (direct or via a raw-bound local). */
function rawIndexOfOffenders(relativePath: string, source: string): string[] {
	const allowed = RAW_READ_ALLOWLIST.filter((a) => a.file === relativePath).map(
		(a) => a.needle,
	);
	const lines = source.split("\n");
	const rawLocals = new Set<string>();
	for (const line of lines) {
		if (SORTS_INLINE.test(line)) continue;
		const m = RAW_BIND.exec(line);
		if (m) rawLocals.add(m[1]);
	}
	const localIndexOf =
		rawLocals.size > 0
			? new RegExp(`\\b(?:${[...rawLocals].join("|")})\\.indexOf\\b`)
			: null;
	return lines
		.filter((line) => !allowed.some((n) => line.includes(n)))
		.filter(
			(line) => RAW_INDEXOF.test(line) || (localIndexOf?.test(line) ?? false),
		)
		.map((line) => line.trim());
}

/** All non-test `.ts` / `.tsx` under a top-level dir (relative paths). */
function sourceFilesUnder(dir: string): string[] {
	return readdirSync(join(process.cwd(), dir), {
		recursive: true,
		encoding: "utf8",
	})
		.filter(
			(p) =>
				(p.endsWith(".ts") || p.endsWith(".tsx")) &&
				!p.includes("__tests__") &&
				!p.endsWith(".test.ts") &&
				!p.endsWith(".test.tsx"),
		)
		.map((p) => `${dir}/${p}`);
}

describe("no raw .indexOf on an order array (a position read, never a membership test)", () => {
	const files = ["lib", "components", "app"]
		.flatMap(sourceFilesUnder)
		.filter((f) => !INDEXOF_EXEMPT(f));
	it.each(files)("%s", (relativePath) => {
		const source = readFileSync(join(process.cwd(), relativePath), "utf8");
		expect(rawIndexOfOffenders(relativePath, source)).toEqual([]);
	});
});

/**
 * The KNOWN pure-consumer files: iteration/position order is authoritative, so
 * EVERY order read must go through an `ordered*Uuids` helper. A raw `.indexOf`,
 * a raw `for (… of <raw>)`, or a raw bind (`const x = …fieldOrder[p]`, unless
 * sorted on the same line) fails — catching the iteration-class bug a static
 * scan can't otherwise distinguish from a set-walk. Set-semantic raw reads in
 * these files are allowlisted below. GROW this list as pure consumers are
 * identified; a mixed file (validators, reducers, the diff, `mediaRefs`, the
 * `fieldWalk` provider) stays off it and on the presence-check.
 */
const STRICT_ORDER_CONSUMERS = [
	"lib/doc/navigation.ts",
	"components/preview/form/virtual/useDragIntent.ts",
] as const;

/** Set-semantic raw reads inside a STRICT file (allowlisted by line + reason). */
const STRICT_RAW_ALLOWLIST: ReadonlyArray<{ file: string; needle: string }> = [
	// A keyed EXISTENCE check ("is this field a container?"), not a positional
	// read — the walk itself already goes through `orderedFieldUuids`.
	{
		file: "lib/doc/navigation.ts",
		needle: "if (doc.fieldOrder[uuid] !== undefined) {",
	},
	// The cycle guard passes the WHOLE `fieldOrder` map to a descendant-set
	// walk (`isUuidInSubtree`) — a membership check over the subtree, so its
	// traversal order is irrelevant.
	{
		file: "components/preview/form/virtual/useDragIntent.ts",
		needle: "docs.getState().fieldOrder as Record<string, readonly string[]>",
	},
];

function strictRawOffenders(relativePath: string, source: string): string[] {
	const allowed = STRICT_RAW_ALLOWLIST.filter(
		(a) => a.file === relativePath,
	).map((a) => a.needle);
	return source
		.split("\n")
		.filter((line) => !allowed.some((n) => line.includes(n)))
		.filter(
			(line) =>
				RAW_INDEXOF.test(line) ||
				RAW_FOR_OF.test(line) ||
				(RAW_BIND.test(line) && !SORTS_INLINE.test(line)),
		)
		.map((line) => line.trim());
}

describe("pure order-consumers read ONLY through ordered* helpers", () => {
	it.each(STRICT_ORDER_CONSUMERS)("%s", (relativePath) => {
		const source = readFileSync(join(process.cwd(), relativePath), "utf8");
		expect(strictRawOffenders(relativePath, source)).toEqual([]);
	});
});

/**
 * The SA tool surface takes positional `moduleIndex` / `formIndex` inputs
 * that address entities in DISPLAY order (`sort-by-(order, uuid)` — the same
 * sequence `summarizeBlueprint` / `get_app` / `searchBlueprint` speak). A
 * tool that resolves those indices by RAW `moduleOrder` / `formOrder` array
 * position addresses the WRONG entity after a same-parent reorder (which
 * leaves the membership array untouched). Every tool must resolve through the
 * sorted helpers (`resolveModuleUuid` / `resolveFormUuid` / `resolveFormContext`
 * / `resolveFieldByIndex`, or the `ordered{Module,Form,Field}Uuids` walks).
 *
 * This guard scans the whole SA tool tree for the forbidden positional-index
 * shapes, so a NEW tool that indexes the raw arrays fails the build. Unlike
 * the enumerated list above, it needs no maintenance — it covers every current
 * and future file under `lib/agent/tools`.
 */
const TOOL_TREE = join(process.cwd(), "lib/agent/tools");

/** All non-test `.ts` files under the SA tool tree. */
function toolSourceFiles(): string[] {
	return readdirSync(TOOL_TREE, { recursive: true, encoding: "utf8" })
		.filter((p) => p.endsWith(".ts") && !p.includes("__tests__"))
		.map((p) => join(TOOL_TREE, p));
}

/**
 * Forbidden raw-order-array reads. Three shapes, so the bound-local evasion
 * `const mo = doc.moduleOrder; const u = mo[moduleIndex]` (which the inline
 * form misses) can't slip past — the ban lands at the BIND site, immune to a
 * rename of the local:
 *   1. `moduleOrder[<ident>]` — inline positional module-array index.
 *   2. `formOrder[<key>][…]` / `[<key>]?.[…]` — inline double-index into a
 *      value array (the positional form/field read).
 *   3. `= <chain>.moduleOrder` / `.formOrder[<key>]` / `.fieldOrder[<key>]` —
 *      BINDING the raw array (or a positional value array) to a local at all;
 *      the sanctioned path is the `ordered{Module,Form,Field}Uuids` helpers.
 * A bare inline `doc.moduleOrder.length` count (no `=` binding) and a
 * `for (… of Object.entries(doc.fieldOrder))` set-semantic map walk (no `[`)
 * stay allowed — neither is a positional read.
 */
const FORBIDDEN_POSITIONAL =
	/\bmoduleOrder\[[A-Za-z_$]|\b(?:formOrder|fieldOrder)\[[^\]]+\]\??\.?\[|=\s*[\w.]*\.(?:moduleOrder\b|formOrder\[[^\]]*\]|fieldOrder\[[^\]]*\])/;

describe("SA tools resolve positional indices through sorted helpers", () => {
	it.each(
		toolSourceFiles(),
	)("%s never indexes or binds moduleOrder/formOrder by raw array position", (absPath) => {
		const source = readFileSync(absPath, "utf8");
		const offending = source
			.split("\n")
			.filter((line) => FORBIDDEN_POSITIONAL.test(line));
		expect(offending).toEqual([]);
	});
});
