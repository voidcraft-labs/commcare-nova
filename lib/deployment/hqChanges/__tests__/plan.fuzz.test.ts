/**
 * The round trip over generated documents.
 *
 * Contract: over the diff fuzz corpora (two independently built admitted
 * endpoints per draw), a document `D` given content CommCare HQ never
 * carries (a persona with a value for a worker property, a user type, an
 * automation, purpose notes, a labelled and an unread case property, a
 * worker property with a label, `required` and choices that a question
 * reads and one nothing reads, and a machine translation awaiting review on
 * every text) is published, and an edit `M` (the diff of the two endpoints)
 * stands in for a person's change in CommCare HQ. `B` and `T` are the
 * production reader's readings of `emit(D)` and `emit(apply(D, M))`, both
 * through `D`'s identity map, as a review reads the baseline and the app
 * now. Then:
 *
 * - the round trip: `planFromDocuments` with nothing changed in Nova gives
 *   `nothing` for an empty `M`, and otherwise `changes` applied to the head
 *   whose target holds every planted thing `M` did not change, differs from
 *   `D` only where `M` changed it or inside a menu or form that took the
 *   reader's spelling, is `apply(D, M)` in the reader's image, and reads
 *   back as `T`;
 * - no change in Nova: with notes, a persona, a review mark and a worker property's label
 *   edited in Nova, the plan is still applied to the head, Nova's list is
 *   empty, and the edits are in the target;
 * - the discard: with a second generated edit made in Nova, the plan is
 *   applied to the published document, every question it removes of that
 *   edit is named under Nova's list and none it keeps, and the worker setup
 *   is the head's;
 * - the reader's spelling: with dormant spellings planted (a tile cell on a
 *   list that is no tile, formatting flags under a form whose formatting is
 *   off, an offered registration standing first in its menu, a form whose
 *   root is one-screen groups) and `M` also toggling formatting, switching
 *   lists to tiles, adding a form beside that registration or a condition to
 *   one of those groups, the round trip's properties hold wherever a menu or
 *   form took the reader's spelling, and some sample takes it.
 *
 * Any sample whose plan is `differs`, and any throw, fails.
 *
 * Plausible failure: Nova's spelling of a menu or form that no longer fits
 * a change (a `one-wire` pair that stops printing alike), a narrowing that
 * loses a planted thing, a reader that reads one emission two ways, or a
 * list that leaves a discarded change unnamed.
 */

import fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { canonDocument } from "@/lib/commcare/reader/canon";
import { matchingUuidOf } from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import {
	DERIVED_WIRE_IDENTITY,
	type WireIdentity,
} from "@/lib/commcare/wireIdentity";
import { endpoint, endpointArb } from "@/lib/doc/__tests__/diffEndpoints";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	type DocumentChanges,
	documentChanges,
} from "@/lib/doc/documentChanges";
import { documentDifferences } from "@/lib/doc/documentDifferences";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import {
	type Automation,
	type BlueprintDoc,
	type PersistableDoc,
	plainColumn,
	type TranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import { formField, isBlank, not } from "@/lib/domain/expression/builders";
import { translationSourceFingerprint } from "@/lib/domain/localization";
import { canonicalProseTemplate, proseText } from "@/lib/domain/prose";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import { readBackDifferences } from "../../reading/readBack";
import { planFromDocuments } from "../plan";
import { withHeadUnsent } from "../reference";
import { committed, readingOf, readingWithIds } from "./hqChangeReadings";

// ── Planted content ──────────────────────────────────────────────────

const VILLAGE = testUuid("plan-fuzz-village");
const SHOE_SIZE = testUuid("plan-fuzz-shoe-size");
const ROLE = testUuid("plan-fuzz-role");
const PERSONA = testUuid("plan-fuzz-persona");
const RULE = testUuid("plan-fuzz-rule");
const PLANTED_MENU = testUuid("plan-fuzz-menu");
const PLANTED_FORM = testUuid("plan-fuzz-form");
const PLANTED_QUESTION = testUuid("plan-fuzz-home");

const ALERT: Automation = {
	uuid: RULE,
	kind: "conditional-alert",
	name: "Visit reminder",
	caseType: "patient",
	criteriaOperator: "all",
	criteria: [],
	setupOnlyCriteria: [],
	recipients: [{ uuid: testUuid("plan-fuzz-recipient"), kind: "owner" }],
	schedule: {
		kind: "immediate",
		events: [
			{
				uuid: testUuid("plan-fuzz-event"),
				minutesToWait: 5,
				content: {
					kind: "sms",
					message: { parts: [{ kind: "text", text: "Visit due" }] },
				},
			},
		],
	},
	includeDescendantLocations: false,
	locationLevelUuids: [],
	userDataFilters: [],
	useUserCaseForFilter: false,
} as unknown as Automation;

/** What Nova holds that CommCare HQ never carries, committed through the gate. */
function planted(doc: BlueprintDoc): BlueprintDoc {
	const withSetup = committed(doc, [
		{
			kind: "addUserProperty",
			property: {
				uuid: VILLAGE,
				slug: "village",
				label: "Home village",
				required: true,
				choices: ["north", "south"],
			},
		},
		{
			kind: "addUserProperty",
			property: { uuid: SHOE_SIZE, slug: "shoe_size", label: "Shoe size" },
		},
		{
			kind: "addUserType",
			userType: { uuid: ROLE, name: "Nurse", values: { [VILLAGE]: "north" } },
		},
		{
			kind: "addPersona",
			persona: {
				uuid: PERSONA,
				name: "Asha",
				userTypeUuid: ROLE,
				values: { [VILLAGE]: "south" },
			},
		},
		{
			kind: "addCaseProperty",
			caseType: "patient",
			property: {
				name: "clinic",
				label: proseText("Clinic"),
				data_type: "text",
			},
		},
		{
			kind: "addCaseProperty",
			caseType: "patient",
			property: { name: "risk", label: proseText("Risk level") },
		},
		{ kind: "addAutomation", automation: ALERT },
		{
			kind: "addModule",
			module: {
				uuid: PLANTED_MENU,
				id: "planted",
				name: "Planted",
				purpose: "Where the home village is asked",
			},
		},
		{
			kind: "addForm",
			moduleUuid: PLANTED_MENU,
			form: {
				uuid: PLANTED_FORM,
				id: "home",
				name: "Home",
				type: "survey",
				purpose: "Asks the worker's village",
			},
		},
		{
			kind: "addField",
			parentUuid: PLANTED_FORM,
			field: {
				uuid: PLANTED_QUESTION,
				id: "home",
				kind: "text",
				label: proseText("Home"),
				default_value: {
					kind: "term",
					term: { kind: "session-user-property", userPropertyUuid: VILLAGE },
				},
			},
		},
	] as unknown as Mutation[]);
	return withMachineFrench(withSetup);
}

/** `doc` in English and French, every text's French written by a model and awaiting review. */
function withMachineFrench(doc: BlueprintDoc): BlueprintDoc {
	const translations: Record<string, unknown> = {};
	for (const unit of snapshotTranslationUnits(doc).values()) {
		const value =
			unit.valueKind === "text"
				? typeof unit.source === "string" && unit.source.length > 0
					? `${unit.source} (fr)`
					: undefined
				: unit.source !== null &&
						typeof unit.source === "object" &&
						"parts" in unit.source &&
						unit.source.parts.length > 0
					? canonicalProseTemplate([
							...unit.source.parts,
							{ kind: "text", text: " (fr)" },
						])
					: undefined;
		if (value === undefined) continue;
		translations[unit.id] = {
			value,
			sourceFingerprint: translationSourceFingerprint(
				unit.valueKind,
				unit.source,
			),
			origin: "ai",
			review: "needs-review",
			translatedFrom: "eng",
		};
	}
	const next = {
		...toPersistableDoc(doc),
		localization: {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			wireCodes: { eng: "en", fra: "fr" },
			translations: { fra: translations },
		},
	};
	return committed(hydratePersistedBlueprint(next as PersistableDoc), []);
}

const OFFERED_MENU = "plan-fuzz-offered";
const OFFERED_SIGN_UP = "plan-fuzz-offered-sign-up";

/** A menu of patients whose list offers its registration after an empty search, the
 *  registration standing first, which the reader reads last: what the menu adds to `doc`. */
function withOfferedRegistration(doc: BlueprintDoc): BlueprintDoc {
	const catalog = [{ name: "patient", properties: [] }];
	const bare = buildDoc({ appId: doc.appId, caseTypes: catalog });
	const offered = buildDoc({
		appId: doc.appId,
		caseTypes: catalog,
		modules: [
			{
				uuid: OFFERED_MENU,
				name: "Clients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(
							testUuid("plan-fuzz-offered-name"),
							"case_name",
							"Name",
						),
					],
					searchInputs: [],
				},
				caseSearchConfig: { formsReadSearch: true },
				caseListRegistrationForm: { formUuid: OFFERED_SIGN_UP },
				forms: [
					{
						uuid: OFFERED_SIGN_UP,
						name: "Sign up",
						type: "registration",
						fields: [
							f({
								uuid: "plan-fuzz-offered-sign-up-name",
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
					{
						uuid: "plan-fuzz-offered-check-in",
						name: "Check in",
						type: "followup",
						fields: [
							f({
								uuid: "plan-fuzz-offered-check-in-c",
								kind: "text",
								id: "c",
								label: "C",
							}),
						],
					},
				],
			},
		],
	});
	return committed(doc, diffDocsToMutations(bare, offered));
}

const PAGES_MENU = "plan-fuzz-pages";
const FIRST_PAGE = "plan-fuzz-pages-first";
const SECOND_PAGE_QUESTION = "plan-fuzz-pages-b";

/** A menu whose survey's root is two one-screen groups, which the reader reads as sections
 *  (`root-question-lists-are-sections`): what the menu adds to `doc`. */
function withOneScreenPages(doc: BlueprintDoc): BlueprintDoc {
	const bare = buildDoc({ appId: doc.appId });
	const pages = buildDoc({
		appId: doc.appId,
		modules: [
			{
				uuid: PAGES_MENU,
				name: "Screens",
				forms: [
					{
						uuid: "plan-fuzz-pages-screen",
						name: "Screen",
						type: "survey",
						fields: [
							f({
								uuid: FIRST_PAGE,
								kind: "group",
								id: "first",
								label: "First",
								fieldList: true,
								children: [
									f({
										uuid: "plan-fuzz-pages-a",
										kind: "text",
										id: "a",
										label: "A",
									}),
								],
							}),
							f({
								uuid: "plan-fuzz-pages-second",
								kind: "group",
								id: "second",
								label: "Second",
								fieldList: true,
								children: [
									f({
										uuid: SECOND_PAGE_QUESTION,
										kind: "text",
										id: "b",
										label: "B",
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	return committed(doc, diffDocsToMutations(bare, pages));
}

/** Dormant spellings on the endpoints' own menus and forms: a tile cell on each list that is
 *  no tile, formatting flags on each form's questions under formatting turned off, a menu
 *  whose offered registration stands first, and a form whose root is one-screen groups. */
function dormant(doc: BlueprintDoc): BlueprintDoc {
	return committed(
		produce(withOneScreenPages(withOfferedRegistration(doc)), (draft) => {
			for (const module of Object.values(draft.modules)) {
				const config = module.caseListConfig;
				if (config === undefined || config.tile !== undefined) continue;
				for (const column of config.columns)
					(column as { tile?: unknown }).tile = {
						x: 0,
						y: 0,
						width: 1,
						height: 1,
						horizontalAlign: "left",
						verticalAlign: "top",
						fontSize: "medium",
					};
			}
			for (const [uuid, form] of Object.entries(draft.forms)) {
				if (uuid === PLANTED_FORM) continue;
				(form as { plainText?: true }).plainText = true;
				for (const field of draft.fieldOrder[uuid as Uuid] ?? []) {
					const own = draft.fields[field] as {
						plainLabel?: true;
						kind: string;
					};
					if (own.kind !== "repeat" && own.kind !== "group")
						own.plainLabel = true;
				}
			}
		}),
		[],
	);
}

// ── Changes a dormant spelling meets ─────────────────────────────────

/** Which of the four changes CommCare HQ's edit also makes that meet a dormant spelling of
 *  Nova's: formatting toggled on every form, every list that is no tile switched to one, a
 *  form added to the menu whose offered registration stands first, and a condition added to
 *  the first of a root's one-screen groups. */
const respellingsArb = fc.record({
	formatting: fc.boolean(),
	tile: fc.boolean(),
	registration: fc.boolean(),
	page: fc.boolean(),
});
type Respellings =
	typeof respellingsArb extends fc.Arbitrary<infer T> ? T : never;
const NO_RESPELLINGS: Respellings = {
	formatting: false,
	tile: false,
	registration: false,
	page: false,
};

/** Every question and container under `parent`, at any depth. */
function under(doc: BlueprintDoc, parent: string): Uuid[] {
	return (doc.fieldOrder[parent as Uuid] ?? []).flatMap((uuid) => [
		uuid,
		...under(doc, uuid),
	]);
}

/**
 * `doc` with the changes `edits` names made as CommCare HQ's app would hold
 * them. Formatting turned on leaves every label of the form with its
 * markdown, which no plain text flag spells; turned off, the questions keep
 * what they hold. A list switched to a tile places each column on a row of
 * its own. A condition on a one-screen group reads the next page's question,
 * so the root reads as groups.
 */
function withRespellings(doc: BlueprintDoc, edits: Respellings): BlueprintDoc {
	let next = doc;
	if (edits.formatting || edits.tile)
		next = committed(
			produce(next, (draft) => {
				if (edits.tile)
					for (const module of Object.values(draft.modules)) {
						const config = module.caseListConfig;
						if (config === undefined || config.tile !== undefined) continue;
						if (config.columns.length === 0) continue;
						(config as { tile?: unknown }).tile = {};
						for (const [row, column] of config.columns.entries())
							(column as { tile?: unknown }).tile = {
								x: 0,
								y: row,
								width: 4,
								height: 1,
								horizontalAlign: "left",
								verticalAlign: "top",
								fontSize: "medium",
							};
					}
				if (edits.formatting)
					for (const [uuid, form] of Object.entries(draft.forms)) {
						if (uuid === PLANTED_FORM) continue;
						const own = form as { plainText?: true };
						if (own.plainText !== true) {
							own.plainText = true;
							continue;
						}
						delete own.plainText;
						for (const question of under(next, uuid)) {
							const field = draft.fields[question] as {
								plainLabel?: true;
								plainHelp?: true;
							};
							delete field.plainLabel;
							delete field.plainHelp;
						}
					}
			}),
			[],
		);
	const menu = testUuid(OFFERED_MENU);
	if (edits.registration && Object.hasOwn(next.modules, menu)) {
		const form = testUuid("plan-fuzz-offered-follow-up");
		next = committed(next, [
			{
				kind: "addForm",
				moduleUuid: menu,
				form: {
					uuid: form,
					id: "follow_up",
					name: "Follow up",
					type: "followup",
					caseOperations: [
						{
							uuid: testUuid("plan-fuzz-offered-follow-up-own"),
							id: "patient",
							action: "own",
						},
					],
				},
			},
			{
				kind: "addField",
				parentUuid: form,
				field: {
					uuid: testUuid("plan-fuzz-offered-follow-up-d"),
					id: "d",
					kind: "text",
					label: proseText("D"),
				},
			},
		] as unknown as Mutation[]);
	}
	const page = testUuid(FIRST_PAGE);
	if (edits.page && Object.hasOwn(next.fields, page))
		next = committed(next, [
			{
				kind: "updateField",
				uuid: page,
				targetKind: "group",
				patch: {
					relevant: not(isBlank(formField(testUuid(SECOND_PAGE_QUESTION)))),
				},
			},
		] as unknown as Mutation[]);
	return next;
}

// ── Oracles ──────────────────────────────────────────────────────────

/** `doc` with each entity under the UUID a reading through `mapOf`'s identities gives its key
 *  (another than its own where `mapOf` holds the key under another entity, or not at all), so
 *  it compares with a reading's document. */
function underMapOf(doc: BlueprintDoc, mapOf: BlueprintDoc): BlueprintDoc {
	const uuidOf = matchingUuidOf(
		mapOf.appId,
		externalIdentityMap(mapOf, DERIVED_WIRE_IDENTITY),
	);
	let text = JSON.stringify(toPersistableDoc(doc));
	for (const entry of externalIdentityMap(doc, DERIVED_WIRE_IDENTITY)) {
		const read = uuidOf(entry);
		if (read !== entry.uuid) text = text.replaceAll(entry.uuid, read);
	}
	return hydratePersistedBlueprint(JSON.parse(text) as PersistableDoc);
}

/** Whether one path is, contains or lies under the other. */
function related(a: readonly string[], b: readonly string[]): boolean {
	const length = Math.min(a.length, b.length);
	for (let at = 0; at < length; at++) if (a[at] !== b[at]) return false;
	return true;
}

/** The menu or form a document path lies in, through either document. */
function ownerOf(
	path: readonly string[],
	docs: readonly BlueprintDoc[],
): string | undefined {
	const [top, key] = path;
	if (key === undefined) return undefined;
	if (top === "modules" || top === "forms" || top === "formOrder") return key;
	if (top === "fields" || top === "fieldOrder") {
		for (const doc of docs) {
			let at: string | undefined = key;
			for (let step = 0; at !== undefined && step < 64; step++) {
				if (Object.hasOwn(doc.forms, at)) return at;
				at = doc.fieldParent[at as Uuid];
			}
		}
	}
	return undefined;
}

interface Sample {
	readonly D: BlueprintDoc;
	readonly DM: BlueprintDoc;
	readonly M: readonly Mutation[];
	readonly B: BlueprintDoc;
	readonly T: BlueprintDoc;
	/** The ids a publish sends after the change comes in: CommCare HQ's, for what it added. */
	readonly identity: WireIdentity;
}

async function sample(
	a: Parameters<typeof endpoint>[0],
	b: Parameters<typeof endpoint>[0],
	plant: (doc: BlueprintDoc) => BlueprintDoc,
	edits: Respellings = NO_RESPELLINGS,
): Promise<Sample> {
	const D = plant(endpoint(a));
	const edit = diffDocsToMutations(endpoint(a), endpoint(b));
	const between = committed(D, edit);
	const M = [
		...edit,
		...diffDocsToMutations(between, withRespellings(between, edits)),
	];
	const DM = committed(D, M);
	const T = await readingWithIds(DM, D);
	return {
		D,
		DM,
		M,
		B: await readingOf(D, D),
		T: T.doc,
		identity: T.identity,
	};
}

/** The round trip's four properties over one sample, for a plan applied to the head. */
async function holdsRoundTrip({
	D,
	DM,
	M,
	B,
	T,
	identity,
}: Sample): Promise<readonly Uuid[]> {
	const plan = planFromDocuments({
		ref: D,
		now: D,
		base: B,
		theirs: T,
		renamesSince: [],
	});
	if (M.length === 0) {
		expect(plan.kind).toBe("nothing");
		return [];
	}
	if (plan.kind === "nothing") {
		// `M` changed only what no export carries.
		expect(readBackDifferences(B, { doc: T, choices: null })).toEqual([]);
		return [];
	}
	expect(plan.kind === "differs" ? plan.signature : plan.kind).toBe("changes");
	if (plan.kind !== "changes") return [];
	expect(plan.appliedTo).toBe("head");
	expect(plan.novaChanges.count).toBe(0);
	const { target } = plan;
	// The batch the commit takes replays to the target, and the gate admits it.
	const verdict = mutationCommitVerdict(
		D,
		admitMutationBatch(JSON.parse(JSON.stringify(plan.batch))),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings.map((one) => one.code)).toEqual([]);

	// (a) Every planted thing `M` did not change.
	expect(target.userProperties).toEqual(D.userProperties);
	expect(target.userPropertyOrder).toEqual(D.userPropertyOrder);
	expect(target.userTypes).toEqual(D.userTypes);
	expect(target.personas).toEqual(D.personas);
	expect(target.automations).toEqual(D.automations);
	expect(target.modules[PLANTED_MENU]).toEqual(D.modules[PLANTED_MENU]);
	expect(target.forms[PLANTED_FORM]).toEqual(D.forms[PLANTED_FORM]);
	expect(target.fields[PLANTED_QUESTION]).toEqual(D.fields[PLANTED_QUESTION]);
	for (const name of ["clinic", "risk"])
		expect(
			target.caseTypes
				?.find((type) => type.name === "patient")
				?.properties.find((property) => property.name === name),
		).toEqual(
			D.caseTypes
				?.find((type) => type.name === "patient")
				?.properties.find((property) => property.name === name),
		);
	const french = D.localization?.translations.fra ?? {};
	const sources = snapshotTranslationUnits(DM);
	const before = snapshotTranslationUnits(D);
	// A unit the reading of CommCare HQ's app holds no longer (its question moved, so its key
	// and its UUID moved with it) went with what `M` changed.
	const read = snapshotTranslationUnits(T);
	for (const [unit, entry] of Object.entries(french)) {
		const was = before.get(unit as TranslationUnitId);
		const now = sources.get(unit as TranslationUnitId);
		if (was === undefined || now === undefined) continue;
		if (!read.has(unit as TranslationUnitId)) continue;
		if (JSON.stringify(was.source) !== JSON.stringify(now.source)) continue;
		expect(
			target.localization?.translations.fra?.[unit as TranslationUnitId],
		).toEqual(entry);
	}

	// (b) `D` and the target differ only where `M` changed `D`, or inside what took the reader's
	// spelling.
	const changed = documentDifferences(D, underMapOf(DM, D));
	const respelled = new Set<string>(plan.respelled);
	const reworded = (path: readonly string[]) => {
		// A translation whose source `M` changed, which the list counts under
		// translations to review.
		if (path[0] !== "localization" || path[1] !== "translations") return false;
		const unit = path[3] as TranslationUnitId | undefined;
		if (unit === undefined) return false;
		return (
			JSON.stringify(before.get(unit)?.source) !==
			JSON.stringify(sources.get(unit)?.source)
		);
	};
	for (const difference of documentDifferences(D, target)) {
		if (changed.some((one) => related(one.path, difference.path))) continue;
		if (reworded(difference.path)) continue;
		const owner = ownerOf(difference.path, [D, target]);
		expect(
			owner !== undefined && respelled.has(owner),
			`/${difference.path.join("/")} changed outside what CommCare HQ changed`,
		).toBe(true);
	}

	// (c) The target is `apply(D, M)` in the reader's image.
	expect(
		readBackDifferences(canonDocument(underMapOf(DM, D)), {
			doc: canonDocument(target),
			choices: null,
		}),
	).toEqual([]);

	// (d) It reads back as CommCare HQ's app does.
	expect(
		readBackDifferences(T, {
			doc: await readingOf(target, D, identity),
			choices: null,
		}),
	).toEqual([]);
	return plan.respelled;
}

/** The value at `path` of a persisted document. */
function valueAt(root: unknown, path: readonly string[]): unknown {
	return path.reduce<unknown>(
		(node, key) =>
			node !== null && typeof node === "object"
				? (node as Record<string, unknown>)[key]
				: undefined,
		root,
	);
}

/** Every question a list's forms name, once each. */
function questionsNamed(changes: DocumentChanges): ReadonlySet<string> {
	return new Set(
		changes.forms
			.flatMap((form) => [
				...form.questions.added,
				...form.questions.removed,
				...form.questions.changed,
				...form.questions.moved,
			])
			.map((question) => question.uuid),
	);
}

/** The discard's properties over one sample: the plan, with a second edit `c` made in Nova. */
async function holdsDiscard(
	a: Parameters<typeof endpoint>[0],
	b: Parameters<typeof endpoint>[0],
	c: Parameters<typeof endpoint>[0],
): Promise<void> {
	const { D, M, B, T } = await sample(a, b, planted);
	if (M.length === 0) return;
	const N = diffDocsToMutations(endpoint(a), endpoint(c));
	const now = committed(committed(D, N), [
		{
			kind: "updateUserProperty",
			uuid: SHOE_SIZE,
			patch: { label: "Shoe size, in EU sizes" },
		},
	] as unknown as Mutation[]);
	const ref = withHeadUnsent(D, now);
	const plan = planFromDocuments({
		ref,
		now,
		base: B,
		theirs: T,
		renamesSince: [],
	});
	if (plan.kind === "nothing") return;
	expect(plan.kind === "differs" ? plan.signature : plan.kind).toBe("changes");
	if (plan.kind !== "changes") return;
	expect(plan.target.userProperties).toEqual(now.userProperties);
	expect(plan.target.personas).toEqual(now.personas);
	expect(plan.target.automations).toEqual(now.automations);
	if (plan.appliedTo === "head") return;

	// Every leaf of Nova's edit the take removes is under a line of the Nova list, at whatever
	// place it lies: a question, a form, a menu, the app's own parts, a translation or a file.
	// An ordering array is compared by the relative order of the members both sides hold, as
	// the plan compares it, so it is held through the entity whose place moved.
	const named = questionsNamed(plan.novaChanges);
	const target = toPersistableDoc(plan.target);
	const head = toPersistableDoc(now);
	const menusListed = new Set(plan.novaChanges.menus.map((menu) => menu.uuid));
	const formsListed = new Set(plan.novaChanges.forms.map((form) => form.uuid));
	const appListed = new Set(plan.novaChanges.app);
	for (const difference of documentDifferences(ref, now)) {
		if (difference.path.some((key) => key.endsWith("Order"))) continue;
		const lost =
			JSON.stringify(valueAt(target, difference.path)) !==
			JSON.stringify(valueAt(head, difference.path));
		if (!lost) continue;
		const wording = documentChanges(ref, now, [difference]);
		const where = `/${difference.path.join("/")}`;
		expect(wording.count, `${where} is worded`).toBeGreaterThan(0);
		for (const uuid of questionsNamed(wording))
			expect(named.has(uuid), `${where} names its question`).toBe(true);
		for (const menu of wording.menus)
			expect(menusListed.has(menu.uuid), `${where} names its menu`).toBe(true);
		for (const form of wording.forms)
			expect(formsListed.has(form.uuid), `${where} names its form`).toBe(true);
		for (const part of wording.app)
			expect(appListed.has(part), `${where} names its app part`).toBe(true);
		if (wording.translations.text > 0)
			expect(plan.novaChanges.translations.text).toBeGreaterThan(0);
		if (wording.translations.review > 0)
			expect(plan.novaChanges.translations.review).toBeGreaterThan(0);
		if (wording.mediaFiles > 0)
			expect(plan.novaChanges.mediaFiles).toBeGreaterThan(0);
	}
	for (const uuid of named) {
		// A question the target holds as the head holds it, in the same place, is kept. Its place
		// is its parent and the siblings on either side of it among those both documents hold
		// there, so a sibling one side alone holds does not make two places one by index.
		const held = valueAt(target, ["fields", uuid]);
		if (held === undefined) continue;
		const place = (doc: BlueprintDoc) => {
			const parent = doc.fieldParent[uuid as Uuid];
			if (parent === undefined) return JSON.stringify([parent]);
			const both = new Set(plan.target.fieldOrder[parent] ?? []);
			const siblings = (doc.fieldOrder[parent] ?? []).filter(
				(sibling) =>
					both.has(sibling) && (now.fieldOrder[parent] ?? []).includes(sibling),
			);
			const at = siblings.indexOf(uuid as Uuid);
			return JSON.stringify([
				parent,
				siblings[at - 1] ?? null,
				siblings[at + 1] ?? null,
			]);
		};
		expect(
			JSON.stringify(held) ===
				JSON.stringify(valueAt(head, ["fields", uuid])) &&
				place(plan.target) === place(now),
			`the question ${uuid} is named though the take keeps it`,
		).toBe(false);
	}
}

const RUNS = { seed: 20261115, numRuns: 60 } as const;

describe("a change made in CommCare HQ, planned over generated documents", () => {
	it("comes in whole and loses nothing Nova holds", {
		timeout: 300_000,
	}, async () => {
		await fc.assert(
			fc.asyncProperty(
				endpointArb,
				endpointArb,
				respellingsArb,
				async (a, b, edits) => {
					await holdsRoundTrip(await sample(a, b, planted, edits));
				},
			),
			RUNS,
		);
	});

	it("comes in whole where Nova holds dormant spellings of what it changed", {
		timeout: 300_000,
	}, async () => {
		// The samples whose take checks failed once and passed in the reader's spelling, and those
		// that added a condition to one of a root's one-screen groups.
		let respelled = 0;
		let pages = 0;
		await fc.assert(
			fc.asyncProperty(
				endpointArb,
				endpointArb,
				respellingsArb,
				async (a, b, edits) => {
					const touched = await holdsRoundTrip(
						await sample(a, b, (doc) => dormant(planted(doc)), edits),
					);
					if (touched.length > 0) respelled++;
					if (edits.page) pages++;
				},
			),
			RUNS,
		);
		expect(respelled).toBeGreaterThan(0);
		expect(pages).toBeGreaterThan(0);
	});

	it("is applied to the head where Nova changed only what CommCare HQ never receives", {
		timeout: 300_000,
	}, async () => {
		await fc.assert(
			fc.asyncProperty(endpointArb, endpointArb, async (a, b) => {
				const { D, M, B, T } = await sample(a, b, planted);
				if (M.length === 0) return;
				const unit = [...snapshotTranslationUnits(D).keys()].find((id) =>
					Object.hasOwn(D.localization?.translations.fra ?? {}, id),
				);
				const now = committed(D, [
					{
						kind: "updateModule",
						uuid: PLANTED_MENU,
						patch: { purpose: "Asked once a year" },
					},
					{
						kind: "updatePersona",
						uuid: PERSONA,
						patch: { name: "Asha K" },
					},
					{
						kind: "updateUserProperty",
						uuid: VILLAGE,
						patch: { label: "Village of residence" },
					},
					...(unit === undefined
						? []
						: [
								{
									kind: "setTranslation",
									language: "fra",
									unitId: unit,
									entry: {
										...D.localization?.translations.fra?.[unit],
										review: "reviewed",
									},
								},
							]),
				] as unknown as Mutation[]);
				const plan = planFromDocuments({
					ref: withHeadUnsent(D, now),
					now,
					base: B,
					theirs: T,
					renamesSince: [],
				});
				if (plan.kind === "nothing") return;
				expect(plan.kind === "differs" ? plan.signature : plan.kind).toBe(
					"changes",
				);
				if (plan.kind !== "changes") return;
				expect(plan.appliedTo).toBe("head");
				expect(plan.novaChanges.count).toBe(0);
				expect(plan.target.modules[PLANTED_MENU]?.purpose).toBe(
					"Asked once a year",
				);
				expect(plan.target.personas?.[PERSONA]?.name).toBe("Asha K");
				expect(plan.target.userProperties?.[VILLAGE]?.label).toBe(
					"Village of residence",
				);
			}),
			RUNS,
		);
	});

	it("names every change a discard removes, and none it keeps", {
		timeout: 300_000,
	}, async () => {
		await fc.assert(
			fc.asyncProperty(endpointArb, endpointArb, endpointArb, holdsDiscard),
			RUNS,
		);
	});
});
