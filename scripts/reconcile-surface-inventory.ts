/**
 * One-off: checks the manifest's entries against the HQ round-trip inventory
 * and against commcare-hq at the pin.
 *
 * Reads the inventory under `docs/research/2026-09-26-hq-round-trip/inventory/`
 * with its own table reader and checks that:
 *
 * - every entries file parses with the manifest schema;
 * - every counted inventory row is exactly one inventory entry with the same
 *   item, section, disposition cell, platform cell and emission cell, and
 *   every inventory entry is exactly one counted row, but the entries written
 *   for an item Nova's exports use that no row covers (`origin:
 *   "export-use"`), which the report lists for review and the counts leave
 *   out;
 * - each entry's platform readings and notes, emission markers, slot-change
 *   directions and refusal-reason kinds are the ones the row's words give; a
 *   slot change's text and scope and a reason's named part and condition are
 *   verbatim parts of the row, the slot changes in the row's order; and a
 *   retiring reason links the gate of the flag the row names in its
 *   `retiring (…)`, a retiring toggle;
 * - the row entries' counts per area and in total equal the inventory
 *   README's Counts table;
 * - every row of the gates file is exactly one gate entry with the row's
 *   item, class, content, kind, symbols and preflight cell, and each gate's
 *   preflight kind and the gates it requires are the ones its cell gives;
 * - the gates the publish-check and Build versions paragraphs name are
 *   present, with the class, version and preflight the paragraphs give;
 * - every gate an entry links exists;
 * - the gates agree with commcare-hq at `proof/pins.json`'s commit: each
 *   toggle's HQ class (and slug, where the gates file shows one), that no
 *   removed slug is still a toggle, each privilege slug, each
 *   project-space-setting field, each build-version gate's minimum version,
 *   and that every `feature_support.py` property and every direct comparison
 *   of `build_version` in the app manager is a build-version gate (the
 *   settings page's per-setting `since` comparison aside).
 *
 * The source checks run a Python AST pass over the checkout. Prints a report
 * and exits 1 on any mismatch. Run from the repository root:
 * `npx tsx scripts/reconcile-surface-inventory.ts --hq <commcare-hq checkout>`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	type GateEntry,
	gateEntriesFileSchema,
	INVENTORY_AREAS,
	type InventoryArea,
	type InventoryEntry,
	inventoryEntriesFileSchema,
} from "@/lib/commcare/surface/schema";

const repoRoot = process.cwd();
const inventoryDir = path.join(
	repoRoot,
	"docs/research/2026-09-26-hq-round-trip/inventory",
);
const entriesDir = path.join(repoRoot, "lib/commcare/surface/entries");

const mismatches: string[] = [];
const report: string[] = [];

function mismatch(message: string): void {
	mismatches.push(message);
}

function check(label: string, ok: boolean, detail: string): void {
	report.push(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
	if (!ok) mismatch(`${label}: ${detail}`);
}

function hqCheckout(): string {
	const flag = process.argv.indexOf("--hq");
	const value = flag === -1 ? undefined : process.argv[flag + 1];
	if (!value) {
		console.error(
			"The reconcile reads commcare-hq at the pinned commit to check the gates. Pass the checkout with `--hq <path>`.",
		);
		process.exit(2);
	}
	return path.resolve(value);
}

// ---------------------------------------------------------------------------
// The inventory, read line by line

interface Row {
	file: string;
	line: number;
	section: string;
	subsection: string | undefined;
	cells: string[];
}

function cellsOf(line: string): string[] {
	const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return body
		.split(/(?<!\\)\|/)
		.map((cell) => cell.replaceAll("\\|", "|").trim());
}

function sectionName(heading: string): string {
	return heading.replace(/ \(.*$/, "").trim();
}

/** The body rows of every table in a file, with their headings. */
function tableRows(file: string): { rows: Row[]; lines: string[] } {
	const lines = readFileSync(path.join(inventoryDir, file), "utf8").split("\n");
	const rows: Row[] = [];
	let section = "";
	let subsection: string | undefined;
	let tableLine = 0;
	lines.forEach((line, index) => {
		if (/^## /.test(line)) {
			section = sectionName(line.slice(3));
			subsection = undefined;
		} else if (/^### /.test(line)) subsection = sectionName(line.slice(4));
		if (!line.startsWith("|")) {
			tableLine = 0;
			return;
		}
		tableLine += 1;
		// A table's first line is its header and its second the separator.
		if (tableLine <= 2) return;
		rows.push({
			file,
			line: index + 1,
			section,
			subsection,
			cells: cellsOf(line),
		});
	});
	return { rows, lines };
}

function withoutCode(text: string): string {
	return text.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
}

const DISPOSITION_OF_ROW =
	/^\*\*(HELD|HELD-NEW|TARGET-OWNED|INERT|REFUSED)\*\*/;

/** A toggle constant as the inventory writes one: upper case with underscores. */
const FLAG_CONSTANT = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

// ---------------------------------------------------------------------------
// Inventory entries

function readJson(file: string): unknown {
	return JSON.parse(readFileSync(path.join(entriesDir, file), "utf8"));
}

const READING_WORDS: Record<string, string> = {
	RUNS: "runs",
	IGNORED: "ignored",
	UNAVAILABLE: "unavailable",
	DIFFERENT: "different",
	"n/a": "not-applicable",
};

/** The two readings of a platform cell, by the slash outside parentheses. */
function readingsOf(cell: string): [string, string] | undefined {
	const bare = withoutCode(cell);
	let depth = 0;
	for (let index = 0; index < bare.length; index += 1) {
		const character = bare[index];
		if (character === "(") depth += 1;
		if (character === ")") depth -= 1;
		if (depth === 0 && bare.slice(index, index + 3) === " / ")
			return [cell.slice(0, index), cell.slice(index + 3)];
	}
	return undefined;
}

function platformsAgree(
	entry: InventoryEntry,
	cell: string,
): string | undefined {
	const platforms = entry.platforms;
	if (cell === "—")
		return platforms.kind === "none"
			? undefined
			: `"—" is not ${platforms.kind}`;
	const halves = readingsOf(cell);
	if (!halves) {
		if (cell.startsWith("n/a"))
			return platforms.kind === "not-applicable"
				? undefined
				: `"${cell}" is not ${platforms.kind}`;
		if (cell.startsWith("as "))
			return platforms.kind === "as-section" &&
				platforms.section === cell.slice(3)
				? undefined
				: `"${cell}" is not the section ${platforms.kind}`;
		return `"${cell}" has no reading`;
	}
	if (platforms.kind !== "each") return `"${cell}" is not ${platforms.kind}`;
	const words = halves.map(
		(half) => READING_WORDS[half.trim().split(/\s/)[0] ?? ""],
	);
	if (
		words[0] !== platforms.webApps.reading ||
		words[1] !== platforms.android.reading
	)
		return `"${cell}" reads ${words.join(" / ")}, the entry ${platforms.webApps.reading} / ${platforms.android.reading}`;
	for (const [half, behavior] of [
		[halves[0], platforms.webApps],
		[halves[1], platforms.android],
	] as const) {
		const rest = half.trim().replace(/^\S+/, "").trim();
		if (
			Boolean(rest) !== Boolean(behavior.note) ||
			(behavior.note && !rest.includes(behavior.note))
		)
			return `the note "${behavior.note ?? ""}" is not the cell's "${rest}"`;
	}
	return undefined;
}

function markersOf(cell: string): string[] {
	const prose = withoutCode(cell);
	const markers: string[] = [];
	for (const word of ["printed", "unproducible", "save-breaking"])
		if (new RegExp(`(^|[^A-Za-z-])${word}($|[^A-Za-z-])`).test(prose))
			markers.push(word);
	if (/^omit($|[^A-Za-z-])/.test(cell)) markers.push("omit");
	if (cell === "n/a") markers.push("n/a");
	return markers.sort();
}

const RULE_FIVE: ReadonlyArray<[RegExp, string[]]> = [
	[/not HQ-editable\/buildable/g, ["not-hq-editable", "not-hq-buildable"]],
	[/not HQ-editable(?!\/)/g, ["not-hq-editable"]],
	[/not HQ-buildable/g, ["not-hq-buildable"]],
	[/broken at runtime/g, ["broken-at-runtime"]],
	[/unrepresentable identity/g, ["unrepresentable-identity"]],
	[/untypeable/g, ["untypeable"]],
	[/freeform/g, ["freeform"]],
	[/below the CommCare version floor/g, ["below-commcare-version-floor"]],
	[/unavailable on a declared platform/g, ["unavailable-on-declared-platform"]],
	[/retiring \(/g, ["retiring"]],
];

function reasonKindsOf(cell: string): string[] {
	const prose = withoutCode(cell);
	const kinds = new Set<string>();
	for (const [pattern, found] of RULE_FIVE)
		if (prose.match(pattern)) for (const kind of found) kinds.add(kind);
	return [...kinds].sort();
}

/** The flags a Disposition cell retires its content under, as gate ids. */
function retiringGatesOf(cell: string): string[] {
	return [
		...new Set(
			[...withoutCode(cell).matchAll(/retiring \(([A-Z][A-Z0-9_]*)/g)].map(
				(match) => `toggle/${match[1]}`,
			),
		),
	].sort();
}

function slotDirectionsOf(cell: string): string[] {
	return [
		...withoutCode(cell).matchAll(/(^|[^\w-])(widen|narrow)(?![\w-])/g),
	].map((match) => match[2] ?? "");
}

/**
 * HELD rows whose slot changes do not follow their direction words one to
 * one: after its `narrow:`, the Connect Learn Module row goes on to list
 * widenings (id lengths, a display condition per block, and the rest).
 */
const SLOT_DIRECTIONS_BY_ROW: Readonly<Record<string, readonly string[]>> = {
	"questions.md:125": ["widen", "narrow", "widen"],
};

function slotChangeProblems(
	entry: Extract<InventoryEntry, { disposition: "HELD" }>,
	cell: string,
	where: string,
): string[] {
	const problems: string[] = [];
	const directions = SLOT_DIRECTIONS_BY_ROW[where] ?? slotDirectionsOf(cell);
	const entryDirections = entry.slotChanges.map((change) => change.direction);
	if (directions.join() !== entryDirections.join())
		problems.push(`slot changes [${entryDirections}], row [${directions}]`);
	let from = 0;
	for (const change of entry.slotChanges) {
		const at = cell.indexOf(change.text, from);
		if (at === -1)
			problems.push(
				`the slot change "${change.text}" is not in the row after the change before it`,
			);
		else from = at + change.text.length;
		if (/^[(:]/.test(change.text))
			problems.push(
				`the slot change "${change.text}" opens with the row's punctuation`,
			);
		if (change.scope !== undefined && !cell.includes(change.scope))
			problems.push(`the slot scope "${change.scope}" is not in the row`);
	}
	return problems;
}

function checkInventory(): Map<InventoryArea, InventoryEntry[]> {
	const byArea = new Map<InventoryArea, InventoryEntry[]>();
	let rowsSeen = 0;
	let entriesSeen = 0;
	let rowMismatches = 0;
	let slotChanges = 0;
	let retiringReasons = 0;
	const exportUse: string[] = [];
	for (const area of INVENTORY_AREAS) {
		const parsed = inventoryEntriesFileSchema.safeParse(
			readJson(`${area}.json`),
		);
		if (!parsed.success) {
			check(`schema ${area}.json`, false, parsed.error.message);
			continue;
		}
		const entries = parsed.data.filter((entry) => entry.origin === undefined);
		exportUse.push(
			...parsed.data
				.filter((entry) => entry.origin === "export-use")
				.map((entry) => `${entry.id} (${entry.disposition})`),
		);
		byArea.set(area, entries);
		entriesSeen += entries.length;
		const matched = new Set<string>();
		const { rows } = tableRows(`${area}.md`);
		for (const row of rows) {
			const [
				item = "",
				disposition = "",
				platformCell = "",
				emissionCell = "",
			] = row.cells;
			if (row.cells.length !== 4) {
				mismatch(`${area}.md:${row.line} has ${row.cells.length} cells`);
				rowMismatches += 1;
				continue;
			}
			if (disposition.startsWith("→")) continue;
			rowsSeen += 1;
			const where = `${area}.md:${row.line}`;
			const candidates = entries.filter((entry) => entry.item === item);
			const entry = candidates[0];
			if (candidates.length !== 1 || !entry) {
				mismatch(
					`${where}: ${candidates.length} entries hold the item "${item}"`,
				);
				rowMismatches += 1;
				continue;
			}
			matched.add(entry.id);
			const problems: string[] = [];
			const rowDisposition = DISPOSITION_OF_ROW.exec(disposition)?.[1];
			if (entry.disposition !== rowDisposition)
				problems.push(
					`disposition ${entry.disposition}, row ${rowDisposition}`,
				);
			if (entry.dispositionCell !== disposition)
				problems.push("disposition cell differs");
			if (entry.platforms.cell !== platformCell)
				problems.push("platform cell differs");
			if (entry.emission.cell !== emissionCell)
				problems.push("emission cell differs");
			if (entry.section !== row.section)
				problems.push(`section "${entry.section}", row "${row.section}"`);
			if (entry.subsection !== row.subsection)
				problems.push(
					`subsection "${entry.subsection}", row "${row.subsection}"`,
				);
			const platformProblem = platformsAgree(entry, platformCell);
			if (platformProblem) problems.push(platformProblem);
			const markers = markersOf(emissionCell);
			const entryMarkers = [...entry.emission.markers].sort();
			if (markers.join() !== entryMarkers.join())
				problems.push(`markers [${entryMarkers}], row [${markers}]`);
			if (entry.disposition === "HELD") {
				slotChanges += entry.slotChanges.length;
				problems.push(...slotChangeProblems(entry, disposition, where));
			}
			if (entry.disposition === "REFUSED") {
				const kinds = reasonKindsOf(disposition);
				const entryKinds = [
					...new Set(entry.reasons.map((reason) => reason.kind)),
				].sort();
				if (kinds.join() !== entryKinds.join())
					problems.push(`reasons [${entryKinds}], row [${kinds}]`);
				for (const reason of entry.reasons)
					for (const part of [reason.named, reason.condition])
						if (part !== undefined && !disposition.includes(part))
							problems.push(`the reason text "${part}" is not in the row`);
				const retiring = entry.reasons.flatMap((reason) =>
					reason.kind === "retiring" ? [reason.gate] : [],
				);
				retiringReasons += retiring.length;
				const rowRetiring = retiringGatesOf(disposition);
				if ([...new Set(retiring)].sort().join() !== rowRetiring.join())
					problems.push(`retiring gates [${retiring}], row [${rowRetiring}]`);
			}
			if (problems.length > 0) {
				rowMismatches += 1;
				mismatch(`${where} (${entry.id}): ${problems.join("; ")}`);
			}
		}
		const unmatched = entries.filter((entry) => !matched.has(entry.id));
		for (const entry of unmatched)
			mismatch(`${entry.id} matches no counted row of ${area}.md`);
		if (unmatched.length > 0) rowMismatches += unmatched.length;
	}
	check(
		"inventory rows",
		rowMismatches === 0 && rowsSeen === entriesSeen,
		`${rowsSeen} counted rows, ${entriesSeen} row entries, ${slotChanges} slot changes, ${retiringReasons} retiring reasons, ${rowMismatches} mismatched`,
	);
	report.push(
		`note entries for items Nova's exports use that no row covers, for review (${exportUse.length}): ${exportUse.join(", ")}`,
	);
	return byArea;
}

function checkCounts(byArea: Map<InventoryArea, InventoryEntry[]>): void {
	const { rows } = tableRows("README.md");
	const countRows = rows.filter((row) => row.section === "Counts");
	const order = [
		"HELD",
		"HELD-NEW",
		"TARGET-OWNED",
		"INERT",
		"REFUSED",
	] as const;
	const computed = new Map<string, number[]>();
	for (const entries of byArea.values())
		for (const entry of entries) {
			const counts = computed.get(entry.section) ?? [0, 0, 0, 0, 0, 0];
			const index = order.indexOf(entry.disposition);
			counts[index] = (counts[index] ?? 0) + 1;
			counts[5] = (counts[5] ?? 0) + 1;
			computed.set(entry.section, counts);
		}
	const total = [0, 0, 0, 0, 0, 0];
	for (const counts of computed.values())
		counts.forEach((count, index) => {
			total[index] = (total[index] ?? 0) + count;
		});
	const numbers = (cells: string[]): number[] =>
		cells
			.slice(1)
			.map((cell) => Number(cell.replaceAll("*", "").replaceAll(",", "")));
	let areaRows = 0;
	for (const row of countRows) {
		const name = (row.cells[0] ?? "").replaceAll("*", "");
		const expected = numbers(row.cells);
		const actual = name === "Total" ? total : computed.get(name);
		if (name !== "Total") areaRows += 1;
		check(
			`count ${name}`,
			actual !== undefined && actual.join() === expected.join(),
			`README ${expected.join("/")}, entries ${actual?.join("/") ?? "none"}`,
		);
	}
	check(
		"count areas",
		areaRows === computed.size &&
			countRows.some((row) => row.cells[0] === "**Total**"),
		`${areaRows} README areas and a Total row, ${computed.size} entry sections`,
	);
}

// ---------------------------------------------------------------------------
// Gate entries

const CLASS_LABELS: Record<string, string> = {
	"target-owned": "TARGET-OWNED",
	retiring: "RETIRING",
	inert: "INERT",
	removed: "REMOVED",
	adjacent: "adjacent",
	"no-field-of-their-own": "no field of their own",
};

function classLabel(gate: GateEntry): string {
	if (gate.class.kind === "now")
		return `now ${gate.class.gate.slice(gate.class.gate.indexOf("/") + 1)}`;
	return CLASS_LABELS[gate.class.kind] ?? gate.class.kind;
}

function symbolsOfRow(table: string, item: string): string[] {
	if (table === "App-building toggles") return [item.split(" ")[0] ?? ""];
	const outside =
		table === "Privileges" ? item : item.replace(/\([^)]*\)/g, "");
	return [...outside.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

/** A table row's preflight kinds, each by the words of the cell that give it. */
function rowPreflightKinds(
	cell: string,
	privilegeKind: (slug: string) => string | undefined,
): string[] {
	const clauses = cell.split("; ");
	const leads = clauses.map(
		(clause) => clause.split(/:|,| \(/)[0]?.trim() ?? "",
	);
	const kinds = new Set<string>();
	if (["none", "drop", "not a publish precondition"].includes(leads[0] ?? ""))
		kinds.add("none");
	if (leads.some((lead) => lead === "refuse" || lead.startsWith("refuse ")))
		kinds.add("refusal");
	if (cell.includes("confirmed at publish")) kinds.add("confirmation");
	const privilege = /^privilege `([a-z_]+)`/.exec(cell)?.[1];
	if (privilege) {
		const kind = privilegeKind(privilege);
		kinds.add(kind ?? `the kind of privilege ${privilege}, which has none`);
	}
	if (leads[0] === "precondition" || leads[0]?.startsWith("precondition "))
		kinds.add("precondition");
	if (/^[A-Z][A-Z0-9_]*$/.test(cell)) kinds.add("precondition");
	return [...kinds];
}

/** The gates a table row's preflight cell requires, and how. */
function rowPreflightRequires(
	cell: string,
	selfId: string,
): { operator: string; gates: string[] } | undefined {
	const gates: string[] = [];
	const privilege = /^privilege `([a-z_]+)`/.exec(cell)?.[1];
	if (privilege) gates.push(`privilege/${privilege}`);
	for (const match of withoutCode(cell).matchAll(FLAG_CONSTANT))
		gates.push(`toggle/${match[0]}`);
	const setting = /\(\+ `([A-Za-z]+\.[a-z_]+)`\)/.exec(cell)?.[1];
	if (setting) gates.push(`project-space-setting/${setting}`);
	if (gates.length === 0) return undefined;
	const addsToSelf = /\((?:\+|or) /.test(cell);
	if (addsToSelf && !gates.includes(selfId)) gates.unshift(selfId);
	return {
		operator: /(?:^|[ (])or /.test(withoutCode(cell)) ? "any" : "all",
		gates,
	};
}

function preflightProblems(
	gate: GateEntry,
	kinds: string[],
	requires: { operator: string; gates: string[] } | undefined,
): string[] {
	const problems: string[] = [];
	if (kinds.length !== 1 || kinds[0] !== gate.preflight.kind)
		problems.push(
			`preflight ${gate.preflight.kind}, the cell gives [${kinds.join(", ")}]`,
		);
	const actual = gate.preflight.requires;
	const same =
		actual === undefined
			? requires === undefined
			: requires !== undefined &&
				actual.operator === requires.operator &&
				[...actual.gates].sort().join() === [...requires.gates].sort().join();
	if (!same)
		problems.push(
			`requires ${JSON.stringify(actual ?? null)}, the cell gives ${JSON.stringify(requires ?? null)}`,
		);
	return problems;
}

const PUBLISH_CHECK_NAMES: ReadonlyArray<[string, string]> = [
	["`VIEW_FORM_ATTACHMENT`", "VIEW_FORM_ATTACHMENT"],
	["`CaseSearchConfig.enabled`", "CaseSearchConfig.enabled"],
	["sync on form entry", "CaseSearchConfig.sync_cases_on_form_entry"],
	["flat location fixture", "LocationFixtureConfiguration.sync_flat_fixture"],
	["CommTrack is off", "Domain.commtrack_enabled"],
];

interface BuildVersionName {
	phrase: string;
	kind: string | undefined;
	version: string | undefined;
	direct: boolean;
}

/**
 * The direct checks the Build versions paragraph lists by where they sit
 * that are no gate of their own: the settings page's per-setting `since`
 * gates are each setting's own `since` value.
 */
const DIRECT_CHECKS_OF_SETTINGS = [
	"the settings page's per-setting `since` gates",
	"`commcare_settings.js` `versionOK`",
];

/** The Build versions paragraph's named gates: phrase, class and version. */
function buildVersionNames(paragraph: string): BuildVersionName[] {
	const names: BuildVersionName[] = [];
	const add = (
		phrase: string,
		kind: string | undefined,
		version: string | undefined,
		direct = false,
	): void => {
		names.push({ phrase, kind, version, direct });
	};
	const directStart = paragraph.indexOf("direct checks in ");
	const directList = paragraph.slice(
		directStart + "direct checks in ".length,
		paragraph.indexOf(")", directStart),
	);
	for (const phrase of directList.split(/, and |, | and /))
		if (!DIRECT_CHECKS_OF_SETTINGS.includes(phrase.trim()))
			add(phrase.trim(), undefined, undefined, true);
	for (const [label, kind] of [
		["Generation gates", "generation"],
		["Authoring gates", "authoring"],
	] as const) {
		const afterLabel = paragraph.slice(paragraph.indexOf(`${label},`));
		const body =
			afterLabel.slice(afterLabel.indexOf(": ") + 2).split(/\. (?=[A-Z])/)[0] ??
			"";
		for (const clause of body.split(" · ")) {
			const plain = clause
				.replace(/\([^()]*(\([^()]*\)[^()]*)*\)/g, "")
				.replace(/\s+/g, " ")
				.trim();
			const version = plain.match(/(\d+(?:\.\d+)+)$/)?.[1];
			const features = plain
				.replace(/\s*\d+(?:\.\d+)+$/, "")
				.split(/,? and |, /)
				.map((feature) => feature.trim())
				.filter(Boolean);
			for (const phrase of features) add(phrase, kind, version);
		}
	}
	const failing = paragraph.match(
		/: ([a-z ]+) below (\d+(?:\.\d+)+) are a build error/,
	);
	if (failing?.[1]) add(failing[1], "build-error", failing[2]);
	const display = paragraph.match(
		/([A-Z][a-z-]+ [a-z ]+) (\d+(?:\.\d+)+) gates only a display/,
	);
	if (display?.[1]) add(display[1], "display-only", display[2]);
	const offline = paragraph.match(
		/(\d+(?:\.\d+)+) \(([a-z ]+), which also needs it, affects only the releases page\)/,
	);
	if (offline?.[2]) add(offline[2], "display-only", offline[1]);
	const disabled = paragraph.match(
		/\((the [a-z ]+ gate) is disabled at every version\)/,
	);
	if (disabled?.[1]) add(disabled[1], "disabled", undefined);
	return names;
}

function checkGates(
	inventory: Map<InventoryArea, InventoryEntry[]>,
): GateEntry[] {
	const parsed = gateEntriesFileSchema.safeParse(readJson("gates.json"));
	if (!parsed.success) {
		check("schema gates.json", false, parsed.error.message);
		return [];
	}
	const gates = parsed.data;
	const byId = new Map(gates.map((gate) => [gate.id, gate]));
	const { rows, lines } = tableRows("gates.md");

	const privilegeKinds = new Map<string, string | undefined>();
	for (const row of rows)
		if (row.subsection === "Privileges")
			for (const slug of symbolsOfRow("Privileges", row.cells[0] ?? "")) {
				const kinds = rowPreflightKinds(row.cells[3] ?? "", () => undefined);
				privilegeKinds.set(slug, kinds.length === 1 ? kinds[0] : undefined);
			}

	let rowMismatches = 0;
	const matched = new Set<string>();
	for (const row of rows) {
		const [item = "", gateCell = "", platformCell = "", preflightCell = ""] =
			row.cells;
		const where = `gates.md:${row.line}`;
		const candidates = gates.filter(
			(gate) => gate.source.kind === "row" && gate.source.line === row.line,
		);
		const gate = candidates[0];
		if (candidates.length !== 1 || !gate) {
			mismatch(
				`${where}: ${candidates.length} gate entries come from this row`,
			);
			rowMismatches += 1;
			continue;
		}
		matched.add(gate.id);
		const problems: string[] = [];
		const table = row.subsection ?? "";
		if (gate.item !== item) problems.push("item differs");
		const rebuilt =
			gate.content === undefined
				? classLabel(gate)
				: `${classLabel(gate)} · ${gate.content}`;
		if (rebuilt !== gateCell)
			problems.push(`class and content "${rebuilt}" differ from "${gateCell}"`);
		if (gate.platforms !== platformCell) problems.push("platform cell differs");
		if (gate.preflight.cell !== preflightCell)
			problems.push("preflight cell differs");
		const symbols = symbolsOfRow(table, item);
		if (symbols.join() !== gate.symbols.join())
			problems.push(`symbols [${gate.symbols}], row [${symbols}]`);
		const expectedKind = {
			"App-building toggles": "toggle",
			"Removed toggles with document residue": "removed-toggle",
			Privileges: "privilege",
		}[table];
		if (gate.kind !== expectedKind)
			problems.push(`kind ${gate.kind} under "${table}"`);
		problems.push(
			...preflightProblems(
				gate,
				rowPreflightKinds(preflightCell, (slug) => privilegeKinds.get(slug)),
				rowPreflightRequires(preflightCell, gate.id),
			),
		);
		if (problems.length > 0) {
			rowMismatches += 1;
			mismatch(`${where} (${gate.id}): ${problems.join("; ")}`);
		}
	}
	const unmatchedRows = gates.filter(
		(gate) => gate.source.kind === "row" && !matched.has(gate.id),
	);
	for (const gate of unmatchedRows)
		mismatch(`${gate.id} names a row the gates file does not have`);
	const tables = new Map<string, number>();
	for (const row of rows)
		tables.set(
			row.subsection ?? "",
			(tables.get(row.subsection ?? "") ?? 0) + 1,
		);
	check(
		"gate rows",
		rowMismatches === 0 &&
			unmatchedRows.length === 0 &&
			matched.size === rows.length,
		`${rows.length} rows (${[...tables].map(([table, count]) => `${table} ${count}`).join(", ")}), ${matched.size} row-sourced gate entries with their preflight kinds and links, ${rowMismatches + unmatchedRows.length} mismatched`,
	);

	const publishIndex = lines.findIndex((line) =>
		line.startsWith("Publish also checks gates"),
	);
	const publishParagraph = lines[publishIndex] ?? "";
	const publishClauses = publishParagraph.split("; ");
	const publishGates = gates.filter(
		(gate) =>
			gate.source.kind === "paragraph" &&
			gate.source.paragraph === "publish-checks",
	);
	const publishProblems: string[] = [];
	for (const [phrase, symbol] of PUBLISH_CHECK_NAMES) {
		if (!publishParagraph.includes(phrase))
			publishProblems.push(`the paragraph no longer names ${phrase}`);
		const found = publishGates.filter((gate) => gate.symbols.includes(symbol));
		if (found.length !== 1)
			publishProblems.push(`${found.length} entries for ${symbol}`);
	}
	for (const gate of publishGates) {
		if (gate.source.line !== publishIndex + 1)
			publishProblems.push(`${gate.id} names line ${gate.source.line}`);
		if (gate.class.kind !== "publish-check")
			publishProblems.push(`${gate.id} is ${gate.class.kind}`);
		for (const part of [gate.item, gate.content, gate.preflight.cell])
			if (part !== undefined && !publishParagraph.includes(part))
				publishProblems.push(`${gate.id}: "${part}" is not in the paragraph`);
		// The paragraph's clauses are separated by "; ", and the ones that
		// ask the person say "to confirm".
		const clause = publishClauses.find((text) => text.includes(gate.item));
		if (!clause) {
			publishProblems.push(`${gate.id}: no clause names "${gate.item}"`);
			continue;
		}
		if (!clause.includes(gate.preflight.cell))
			publishProblems.push(
				`${gate.id}: its preflight cell is not in the clause that names it`,
			);
		const kind = clause.includes("to confirm")
			? "confirmation"
			: "precondition";
		if (gate.preflight.kind !== kind || gate.preflight.requires)
			publishProblems.push(
				`${gate.id}: preflight ${gate.preflight.kind}, the clause gives ${kind}`,
			);
	}
	check(
		"publish-check gates",
		publishProblems.length === 0 &&
			publishGates.length === PUBLISH_CHECK_NAMES.length,
		publishProblems.length === 0
			? `${publishGates.length} entries from gates.md:${publishIndex + 1}, each with the preflight its clause gives`
			: publishProblems.join("; "),
	);

	const buildIndex = lines.findIndex((line) =>
		line.startsWith("Every version check in HQ is a minimum"),
	);
	const buildParagraph = lines[buildIndex] ?? "";
	const buildGates = gates.filter((gate) => gate.kind === "build-version");
	const names = buildVersionNames(buildParagraph);
	const buildProblems: string[] = [];
	const covering = new Map<string, number>();
	for (const name of names) {
		const found = buildGates.filter((gate) =>
			name.direct
				? gate.item === name.phrase ||
					(gate.content ?? "").includes(`(${name.phrase})`)
				: new RegExp(
						`(^| )${name.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`,
					).test(gate.item),
		);
		const gate = found[0];
		if (found.length !== 1 || !gate || gate.kind !== "build-version") {
			buildProblems.push(`${found.length} entries name "${name.phrase}"`);
			continue;
		}
		covering.set(gate.id, (covering.get(gate.id) ?? 0) + 1);
		if (name.kind !== undefined && gate.class.kind !== name.kind)
			buildProblems.push(
				`${gate.id} is ${gate.class.kind}, the paragraph ${name.kind}`,
			);
		if (!name.direct && gate.minimumVersion !== name.version)
			buildProblems.push(
				`${gate.id} is ${gate.minimumVersion}, the paragraph ${name.version}`,
			);
	}
	for (const gate of buildGates) {
		if (!covering.has(gate.id))
			buildProblems.push(`${gate.id} is a gate the paragraph does not name`);
		if (gate.source.kind !== "paragraph" || gate.source.line !== buildIndex + 1)
			buildProblems.push(`${gate.id} names another source`);
		for (const part of [gate.item, gate.content, gate.preflight.cell])
			if (part !== undefined && !buildParagraph.includes(part))
				buildProblems.push(`${gate.id}: "${part}" is not in the paragraph`);
		if (
			gate.preflight.kind !== "none" ||
			gate.preflight.requires ||
			!gate.preflight.cell.includes("no row carries a version precondition")
		)
			buildProblems.push(
				`${gate.id}: its preflight is not the paragraph's none`,
			);
		// A function under `views/` is an editor's; any other builds the app.
		for (const symbol of gate.symbols)
			if (symbol.includes("::")) {
				const kind = symbol.startsWith("views/") ? "authoring" : "generation";
				if (gate.class.kind !== kind)
					buildProblems.push(
						`${gate.id} is ${gate.class.kind}, but ${symbol} is ${kind}`,
					);
			}
	}
	check(
		"build-version gates",
		buildProblems.length === 0,
		buildProblems.length === 0
			? `${names.length} names in gates.md:${buildIndex + 1} (${names.filter((name) => name.direct).length} of them direct checks), covered by ${buildGates.length} entries; the per-setting \`since\` gates are the settings' own`
			: buildProblems.join("; "),
	);

	const links: Array<[string, string]> = [];
	const retiringTargets: Array<[string, string]> = [];
	for (const gate of gates) {
		if (gate.class.kind === "now") links.push([gate.id, gate.class.gate]);
		for (const required of gate.preflight.requires?.gates ?? [])
			links.push([gate.id, required]);
	}
	for (const entries of inventory.values())
		for (const entry of entries) {
			for (const gate of entry.gates) links.push([entry.id, gate]);
			if (entry.disposition === "REFUSED")
				for (const reason of entry.reasons)
					if (reason.kind === "retiring") {
						links.push([entry.id, reason.gate]);
						retiringTargets.push([entry.id, reason.gate]);
					}
		}
	const dangling = links.filter(([, target]) => !byId.has(target));
	check(
		"gate links",
		dangling.length === 0,
		dangling.length === 0
			? `${links.length} links, all to gate entries`
			: dangling.map(([from, target]) => `${from} → ${target}`).join("; "),
	);
	const notRetiring = retiringTargets.filter(([, target]) => {
		const gate = byId.get(target);
		return gate && (gate.kind !== "toggle" || gate.class.kind !== "retiring");
	});
	check(
		"retiring links",
		notRetiring.length === 0,
		notRetiring.length === 0
			? `${retiringTargets.length} retiring reasons, each linking a RETIRING toggle`
			: notRetiring.map(([from, target]) => `${from} → ${target}`).join("; "),
	);
	check(
		"gate total",
		gates.length === rows.length + publishGates.length + buildGates.length,
		`${gates.length} gate entries = ${rows.length} rows + ${publishGates.length} publish checks + ${buildGates.length} build versions`,
	);
	return gates;
}

// ---------------------------------------------------------------------------
// The gates against commcare-hq at the pin

/**
 * Reads the facts the gates rest on from the checkout, by AST: the toggle
 * registry, the privilege slugs, `CommCareFeatureSupportMixin`'s properties,
 * every comparison of a `build_version` with a `LooseVersion` in the app
 * manager (tests and migrations aside) with the literal versions it holds,
 * and the settings' fields.
 */
const SOURCE_FACTS = `
import ast, json, os, sys

hq = sys.argv[1]
request = json.loads(sys.argv[2])
APP_MANAGER = "corehq/apps/app_manager"


def parse(relative):
    with open(os.path.join(hq, relative), encoding="utf-8") as handle:
        return ast.parse(handle.read(), filename=relative)


def string(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def find_class(tree, name):
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node
    return None


toggle_module = parse("corehq/toggles/__init__.py")
toggle_classes = {"StaticToggle"}
grew = True
while grew:
    grew = False
    for node in toggle_module.body:
        if (isinstance(node, ast.ClassDef) and node.name not in toggle_classes
                and any(isinstance(base, ast.Name) and base.id in toggle_classes
                        for base in node.bases)):
            toggle_classes.add(node.name)
            grew = True
toggles = {}
for node in toggle_module.body:
    if not (isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id in toggle_classes):
        continue
    call = node.value
    keywords = {keyword.arg: keyword.value for keyword in call.keywords}
    positional = call.args
    if call.func.id == "FrozenPrivilegeToggle" and "privilege_slug" not in keywords:
        positional = call.args[1:]
    if "slug" in keywords:
        slug = string(keywords["slug"])
    else:
        slug = string(positional[0]) if positional else None
    toggles[node.targets[0].id] = {"class": call.func.id, "slug": slug}

privileges = sorted({string(node.value) for node in parse("corehq/privileges.py").body
                     if isinstance(node, ast.Assign) and string(node.value) is not None})

mixin = find_class(parse(APP_MANAGER + "/feature_support.py"), "CommCareFeatureSupportMixin")
properties = [node for node in mixin.body if isinstance(node, ast.FunctionDef) and any(
    isinstance(decorator, ast.Name) and decorator.id == "property"
    for decorator in node.decorator_list)]
property_names = {node.name for node in properties}
features = {}
for node in properties:
    minimums, references, returns_false = [], [], False
    for inner in ast.walk(node):
        if (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute)
                and inner.func.attr == "_require_minimum_version" and inner.args):
            minimums.append(string(inner.args[0]))
        elif (isinstance(inner, ast.Attribute) and isinstance(inner.value, ast.Name)
                and inner.value.id == "self" and inner.attr in property_names):
            references.append(inner.attr)
        elif (isinstance(inner, ast.Return) and isinstance(inner.value, ast.Constant)
                and inner.value.value is False):
            returns_false = True
    features[node.name] = {
        "minimums": minimums, "references": references, "returnsFalse": returns_false,
    }


def compared_versions(compare):
    """The literal versions a comparison of a build_version with a
    LooseVersion holds, or None where it is no such comparison."""
    operands = [compare.left, *compare.comparators]
    nodes = [node for operand in operands for node in ast.walk(operand)]
    reads = any(isinstance(node, ast.Attribute) and node.attr == "build_version"
                for node in nodes)
    calls = [node for node in nodes if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Name) and node.func.id == "LooseVersion"]
    if not (reads and calls):
        return None
    return [string(call.args[0]) for call in calls
            if call.args and string(call.args[0]) is not None]


comparisons = {}


def visit(node, relative, scope):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            visit(child, relative, [*scope, child.name])
            continue
        if isinstance(child, ast.Compare):
            versions = compared_versions(child)
            if versions is not None:
                key = relative + "::" + ".".join(scope)
                comparisons.setdefault(key, []).extend(versions)
        visit(child, relative, scope)


root = os.path.join(hq, APP_MANAGER)
for directory, subdirectories, files in os.walk(root):
    subdirectories[:] = sorted(name for name in subdirectories
                               if name not in ("tests", "migrations"))
    for name in sorted(files):
        if name.endswith(".py"):
            relative = os.path.relpath(os.path.join(directory, name), root)
            if relative == "feature_support.py":
                continue
            visit(parse(os.path.join(APP_MANAGER, relative)), relative, [])

fields = {}
for symbol, relative in request["fields"].items():
    class_name, field = symbol.split(".")
    node = find_class(parse(relative), class_name)
    value = None
    for statement in node.body if node else []:
        if isinstance(statement, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == field
                for target in statement.targets):
            value = statement.value
    if value is None:
        fields[symbol] = None
        continue
    default = None
    if isinstance(value, ast.Call):
        default = next((keyword.value for keyword in value.keywords
                        if keyword.arg == "default"), None)
    fields[symbol] = {"default": ast.unparse(default) if default is not None else None}

print(json.dumps({
    "toggles": toggles, "privileges": privileges, "features": features,
    "comparisons": comparisons, "fields": fields,
}))
`;

interface SourceFacts {
	toggles: Record<string, { class: string; slug: string | null }>;
	privileges: string[];
	features: Record<
		string,
		{ minimums: string[]; references: string[]; returnsFalse: boolean }
	>;
	comparisons: Record<string, string[]>;
	fields: Record<string, { default: string | null } | null>;
}

/** The files that define the project-space settings' classes. */
const SETTING_FILES: Readonly<Record<string, string>> = {
	CaseSearchConfig: "corehq/apps/case_search/models.py",
	LocationFixtureConfiguration: "corehq/apps/locations/models.py",
	Domain: "corehq/apps/domain/models.py",
};

/** The one direct comparison that is no gate: each setting's own `since`. */
const SETTING_SINCE_COMPARISON =
	"models/applications.py::Application.get_profile_setting";

/** Nova's CommCare version floor, which the paragraph says no gate exceeds. */
const NOVA_VERSION_FLOOR = "2.57";

function compareVersions(left: string, right: string): number {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function checkSource(gates: GateEntry[], hq: string): void {
	const pins = JSON.parse(
		readFileSync(path.join(repoRoot, "proof/pins.json"), "utf8"),
	) as Record<string, { commit: string }>;
	const pin = pins["commcare-hq"]?.commit ?? "";
	let head: string;
	try {
		head = execFileSync("git", ["-C", hq, "rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		check(
			"source commit",
			false,
			`could not read the commit of ${hq}, so the gates were not checked against commcare-hq; is it a commcare-hq checkout? (${error instanceof Error ? error.message.split("\n")[0] : error})`,
		);
		return;
	}
	check(
		"source commit",
		head === pin,
		`the checkout is at ${head}, the pin ${pin}`,
	);
	if (head !== pin) return;

	const settingSymbols = gates
		.filter((gate) => gate.kind === "project-space-setting")
		.flatMap((gate) => gate.symbols);
	const request = {
		fields: Object.fromEntries(
			settingSymbols.map((symbol) => [
				symbol,
				SETTING_FILES[symbol.split(".")[0] ?? ""] ?? "",
			]),
		),
	};
	let facts: SourceFacts;
	try {
		facts = JSON.parse(
			execFileSync(
				"python3",
				["-c", SOURCE_FACTS, hq, JSON.stringify(request)],
				{
					encoding: "utf8",
					maxBuffer: 16 * 1024 * 1024,
					stdio: ["ignore", "pipe", "pipe"],
				},
			),
		) as SourceFacts;
	} catch (error) {
		const stderr =
			error instanceof Error && "stderr" in error ? String(error.stderr) : "";
		check(
			"source facts",
			false,
			`python3 could not read the gates' facts from ${hq}, so they were not checked; its last words: ${stderr.trim().split("\n").at(-1) ?? error}`,
		);
		return;
	}

	const toggleProblems: string[] = [];
	let slugsShown = 0;
	const toggleGates = gates.filter((gate) => gate.kind === "toggle");
	for (const gate of toggleGates) {
		const symbol = gate.symbols[0] ?? "";
		const found = facts.toggles[symbol];
		if (!found) {
			toggleProblems.push(`${symbol} is not in the toggle registry`);
			continue;
		}
		if (gate.kind === "toggle" && found.class !== gate.hqToggleClass)
			toggleProblems.push(
				`${symbol} is a ${found.class}, the entry ${gate.hqToggleClass}`,
			);
		const shown = /^[A-Z0-9_]+ \(`([^`]+)`\)/.exec(gate.item)?.[1];
		if (shown !== undefined) {
			slugsShown += 1;
			if (shown !== found.slug)
				toggleProblems.push(
					`${symbol}'s slug is ${found.slug}, the row's ${shown}`,
				);
		}
	}
	check(
		"source toggles",
		toggleProblems.length === 0,
		toggleProblems.length === 0
			? `${toggleGates.length} toggle gates are in corehq/toggles/__init__.py with their HQ class (${slugsShown} with the slug the row shows)`
			: toggleProblems.join("; "),
	);

	const registrySlugs = new Set(
		Object.values(facts.toggles).map((toggle) => toggle.slug),
	);
	const removed = gates
		.filter((gate) => gate.kind === "removed-toggle")
		.flatMap((gate) => gate.symbols);
	const stillThere = removed.filter((slug) => registrySlugs.has(slug));
	check(
		"source removed toggles",
		stillThere.length === 0,
		stillThere.length === 0
			? `none of ${removed.length} removed slugs is a toggle`
			: `still toggles: ${stillThere.join(", ")}`,
	);

	const privileges = new Set(facts.privileges);
	const privilegeSlugs = gates
		.filter((gate) => gate.kind === "privilege")
		.flatMap((gate) => gate.symbols);
	const unknownPrivileges = privilegeSlugs.filter(
		(slug) => !privileges.has(slug),
	);
	check(
		"source privileges",
		unknownPrivileges.length === 0,
		unknownPrivileges.length === 0
			? `${privilegeSlugs.length} privilege slugs are in corehq/privileges.py`
			: `not privileges: ${unknownPrivileges.join(", ")}`,
	);

	const missingFields = settingSymbols.filter(
		(symbol) => !facts.fields[symbol],
	);
	check(
		"source settings",
		missingFields.length === 0,
		missingFields.length === 0
			? settingSymbols
					.map(
						(symbol) =>
							`${symbol} (default ${facts.fields[symbol]?.default ?? "none"})`,
					)
					.join(", ")
			: `no such field: ${missingFields.join(", ")}`,
	);

	const effectiveMinimum = (
		name: string,
		seen: Set<string> = new Set(),
	): string | undefined => {
		const feature = facts.features[name];
		if (!feature || seen.has(name)) return undefined;
		seen.add(name);
		const versions = [
			...feature.minimums,
			...feature.references.flatMap((reference) => {
				const version = effectiveMinimum(reference, seen);
				return version === undefined ? [] : [version];
			}),
		];
		return versions.sort(compareVersions).at(-1);
	};
	const buildGates = gates.filter((gate) => gate.kind === "build-version");
	const versionProblems: string[] = [];
	const gateSymbols = new Set<string>();
	for (const gate of buildGates) {
		if (gate.kind !== "build-version") continue;
		for (const symbol of gate.symbols) {
			gateSymbols.add(symbol);
			let versions: string[];
			if (symbol.includes("::")) versions = facts.comparisons[symbol] ?? [];
			else {
				const feature = facts.features[symbol];
				if (!feature) {
					versionProblems.push(
						`${symbol} is not a CommCareFeatureSupportMixin property`,
					);
					continue;
				}
				const minimum = effectiveMinimum(symbol);
				versions = minimum === undefined ? [] : [minimum];
				if (gate.class.kind === "disabled" && !feature.returnsFalse)
					versionProblems.push(`${symbol} does not return False`);
			}
			const expected =
				gate.class.kind === "disabled" ? [] : [gate.minimumVersion ?? ""];
			if ([...new Set(versions)].join() !== expected.join())
				versionProblems.push(
					`${symbol} compares with [${versions}], the entry [${expected}]`,
				);
		}
		if (
			gate.minimumVersion !== undefined &&
			compareVersions(gate.minimumVersion, NOVA_VERSION_FLOOR) > 0
		)
			versionProblems.push(`${gate.id} is above ${NOVA_VERSION_FLOOR}`);
	}
	const ungatedProperties = Object.keys(facts.features).filter(
		(name) => !gateSymbols.has(name),
	);
	const ungatedComparisons = Object.keys(facts.comparisons).filter(
		(name) => name !== SETTING_SINCE_COMPARISON && !gateSymbols.has(name),
	);
	for (const name of [...ungatedProperties, ...ungatedComparisons])
		versionProblems.push(`${name} is no build-version gate`);
	const sinceVersions = facts.comparisons[SETTING_SINCE_COMPARISON];
	if (sinceVersions === undefined || sinceVersions.length > 0)
		versionProblems.push(
			`${SETTING_SINCE_COMPARISON} no longer compares with each setting's own \`since\` alone`,
		);
	check(
		"source build versions",
		versionProblems.length === 0,
		versionProblems.length === 0
			? `${Object.keys(facts.features).length} feature_support.py properties and ${Object.keys(facts.comparisons).length - 1} direct comparisons (with ${SETTING_SINCE_COMPARISON}, each setting's \`since\`, aside) are build-version gates with their minimum versions, none above ${NOVA_VERSION_FLOOR}`
			: versionProblems.join("; "),
	);
}

const hq = hqCheckout();
const inventory = checkInventory();
checkCounts(inventory);
const gates = checkGates(inventory);
if (gates.length > 0) checkSource(gates, hq);
console.log(report.join("\n"));
if (mismatches.length > 0) {
	console.log(`\n${mismatches.length} mismatch(es):`);
	for (const message of mismatches) console.log(`  ${message}`);
	process.exitCode = 1;
} else
	console.log(
		"\nEvery counted inventory row is exactly one entry, every gate is present, and the gates agree with commcare-hq at the pin.",
	);
