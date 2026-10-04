/**
 * One-off: writes the manifest's entries from the HQ round-trip inventory.
 *
 * Reads the six area files and the gates file under
 * `docs/research/2026-09-26-hq-round-trip/inventory/` and writes
 * `lib/commcare/surface/entries/<area>.json` (one entry per counted row) and
 * `lib/commcare/surface/entries/gates.json` (one entry per gate row, per
 * publish check the gates file names after its toggle table, and per
 * build-version gate its Build versions paragraph names). Surface keys, value
 * classes, an entry's gates and a gate's effects are empty here.
 *
 * Tables are read the GFM way: a table is a run of lines starting with `|`,
 * an unescaped `|` separates cells and `\|` is a literal pipe, also inside a
 * code span. Every structured field is either a closed vocabulary value or a
 * verbatim part of the row it came from.
 *
 * Run from the repository root: `npx tsx scripts/surface-from-inventory.ts`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	DISPOSITIONS,
	type Disposition,
	EMISSION_MARKERS,
	type EmissionMarker,
	type GateClass,
	type GateEntry,
	type GatePreflight,
	gateEntriesFileSchema,
	type HqToggleClass,
	INVENTORY_AREAS,
	type InventoryArea,
	type InventoryEntry,
	inventoryEntriesFileSchema,
	type PlatformBehavior,
	type Platforms,
	type RefusalReason,
	type RefusalReasonKind,
	type SlotChange,
} from "@/lib/commcare/surface/schema";

/**
 * A gate entry as the gates file gives it, before its surface keys, the
 * inventory entries it governs and a toggle's slug and namespaces were
 * assigned from HQ's source.
 */
type GateRow = GateEntry extends infer Entry
	? Entry extends GateEntry
		? Omit<
				Entry,
				"surfaceKeys" | "contentEntries" | "slug" | "namespaces" | "privilege"
			>
		: never
	: never;

const repoRoot = process.cwd();
const inventoryDir = path.join(
	repoRoot,
	"docs/research/2026-09-26-hq-round-trip/inventory",
);
const entriesDir = path.join(repoRoot, "lib/commcare/surface/entries");

class InventoryReadError extends Error {}

function fail(where: string, message: string): never {
	throw new InventoryReadError(`${where}: ${message}`);
}

// ---------------------------------------------------------------------------
// Markdown: headings, GFM tables, code spans

interface TableRow {
	line: number;
	cells: string[];
	section: string | undefined;
	subsection: string | undefined;
}

interface Table {
	line: number;
	section: string | undefined;
	subsection: string | undefined;
	header: string[];
	rows: TableRow[];
}

interface MarkdownFile {
	name: string;
	lines: string[];
	tables: Table[];
}

/** GFM table-row split: `\|` is a literal pipe, every other `|` a boundary. */
function splitTableRow(text: string, where: string): string[] {
	const trimmed = text.trim();
	if (!trimmed.startsWith("|") || !trimmed.endsWith("|"))
		fail(where, "a table line must start and end with `|`.");
	const inner = trimmed.slice(1, -1);
	const cells: string[] = [];
	let current = "";
	for (let index = 0; index < inner.length; index += 1) {
		const character = inner[index];
		if (character === "\\" && inner[index + 1] === "|") {
			current += "|";
			index += 1;
		} else if (character === "|") {
			cells.push(current.trim());
			current = "";
		} else current += character;
	}
	cells.push(current.trim());
	return cells;
}

/** A heading's name without its parenthesised aside. */
function headingName(heading: string): string {
	const aside = heading.indexOf(" (");
	return aside === -1 ? heading : heading.slice(0, aside);
}

function readMarkdown(name: string): MarkdownFile {
	const lines = readFileSync(path.join(inventoryDir, name), "utf8").split("\n");
	const tables: Table[] = [];
	let section: string | undefined;
	let subsection: string | undefined;
	let index = 0;
	while (index < lines.length) {
		const text = lines[index] ?? "";
		if (text.startsWith("```"))
			fail(`${name}:${index + 1}`, "the inventory holds no fenced code.");
		if (text.startsWith("## ")) {
			section = headingName(text.slice(3));
			subsection = undefined;
		} else if (text.startsWith("### ")) {
			subsection = headingName(text.slice(4));
		}
		if (!text.startsWith("|")) {
			index += 1;
			continue;
		}
		const start = index;
		while (index < lines.length && (lines[index] ?? "").startsWith("|"))
			index += 1;
		const where = `${name}:${start + 1}`;
		if (index - start < 2)
			fail(where, "a table needs a header and a separator.");
		const header = splitTableRow(lines[start] ?? "", where);
		const separator = splitTableRow(lines[start + 1] ?? "", where);
		if (
			separator.length !== header.length ||
			!separator.every((cell) => /^:?-+:?$/.test(cell))
		)
			fail(where, "the table's second line is not a separator row.");
		const rows: TableRow[] = [];
		for (let rowIndex = start + 2; rowIndex < index; rowIndex += 1) {
			const cells = splitTableRow(
				lines[rowIndex] ?? "",
				`${name}:${rowIndex + 1}`,
			);
			if (cells.length !== header.length)
				fail(
					`${name}:${rowIndex + 1}`,
					`the row has ${cells.length} cells where its table has ${header.length}.`,
				);
			rows.push({ line: rowIndex + 1, cells, section, subsection });
		}
		tables.push({ line: start + 1, section, subsection, header, rows });
	}
	return { name, lines, tables };
}

/**
 * The text with every code span's content replaced by `X`, so positions line
 * up with the original and nothing inside a code span is read as prose.
 */
function maskCodeSpans(text: string): string {
	let masked = "";
	let index = 0;
	while (index < text.length) {
		if (text[index] !== "`") {
			masked += text[index];
			index += 1;
			continue;
		}
		let runEnd = index;
		while (text[runEnd] === "`") runEnd += 1;
		const fence = text.slice(index, runEnd);
		let close = text.indexOf(fence, runEnd);
		while (close !== -1 && text[close + fence.length] === "`")
			close = text.indexOf(fence, close + fence.length + 1);
		if (close === -1) {
			masked += fence;
			index = runEnd;
			continue;
		}
		masked += fence + "X".repeat(close - runEnd) + fence;
		index = close + fence.length;
	}
	return masked;
}

/** Parenthesis depth before each position of a masked text. */
function parenDepths(masked: string): number[] {
	const depths: number[] = [];
	let depth = 0;
	for (const character of masked) {
		depths.push(depth);
		if (character === "(") depth += 1;
		else if (character === ")") depth -= 1;
	}
	depths.push(depth);
	return depths;
}

/** Splits at `separator` where it sits outside parentheses and code spans. */
function splitTopLevel(text: string, separator: string): string[] {
	const masked = maskCodeSpans(text);
	const depths = parenDepths(masked);
	const parts: string[] = [];
	let last = 0;
	let index = 0;
	while (index < masked.length) {
		if (depths[index] === 0 && masked.startsWith(separator, index)) {
			parts.push(text.slice(last, index));
			index += separator.length;
			last = index;
		} else index += 1;
	}
	parts.push(text.slice(last));
	return parts;
}

/** The text inside one pair of parentheses that encloses all of it. */
function unwrapParenthesised(text: string): string {
	if (!text.startsWith("(") || !text.endsWith(")")) return text;
	const depths = parenDepths(maskCodeSpans(text));
	for (let index = 1; index < text.length - 1; index += 1)
		if ((depths[index] ?? 0) === 0) return text;
	return text.slice(1, -1).trim();
}

function wordAt(masked: string, word: string): boolean {
	return new RegExp(`(?:^|[^\\w-])${word}(?![\\w-])`).test(masked);
}

// ---------------------------------------------------------------------------
// Inventory entries

const DISPOSITION_TOKEN = /^\*\*(HELD-NEW|HELD|TARGET-OWNED|INERT|REFUSED)\*\*/;

function dispositionOf(cell: string, where: string): Disposition {
	const match = DISPOSITION_TOKEN.exec(cell);
	const disposition = match?.[1];
	if (
		!disposition ||
		!(DISPOSITIONS as readonly string[]).includes(disposition)
	)
		fail(
			where,
			`the Disposition cell starts with neither \`→\` nor a disposition.`,
		);
	for (const bold of cell.matchAll(/\*\*([A-Z-]+)\*\*/g)) {
		const token = bold[1] ?? "";
		if (
			(DISPOSITIONS as readonly string[]).includes(token) &&
			token !== disposition
		)
			fail(where, `the cell names both ${disposition} and ${token}.`);
	}
	return disposition as Disposition;
}

/**
 * HELD rows whose slot changes the direction words alone do not split: the
 * media rows put the widened formats in parentheses before the slot they
 * share, and the Connect Learn Module row scopes its changes to all four
 * Connect blocks and, after its `narrow:`, goes on to list widenings. Each
 * string is a verbatim part of the row's Disposition cell, and the changes
 * follow the cell's order.
 */
const SLOT_CHANGE_OVERRIDES: ReadonlyArray<{
	area: InventoryArea;
	line: number;
	itemStartsWith: string;
	changes: SlotChange[];
}> = [
	{
		area: "expressions-and-data",
		line: 170,
		itemStartsWith: "audio MP3, AAC in M4A",
		changes: [
			{
				direction: "narrow",
				text: "PCM 8- or 16-bit only, Nova checks no WAV encoding today",
			},
			{ direction: "widen", text: "M4A with a brand check, FLAC" },
		],
	},
	{
		area: "expressions-and-data",
		line: 176,
		itemStartsWith: "video MP4 H.264 Baseline or Main",
		changes: [
			{ direction: "narrow", text: "Nova checks no codec today" },
			{ direction: "widen", text: "WebM" },
		],
	},
	{
		area: "questions",
		line: 125,
		itemStartsWith: "Connect Learn Module",
		changes: [
			{
				direction: "widen",
				text: "hyphens in block ids, as Vellum's id rule allows (`util.js` `/^(?!XML)[a-zA-Z][\\w-]*$/`)",
				scope:
					"all four Connect blocks, an assessment at most once per submission, as the next row refuses",
			},
			{
				direction: "narrow",
				text: "no leading `_` or `XML` and not `meta` in any case, which Vellum refuses on every Connect block and Nova admits today (executed; defect 15)",
			},
			{
				direction: "widen",
				text: "the id length each block's Connect column takes (50 for a learn module or task, 100 for a deliver unit, any for an assessment, which Connect does not store; Nova caps every id at 50 today), a display condition per block, blank entity expressions, a `time_estimate` of 0, several blocks per form, and placement inside groups and repeats, as Vellum allows",
				scope:
					"all four Connect blocks, an assessment at most once per submission, as the next row refuses",
			},
		],
	},
];

function slotChangesOf(
	area: InventoryArea,
	row: TableRow,
	cell: string,
	where: string,
	usedOverrides: Set<number>,
): SlotChange[] {
	const overrideIndex = SLOT_CHANGE_OVERRIDES.findIndex(
		(override) => override.area === area && override.line === row.line,
	);
	const override = SLOT_CHANGE_OVERRIDES[overrideIndex];
	if (!override) return directionWordChanges(cell);
	usedOverrides.add(overrideIndex);
	if (!(row.cells[0] ?? "").startsWith(override.itemStartsWith))
		fail(where, "the slot-change override names another row.");
	const cellDirections = new Set(
		directionWordChanges(cell).map((change) => change.direction),
	);
	const overrideDirections = new Set(
		override.changes.map((change) => change.direction),
	);
	if (
		cellDirections.size !== overrideDirections.size ||
		[...cellDirections].some((direction) => !overrideDirections.has(direction))
	)
		fail(
			where,
			`the override's directions (${[...overrideDirections].join(", ")}) differ from the cell's (${[...cellDirections].join(", ")}).`,
		);
	let from = 0;
	for (const change of override.changes) {
		const at = cell.indexOf(change.text, from);
		if (at === -1)
			fail(
				where,
				`"${change.text}" is not part of the cell after the change before it.`,
			);
		from = at + change.text.length;
		if (change.scope !== undefined && !cell.includes(change.scope))
			fail(where, `"${change.scope}" is not part of the cell.`);
	}
	return override.changes;
}

/** The changes the cell's `widen` and `narrow` words open, each running to the next. */
function directionWordChanges(cell: string): SlotChange[] {
	const masked = maskCodeSpans(cell);
	const depths = parenDepths(masked);
	const markers = [
		...masked.matchAll(/(?<![\w-])(widen|narrow)(?![\w-])/g),
	].map((match) => ({
		direction: match[1] as SlotChange["direction"],
		start: match.index ?? 0,
		end: (match.index ?? 0) + (match[1] ?? "").length,
	}));
	return markers.map((marker, markerIndex) => {
		const depth = depths[marker.start] ?? 0;
		let end = cell.length;
		for (let index = marker.end; index < masked.length; index += 1) {
			if ((depths[index + 1] ?? 0) < depth) {
				end = index;
				break;
			}
		}
		const next = markers
			.slice(markerIndex + 1)
			.find((other) => (depths[other.start] ?? 0) === depth);
		if (next && next.start < end) end = next.start;
		let text = cell.slice(marker.end, end).trim();
		if (text.startsWith(":")) text = text.slice(1).trim();
		for (;;) {
			const trimmed = text.replace(/(?:[;,]|\band)$/, "").trim();
			if (trimmed === text) break;
			text = trimmed;
		}
		return { direction: marker.direction, text };
	});
}

const REASON_PHRASES: ReadonlyArray<{
	phrase: string;
	kinds: RefusalReasonKind[];
}> = [
	{
		phrase: "not HQ-editable/buildable",
		kinds: ["not-hq-editable", "not-hq-buildable"],
	},
	{ phrase: "not HQ-editable", kinds: ["not-hq-editable"] },
	{ phrase: "not HQ-buildable", kinds: ["not-hq-buildable"] },
	{ phrase: "broken at runtime", kinds: ["broken-at-runtime"] },
	{ phrase: "unrepresentable identity", kinds: ["unrepresentable-identity"] },
	{ phrase: "untypeable", kinds: ["untypeable"] },
	{ phrase: "freeform", kinds: ["freeform"] },
	{
		phrase: "below the CommCare version floor",
		kinds: ["below-commcare-version-floor"],
	},
	{
		phrase: "unavailable on a declared platform",
		kinds: ["unavailable-on-declared-platform"],
	},
	// A retiring reason names its gate in parentheses; "the retiring X" is
	// prose about a flag, not a reason.
	{ phrase: "retiring (", kinds: ["retiring"] },
];

interface PhraseOccurrence {
	start: number;
	end: number;
	kinds: RefusalReasonKind[];
}

function reasonPhrases(text: string): PhraseOccurrence[] {
	const masked = maskCodeSpans(text);
	const found: PhraseOccurrence[] = [];
	let index = 0;
	while (index < masked.length) {
		const hit = REASON_PHRASES.find(({ phrase }) =>
			masked.startsWith(phrase, index),
		);
		if (hit) {
			found.push({
				start: index,
				end: index + hit.phrase.length,
				kinds: hit.kinds,
			});
			index += hit.phrase.length;
		} else index += 1;
	}
	return found;
}

function retiringGate(named: string, where: string): string {
	const symbol = /^\(([A-Z][A-Z0-9_]*)/.exec(named)?.[1];
	if (!symbol) fail(where, `a retiring reason names no flag: "${named}".`);
	return `toggle/${symbol}`;
}

type ReasonOverride =
	| {
			kind: Exclude<RefusalReasonKind, "retiring">;
			named?: string;
			condition?: string;
	  }
	| { kind: "retiring"; named: string; condition?: string };

/**
 * REFUSED rows that name several reasons, or limit a reason to a case. Each
 * string is a verbatim part of the row's Disposition cell; the reasons'
 * kinds are exactly the rule-5 phrases the cell holds.
 */
const REASON_OVERRIDES: ReadonlyArray<{
	area: InventoryArea;
	line: number;
	itemStartsWith: string;
	reasons: ReasonOverride[];
}> = [
	{
		area: "application-and-settings",
		line: 54,
		itemStartsWith: "`logo_refs[slot].path` other than",
		reasons: [
			{
				kind: "not-hq-editable",
				named:
					"the logo uploader writes only that path (`hqmedia/views.py::ProcessLogoFileUploadView.form_path`)",
			},
			{
				kind: "not-hq-buildable",
				named: "`MediaResourceError`",
				condition:
					"when the path is also a `multimedia_map` key outside `jr://file/`",
			},
		],
	},
	{
		area: "menus-and-case-lists",
		line: 23,
		itemStartsWith: "any module under a training menu",
		reasons: [
			{ kind: "retiring", named: "(TRAINING_MODULE)" },
			{
				kind: "not-hq-buildable",
				named: "`training module parent` (`ModuleValidator` only)",
				condition: "for a basic module",
			},
		],
	},
	{
		area: "menus-and-case-lists",
		line: 44,
		itemStartsWith: "`put_in_root` + `session_endpoint_id`",
		reasons: [
			{
				kind: "not-hq-buildable",
				named:
					"`endpoint to display only forms`, `inline search to display only forms`, `form link to display only forms`",
			},
			{
				kind: "not-hq-editable",
				named: "the editor's link targets leave it out, `views/forms.py`",
				condition: "a form link to such a menu",
			},
		],
	},
	{
		area: "menus-and-case-lists",
		line: 57,
		itemStartsWith: "two endpoints sharing an id",
		reasons: [
			{
				kind: "not-hq-editable",
				named:
					"`views/utils.py::_duplicate_endpoint_ids` compares module, form and mirror-form ids only; no case-list id is compared with anything",
				condition: "where a save compares them",
			},
			{
				kind: "broken-at-runtime",
				named:
					"Core keys endpoints by id (`SuiteParser`), so one replaces the other",
				condition: "otherwise",
			},
		],
	},
	{
		area: "menus-and-case-lists",
		line: 114,
		itemStartsWith: "`Detail.filter` failing",
		reasons: [
			{
				kind: "not-hq-buildable",
				named: "`invalid filter xpath`",
				condition: "in a basic or shadow module",
			},
			{
				kind: "broken-at-runtime",
				named: "Core cannot parse the nodeset (executed)",
				condition: "in an advanced one, where HQ does not check it",
			},
		],
	},
	{
		area: "menus-and-case-lists",
		line: 157,
		itemStartsWith: "`field` failing `details/utils.js::isValidPropertyName`",
		reasons: [
			{ kind: "not-hq-editable", named: "save blocked" },
			{
				kind: "not-hq-buildable",
				named: "`invalid sort field` for sorts",
				condition: "in a basic or shadow module",
			},
		],
	},
	{
		area: "menus-and-case-lists",
		line: 218,
		itemStartsWith: "16′ `clickable-icon` with an empty",
		reasons: [
			{
				kind: "not-hq-buildable",
				named: "`invalid clickable icon configuration`",
			},
			{
				kind: "broken-at-runtime",
				named:
					"HQ emits no action, and Web Apps' click reads it (`menus/views.js::iconClick`)",
				condition: "in an advanced module, which skips the first check",
			},
		],
	},
	{
		area: "menus-and-case-lists",
		line: 237,
		itemStartsWith: "more than one `address` column, or more than one",
		reasons: [
			{
				kind: "not-hq-editable",
				named:
					"the Case List and Case Detail saves refuse a second column of the same `image` or geo-* format (`screen.js::save` counts each format separately)",
			},
			{
				kind: "not-hq-buildable",
				named:
					"a second `address` fails `invalid tile configuration` (`ModuleDetailValidatorMixin._validate_fields_with_format_duplicate`)",
			},
		],
	},
	{
		area: "menus-and-case-lists",
		line: 328,
		itemStartsWith: "`parent_select.module_id` naming a multi-select",
		reasons: [
			{
				kind: "not-hq-editable",
				named: "`get_modules_with_parent_case_type` excludes multi-select",
			},
			{
				kind: "not-hq-buildable",
				named:
					"`invalid parent select id`, `parent cycle`, `circular case hierarchy`",
			},
		],
	},
	{
		area: "forms-and-case-writes",
		line: 22,
		itemStartsWith: "unknown form `doc_type`",
		reasons: [
			{
				kind: "not-hq-buildable",
				named: "`FormBase.wrap` raises",
				condition: "in an advanced module",
			},
			{
				kind: "not-hq-editable",
				named:
					"it wraps as a `Form` still carrying the unknown `doc_type`, which no editor writes (`Module.forms` is `SchemaListProperty(Form)`)",
				condition: "in a basic module",
			},
		],
	},
	{
		area: "forms-and-case-writes",
		line: 65,
		itemStartsWith: "`form_links[]` target any other module",
		reasons: [
			{
				kind: "retiring",
				named: "(FORM_LINK_ADVANCED_MODE)",
				condition: "for a child menu HQ does not match",
			},
			{
				kind: "not-hq-editable",
				named: "which HQ never offers",
				condition: "for a display-only-forms menu",
			},
		],
	},
	{
		area: "forms-and-case-writes",
		line: 87,
		itemStartsWith: "`session_endpoint_id` not a slug fixed point",
		reasons: [
			{
				kind: "not-hq-editable",
				named:
					"under SESSION_ENDPOINTS, which every endpoint needs, a form-settings save fails (`views/utils.py::set_session_endpoint`), or strips surrounding whitespace (`get_cleaned_session_endpoint_id`)",
			},
			{
				kind: "broken-at-runtime",
				named: "Module fields",
				condition: "a duplicate",
			},
		],
	},
	{
		area: "forms-and-case-writes",
		line: 200,
		itemStartsWith: "a load or open action's `case_tag` containing `/`",
		reasons: [
			{
				kind: "not-hq-buildable",
				named: "`ValueError`, `xform.py::_make_elem`; executed",
				condition: "where the action writes a case block",
			},
			{
				kind: "broken-at-runtime",
				named:
					"the session datum is `case_id_<a>/<b>`, which a preload reads as `session/data/case_id_<a>/<b>`, a child step that finds nothing (executed)",
				condition: "otherwise",
			},
		],
	},
	{
		area: "forms-and-case-writes",
		line: 208,
		itemStartsWith: "`LoadUpdateAction.preload` or `case_properties`",
		reasons: [
			{
				kind: "not-hq-buildable",
				named:
					"`update_case word illegal` (`AdvancedFormValidator.check_actions` passes such a load's names as subcase names; executed)",
			},
			{
				kind: "not-hq-editable",
				named:
					'"Parent property references not allowed for subcases", `advanced/case_properties.js`',
			},
		],
	},
	{
		area: "forms-and-case-writes",
		line: 231,
		itemStartsWith: "`AdvancedOpenCaseAction.case_properties` key with `/`",
		reasons: [
			{
				kind: "not-hq-editable",
				named:
					'"Parent property references not allowed for subcases", `advanced/case_properties.js`',
				condition: "on an indexed open action",
			},
			{
				kind: "not-hq-buildable",
				named:
					"`update_case word illegal` on an indexed one, whose names HQ checks as subcase names (`AdvancedFormValidator.check_actions`, `get_subcase_actions`), and otherwise `validate_app` raises `ValueError` building the element (executed)",
			},
		],
	},
	{
		area: "forms-and-case-writes",
		line: 246,
		itemStartsWith:
			"an advanced open action indexed to an open action that has a `repeat_context`, the child's `repeat_context` neither",
		reasons: [
			{
				kind: "not-hq-buildable",
				named:
					"`subcase repeat context`, `AdvancedFormValidator.check_actions`",
				condition: "where it does not start with the parent's path",
			},
			{
				kind: "broken-at-runtime",
				named:
					"since HQ's check is a string prefix: the child's index then reads every row's parent id and fails once the parent repeat has two rows (executed in Core)",
				condition:
					"where it only shares leading text (`/data/rep2` beside `/data/rep`)",
			},
		],
	},
	{
		area: "questions",
		line: 74,
		itemStartsWith: "user-controlled repeat inside a Question List",
		reasons: [
			{
				kind: "not-hq-editable",
				named:
					'Vellum reports "Repeat Count is required." (for `field-list` exactly; a case variant loads as a plain group)',
			},
			{
				kind: "broken-at-runtime",
				named:
					"Android cannot add instances there, reading the host ignoring case (`FormEntryController.isHostWithAppearance`)",
			},
		],
	},
	{
		area: "questions",
		line: 80,
		itemStartsWith: "`jr:imageDimensionScaledMax` that is not an integer",
		reasons: [
			{
				kind: "broken-at-runtime",
				named:
					'Core throws "Invalid input for image max dimension" on a non-integer when Android installs or loads the form, on every `<upload>` element (`UploadQuestionExtensionParser`, which Android registers for all of them, `XFormExtensionUtils`)',
			},
			{
				kind: "not-hq-editable",
				named:
					"a Vellum save drops a non-number and truncates a fraction (executed: `big` dropped, `12.5px` becomes `12px`)",
			},
			{
				kind: "broken-at-runtime",
				named:
					"Android cannot scale an image to a size of zero or less (`FileUtil.getBitmapScaledByMaxDimen` then asks for a non-positive size)",
			},
		],
	},
	{
		area: "questions",
		line: 305,
		itemStartsWith: "a label with a `markdown` form in some languages only",
		reasons: [
			{
				kind: "broken-at-runtime",
				named:
					"since Core throws `NoLocalizedTextException` when that language loads (executed)",
				condition: "where a non-default language holds one the default lacks",
			},
			{
				kind: "not-hq-editable",
				named:
					"since a Vellum save writes each language's own markdown (`javaRosa/plugin.js`; meanwhile the other languages show the default language's markdown, executed)",
				condition: "otherwise",
			},
		],
	},
	{
		area: "expressions-and-data",
		line: 145,
		itemStartsWith: "filter expression `(expr)[…]`",
		reasons: [
			{
				kind: "broken-at-runtime",
				named: '`XPathUnsupportedException("filter expression")`',
			},
			{
				kind: "not-hq-buildable",
				named: "Core's parse refuses it",
				condition: "followed by a path step in a bind",
			},
		],
	},
	{
		area: "expressions-and-data",
		line: 146,
		itemStartsWith: "`//`, and axes other than",
		reasons: [
			{
				kind: "not-hq-buildable",
				named:
					"where Core's parse refuses it (\"step other than 'child::name', '.', '..'\", `XPathPathExpr.getReference`)",
				condition: "in a bind",
			},
			{ kind: "broken-at-runtime", condition: "in an output or setvalue" },
		],
	},
	{
		area: "expressions-and-data",
		line: 147,
		itemStartsWith: "`..` after a named step",
		reasons: [
			{
				kind: "not-hq-buildable",
				named: "where Core's parse refuses it",
				condition: "in a bind",
			},
			{
				kind: "broken-at-runtime",
				named: "parents are not allowed after a named step",
				condition: "in an output or setvalue",
			},
		],
	},
];

function reasonsOf(
	area: InventoryArea,
	row: TableRow,
	cell: string,
	where: string,
	usedOverrides: Set<number>,
): RefusalReason[] {
	const prefix = "**REFUSED**: ";
	if (!cell.startsWith(prefix))
		fail(where, "a REFUSED cell starts with `**REFUSED**: `.");
	const text = cell.slice(prefix.length);
	const phrases = reasonPhrases(text);
	const phraseKinds = new Set(phrases.flatMap((phrase) => phrase.kinds));
	const overrideIndex = REASON_OVERRIDES.findIndex(
		(override) => override.area === area && override.line === row.line,
	);
	const override = REASON_OVERRIDES[overrideIndex];
	if (override) {
		usedOverrides.add(overrideIndex);
		if (!(row.cells[0] ?? "").startsWith(override.itemStartsWith))
			fail(where, "the reason override names another row.");
		const overrideKinds = new Set(
			override.reasons.map((reason) => reason.kind),
		);
		if (
			overrideKinds.size !== phraseKinds.size ||
			[...overrideKinds].some((kind) => !phraseKinds.has(kind))
		)
			fail(
				where,
				`the override's reasons (${[...overrideKinds].join(", ")}) differ from the cell's (${[...phraseKinds].join(", ")}).`,
			);
		return override.reasons.map((reason) => {
			for (const part of [reason.named, reason.condition])
				if (part !== undefined && !text.includes(part))
					fail(where, `"${part}" is not part of the cell.`);
			if (reason.kind === "retiring")
				return {
					kind: "retiring",
					gate: retiringGate(reason.named, where),
					named: reason.named,
					...(reason.condition ? { condition: reason.condition } : {}),
				};
			return {
				kind: reason.kind,
				...(reason.named ? { named: reason.named } : {}),
				...(reason.condition ? { condition: reason.condition } : {}),
			};
		});
	}
	const first = phrases[0];
	if (first?.start !== 0)
		fail(where, "the cell does not open with a rule-5 reason.");
	const second = phrases[1];
	if (
		phrases.length === 2 &&
		second &&
		first.kinds[0] === "freeform" &&
		second.kinds[0] === "retiring" &&
		text.slice(first.end, second.start) === " + "
	) {
		const named = text.slice(second.end - 1);
		return [
			{ kind: "freeform" },
			{ kind: "retiring", gate: retiringGate(named, where), named },
		];
	}
	if (phrases.length !== 1)
		fail(where, "the cell names several reasons and has no reason override.");
	if (first.kinds[0] === "retiring") {
		const named = text.slice(first.end - 1);
		return [{ kind: "retiring", gate: retiringGate(named, where), named }];
	}
	const named = text
		.slice(first.end)
		.replace(/^[:,]\s*/, "")
		.trim();
	return first.kinds.map((kind) => ({
		kind: kind as Exclude<RefusalReasonKind, "retiring">,
		...(named ? { named } : {}),
	}));
}

const PLATFORM_READING_WORDS: Record<string, PlatformBehavior["reading"]> = {
	RUNS: "runs",
	IGNORED: "ignored",
	UNAVAILABLE: "unavailable",
	DIFFERENT: "different",
	"n/a": "not-applicable",
};

function platformBehaviorOf(text: string, where: string): PlatformBehavior {
	const match = /^(RUNS|IGNORED|UNAVAILABLE|DIFFERENT|n\/a)(?=\s|$)(.*)$/s.exec(
		text.trim(),
	);
	const word = match?.[1];
	if (!word) fail(where, `"${text}" does not open with a platform reading.`);
	const reading = PLATFORM_READING_WORDS[word];
	if (!reading) fail(where, `"${word}" is not a platform reading.`);
	const note = unwrapParenthesised((match?.[2] ?? "").trim());
	return { reading, ...(note ? { note } : {}) };
}

function platformsOf(cell: string, where: string): Platforms {
	if (cell === "—") return { kind: "none", cell };
	const halves = splitTopLevel(cell, " / ");
	if (halves.length === 1) {
		if (cell === "n/a" || cell.startsWith("n/a ")) {
			const note = unwrapParenthesised(cell.slice(3).trim());
			return { kind: "not-applicable", cell, ...(note ? { note } : {}) };
		}
		if (cell.startsWith("as "))
			return { kind: "as-section", cell, section: cell.slice(3) };
		fail(where, `the platform cell "${cell}" has no reading.`);
	}
	if (halves.length !== 2)
		fail(where, `the platform cell "${cell}" has more than two readings.`);
	return {
		kind: "each",
		cell,
		webApps: platformBehaviorOf(halves[0] ?? "", where),
		android: platformBehaviorOf(halves[1] ?? "", where),
	};
}

function emissionMarkersOf(cell: string): EmissionMarker[] {
	const masked = maskCodeSpans(cell);
	const markers = new Set<EmissionMarker>();
	if (cell === "n/a") markers.add("n/a");
	if (/^omit(?![\w-])/.test(cell)) markers.add("omit");
	for (const word of ["printed", "unproducible", "save-breaking"] as const)
		if (wordAt(masked, word)) markers.add(word);
	return EMISSION_MARKERS.filter((marker) => markers.has(marker));
}

const ID_SLUG_LENGTH = 64;

function fullSlugOf(text: string): string {
	return text
		.replaceAll("″", "pp")
		.replaceAll("′", "p")
		.normalize("NFKD")
		.replace(/[^\x20-\x7e]/g, " ")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function truncatedSlug(slug: string): string {
	if (slug.length <= ID_SLUG_LENGTH) return slug;
	const cut = slug.slice(0, ID_SLUG_LENGTH);
	return slug[ID_SLUG_LENGTH] === "-"
		? cut
		: cut.slice(0, cut.lastIndexOf("-"));
}

const ID_EXTENDED_SLUG_LENGTH = 80;

/**
 * Each row's id slug within its area: its first cell's slug cut at a word
 * boundary near 64 characters. Where rows share that cut, each is extended
 * word by word until no rival could share it, and where that would pass 80
 * characters, the cut is followed instead by the row's words at the first
 * positions where it differs from each rival.
 */
function entrySlugs(items: readonly string[], where: string): string[] {
	const fulls = items.map(fullSlugOf);
	const bases = fulls.map(truncatedSlug);
	return fulls.map((full, index) => {
		const base = bases[index] ?? "";
		if (!base) fail(where, `"${items[index]}" yields no id.`);
		const rivals = fulls.filter(
			(_, otherIndex) => otherIndex !== index && bases[otherIndex] === base,
		);
		if (rivals.length === 0) return base;
		const words = full.split("-");
		const baseWords = base.split("-").length;
		for (let count = baseWords; count <= words.length; count += 1) {
			const prefix = words.slice(0, count).join("-");
			if (prefix.length > ID_EXTENDED_SLUG_LENGTH) break;
			const sharedByRival = rivals.some(
				(rival) => rival === prefix || rival.startsWith(`${prefix}-`),
			);
			if (!sharedByRival || (prefix === full && !rivals.includes(full)))
				return prefix;
		}
		const divergences = new Set<number>();
		for (const rival of rivals) {
			const rivalWords = rival.split("-");
			let position = baseWords;
			while (
				position < words.length &&
				words[position] === rivalWords[position]
			)
				position += 1;
			if (position >= words.length)
				fail(where, `"${items[index]}" has the same id as another row.`);
			divergences.add(position);
		}
		return [
			base,
			...[...divergences]
				.sort((left, right) => left - right)
				.map((position) => words[position]),
		].join("-");
	});
}

interface AreaResult {
	entries: InventoryEntry[];
	pointers: number;
}

interface UsedOverrides {
	reasons: Set<number>;
	slotChanges: Set<number>;
}

function inventoryEntries(
	area: InventoryArea,
	usedOverrides: UsedOverrides,
): AreaResult {
	const file = readMarkdown(`${area}.md`);
	const entries: InventoryEntry[] = [];
	const items = new Set<string>();
	const counted = file.tables.flatMap((table) =>
		table.rows.filter((row) => !(row.cells[1] ?? "").startsWith("→")),
	);
	const slugs = new Map(
		entrySlugs(
			counted.map((row) => row.cells[0] ?? ""),
			file.name,
		).map((slug, index) => [counted[index]?.line, slug]),
	);
	let pointers = 0;
	for (const table of file.tables) {
		if (
			table.header.join(" | ") !==
			"HQ item | Disposition | Web Apps / Android | Emission"
		)
			fail(
				`${file.name}:${table.line}`,
				"an area table's header differs from the inventory's.",
			);
		for (const row of table.rows) {
			const where = `${file.name}:${row.line}`;
			const [
				item = "",
				dispositionCell = "",
				platformCell = "",
				emissionCell = "",
			] = row.cells;
			if (items.has(item))
				fail(where, "two rows of one file share a first cell.");
			items.add(item);
			if (dispositionCell.startsWith("→")) {
				if (platformCell !== "—" || emissionCell !== "—")
					fail(where, "a pointer row carries a platform or emission cell.");
				pointers += 1;
				continue;
			}
			if (!row.section) fail(where, "the row sits under no section.");
			const common = {
				id: `${area}/${slugs.get(row.line)}`,
				area,
				section: row.section,
				...(row.subsection ? { subsection: row.subsection } : {}),
				item,
				surfaceKeys: [],
				dispositionCell,
				emission: {
					cell: emissionCell,
					markers: emissionMarkersOf(emissionCell),
				},
				gates: [],
			};
			const disposition = dispositionOf(dispositionCell, where);
			const platforms = platformsOf(platformCell, where);
			switch (disposition) {
				case "HELD":
					if (platforms.kind === "none")
						fail(where, "a HELD row has the refused platform cell.");
					entries.push({
						...common,
						disposition,
						slotChanges: slotChangesOf(
							area,
							row,
							dispositionCell,
							where,
							usedOverrides.slotChanges,
						),
						platforms,
					});
					break;
				case "HELD-NEW":
					if (platforms.kind === "none")
						fail(where, "a HELD-NEW row has the refused platform cell.");
					entries.push({ ...common, disposition, platforms });
					break;
				case "TARGET-OWNED":
				case "INERT":
					if (platforms.kind !== "not-applicable")
						fail(where, `a ${disposition} row reads on a platform.`);
					entries.push({ ...common, disposition, platforms });
					break;
				case "REFUSED":
					if (platforms.kind !== "none")
						fail(where, "a REFUSED row has a platform reading.");
					entries.push({
						...common,
						disposition,
						reasons: reasonsOf(
							area,
							row,
							dispositionCell,
							where,
							usedOverrides.reasons,
						),
						platforms,
					});
					break;
			}
		}
	}
	return { entries, pointers };
}

// ---------------------------------------------------------------------------
// Gate entries

/**
 * The gate rows' toggles whose HQ class is not `StaticToggle`, read from
 * `corehq/toggles/__init__.py` at commcare-hq `f57e85e02913` (an AST pass over
 * its module-level toggle constructions; every other gate toggle, and
 * `VIEW_FORM_ATTACHMENT`, is a `StaticToggle` there).
 */
const NON_STATIC_TOGGLES: Readonly<Record<string, HqToggleClass>> = {
	CUSTOM_ICON_BADGES: "FrozenPrivilegeToggle",
	DATA_DICTIONARY: "FrozenPrivilegeToggle",
	FORM_LINK_WORKFLOW: "FrozenPrivilegeToggle",
	MOBILE_USER_DEMO_MODE: "FrozenPrivilegeToggle",
	PHONE_HEARTBEAT: "FrozenPrivilegeToggle",
	VELLUM_SAVE_TO_CASE: "FrozenPrivilegeToggle",
	SAVE_ONLY_EDITED_FORM_FIELDS: "FeatureRelease",
	FACE_CAPTURE: "FeatureRelease",
};

function codeSpans(text: string): string[] {
	return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

function splitGateCell(
	cell: string,
	where: string,
): { label: string; content?: string } {
	const parts = cell.split(" · ");
	if (parts.length > 2)
		fail(where, "the Gate · content cell has two separators.");
	const [label = "", content] = parts;
	return content === undefined ? { label } : { label, content };
}

function preflightOf(
	cell: string,
	selfId: string,
	where: string,
): GatePreflight {
	let kind: GatePreflight["kind"];
	if (/^(?:none|drop|not a publish precondition)(?![\w-])/.test(cell))
		kind = "none";
	else if (/^(?:refuse|flag probe; refuse)(?![\w-])/.test(cell))
		kind = "refusal";
	else if (/^privilege `|confirmed at publish/.test(cell))
		kind = "confirmation";
	else if (/^precondition(?![\w-])|^[A-Z][A-Z0-9_]*$/.test(cell))
		kind = "precondition";
	else fail(where, `the preflight "${cell}" matches no preflight kind.`);

	const requiresOf = (): GatePreflight["requires"] => {
		let match = /^precondition: ([A-Z][A-Z0-9_]*) or ([A-Z][A-Z0-9_]*)$/.exec(
			cell,
		);
		if (match)
			return {
				operator: "any",
				gates: [`toggle/${match[1]}`, `toggle/${match[2]}`],
			};
		match = /^precondition \(or ([A-Z][A-Z0-9_]*)\)$/.exec(cell);
		if (match)
			return { operator: "any", gates: [selfId, `toggle/${match[1]}`] };
		match = /^precondition \(\+ ([A-Z][A-Z0-9_]*)\)$/.exec(cell);
		if (match)
			return { operator: "all", gates: [selfId, `toggle/${match[1]}`] };
		match = /^precondition \(\+ `([A-Za-z]+\.[a-z_]+)`\)$/.exec(cell);
		if (match)
			return {
				operator: "all",
				gates: [selfId, `project-space-setting/${match[1]}`],
			};
		match = /^confirmed at publish \(\+ ([A-Z][A-Z0-9_]*)\)$/.exec(cell);
		if (match)
			return { operator: "all", gates: [selfId, `toggle/${match[1]}`] };
		match = /^privilege `([a-z_]+)`/.exec(cell);
		if (match) return { operator: "all", gates: [`privilege/${match[1]}`] };
		match = /^([A-Z][A-Z0-9_]*)$/.exec(cell);
		if (match) return { operator: "all", gates: [`toggle/${match[1]}`] };
		return undefined;
	};
	const requires = requiresOf();
	// Every flag the cell names must be one `requires` links.
	const selfSymbol = selfId.slice(selfId.indexOf("/") + 1);
	for (const symbol of maskCodeSpans(cell).match(
		/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g,
	) ?? [])
		if (symbol !== selfSymbol && !requires?.gates.includes(`toggle/${symbol}`))
			fail(where, `the preflight names ${symbol}, which no link records.`);
	return { kind, cell, ...(requires ? { requires } : {}) };
}

interface GatesFileParts {
	file: MarkdownFile;
	rows: GateRow[];
	publishChecksLine: number;
	publishChecksText: string;
	buildVersionsLine: number;
	buildVersionsText: string;
}

function gateRows(): GatesFileParts {
	const file = readMarkdown("gates.md");
	const rows: GateRow[] = [];
	const wanted: Record<
		string,
		"app-building-toggles" | "removed-toggles" | "privileges"
	> = {
		"App-building toggles": "app-building-toggles",
		"Removed toggles with document residue": "removed-toggles",
		Privileges: "privileges",
	};
	if (file.tables.length !== 3)
		fail("gates.md", "the gates file holds three tables.");
	for (const table of file.tables) {
		const tableName = wanted[table.subsection ?? ""];
		if (!tableName)
			fail(`gates.md:${table.line}`, "a table sits under no known subsection.");
		for (const row of table.rows) {
			const where = `gates.md:${row.line}`;
			const [item = "", gateCell = "", platformCell = "", preflightCell = ""] =
				row.cells;
			if (platformCell !== "n/a")
				fail(where, "a gate row reads on a platform.");
			const { label, content } = splitGateCell(gateCell, where);
			const source = { kind: "row" as const, table: tableName, line: row.line };
			const shared = {
				item,
				...(content ? { content } : {}),
				platforms: "n/a" as const,
				effects: [],
				source,
			};
			if (tableName === "app-building-toggles") {
				const symbol =
					/^([A-Z][A-Z0-9_]*)(?: \((?:`[^`]+`|toggle)\))?(?: \[[^\]]+\])?$/.exec(
						item,
					)?.[1];
				if (!symbol) fail(where, `"${item}" names no toggle constant.`);
				const classes: Record<string, GateClass> = {
					"TARGET-OWNED": { kind: "target-owned" },
					RETIRING: { kind: "retiring" },
					INERT: { kind: "inert" },
				};
				const gateClass = classes[label];
				if (!gateClass)
					fail(where, `"${label}" is not an app-building toggle class.`);
				const id = `toggle/${symbol}`;
				rows.push({
					id,
					kind: "toggle",
					symbols: [symbol],
					hqToggleClass: NON_STATIC_TOGGLES[symbol] ?? "StaticToggle",
					class: gateClass,
					preflight: preflightOf(preflightCell, id, where),
					...shared,
				});
			} else if (tableName === "removed-toggles") {
				const outsideParens = item.replace(/\([^)]*\)/g, "");
				const symbols = codeSpans(outsideParens);
				if (symbols.length === 0)
					fail(where, `"${item}" names no removed slug.`);
				let gateClass: GateClass;
				const now = /^now ([A-Z][A-Z0-9_]*)$/.exec(label);
				if (now) gateClass = { kind: "now", gate: `toggle/${now[1]}` };
				else if (label === "REMOVED" && content?.startsWith("INERT residue"))
					gateClass = { kind: "removed", residue: "inert" };
				else if (label === "REMOVED" && content?.startsWith("REFUSED"))
					gateClass = { kind: "removed", residue: "refused" };
				else if (label === "no field of their own" && content === undefined)
					gateClass = { kind: "no-field-of-their-own" };
				else fail(where, `"${gateCell}" is not a removed toggle's class.`);
				const id = `removed-toggle/${symbols.join("+")}`;
				rows.push({
					id,
					kind: "removed-toggle",
					symbols,
					class: gateClass,
					preflight: preflightOf(preflightCell, id, where),
					...shared,
				});
			} else {
				const symbols = codeSpans(item);
				if (symbols.length === 0) fail(where, `"${item}" names no privilege.`);
				const classes: Record<string, GateClass> = {
					"TARGET-OWNED": { kind: "target-owned" },
					adjacent: { kind: "adjacent" },
				};
				const gateClass = classes[label];
				if (!gateClass) fail(where, `"${label}" is not a privilege class.`);
				const id = `privilege/${symbols.join("+")}`;
				rows.push({
					id,
					kind: "privilege",
					symbols,
					class: gateClass,
					preflight: preflightOf(preflightCell, id, where),
					...shared,
				});
			}
		}
	}
	const paragraphLine = (opening: string): number => {
		const index = file.lines.findIndex((text) => text.startsWith(opening));
		if (index === -1) fail("gates.md", `no paragraph opens with "${opening}".`);
		return index + 1;
	};
	const publishChecksLine = paragraphLine("Publish also checks gates");
	const buildVersionsLine = paragraphLine(
		"Every version check in HQ is a minimum",
	);
	return {
		file,
		rows,
		publishChecksLine,
		publishChecksText: file.lines[publishChecksLine - 1] ?? "",
		buildVersionsLine,
		buildVersionsText: file.lines[buildVersionsLine - 1] ?? "",
	};
}

/**
 * The gates the paragraph after the app-building toggle table names as
 * publish checks outside the flags. Every string is a verbatim part of that
 * paragraph, and a preflight cell is the part that says how publish checks
 * that gate. The symbols are the HQ fields at commcare-hq `f57e85e02913`:
 * `corehq/toggles/__init__.py::VIEW_FORM_ATTACHMENT` (a `StaticToggle`),
 * `case_search/models.py::CaseSearchConfig.enabled` and
 * `.sync_cases_on_form_entry`,
 * `locations/models.py::LocationFixtureConfiguration.sync_flat_fixture`
 * (read by `locations/fixtures.py::should_sync_flat_fixture`), and
 * `domain/models.py::Domain.commtrack_enabled` (read through
 * `Application.commtrack_enabled`).
 */
const PUBLISH_CHECKS: ReadonlyArray<{
	kind: "toggle" | "project-space-setting";
	symbol: string;
	item: string;
	content: string;
	preflight: GatePreflight["kind"];
	preflightCell: string;
}> = [
	{
		kind: "toggle",
		symbol: "VIEW_FORM_ATTACHMENT",
		item: "`VIEW_FORM_ATTACHMENT` [GA path]",
		content: "for an app that shows a link write in a case list or detail",
		preflight: "precondition",
		preflightCell:
			"Publish also checks gates outside the app-building flags above: `VIEW_FORM_ATTACHMENT` [GA path], for an app that shows a link write in a case list or detail",
	},
	{
		kind: "project-space-setting",
		symbol: "CaseSearchConfig.enabled",
		item: "whether case search is on (`CaseSearchConfig.enabled`)",
		content: "for an app with case search",
		preflight: "precondition",
		preflightCell:
			"which Nova's runtime probe reads for an app with case search (`lib/commcare/client.ts::probeCaseSearchRuntime`)",
	},
	{
		kind: "project-space-setting",
		symbol: "CaseSearchConfig.sync_cases_on_form_entry",
		item: "sync on form entry",
		content:
			"for an app that declares Android and has a module that offers search (defect 20)",
		preflight: "confirmation",
		preflightCell:
			"by asking the person to confirm, since no API reads those settings: that sync on form entry is off",
	},
	{
		kind: "project-space-setting",
		symbol: "LocationFixtureConfiguration.sync_flat_fixture",
		item: "the flat location fixture",
		content: "for an app that reads locations (Settings and profile)",
		preflight: "confirmation",
		preflightCell: "that the flat location fixture still syncs",
	},
	{
		kind: "project-space-setting",
		symbol: "Domain.commtrack_enabled",
		item: "CommTrack",
		content:
			"at import and publish of an app with an advanced module whose case list menu item is on, or with a form whose source contains the text `instance('commcaresession')/session/data/supply_point_id` (HQ's substring test, `entries.py::entry_for_module`)",
		preflight: "confirmation",
		preflightCell:
			"by asking the person to confirm, that CommTrack is off in the project space (defect 20)",
	},
];

type BuildVersionClass =
	| "generation"
	| "authoring"
	| "build-error"
	| "display-only"
	| "disabled";

/**
 * The build-version gates the Build versions paragraph names, one per HQ
 * check. `item` is the paragraph's name for the gate and `covers` the
 * features it lists under that check (where one check gates several);
 * `content` is the paragraph's whole clause. The symbols are
 * `feature_support.py::CommCareFeatureSupportMixin` properties at
 * commcare-hq `f57e85e02913`, or, for a comparison of `build_version` made
 * outside it, the functions that make it (paths under
 * `corehq/apps/app_manager/`).
 *
 * A `direct` gate is one the paragraph names only by where its checks sit
 * ("direct checks in `app_strings.py`, the suite generator, …"), with no
 * feature or version, so it has no content and its version is the one its
 * functions compare with: `app_strings.py::_maybe_add_index` prefixes
 * numeric-navigation menu text from 2.8, and the suite generator's three
 * checks give media, form and locale resources a descriptor from 2.9. The
 * settings page's per-setting `since` gates, the paragraph's last direct
 * checks, are each setting's own `since` value, so they are no gate entry
 * of their own.
 */
const BUILD_VERSION_GATES: ReadonlyArray<{
	item: string;
	covers?: readonly string[];
	direct?: true;
	symbols: readonly string[];
	class: BuildVersionClass;
	minimumVersion?: string;
	content?: string;
}> = [
	{
		item: "`app_strings.py`",
		direct: true,
		symbols: ["app_strings.py::_maybe_add_index"],
		class: "generation",
		minimumVersion: "2.8",
	},
	{
		item: "the suite generator",
		direct: true,
		symbols: [
			"suite_xml/generator.py::MediaSuiteGenerator.media_resources",
			"suite_xml/sections/resources.py::FormResourceContributor.get_section_elements",
			"suite_xml/sections/resources.py::LocaleResourceContributor.get_section_elements",
		],
		class: "generation",
		minimumVersion: "2.9",
	},
	{
		item: "multimedia case properties",
		symbols: ["enable_multimedia_case_property"],
		class: "build-error",
		minimumVersion: "2.6",
		content:
			"multimedia case properties below 2.6 are a build error (`enable_multimedia_case_property`)",
	},
	{
		item: "the case list icon width gate",
		symbols: ["enable_case_list_icon_dynamic_width"],
		class: "disabled",
		content: "the case list icon width gate is disabled at every version",
	},
	{
		item: "multi-sort",
		symbols: ["enable_multi_sort"],
		class: "generation",
		minimumVersion: "2.2",
		content: "multi-sort 2.2",
	},
	{
		item: "post-form workflow",
		symbols: ["enable_post_form_workflow"],
		class: "generation",
		minimumVersion: "2.9",
		content: "post-form workflow 2.9",
	},
	{
		item: "relative suite paths",
		symbols: ["enable_relative_suite_path"],
		class: "generation",
		minimumVersion: "2.12",
		content: "relative suite paths 2.12",
	},
	{
		item: "local media resources",
		symbols: ["enable_local_resource"],
		class: "generation",
		minimumVersion: "2.13",
		content:
			"local media resources 2.13 (offline install, which also needs it, affects only the releases page)",
	},
	{
		item: "offline install",
		symbols: ["enable_offline_install"],
		class: "display-only",
		minimumVersion: "2.13",
		content:
			"offline install, which also needs it, affects only the releases page",
	},
	{
		item: "auto GPS",
		symbols: ["enable_auto_gps"],
		class: "generation",
		minimumVersion: "2.14",
		content: "auto GPS 2.14",
	},
	{
		item: "menu filtering",
		symbols: ["enable_module_filtering"],
		class: "generation",
		minimumVersion: "2.20",
		content: "menu filtering 2.20",
	},
	{
		item: "localized menu media and badges",
		covers: ["localized menu media", "badges"],
		symbols: ["enable_localized_menu_media"],
		class: "generation",
		minimumVersion: "2.21",
		content: "localized menu media and badges 2.21",
	},
	{
		item: "practice users",
		symbols: ["supports_practice_users"],
		class: "generation",
		minimumVersion: "2.26",
		content: "practice users 2.26",
	},
	{
		item: "prompt appearance",
		symbols: ["enable_search_prompt_appearance"],
		class: "generation",
		minimumVersion: "2.50",
		content: "prompt appearance 2.50",
	},
	{
		item: "prompt default expressions",
		symbols: ["enable_default_value_expression"],
		class: "generation",
		minimumVersion: "2.51",
		content: "prompt default expressions and session endpoints 2.51",
	},
	{
		item: "session endpoints",
		symbols: ["supports_session_endpoints"],
		class: "generation",
		minimumVersion: "2.51",
		content: "prompt default expressions and session endpoints 2.51",
	},
	{
		item: "search title translation",
		symbols: ["enable_case_search_title_translation"],
		class: "generation",
		minimumVersion: "2.53",
		content: "search title translation and data registries 2.53",
	},
	{
		item: "data registries",
		symbols: ["supports_data_registry"],
		class: "generation",
		minimumVersion: "2.53",
		content: "search title translation and data registries 2.53",
	},
	...(
		[
			["alt text", "supports_alt_text"],
			["clickable icons", "supports_detail_field_action"],
			["empty-list text", "supports_empty_case_list_text"],
			["menu instances", "supports_menu_instances"],
			["select text", "supports_select_text"],
		] as const
	).map(([item, symbol]) => ({
		item,
		symbols: [symbol],
		class: "generation" as const,
		minimumVersion: "2.54",
		content:
			"alt text, clickable icons, empty-list text, menu instances and select text 2.54",
	})),
	{
		item: "case-list optimizations",
		symbols: ["supports_case_list_optimizations"],
		class: "generation",
		minimumVersion: "2.56",
		content: "case-list optimizations 2.56",
	},
	{
		item: "groups in field lists",
		symbols: ["enable_group_in_field_list"],
		class: "authoring",
		minimumVersion: "2.16",
		content: "groups in field lists 2.16",
	},
	{
		item: "image resize",
		symbols: ["enable_image_resize"],
		class: "authoring",
		minimumVersion: "2.23",
		content: "image resize and markdown in groups 2.23",
	},
	{
		item: "markdown in groups",
		symbols: ["enable_markdown_in_groups"],
		class: "authoring",
		minimumVersion: "2.23",
		content: "image resize and markdown in groups 2.23",
	},
	{
		item: "parent selection with a case-list form",
		symbols: ["views/modules.py::_case_list_form_not_allowed_reasons"],
		class: "authoring",
		minimumVersion: "2.23",
		content: "parent selection with a case-list form 2.23 (`views/modules.py`)",
	},
	{
		item: "sort blank placement",
		symbols: ["enable_case_list_sort_blanks"],
		class: "authoring",
		minimumVersion: "2.35",
		content: "sort blank placement 2.35",
	},
	{
		item: "sorted itemsets",
		symbols: ["enable_sorted_itemsets"],
		class: "authoring",
		minimumVersion: "2.38",
		content: "sorted itemsets 2.38",
	},
	{
		item: "update prompts",
		symbols: ["supports_update_prompts"],
		class: "authoring",
		minimumVersion: "2.38",
		content: "update prompts 2.38 (a releases-page setting, no app content)",
	},
	{
		item: "markdown tables",
		symbols: ["enable_markdown_tables"],
		class: "authoring",
		minimumVersion: "2.50",
		content: "markdown tables 2.50",
	},
	{
		item: "training modules",
		symbols: ["enable_training_modules"],
		class: "authoring",
		minimumVersion: "2.43",
		content:
			"training modules 2.43 (`views/apps.py`, the new-menu dialog; retiring content)",
	},
	{
		item: "grouped tiles",
		symbols: ["supports_grouped_case_tiles"],
		class: "authoring",
		minimumVersion: "2.54",
		content:
			"grouped tiles, grouped prompts, and module assertions (retiring content) 2.54",
	},
	{
		item: "grouped prompts",
		symbols: ["supports_grouped_case_search_properties"],
		class: "authoring",
		minimumVersion: "2.54",
		content:
			"grouped tiles, grouped prompts, and module assertions (retiring content) 2.54",
	},
	{
		item: "module assertions",
		symbols: ["supports_module_assertions"],
		class: "authoring",
		minimumVersion: "2.54",
		content:
			"grouped tiles, grouped prompts, and module assertions (retiring content) 2.54",
	},
	{
		item: "repeat button text",
		symbols: ["views/formdesigner.py::_get_vellum_features"],
		class: "authoring",
		minimumVersion: "2.55",
		content: "repeat button text 2.55 (`views/formdesigner.py`)",
	},
	{
		item: "document upload",
		symbols: ["support_document_upload"],
		class: "authoring",
		minimumVersion: "2.57",
		content: "document upload 2.57",
	},
	{
		item: "Multi-master linked apps",
		symbols: ["enable_multi_master"],
		class: "display-only",
		minimumVersion: "2.47.4",
		content:
			"Multi-master linked apps 2.47.4 gates only a display on the app's linked-apps page (`views/apps.py`), no app content",
	},
];

const BUILD_VERSION_PREFLIGHT =
	"so no row carries a version precondition of its own";

/** The text with its top-level parenthesised asides removed. */
function withoutParentheticals(text: string): string {
	const depths = parenDepths(maskCodeSpans(text));
	let kept = "";
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index] ?? "";
		const inside = (depths[index] ?? 0) > 0 || character === "(";
		if (!inside) kept += character;
	}
	return kept.replace(/\s+/g, " ").trim();
}

/**
 * The features the paragraph lists under its generation and authoring
 * gates, by class and version, read from its `·`-separated lists.
 */
function listedBuildVersionFeatures(
	text: string,
): Array<{ class: BuildVersionClass; version: string; feature: string }> {
	const listed: Array<{
		class: BuildVersionClass;
		version: string;
		feature: string;
	}> = [];
	for (const [opening, gateClass] of [
		["Generation gates", "generation"],
		["Authoring gates", "authoring"],
	] as const) {
		const start = text.indexOf(opening);
		const colon = text.indexOf(": ", start);
		const end = text.indexOf(". ", colon);
		if (start === -1 || colon === -1 || end === -1)
			fail(
				"gates.md",
				`the Build versions paragraph has no "${opening}" list.`,
			);
		for (const clause of text.slice(colon + 2, end).split(" · ")) {
			const bare = withoutParentheticals(clause);
			const version = /\s(\d+(?:\.\d+)+)$/.exec(bare);
			if (!version?.[1]) fail("gates.md", `"${clause}" names no version.`);
			const features = bare
				.slice(0, version.index)
				.split(/, and |, | and /)
				.map((feature) => feature.trim());
			for (const feature of features)
				listed.push({ class: gateClass, version: version[1], feature });
		}
	}
	return listed;
}

function paragraphGates(parts: GatesFileParts): GateRow[] {
	const gates: GateRow[] = [];
	for (const check of PUBLISH_CHECKS) {
		for (const part of [check.item, check.content, check.preflightCell])
			if (!parts.publishChecksText.includes(part))
				fail(
					`gates.md:${parts.publishChecksLine}`,
					`"${part}" is not part of the paragraph.`,
				);
		const shared = {
			symbols: [check.symbol],
			item: check.item,
			class: { kind: "publish-check" as const },
			content: check.content,
			platforms: "n/a" as const,
			preflight: { kind: check.preflight, cell: check.preflightCell },
			effects: [],
			source: {
				kind: "paragraph" as const,
				paragraph: "publish-checks" as const,
				line: parts.publishChecksLine,
			},
		};
		gates.push(
			check.kind === "toggle"
				? {
						id: `toggle/${check.symbol}`,
						kind: "toggle",
						hqToggleClass: NON_STATIC_TOGGLES[check.symbol] ?? "StaticToggle",
						...shared,
					}
				: {
						id: `project-space-setting/${check.symbol}`,
						kind: check.kind,
						...shared,
					},
		);
	}

	const text = parts.buildVersionsText;
	const where = `gates.md:${parts.buildVersionsLine}`;
	if (!text.includes(BUILD_VERSION_PREFLIGHT))
		fail(
			where,
			"the paragraph no longer says no row carries a version precondition.",
		);
	const directOpening = "direct checks in ";
	const directStart = text.indexOf(directOpening);
	if (directStart === -1)
		fail(where, `the paragraph names no "${directOpening}".`);
	const directChecks = text.slice(
		directStart + directOpening.length,
		text.indexOf(")", directStart),
	);
	const covered = new Map<string, string>();
	for (const gate of BUILD_VERSION_GATES) {
		for (const part of [gate.item, gate.content])
			if (part !== undefined && !text.includes(part))
				fail(where, `"${part}" is not part of the paragraph.`);
		if (gate.direct && !directChecks.includes(gate.item))
			fail(where, `"${gate.item}" is not among the paragraph's direct checks.`);
		if (gate.direct && (gate.content !== undefined || gate.covers))
			fail(where, `the direct check "${gate.item}" names no feature.`);
		for (const feature of gate.covers ?? [gate.item]) {
			if (covered.has(feature)) fail(where, `two gates cover "${feature}".`);
			covered.set(feature, `${gate.class} ${gate.minimumVersion ?? ""}`);
		}
		gates.push({
			id: `build-version/${gate.symbols.join("+")}`,
			kind: "build-version",
			symbols: [...gate.symbols],
			item: gate.item,
			class: { kind: gate.class },
			...(gate.content ? { content: gate.content } : {}),
			platforms: "n/a",
			preflight: { kind: "none", cell: BUILD_VERSION_PREFLIGHT },
			effects: [],
			source: {
				kind: "paragraph",
				paragraph: "build-versions",
				line: parts.buildVersionsLine,
			},
			...(gate.minimumVersion ? { minimumVersion: gate.minimumVersion } : {}),
		});
	}
	const listed = listedBuildVersionFeatures(text);
	for (const { class: gateClass, version, feature } of listed)
		if (covered.get(feature) !== `${gateClass} ${version}`)
			fail(where, `no ${gateClass} gate at ${version} covers "${feature}".`);
	const listedFeatures = new Set(listed.map(({ feature }) => feature));
	for (const gate of BUILD_VERSION_GATES)
		if (
			!gate.direct &&
			(gate.class === "generation" || gate.class === "authoring")
		)
			for (const feature of gate.covers ?? [gate.item])
				if (!listedFeatures.has(feature))
					fail(
						where,
						`"${feature}" is not in the paragraph's ${gate.class} list.`,
					);
	return gates;
}

// ---------------------------------------------------------------------------

function writeJson(fileName: string, value: unknown): string {
	const target = path.join(entriesDir, fileName);
	writeFileSync(target, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	return target;
}

/**
 * The entry files that already hold what was assigned after this script
 * wrote them: an inventory entry's surface keys, value class or gates, or a
 * gate entry's surface keys, content entries or effects.
 */
function assignedEntryFiles(): string[] {
	const holds = (entry: unknown, fields: readonly string[]): boolean =>
		typeof entry === "object" &&
		entry !== null &&
		fields.some((field) => {
			const value = (entry as Record<string, unknown>)[field];
			return Array.isArray(value) ? value.length > 0 : value !== undefined;
		});
	return [
		...INVENTORY_AREAS.map((area) => ({
			name: `${area}.json`,
			fields: ["surfaceKeys", "valueClass", "gates"],
		})),
		{
			name: "gates.json",
			fields: ["surfaceKeys", "contentEntries", "effects"],
		},
	].flatMap(({ name, fields }) => {
		const file = path.join(entriesDir, name);
		if (!existsSync(file)) return [];
		const entries: unknown = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(entries) &&
			entries.some((entry) => holds(entry, fields))
			? [name]
			: [];
	});
}

function main(): void {
	const assigned = assignedEntryFiles();
	if (assigned.length > 0)
		fail(
			path.relative(repoRoot, entriesDir),
			`${assigned.join(", ")} already hold surface keys, gates or content links assigned after this script wrote the entries, and writing them again would erase that work. Nothing was written. The pull request that added this script records its one run.`,
		);
	mkdirSync(entriesDir, { recursive: true });
	const written: string[] = [];
	const usedOverrides: UsedOverrides = {
		reasons: new Set(),
		slotChanges: new Set(),
	};
	const retiringGates = new Set<string>();
	const summary: string[] = [];
	let totalEntries = 0;
	let totalPointers = 0;
	for (const area of INVENTORY_AREAS) {
		const { entries, pointers } = inventoryEntries(area, usedOverrides);
		const parsed = inventoryEntriesFileSchema.parse(entries);
		for (const entry of parsed)
			if (entry.disposition === "REFUSED")
				for (const reason of entry.reasons)
					if (reason.kind === "retiring") retiringGates.add(reason.gate);
		written.push(writeJson(`${area}.json`, parsed));
		const byDisposition = DISPOSITIONS.map(
			(disposition) =>
				`${disposition} ${parsed.filter((entry) => entry.disposition === disposition).length}`,
		);
		summary.push(
			`${area}: ${parsed.length} entries (${byDisposition.join(", ")}), ${pointers} pointer rows skipped`,
		);
		totalEntries += parsed.length;
		totalPointers += pointers;
	}
	for (const [name, overrides, used] of [
		["reason", REASON_OVERRIDES, usedOverrides.reasons],
		["slot-change", SLOT_CHANGE_OVERRIDES, usedOverrides.slotChanges],
	] as const) {
		const unused = overrides.filter((_, index) => !used.has(index));
		if (unused.length > 0)
			fail(
				`${name} overrides`,
				`${unused.length} override(s) matched no row: ${unused.map((override) => `${override.area}:${override.line}`).join(", ")}.`,
			);
	}

	const gateParts = gateRows();
	const gates = [...gateParts.rows, ...paragraphGates(gateParts)].sort(
		(left, right) => left.source.line - right.source.line,
	);
	const parsedGates = gateEntriesFileSchema.parse(gates);
	const gateIds = new Set(parsedGates.map((gate) => gate.id));
	const links = [
		...retiringGates,
		...parsedGates.flatMap((gate) => [
			...(gate.class.kind === "now" ? [gate.class.gate] : []),
			...(gate.preflight.requires?.gates ?? []),
		]),
	];
	for (const link of links)
		if (!gateIds.has(link)) fail("gates", `"${link}" names no gate entry.`);
	written.push(writeJson("gates.json", parsedGates));

	execFileSync(
		path.join(repoRoot, "node_modules", ".bin", "biome"),
		["check", "--write", ...written],
		{ stdio: "inherit" },
	);

	const gatesByKind = parsedGates.reduce((counts, gate) => {
		counts.set(gate.kind, (counts.get(gate.kind) ?? 0) + 1);
		return counts;
	}, new Map<string, number>());
	console.log(summary.join("\n"));
	console.log(
		`inventory: ${totalEntries} entries from ${totalEntries + totalPointers} area rows (${totalPointers} pointer rows skipped)`,
	);
	console.log(
		`gates: ${parsedGates.length} entries (${[...gatesByKind]
			.map(([kind, count]) => `${kind} ${count}`)
			.join(
				", ",
			)}); ${gateParts.rows.length} from table rows, ${parsedGates.length - gateParts.rows.length} from paragraphs`,
	);
	console.log(
		`wrote ${written.length} files under ${path.relative(repoRoot, entriesDir)}`,
	);
}

try {
	main();
} catch (error) {
	if (error instanceof InventoryReadError) {
		console.error(`Could not write the manifest entries. ${error.message}`);
		process.exit(1);
	}
	throw error;
}
