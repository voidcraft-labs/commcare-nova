/**
 * Every manifest entry is shown by an app made in CommCare HQ, or exempted
 * with a reason.
 *
 * Contract, the five rules of `entryCoverageRules.ts` over the repository's
 * files: (1) every entry is base-exhibited (a base's `expected.json` claims
 * it), variant-exhibited (a row of `proof/matrix/variants.json` without
 * `hqNeverServes` names it) or exempt (`proof/matrix/exemptions.json`), none
 * shown is exempt, no file names an id the manifest lacks, each exemption takes
 * the first of the five reasons true of it and a note names files that exist;
 * (2) every `KEPT_AT_HQ` row's base claims its entry, an archive's kept
 * setting sits on a base read with Android at a value other than the one an
 * archive and Nova would agree on, and a row no reading meets names no base
 * and is exempt for a reason its keys or HQ's answer make true, never by a
 * decision; (3) every first-publish change, and every
 * register id a reading records a rewrite under, is in some base's
 * `firstPublish`; (4) no exemption for want of an app's source rests on a key
 * the lane's manifest check reads from one; (5) no refusal is exempt for want
 * of a key, every entry a registered claim refuses is shown by a variant or
 * exempt for a reason that is no assumption about HQ, and `hqNeverServes`
 * rows and their exemptions name each other.
 *
 * Plausible failure: a manifest entry nothing shows that no one notices; an
 * exemption that outlives its reason or rests on a guess about HQ; a kept
 * setting only ever seen at the value that makes it invisible; a first-publish
 * change no base makes; and a tree no lane run wrote, which would leave the
 * rules nothing to read. Each rule is first run over planted inputs that it
 * refuses by name, beside the same inputs it accepts.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SEEDED_PROFILE_PROPERTIES } from "@/lib/commcare/appProfileSettings";
import { claimRegistry } from "@/lib/commcare/reader/claims";
import {
	FIRST_PUBLISH_READING_RECORDS,
	type ReadFacts,
	SAME_STATE_REGISTERS,
} from "@/lib/commcare/reader/types";
import {
	FIRST_PUBLISH_CHANGES,
	type FirstPublishFacts,
} from "@/lib/deployment/reading/firstPublishChanges";
import { PLATFORMS, type Platform } from "@/lib/domain/platforms";
import {
	CURRENT_FIRST_PUBLISH_CHANGE_IDS,
	type CurrentFirstPublishChangeId,
	FIRST_PUBLISH_PLATFORM,
} from "@/lib/publish/firstPublishChangeIds";
import { KEPT_AT_HQ, type KeptRow } from "../keptAtHq";
import { schemaPropertyDefault } from "../schemaDefaults";
import {
	absentBases,
	type CoverageInputs,
	type RetainedBaseView,
	repositoryInputs,
	rule1,
	rule2,
	rule3,
	rule4,
	rule5,
	unshownMessage,
	unshownRefusalMessage,
} from "./entryCoverageRules";
import { loadManifest } from "./loadManifest";

/** Importing every module of the reader registers every claim it declares. */
const IMPORT_MS = 120_000;

const READER_DIR = join(process.cwd(), "lib/commcare/reader");

/** Every module of the reader, tests left out. */
function readerModules(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			return entry.name === "__tests__" ? [] : readerModules(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

const REGISTER_IDS: readonly string[] = [
	...SAME_STATE_REGISTERS,
	...FIRST_PUBLISH_READING_RECORDS,
];

const PROFILE_SEEDS: ReadonlyMap<string, string> = new Map(
	SEEDED_PROFILE_PROPERTIES.map(({ key, value }) => [key, value]),
);

// ---------------------------------------------------------------------------
// The planted world: one entry of each kind, a base that shows what it should
// ---------------------------------------------------------------------------

const KEPT_ROW: KeptRow = {
	kind: "setting",
	ccz: { does: "mirrors", by: "lib/commcare/compiler.ts::compileCcz" },
	preview: { does: "no-claim", why: "Planted." },
	elsewhere: { does: "its-own" },
	base: "planted-base",
};

function plantedBase(
	overrides: Partial<RetainedBaseView["expected"]> = {},
	source: unknown = {
		secure_submissions: true,
		profile: { properties: { "cc-autoup-freq": "freq-daily" } },
	},
): RetainedBaseView {
	return {
		id: "planted-base",
		expected: {
			reads: true,
			declaration: { runsOnlyOn: null, splitDatetime: false },
			claimed: [
				"application-and-settings/planted-held",
				"application-and-settings/planted-kept",
				"application-and-settings/planted-kept-profile",
			],
			firstPublish: ["planted-change", "planted-register"],
			...overrides,
		},
		source,
	};
}

/** Inputs every rule accepts. */
function planted(overrides: Partial<CoverageInputs> = {}): CoverageInputs {
	return {
		entries: [
			{
				id: "application-and-settings/planted-held",
				disposition: "HELD",
				surfaceKeys: ["schema:Application.name"],
			},
			{
				id: "application-and-settings/planted-kept",
				disposition: "TARGET-OWNED",
				surfaceKeys: ["schema:Application.secure_submissions"],
			},
			{
				id: "application-and-settings/planted-kept-profile",
				disposition: "TARGET-OWNED",
				surfaceKeys: ["setting:properties.cc-autoup-freq"],
			},
			{
				id: "questions/planted-refused",
				disposition: "REFUSED",
				surfaceKeys: ["xform:bind@planted"],
			},
			{
				id: "expressions-and-data/planted-lookup",
				disposition: "REFUSED",
				surfaceKeys: ["lookup-model:LookupTable.tag"],
			},
			{
				id: "questions/planted-never-served",
				disposition: "REFUSED",
				surfaceKeys: ["schema:Form.planted"],
			},
			{
				id: "questions/planted-no-key",
				disposition: "INERT",
				surfaceKeys: [],
			},
			{
				id: "application-and-settings/planted-build",
				disposition: "HELD",
				surfaceKeys: ["parser:ProfileParser/planted"],
			},
		],
		namedBases: ["planted-base"],
		bases: new Map([["planted-base", plantedBase()]]),
		variants: [
			{
				id: "planted-base/refused",
				base: "planted-base",
				entry: "questions/planted-refused",
			},
			{
				id: "planted-base/never-served",
				base: "planted-base",
				entry: "questions/planted-never-served",
				hqNeverServes: { raised: "BadValueError" },
			},
		],
		exemptions: {
			"expressions-and-data/planted-lookup": {
				reason: "not-in-app-source",
				note: "Every key is of a lookup family; lib/planted/lookup.test.ts reads HQ's answers.",
			},
			"questions/planted-never-served": {
				reason: "hq-never-serves-the-value",
				note: "CommCare HQ's import refuses the value.",
			},
			"questions/planted-no-key": {
				reason: "no-surface-key",
				note: "The entry names no surface key.",
			},
			"application-and-settings/planted-build": {
				reason: "only-in-a-build",
				note: "Every key is parser:.",
			},
		},
		kept: {
			"application-and-settings/planted-kept": KEPT_ROW,
			"application-and-settings/planted-kept-profile": KEPT_ROW,
		},
		firstPublishIds: ["planted-change", "planted-register"],
		registerIds: ["planted-register"],
		sourceFamilies: ["schema", "xform", "setting"],
		refusingClaims: [
			{ claim: "planted.refused", entry: "questions/planted-refused" },
			{ claim: "planted.lookup", entry: "expressions-and-data/planted-lookup" },
		],
		profileSeeds: new Map([["cc-autoup-freq", "freq-never"]]),
		schemaDefault: schemaPropertyDefault,
		fileExists: (path) => path === "lib/planted/lookup.test.ts",
		...overrides,
	};
}

const RULES = { rule1, rule2, rule3, rule4, rule5 };

describe("the rules over planted inputs", () => {
	it("accept a world where every entry is shown or exempt for its reason", () => {
		const world = planted();
		for (const [name, rule] of Object.entries(RULES))
			expect(rule(world), name).toEqual([]);
	});

	it("rule 1 names an entry nothing shows, a stale exemption, a wrong reason and a missing file (Copy L7)", () => {
		const world = planted();
		const found = rule1({
			...world,
			entries: [
				...world.entries,
				{
					id: "questions/planted-unshown",
					disposition: "HELD",
					surfaceKeys: ["xform:planted"],
				},
			],
			exemptions: {
				...world.exemptions,
				"application-and-settings/planted-held": {
					reason: "no-surface-key",
					note: "The entry names no surface key.",
				},
				"expressions-and-data/planted-lookup": {
					reason: "not-in-app-source",
					note: "lib/planted/gone.test.ts reads HQ's answers.",
				},
				"questions/planted-gone": {
					reason: "no-surface-key",
					note: "No key.",
				},
			},
		});
		expect(found).toContain(unshownMessage("questions/planted-unshown"));
		expect(found).toContain(
			"proof/matrix/exemptions.json exempts application-and-settings/planted-held as no-surface-key, and the base planted-base shows it. An entry that is shown takes no exemption: remove it from proof/matrix/exemptions.json.",
		);
		expect(found).toContain(
			"proof/matrix/exemptions.json exempts application-and-settings/planted-held as no-surface-key, which is not true of it (it is HELD, with the keys schema:Application.name). No reason is true of it, so a base or a variant shows it: take it off the list.",
		);
		expect(found).toContain(
			"The note proof/matrix/exemptions.json gives expressions-and-data/planted-lookup names lib/planted/gone.test.ts, and no such file exists. Name the file that is its evidence where it is now.",
		);
		expect(found).toContain(
			"proof/matrix/exemptions.json names questions/planted-gone, which no area file of lib/commcare/surface/entries holds. Check the id's spelling, or point it at the entry that took its place.",
		);
		expect(found).toHaveLength(5);
	});

	it("rule 1 gives an exemption the first reason true of it, and names the bases it cannot read", () => {
		const world = planted();
		expect(
			rule1({
				...world,
				exemptions: {
					...world.exemptions,
					"questions/planted-never-served": {
						reason: "no-surface-key",
						note: "Planted.",
					},
				},
			}),
		).toContain(
			"proof/matrix/exemptions.json exempts questions/planted-never-served as no-surface-key, which is not true of it (it is REFUSED, with the keys schema:Form.planted). Give it hq-never-serves-the-value, the first reason true of it.",
		);
		expect(
			rule1({ ...world, namedBases: ["planted-base", "planted-absent"] }),
		).toEqual([
			"Coverage reads every base's expected.json, and proof/hq-apps/ lacks planted-absent. A lane run writes each base (proof/matrix/test_retained.py), and python3 -m proof.matrix.adopt copies its output into proof/hq-apps/.",
		]);
	});

	it("rule 2 names a kept entry its base does not claim, a web-only base and a value at the default", () => {
		const world = planted();
		const atDefaults = planted({
			bases: new Map([
				[
					"planted-base",
					plantedBase(
						{
							declaration: { runsOnlyOn: "web-apps", splitDatetime: false },
							claimed: [
								"application-and-settings/planted-held",
								"application-and-settings/planted-kept",
							],
						},
						{
							secure_submissions: false,
							profile: { properties: { "cc-autoup-freq": "freq-never" } },
						},
					),
				],
			]),
		});
		expect(rule2(atDefaults)).toEqual([
			"application-and-settings/planted-kept is a setting an archive mirrors, and its base planted-base is read as an app that runs on Web Apps only, which Nova hands no archive. Place the row on a base read with Android.",
			"application-and-settings/planted-kept is a setting an archive mirrors, and the base planted-base holds false at /secure_submissions, which shows nothing against CommCare HQ's default, false: there an archive and Nova's own value agree. Author the base with another value (proof/matrix/bases/).",
			"KEPT_AT_HQ places application-and-settings/planted-kept-profile on the base planted-base, and that base's reading claims nothing under it (proof/hq-apps/planted-base/expected.json). A kept value is shown by the base its row names: either the base no longer holds it (look at what proof/matrix/bases/ authors), or the reader stopped claiming it.",
			"application-and-settings/planted-kept-profile is a setting an archive mirrors, and its base planted-base is read as an app that runs on Web Apps only, which Nova hands no archive. Place the row on a base read with Android.",
			`application-and-settings/planted-kept-profile is a setting an archive mirrors, and the base planted-base holds "freq-never" at /profile/properties/cc-autoup-freq, which shows nothing against Nova's seed, "freq-never": there an archive and Nova's own value agree. Author the base with another value (proof/matrix/bases/).`,
		]);
		expect(rule2({ ...world, bases: new Map() })).toEqual([
			"KEPT_AT_HQ places application-and-settings/planted-kept, application-and-settings/planted-kept-profile on the base planted-base, and proof/hq-apps/planted-base/ is absent, so nothing shows the base holds them. A lane run writes it (proof/matrix/test_retained.py), and python3 -m proof.matrix.adopt copies it into proof/hq-apps/.",
		]);
	});

	it("rule 2 takes a kept entry no reading meets only with an exemption its keys or HQ's answer make true", () => {
		const world = planted();
		const unmet: KeptRow = {
			...KEPT_ROW,
			kind: "project-state",
			ccz: { does: "no-reader", why: "Planted." },
			base: null,
		};
		const withUnmet = (exemption?: { reason: string; note: string }) =>
			planted({
				entries: [
					...world.entries,
					{
						id: "forms-and-case-writes/planted-unmet",
						disposition: "TARGET-OWNED",
						surfaceKeys: [],
					},
				],
				kept: { ...world.kept, "forms-and-case-writes/planted-unmet": unmet },
				exemptions:
					exemption === undefined
						? world.exemptions
						: {
								...world.exemptions,
								"forms-and-case-writes/planted-unmet": exemption,
							},
			});
		const accepted = withUnmet({
			reason: "no-surface-key",
			note: "The entry names no surface key, and it allows what it describes.",
		});
		expect(rule1(accepted)).toEqual([]);
		expect(rule2(accepted)).toEqual([]);
		expect(rule2(withUnmet())).toEqual([
			"KEPT_AT_HQ places forms-and-case-writes/planted-unmet on no base, and proof/matrix/exemptions.json gives no reason for it. A kept entry no reading meets is exempt for the reason its keys or CommCare HQ's answer make true (hq-never-serves-the-value, no-surface-key, not-in-app-source, only-in-a-build): add it, or name the base whose reading meets it.",
		]);
		expect(
			rule2(
				withUnmet({
					reason: "stated-by-its-part",
					note: "Part 01 decided it.",
				}),
			),
		).toEqual([
			"KEPT_AT_HQ places forms-and-case-writes/planted-unmet on no base, and proof/matrix/exemptions.json exempts it as stated-by-its-part. A kept entry no reading meets is exempt only for a reason its keys or CommCare HQ's answer make true (hq-never-serves-the-value, no-surface-key, not-in-app-source, only-in-a-build), never by a decision: name the base whose reading meets it.",
		]);
		// A kept entry its base meets takes no exemption at all.
		expect(
			rule1({
				...world,
				exemptions: {
					...world.exemptions,
					"application-and-settings/planted-kept": {
						reason: "no-surface-key",
						note: "Planted.",
					},
				},
			}),
		).toContain(
			"proof/matrix/exemptions.json exempts application-and-settings/planted-kept, and KEPT_AT_HQ places it on the base planted-base, which shows it. A kept entry is shown by its base and takes no exemption: remove it from proof/matrix/exemptions.json.",
		);
	});

	it("counts an entry a row composes beside its second as shown by that row", () => {
		const world = planted();
		const composedOnly = {
			id: "questions/planted-composed",
			disposition: "REFUSED" as const,
			surfaceKeys: ["xform:bind@composed"],
		};
		const entries = [...world.entries, composedOnly];
		const refusingClaims = [
			...world.refusingClaims,
			{ claim: "planted.composed", entry: composedOnly.id },
		];
		const withRow = (also: readonly { entry: string }[] | undefined) =>
			planted({
				entries,
				refusingClaims,
				variants: [
					...world.variants,
					{
						id: "planted-base/composed",
						base: "planted-base",
						entry: "questions/planted-refused",
						second: { entry: "questions/planted-refused" },
						...(also === undefined ? {} : { also }),
					},
				],
			});
		expect(rule1(withRow([{ entry: composedOnly.id }]))).toEqual([]);
		expect(rule5(withRow([{ entry: composedOnly.id }]))).toEqual([]);
		expect(rule1(withRow(undefined))).toEqual([
			unshownMessage(composedOnly.id),
		]);
	});

	it("rule 3 names a first-publish change and a register id no base shows", () => {
		const world = planted({
			bases: new Map([
				["planted-base", plantedBase({ firstPublish: ["planted-change"] })],
			]),
		});
		expect(rule3(world)).toEqual([
			"No base's first publish makes the change planted-register: no proof/hq-apps/*/expected.json lists it in firstPublish. Every change a first publish can make is shown by a base that holds the shape it rewrites; author one (proof/matrix/bases/), or the rule that predicts the change fires nowhere.",
			"No base's reading records a rewrite under the register id planted-register, so the rule that writes it back differently is shown by no app made in CommCare HQ. Author a base that holds the shape the rule reads (proof/matrix/bases/).",
		]);
		expect(rule3({ ...world, bases: new Map() })).toEqual([
			"The first-publish coverage reads every base's expected.json, and proof/hq-apps/ lacks planted-base. A lane run writes each base (proof/matrix/test_retained.py), and python3 -m proof.matrix.adopt copies its output into proof/hq-apps/.",
		]);
	});

	it("rule 4 names an exemption for want of a source whose key a source holds", () => {
		const world = planted();
		expect(
			rule4({ ...world, sourceFamilies: [...world.sourceFamilies, "parser"] }),
		).toEqual([
			"proof/matrix/exemptions.json exempts application-and-settings/planted-build as only-in-a-build, and its key parser:ProfileParser/planted is of the family parser, which the lane's manifest check reads from an app's source (proof/checks/fixtures/source-families.json). An app's source can hold it, so a base or a variant shows it.",
		]);
	});

	it("rule 5 names a keyless refusal exempt, a refusal no variant shows and hqNeverServes out of step (Copy L7)", () => {
		const world = planted();
		expect(
			rule5({
				...world,
				entries: [
					...world.entries,
					{
						id: "questions/planted-keyless-refusal",
						disposition: "REFUSED",
						surfaceKeys: [],
					},
				],
				variants: [
					{
						id: "planted-base/never-served",
						base: "planted-base",
						entry: "questions/planted-never-served",
					},
					{
						id: "planted-base/claims-never-served",
						base: "planted-base",
						entry: "questions/planted-refused",
						hqNeverServes: { notServedAt: "/planted" },
					},
				],
				exemptions: {
					...world.exemptions,
					"questions/planted-keyless-refusal": {
						reason: "no-surface-key",
						note: "Planted.",
					},
				},
			}),
		).toEqual([
			"proof/matrix/exemptions.json exempts questions/planted-keyless-refusal as no-surface-key, and it is REFUSED. A refusal is never exempt for want of a key: give it a row in proof/matrix/variants.json.",
			unshownRefusalMessage("questions/planted-refused", "planted.refused"),
			"proof/matrix/exemptions.json exempts questions/planted-never-served as hq-never-serves-the-value, and the row planted-base/never-served names it without hqNeverServes, expecting CommCare HQ to serve the value. Record on the row what HQ does (hqNeverServes), or take the exemption away.",
			"The row planted-base/claims-never-served of proof/matrix/variants.json records that CommCare HQ never serves its value, and questions/planted-refused is not exempt as hq-never-serves-the-value. Exempt it so (proof/matrix/exemptions.json), or take hqNeverServes off the row.",
		]);
		expect(rule5({ ...world, variants: world.variants.slice(0, 1) })).toEqual([
			"proof/matrix/exemptions.json exempts questions/planted-never-served as hq-never-serves-the-value, and no row of proof/matrix/variants.json names it. The exemption holds only while a row makes the change and the lane sees CommCare HQ refuse it or not serve it on every run: add that row, with hqNeverServes.",
		]);
	});
});

describe("the register ids rule 3 reads from a base's firstPublish", () => {
	const facts = (
		registers: readonly string[],
		runsOnlyOn: Platform | null,
	): FirstPublishFacts =>
		({
			// A source with no menu: a change a predicate works out from the
			// stored app beside the reading's records (a search a menu does not
			// offer) has nothing to find, so each id stands on its records alone.
			source: { raw: { modules: [] } },
			doc: { appSettings: { runsOnlyOn } },
			facts: {
				sameStateRewrites: registers.map((register) => ({
					entry: "planted",
					path: "/planted",
					register,
				})),
			} as unknown as ReadFacts,
			choice: { runsOnlyOn, split: false },
		}) as unknown as FirstPublishFacts;

	it("are each a first-publish change predicted exactly where a reading records a rewrite under it, under every declaration a worker meets it", () => {
		for (const id of REGISTER_IDS) {
			expect(
				CURRENT_FIRST_PUBLISH_CHANGE_IDS as readonly string[],
				id,
			).toContain(id);
			const key = id as CurrentFirstPublishChangeId;
			const change = FIRST_PUBLISH_CHANGES[key];
			for (const runsOnlyOn of [null, ...PLATFORMS]) {
				const under = `${id} where the app runs on ${runsOnlyOn ?? "every platform"}`;
				const platform = FIRST_PUBLISH_PLATFORM.get(key);
				const met = !platform || !runsOnlyOn || platform === runsOnlyOn;
				expect(change.applies(facts([id], runsOnlyOn)), under).toBe(met);
				expect(change.applies(facts([], runsOnlyOn)), under).toBe(false);
			}
			if (FIRST_PUBLISH_PLATFORM.has(key)) {
				expect(change.recorded?.(facts([id], null).facts), id).toBe(true);
				expect(change.recorded?.(facts([], null).facts), id).toBe(false);
			}
		}
	});
});

describe("the repository's coverage", () => {
	const manifest = loadManifest();
	let inputs: CoverageInputs;

	beforeAll(async () => {
		for (const module of readerModules(READER_DIR)) await import(module);
		inputs = {
			...repositoryInputs(manifest.inventory),
			kept: KEPT_AT_HQ,
			firstPublishIds: CURRENT_FIRST_PUBLISH_CHANGE_IDS,
			registerIds: REGISTER_IDS,
			refusingClaims: [...claimRegistry()]
				.filter(([, claim]) => claim.use === "refuse")
				.map(([claim, { entry }]) => ({ claim, entry })),
			profileSeeds: PROFILE_SEEDS,
			schemaDefault: schemaPropertyDefault,
		};
	}, IMPORT_MS);

	it("holds every base the lane's registry names", () => {
		expect(
			absentBases(inputs),
			"proof/hq-apps/ is to hold one directory a base of proof/matrix/bases.json; a lane run writes it (proof/matrix/test_retained.py) and python3 -m proof.matrix.adopt copies it in",
		).toEqual([]);
	});

	it("reads the refusals the reader's own modules register", () => {
		expect(inputs.refusingClaims.length).toBeGreaterThan(0);
	});

	it("shows every entry, or exempts it for the first reason true of it (rule 1)", () => {
		expect(rule1(inputs)).toEqual([]);
	});

	it("shows every kept entry on its base, and an archive's kept setting away from the default (rule 2)", () => {
		expect(rule2(inputs)).toEqual([]);
	});

	it("shows every change a first publish makes on some base (rule 3)", () => {
		expect(rule3(inputs)).toEqual([]);
	});

	it("exempts nothing for want of an app's source that an app's source holds (rule 4)", () => {
		expect(rule4(inputs)).toEqual([]);
	});

	it("shows every refusal by a variant, or exempts it for no assumption about HQ (rule 5)", () => {
		expect(rule5(inputs)).toEqual([]);
	});
});
