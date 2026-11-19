/**
 * The coverage rules over the surface manifest: every entry is shown by an
 * app made in CommCare HQ that comes in (a base's `expected.json` claims it),
 * by a variant of one with its expected finding (a row of
 * `proof/matrix/variants.json`), or exempted with one of five reasons
 * (`proof/matrix/exemptions.json`).
 *
 * Each rule is a pure function of `CoverageInputs` that returns the sentences
 * a person reads, none where the rule holds, so the test runs one function
 * over the repository's files and over planted inputs alike.
 * `repositoryInputs` reads the files; it is the only part that touches the
 * disk.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { KeptRow } from "../keptAtHq";
import type { Disposition, InventoryEntry } from "../schema";
import type { SchemaDefaultReader } from "../schemaDefaults";

// ---------------------------------------------------------------------------
// The inputs
// ---------------------------------------------------------------------------

/** The closed reasons, in the order whose first true reason an entry takes. */
export const EXEMPTION_REASONS = [
	"stated-by-its-part",
	"hq-never-serves-the-value",
	"no-surface-key",
	"not-in-app-source",
	"only-in-a-build",
] as const;
export type ExemptionReason = (typeof EXEMPTION_REASONS)[number];

export interface Exemption {
	readonly reason: string;
	readonly note: string;
}

/** The key families no app's source holds: lookup data, HQ's API and project space settings. */
export const NOT_IN_APP_SOURCE_FAMILIES: readonly string[] = [
	"lookup-model",
	"lookup-workbook",
	"lookup-code",
	"hq-api",
	"project-setting",
];

/** The one family a runtime reads from a build and no app's source holds. */
export const BUILD_FAMILY = "parser";

/** The dispositions that allow what they describe. */
const ALLOWING: ReadonlySet<Disposition> = new Set([
	"HELD",
	"TARGET-OWNED",
	"INERT",
]);

export interface CoverageEntry {
	readonly id: string;
	readonly disposition: Disposition;
	readonly surfaceKeys: readonly string[];
}

/** A row of `proof/matrix/variants.json`, as far as coverage reads it. */
export interface VariantRow {
	readonly id: string;
	readonly base: string;
	readonly entry: string;
	readonly second?: { readonly entry: string };
	/** The findings a row composes beside its second. */
	readonly also?: readonly { readonly entry: string }[];
	readonly hqNeverServes?: Readonly<Record<string, string>>;
}

/** A base's `expected.json`. */
export interface BaseExpectation {
	readonly reads: true;
	readonly declaration: {
		readonly runsOnlyOn: "web-apps" | "android" | null;
		readonly splitDatetime: boolean;
	};
	readonly claimed: readonly string[];
	readonly firstPublish: readonly string[];
}

/** A base under `proof/hq-apps/`: its expectation and the app source HQ answered, parsed. */
export interface RetainedBaseView {
	readonly id: string;
	readonly expected: BaseExpectation;
	readonly source: unknown;
}

/** A registered claim of the reader whose use is `refuse`. */
export interface RefusingClaim {
	readonly claim: string;
	readonly entry: string;
}

export interface CoverageInputs {
	readonly entries: readonly CoverageEntry[];
	/** Every base the lane's registry names (`proof/matrix/bases.json`). */
	readonly namedBases: readonly string[];
	/** The bases `proof/hq-apps/` holds, by id. */
	readonly bases: ReadonlyMap<string, RetainedBaseView>;
	readonly variants: readonly VariantRow[];
	readonly exemptions: Readonly<Record<string, Exemption>>;
	readonly kept: Readonly<Record<string, KeptRow>>;
	/** `FIRST_PUBLISH_CHANGE_IDS`. */
	readonly firstPublishIds: readonly string[];
	/** Every register id a reading can record in `ReadFacts.sameStateRewrites`. */
	readonly registerIds: readonly string[];
	/** The families the lane's manifest check extracts from an app's source. */
	readonly sourceFamilies: readonly string[];
	readonly refusingClaims: readonly RefusingClaim[];
	/** Nova's seed of each profile property it seeds, by key. */
	readonly profileSeeds: ReadonlyMap<string, string>;
	readonly schemaDefault: SchemaDefaultReader;
	/** Whether a path from the checkout's root names a file or directory. */
	readonly fileExists: (path: string) => boolean;
}

// ---------------------------------------------------------------------------
// What the sets are
// ---------------------------------------------------------------------------

function familyOf(key: string): string {
	const colon = key.indexOf(":");
	return colon < 0 ? key : key.slice(0, colon);
}

function namedEntries(row: VariantRow): string[] {
	return [
		row.entry,
		...(row.second === undefined ? [] : [row.second.entry]),
		...(row.also ?? []).map((one) => one.entry),
	];
}

/** Each entry a base's `claimed` lists, with the first base (in id order) that lists it. */
function baseExhibited(inputs: CoverageInputs): Map<string, string> {
	const shown = new Map<string, string>();
	for (const id of [...inputs.bases.keys()].sort())
		for (const entry of inputs.bases.get(id)?.expected.claimed ?? [])
			if (!shown.has(entry)) shown.set(entry, id);
	return shown;
}

/** Each entry a row with no `hqNeverServes` names, with the first such row. */
function variantExhibited(inputs: CoverageInputs): Map<string, string> {
	const shown = new Map<string, string>();
	for (const row of inputs.variants)
		if (row.hqNeverServes === undefined)
			for (const entry of namedEntries(row))
				if (!shown.has(entry)) shown.set(entry, row.id);
	return shown;
}

/** The named bases `proof/hq-apps/` does not hold. */
export function absentBases(inputs: CoverageInputs): string[] {
	return inputs.namedBases.filter((id) => !inputs.bases.has(id));
}

function absentBasesMessage(rule: string, absent: readonly string[]): string {
	return `${rule} reads every base's expected.json, and proof/hq-apps/ lacks ${absent.join(", ")}. A lane run writes each base (proof/matrix/test_retained.py), and python3 -m proof.matrix.adopt copies its output into proof/hq-apps/.`;
}

/**
 * Which of the reasons that can be read off the files are true of an entry,
 * in the closed order. `stated-by-its-part` is a decision, read only from its
 * note, so it is never in the list.
 */
export function trueReasons(
	entry: CoverageEntry,
	neverServed: ReadonlySet<string>,
): ExemptionReason[] {
	const keys = entry.surfaceKeys;
	const reasons: ExemptionReason[] = [];
	if (neverServed.has(entry.id)) reasons.push("hq-never-serves-the-value");
	if (keys.length === 0 && ALLOWING.has(entry.disposition))
		reasons.push("no-surface-key");
	if (
		keys.length > 0 &&
		keys.every((key) => NOT_IN_APP_SOURCE_FAMILIES.includes(familyOf(key)))
	)
		reasons.push("not-in-app-source");
	if (keys.length > 0 && keys.every((key) => familyOf(key) === BUILD_FAMILY))
		reasons.push("only-in-a-build");
	return reasons;
}

/** Paths from the checkout's root a note names: each word under one of the repository's roots. */
export function notePaths(note: string): string[] {
	const roots = [
		"lib/",
		"proof/",
		"app/",
		"components/",
		"docs/",
		"scripts/",
		"__tests__/",
		"e2e/",
	];
	return note
		.split(/\s+/)
		.map((word) => word.replace(/^[(`'"]+|[)`'",.;:]+$/g, ""))
		.filter((word) => roots.some((root) => word.startsWith(root)));
}

// ---------------------------------------------------------------------------
// Rule 1: every entry is in a set or exempt, every file names manifest ids,
// every exemption takes the first reason true of it, and a note names a file
// that exists
// ---------------------------------------------------------------------------

/** Copy L7. */
export function unshownMessage(entry: string): string {
	return `No base and no variant shows the manifest entry ${entry}, and proof/matrix/exemptions.json gives no reason for leaving it out. Every entry is exhibited by a base that comes in, by a variant with its expected finding, or exempted with one of the five reasons. Add the one that is true of it.`;
}

/** Every id the coverage files name is a manifest entry's. */
export function unknownIdProblems(inputs: CoverageInputs): string[] {
	const known = new Set(inputs.entries.map((entry) => entry.id));
	const problem = (where: string, id: string) =>
		`${where} names ${id}, which no area file of lib/commcare/surface/entries holds. Check the id's spelling, or point it at the entry that took its place.`;
	return [
		...Object.keys(inputs.exemptions)
			.filter((id) => !known.has(id))
			.map((id) => problem("proof/matrix/exemptions.json", id)),
		...inputs.variants.flatMap((row) =>
			namedEntries(row)
				.filter((id) => !known.has(id))
				.map((id) =>
					problem(`The row ${row.id} of proof/matrix/variants.json`, id),
				),
		),
		...[...inputs.bases.keys()]
			.sort()
			.flatMap((base) =>
				(inputs.bases.get(base)?.expected.claimed ?? [])
					.filter((id) => !known.has(id))
					.map((id) => problem(`proof/hq-apps/${base}/expected.json`, id)),
			),
	];
}

/** Each exemption has a closed reason, the first true of its entry, and a note that holds. */
export function exemptionProblems(inputs: CoverageInputs): string[] {
	const byId = new Map(inputs.entries.map((entry) => [entry.id, entry]));
	const neverServed = new Set(
		inputs.variants
			.filter((row) => row.hqNeverServes !== undefined)
			.flatMap(namedEntries),
	);
	const problems: string[] = [];
	for (const [id, { reason, note }] of Object.entries(inputs.exemptions)) {
		const where = `proof/matrix/exemptions.json exempts ${id}`;
		const kept = inputs.kept[id];
		if (kept !== undefined && kept.base !== null)
			problems.push(
				`${where}, and KEPT_AT_HQ places it on the base ${kept.base}, which shows it. A kept entry is shown by its base and takes no exemption: remove it from proof/matrix/exemptions.json.`,
			);
		if (!(EXEMPTION_REASONS as readonly string[]).includes(reason)) {
			problems.push(
				`${where} for ${reason}, which is not one of the five reasons (${EXEMPTION_REASONS.join(", ")}). Give it the one that is true of it.`,
			);
			continue;
		}
		if (note.trim() === "")
			problems.push(
				`${where} with no note. Say in one sentence why the reason is true of it.`,
			);
		for (const path of notePaths(note))
			if (!inputs.fileExists(path))
				problems.push(
					`The note proof/matrix/exemptions.json gives ${id} names ${path}, and no such file exists. Name the file that is its evidence where it is now.`,
				);
		if (reason === "not-in-app-source" && notePaths(note).length === 0)
			problems.push(
				`${where} as not-in-app-source, and its note names no test. Such an entry is exempt only beside the test that reads what holds it: name that test in the note.`,
			);
		if (reason === "stated-by-its-part") {
			if (!/\bpart \d{2}\b/i.test(note))
				problems.push(
					`${where} as stated-by-its-part, and its note names no part. Name the part and section that decided it.`,
				);
			continue;
		}
		const entry = byId.get(id);
		if (entry === undefined) continue;
		const truths = trueReasons(entry, neverServed);
		const [first] = truths;
		if (!truths.includes(reason as ExemptionReason))
			problems.push(
				`${where} as ${reason}, which is not true of it (it is ${entry.disposition}, with ${
					entry.surfaceKeys.length === 0
						? "no surface key"
						: `the keys ${entry.surfaceKeys.join(", ")}`
				}). ${
					first === undefined
						? "No reason is true of it, so a base or a variant shows it: take it off the list."
						: `Give it ${first}, the first reason true of it.`
				}`,
			);
		else if (first !== reason)
			problems.push(
				`${where} as ${reason}, and ${first} is also true of it and comes first. An entry takes the first reason true of it: give it ${first}.`,
			);
	}
	return problems;
}

/** Every entry is base-exhibited, variant-exhibited or exempt, and none exhibited is exempt. */
export function setProblems(inputs: CoverageInputs): string[] {
	const byBase = baseExhibited(inputs);
	const byRow = variantExhibited(inputs);
	const problems: string[] = [];
	for (const [id, { reason }] of Object.entries(inputs.exemptions)) {
		const shownBy = byBase.has(id)
			? `the base ${byBase.get(id)}`
			: byRow.has(id)
				? `the variant ${byRow.get(id)}`
				: undefined;
		if (shownBy !== undefined)
			problems.push(
				`proof/matrix/exemptions.json exempts ${id} as ${reason}, and ${shownBy} shows it. An entry that is shown takes no exemption: remove it from proof/matrix/exemptions.json.`,
			);
	}
	const absent = absentBases(inputs);
	if (absent.length > 0)
		return [...problems, absentBasesMessage("Coverage", absent)];
	for (const entry of inputs.entries)
		if (
			!byBase.has(entry.id) &&
			!byRow.has(entry.id) &&
			!Object.hasOwn(inputs.exemptions, entry.id)
		)
			problems.push(unshownMessage(entry.id));
	return problems;
}

export function rule1(inputs: CoverageInputs): string[] {
	return [
		...unknownIdProblems(inputs),
		...exemptionProblems(inputs),
		...setProblems(inputs),
	];
}

// ---------------------------------------------------------------------------
// Rule 2: every kept entry is shown by the base its row names, and an
// archive's kept setting is shown where an archive is made, away from the
// value an archive and Nova would agree on; a kept entry no reading meets
// names no base and is exempt for a reason its keys or HQ's answer make true
// ---------------------------------------------------------------------------

/** The reasons a kept entry no reading meets may be exempt under: each is read off its keys
 *  (rules 1 and 4) or held by a row on every run (rule 5), and none is a decision. */
const UNMET_KEPT_REASONS: ReadonlySet<string> = new Set([
	"hq-never-serves-the-value",
	"no-surface-key",
	"not-in-app-source",
	"only-in-a-build",
]);

/** Where an app's source holds a kept setting, and whether that is away from the default. */
export interface KeptValue {
	/** A JSON Pointer into the source. */
	readonly where: string;
	readonly value: unknown;
	/** What the value would show nothing against: HQ's default, or Nova's seed. */
	readonly against: string;
	readonly away: boolean;
}

function member(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function shown(value: unknown): string {
	return value === undefined ? "nothing" : JSON.stringify(value);
}

/**
 * Where the source holds the setting an entry keeps, read from the entry's
 * keys: a property of HQ's `Application` (`schema:Application.<key>`) is a
 * key of the app, away where it holds other than the model's default; a
 * profile setting (`setting:properties.<key>`, `setting:features.<key>`) is
 * the key under the profile's `properties` or `features`, away where it holds
 * other than Nova's seed, or any value where Nova seeds none. Undefined where
 * no key says where the source holds it.
 */
export function keptValue(
	keys: readonly string[],
	source: unknown,
	seeds: ReadonlyMap<string, string>,
	schemaDefault: SchemaDefaultReader,
): KeptValue | undefined {
	for (const key of keys) {
		const match = /^schema:Application\.([^.]+)$/.exec(key);
		if (match === null) continue;
		const name = match[1] as string;
		const declared = schemaDefault("Application", name);
		if (!declared.known) continue;
		const value = member(source, name);
		return {
			where: `/${name}`,
			value,
			against: `CommCare HQ's default, ${JSON.stringify(declared.default)}`,
			away: value !== undefined && !isDeepStrictEqual(value, declared.default),
		};
	}
	for (const section of ["properties", "features"]) {
		const prefix = `setting:${section}.`;
		const key = keys.find((one) => one.startsWith(prefix));
		if (key === undefined) continue;
		const name = key.slice(prefix.length);
		const value = member(member(member(source, "profile"), section), name);
		const seed = section === "properties" ? seeds.get(name) : undefined;
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return {
			where: `/profile/${section}/${name}`,
			value,
			against:
				seed === undefined
					? "nothing, which is what Nova writes"
					: `Nova's seed, ${JSON.stringify(seed)}`,
			away: value !== undefined && (seed === undefined || text !== seed),
		};
	}
	return undefined;
}

export function rule2(inputs: CoverageInputs): string[] {
	const byId = new Map(inputs.entries.map((entry) => [entry.id, entry]));
	const problems: string[] = [];
	const awaiting = new Map<string, string[]>();
	for (const [id, row] of Object.entries(inputs.kept)) {
		if (row.base === null) {
			const exemption = inputs.exemptions[id];
			if (exemption === undefined)
				problems.push(
					`KEPT_AT_HQ places ${id} on no base, and proof/matrix/exemptions.json gives no reason for it. A kept entry no reading meets is exempt for the reason its keys or CommCare HQ's answer make true (${[...UNMET_KEPT_REASONS].join(", ")}): add it, or name the base whose reading meets it.`,
				);
			else if (!UNMET_KEPT_REASONS.has(exemption.reason))
				problems.push(
					`KEPT_AT_HQ places ${id} on no base, and proof/matrix/exemptions.json exempts it as ${exemption.reason}. A kept entry no reading meets is exempt only for a reason its keys or CommCare HQ's answer make true (${[...UNMET_KEPT_REASONS].join(", ")}), never by a decision: name the base whose reading meets it.`,
				);
			continue;
		}
		if (!inputs.namedBases.includes(row.base)) {
			problems.push(
				`KEPT_AT_HQ places ${id} on ${row.base}, which proof/matrix/bases.json does not name. Place it on a base the lane authors.`,
			);
			continue;
		}
		const base = inputs.bases.get(row.base);
		if (base === undefined) {
			awaiting.set(row.base, [...(awaiting.get(row.base) ?? []), id]);
			continue;
		}
		if (!base.expected.claimed.includes(id))
			problems.push(
				`KEPT_AT_HQ places ${id} on the base ${row.base}, and that base's reading claims nothing under it (proof/hq-apps/${row.base}/expected.json). A kept value is shown by the base its row names: either the base no longer holds it (look at what proof/matrix/bases/ authors), or the reader stopped claiming it.`,
			);
		if (
			row.kind !== "setting" ||
			(row.ccz.does !== "mirrors" && row.ccz.does !== "states")
		)
			continue;
		const verb = row.ccz.does === "mirrors" ? "mirrors" : "states";
		if (base.expected.declaration.runsOnlyOn === "web-apps")
			problems.push(
				`${id} is a setting an archive ${verb}, and its base ${row.base} is read as an app that runs on Web Apps only, which Nova hands no archive. Place the row on a base read with Android.`,
			);
		const value = keptValue(
			byId.get(id)?.surfaceKeys ?? [],
			base.source,
			inputs.profileSeeds,
			inputs.schemaDefault,
		);
		if (value === undefined)
			problems.push(
				`${id} is a setting an archive ${verb}, and none of its surface keys says where an app's source holds it, so nothing shows the base ${row.base} holds it away from the default. Give the entry the key of the value it keeps.`,
			);
		else if (!value.away)
			problems.push(
				`${id} is a setting an archive ${verb}, and the base ${row.base} holds ${shown(value.value)} at ${value.where}, which shows nothing against ${value.against}: there an archive and Nova's own value agree. Author the base with another value (proof/matrix/bases/).`,
			);
	}
	for (const [base, ids] of awaiting)
		problems.push(
			`KEPT_AT_HQ places ${ids.join(", ")} on the base ${base}, and proof/hq-apps/${base}/ is absent, so nothing shows the base holds them. A lane run writes it (proof/matrix/test_retained.py), and python3 -m proof.matrix.adopt copies it into proof/hq-apps/.`,
		);
	return problems;
}

// ---------------------------------------------------------------------------
// Rule 3: every change a first publish makes is shown by a base
// ---------------------------------------------------------------------------

export function rule3(inputs: CoverageInputs): string[] {
	const absent = absentBases(inputs);
	if (absent.length > 0)
		return [absentBasesMessage("The first-publish coverage", absent)];
	const predicted = new Set(
		[...inputs.bases.values()].flatMap((base) => base.expected.firstPublish),
	);
	return [
		...inputs.firstPublishIds
			.filter((id) => !predicted.has(id))
			.map(
				(id) =>
					`No base's first publish makes the change ${id}: no proof/hq-apps/*/expected.json lists it in firstPublish. Every change a first publish can make is shown by a base that holds the shape it rewrites; author one (proof/matrix/bases/), or the rule that predicts the change fires nowhere.`,
			),
		...inputs.registerIds
			.filter((id) => !predicted.has(id))
			.map(
				(id) =>
					`No base's reading records a rewrite under the register id ${id}, so the rule that writes it back differently is shown by no app made in CommCare HQ. Author a base that holds the shape the rule reads (proof/matrix/bases/).`,
			),
	];
}

// ---------------------------------------------------------------------------
// Rule 4: no exemption for want of an app's source rests on a key an app's
// source holds
// ---------------------------------------------------------------------------

export function rule4(inputs: CoverageInputs): string[] {
	const byId = new Map(inputs.entries.map((entry) => [entry.id, entry]));
	const problems: string[] = [];
	for (const [id, { reason }] of Object.entries(inputs.exemptions)) {
		if (reason !== "not-in-app-source" && reason !== "only-in-a-build")
			continue;
		for (const key of byId.get(id)?.surfaceKeys ?? [])
			if (inputs.sourceFamilies.includes(familyOf(key)))
				problems.push(
					`proof/matrix/exemptions.json exempts ${id} as ${reason}, and its key ${key} is of the family ${familyOf(key)}, which the lane's manifest check reads from an app's source (proof/checks/fixtures/source-families.json). An app's source can hold it, so a base or a variant shows it.`,
				);
	}
	return problems;
}

// ---------------------------------------------------------------------------
// Rule 5: a refusal is shown by a variant, and no exemption rests on an
// assumption about HQ
// ---------------------------------------------------------------------------

/** Copy L7's second form. */
export function unshownRefusalMessage(entry: string, claim: string): string {
	return `The entry ${entry} is a refusal Nova's reader raises (${claim}), and no variant shows it. A refusal is exempt only where a part of the plan decided it, where no app's source holds it, or where CommCare HQ never serves the value. Add its row to proof/matrix/variants.json.`;
}

const REFUSAL_EXEMPTIONS: ReadonlySet<string> = new Set([
	"stated-by-its-part",
	"not-in-app-source",
	"hq-never-serves-the-value",
]);

export function rule5(inputs: CoverageInputs): string[] {
	const problems: string[] = [];
	for (const entry of inputs.entries)
		if (
			(entry.disposition === "REFUSED" || entry.disposition === "HELD-NEW") &&
			inputs.exemptions[entry.id]?.reason === "no-surface-key"
		)
			problems.push(
				`proof/matrix/exemptions.json exempts ${entry.id} as no-surface-key, and it is ${entry.disposition}. A refusal is never exempt for want of a key: give it a row in proof/matrix/variants.json.`,
			);
	const byRow = variantExhibited(inputs);
	const raised = new Map<string, string>();
	for (const { claim, entry } of inputs.refusingClaims)
		if (!raised.has(entry)) raised.set(entry, claim);
	for (const [entry, claim] of raised) {
		const reason = inputs.exemptions[entry]?.reason;
		if (
			!byRow.has(entry) &&
			(reason === undefined || !REFUSAL_EXEMPTIONS.has(reason))
		)
			problems.push(unshownRefusalMessage(entry, claim));
	}
	for (const [id, { reason }] of Object.entries(inputs.exemptions)) {
		if (reason !== "hq-never-serves-the-value") continue;
		const rows = inputs.variants.filter((row) =>
			namedEntries(row).includes(id),
		);
		if (rows.length === 0)
			problems.push(
				`proof/matrix/exemptions.json exempts ${id} as hq-never-serves-the-value, and no row of proof/matrix/variants.json names it. The exemption holds only while a row makes the change and the lane sees CommCare HQ refuse it or not serve it on every run: add that row, with hqNeverServes.`,
			);
		for (const row of rows)
			if (row.hqNeverServes === undefined)
				problems.push(
					`proof/matrix/exemptions.json exempts ${id} as hq-never-serves-the-value, and the row ${row.id} names it without hqNeverServes, expecting CommCare HQ to serve the value. Record on the row what HQ does (hqNeverServes), or take the exemption away.`,
				);
	}
	for (const row of inputs.variants) {
		if (row.hqNeverServes === undefined) continue;
		for (const entry of namedEntries(row))
			if (inputs.exemptions[entry]?.reason !== "hq-never-serves-the-value")
				problems.push(
					`The row ${row.id} of proof/matrix/variants.json records that CommCare HQ never serves its value, and ${entry} is not exempt as hq-never-serves-the-value. Exempt it so (proof/matrix/exemptions.json), or take hqNeverServes off the row.`,
				);
	}
	return problems;
}

// ---------------------------------------------------------------------------
// The repository's files
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

/** `app-source.json`: HQ's answer, whose body is the app's source. */
function sourceOf(directory: string): unknown {
	const answer = readJson(join(directory, "app-source.json")) as {
		readonly body?: string;
	};
	return answer.body === undefined ? undefined : JSON.parse(answer.body);
}

/** The bases `proof/hq-apps/` holds, each read from its `expected.json` and `app-source.json`. */
export function retainedBases(): Map<string, RetainedBaseView> {
	const root = join(ROOT, "proof/hq-apps");
	const bases = new Map<string, RetainedBaseView>();
	if (!existsSync(root)) return bases;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const directory = join("proof/hq-apps", entry.name);
		bases.set(entry.name, {
			id: entry.name,
			expected: readJson(join(directory, "expected.json")) as BaseExpectation,
			source: sourceOf(directory),
		});
	}
	return bases;
}

/** The inputs the repository's files give, but for what the reader's modules register. */
export function repositoryInputs(
	inventory: readonly InventoryEntry[],
): Omit<
	CoverageInputs,
	| "kept"
	| "firstPublishIds"
	| "registerIds"
	| "refusingClaims"
	| "profileSeeds"
	| "schemaDefault"
> {
	return {
		entries: inventory.map(({ id, disposition, surfaceKeys }) => ({
			id,
			disposition,
			surfaceKeys,
		})),
		namedBases: readJson("proof/matrix/bases.json") as string[],
		bases: retainedBases(),
		variants: readJson("proof/matrix/variants.json") as VariantRow[],
		exemptions: readJson("proof/matrix/exemptions.json") as Record<
			string,
			Exemption
		>,
		sourceFamilies: (
			readJson("proof/checks/fixtures/source-families.json") as {
				readonly families: readonly string[];
			}
		).families,
		fileExists: (path) => existsSync(join(ROOT, path)),
	};
}
