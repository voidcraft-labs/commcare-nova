/**
 * The first-publish register says exactly what Nova's first publish over an
 * app it brought in from CommCare HQ changes there.
 *
 * Contract: every entry applies on some reading and not on another, each
 * built from a retained read of CommCare HQ's or a reading of a document
 * production builders made, through `firstPublishFactsOf`
 * (`forms-and-settings-rewritten` applies on every one), and an entry that
 * reads what the reader records applies on a whole reading of a production
 * export changed to the source shape that makes the reader record it, never
 * on a record added by hand; the register's columns agree with the
 * client-safe copies of them and with the emitter's rewrites; every
 * same-state record a retained read or one of those readings makes is
 * covered by the paths of the entry it names; a Save to Case value in the
 * spelling Nova wrote before reads whole to the document the current
 * spelling gives; what the birth stores for a choice gives
 * that choice's list back under its declaration and differs only by the
 * two Web Apps lines under another; and the four entries a shell key carries
 * part ways with the source in the body a first publish sends exactly where
 * they apply.
 *
 * Plausible failures: an entry that never applies, or always does; an
 * entry whose record the reader never makes; a
 * same-state rule whose rewrite no entry allows; a rewrite a worker meets
 * that no line says; a stored list that tells a person Web Apps is turned
 * off after they turned it on; a predicate and the shell it speaks for
 * parting ways.
 */

import { Element, isTag, Text } from "domhandler";
import {
	findAll,
	findOne,
	prepend,
	removeElement,
	replaceElement,
} from "domutils";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { constraintMessageFixture } from "@/lib/commcare/__tests__/constraintMessageFixture";
import { buildShape } from "@/lib/commcare/__tests__/formLinkDocArbitrary";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import {
	GENERATED_APP_STRING_PATTERNS,
	generatedAppStringPattern,
} from "@/lib/commcare/appStringKeys";
import { localAppStringTable } from "@/lib/commcare/appStrings";
import { EMISSION_REWRITES } from "@/lib/commcare/emissionRewrites";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { wirePathFor } from "@/lib/commcare/multimedia/assetWirePath";
import {
	type ExportEdits,
	exportedBody,
} from "@/lib/commcare/reader/__tests__/novaExport";
import { hydrated } from "@/lib/commcare/reader/__tests__/publishedDocuments";
import { sourceFromBody } from "@/lib/commcare/reader/__tests__/readerInput";
import {
	patients,
	uuid,
} from "@/lib/commcare/reader/caseList/__tests__/fixtures";
import {
	csqlRow,
	csqlVectorDoc,
} from "@/lib/commcare/reader/expressions/__tests__/csqlVectors";
import { knownCaseTypesOf } from "@/lib/commcare/reader/index";
import { inSpanish } from "@/lib/commcare/reader/menus/__tests__/menuReading";
import { readFormSyntax } from "@/lib/commcare/reader/syntaxRead";
import type {
	ReaderInput,
	ReadFacts,
	SameStateRewrite,
} from "@/lib/commcare/reader/types";
import { literalOutputText } from "@/lib/commcare/reader/xform/prose";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { imageMapEnumKey } from "@/lib/commcare/suite/case-list/columns";
import { servedSchemaPropertyDefault } from "@/lib/commcare/surface/schemaDefaults";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { FormPath } from "@/lib/commcare/xform/formPath";
import type { GeneratedNodePurpose } from "@/lib/commcare/xform/generatedNodes";
import { parseXml } from "@/lib/commcare/xmlParse";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { typedInstantValue } from "@/lib/commcare/xpath/wire/instant";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { DeclarationChoice } from "@/lib/doc/platformDeclaration";
import {
	type BlueprintDoc,
	type CaseOperation,
	NEW_APP_SETTINGS,
	type Platform,
	proseText,
	type SearchInputDef,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import {
	eq,
	input,
	literal,
	lte,
	neq,
	now,
	prop,
	tableColumn,
	term,
	today,
	whenInput,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	type CaseListConfig,
	type CaseSearchConfig,
	columnSort,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	intervalColumn,
	plainColumn,
} from "@/lib/domain/modules";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import {
	CURRENT_FIRST_PUBLISH_CHANGE_IDS,
	type CurrentFirstPublishChangeId,
	FIRST_PUBLISH_PLATFORM,
	FIRST_PUBLISH_TOUCHES_WORKERS,
	firstPublishViewFromStored,
} from "@/lib/publish/firstPublishChangeIds";
import { connectDeliverRename } from "@/proof/targeted/documents/connectApps";
import {
	type AdoptedMediaFile,
	adoptedAppBaselineWrite,
	adoptedIdentityRows,
} from "../../adoption";
import { hqImportApplication } from "../../importApplication";
import type { DeploymentTargetKey } from "../../store";
import { adoptionExportBoundary } from "../adoptionBoundary";
import { readingAppStrings } from "../appStrings";
import {
	birthPublishSubjects,
	FIRST_PUBLISH_CHANGES,
	type FirstPublishFacts,
	firstPublishChangePlaces,
	firstPublishChangesFor,
	firstPublishFactsOf,
	firstPublishListToStore,
	firstPublishPlaceKindsOf,
	firstPublishRegisterRefusals,
	GENERATED_NODE_CHANGE,
	MEDIA_REFERENCE_PATHS,
	pointerCovers,
	publishChangeSubjects,
} from "../firstPublishChanges";
import {
	FOLDED_TEXT_SLOTS,
	firstPublishPlaceKind,
	foldedTextPathsOf,
	foldedTextSlotsOf,
	formPositionsOf,
	placeOf,
	placeOfStoredPointer,
	placeSteps,
	placesOfGeneratedKey,
} from "../firstPublishPlaces";
import {
	HQ_MEDIA_SLOTS,
	type HqMediaClaim,
	type HqMediaSlot,
	hqMediaReferencesOf,
	mediaFindings,
	planHqMedia,
	planReadingMedia,
	type ReadingMediaPlan,
	readingMediaFindings,
	readingMediaIndex,
} from "../projectData/media";
import {
	type RegisterReading,
	readExport,
	readingForms,
	readWhole,
	retainedReadings,
} from "./registerReadings";

const TARGET = { origin: "https://india.commcarehq.org", domain: "clinic" };
const TARGET_KEY: DeploymentTargetKey = { server: "india", domain: "clinic" };
const REMOTE_APP_ID = "0123456789abcdef0123456789abcdef";

// ── Building facts ───────────────────────────────────────────────────────

function choicesOf(reading: RegisterReading): readonly DeclarationChoice[] {
	const declaration = reading.draft.declaration;
	if (declaration.kind !== "choices")
		throw new Error(`The reading ${reading.name} offers no declaration.`);
	return declaration.choices;
}

function proposedChoice(reading: RegisterReading): DeclarationChoice {
	const declaration = reading.draft.declaration;
	if (declaration.kind !== "choices")
		throw new Error(`The reading ${reading.name} offers no declaration.`);
	return declaration.choices[declaration.proposed] as DeclarationChoice;
}

/** The choice of the reading whose declaration is `runsOnlyOn` and that splits nothing. */
function choiceRunningOn(
	reading: RegisterReading,
	runsOnlyOn: Platform | undefined,
): DeclarationChoice {
	const choice = choicesOf(reading).find(
		(one) => one.runsOnlyOn === runsOnlyOn && !one.split,
	);
	if (choice === undefined)
		throw new Error(
			`The reading ${reading.name} offers no choice running on ${runsOnlyOn ?? "both"}.`,
		);
	return choice;
}

/** The document under a choice: the draft with the choice's mutations applied, as the gate gives it. */
function docUnder(
	reading: RegisterReading,
	choice: DeclarationChoice,
): BlueprintDoc {
	return mutationCommitVerdict(
		reading.draft.doc,
		choice.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	).nextDoc;
}

interface FactsChange {
	readonly choice?: DeclarationChoice;
	readonly source?: HqAppSource;
	readonly doc?: BlueprintDoc;
	readonly facts?: Partial<ReadFacts>;
	readonly mediaFiles?: readonly AdoptedMediaFile[];
	readonly mediaClaims?: readonly HqMediaClaim[];
}

/** The facts of `reading` under a choice, through the production builder, with `change` made to its input. */
function factsOf(
	reading: RegisterReading,
	change: FactsChange = {},
): FirstPublishFacts {
	const choice = change.choice ?? proposedChoice(reading);
	return firstPublishFactsOf({
		source: change.source ?? reading.source,
		doc: change.doc ?? docUnder(reading, choice),
		facts: { ...reading.draft.facts, ...change.facts },
		forms: readingForms(reading.draft),
		attachmentTarget: reading.input.target,
		mediaFiles: change.mediaFiles ?? [],
		mediaClaims: change.mediaClaims ?? [],
		choice: { runsOnlyOn: choice.runsOnlyOn ?? null, split: choice.split },
	});
}

/** The reading's source with root keys of its stored app changed, as CommCare HQ would serve it. */
async function sourceWith(
	source: HqAppSource,
	root: Readonly<Record<string, unknown>>,
): Promise<HqAppSource> {
	const body: Record<string, unknown> = { ...source.raw, ...root };
	for (const [key, value] of Object.entries(root))
		if (value === undefined) delete body[key];
	return sourceFromBody(body);
}

/** The reading's facts with every form's folded nodes taken away: a source that held none of Nova's. */
function withNoFoldedNodes(reading: RegisterReading): Partial<ReadFacts> {
	return {
		forms: reading.draft.facts.forms.map((form) => ({
			...form,
			generated: [],
		})),
	};
}

const applies = (id: CurrentFirstPublishChangeId, facts: FirstPublishFacts) =>
	FIRST_PUBLISH_CHANGES[id].applies(facts);

// ── Readings ─────────────────────────────────────────────────────────────

async function baseReading(): Promise<RegisterReading> {
	const reading = (await retainedReadings()).find(
		(one) => one.name === "navigation-base/app-source",
	);
	if (reading === undefined)
		throw new Error(
			"CommCare HQ's retained navigation-base source read to an account.",
		);
	return reading;
}

/** A registration whose name and a date and time a question saves to the case. */
function registrationDoc(extraDates = 0): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "seen_at", label: proseText("Seen") },
					...Array.from({ length: extraDates }, (_, i) => ({
						name: `time_${i}`,
						label: proseText(`Time ${i}`),
					})),
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "datetime",
								id: "seen",
								caseWrite: { caseType: "patient", property: "seen_at" },
							}),
							...Array.from({ length: extraDates }, (_, i) =>
								f({
									kind: "datetime",
									id: `time_${i}`,
									caseWrite: { caseType: "patient", property: `time_${i}` },
								}),
							),
						],
					},
				],
			},
		],
	});
}

/** A survey whose validation counts another question's answers. */
function countDoc(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Menu",
				forms: [
					{
						name: "Form",
						type: "survey",
						fields: [
							f({
								kind: "repeat",
								id: "roster",
								children: [f({ kind: "text", id: "answer" })],
							}),
							f({
								kind: "int",
								id: "gate",
								validate: "count(#form/roster/answer[. = 'x']) >= 1",
							}),
						],
					},
				],
			},
		],
	});
}

const VISIT_FORM = testUuid("first-publish-visit");

/** A follow-up whose Save to Case block saves the time it is filled in. */

function visitDoc(): BlueprintDoc {
	const operation: CaseOperation = {
		uuid: testUuid("first-publish-visit-own"),
		id: "patient",
		action: "own",
		writes: [{ property: "visited_at", value: now() }],
	};
	return buildDoc(
		{
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "visited_at",
							label: proseText("Visited at"),
							data_type: "datetime",
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "first-publish-visit",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[VISIT_FORM] = {
				...built.forms[VISIT_FORM],
				caseOperations: [operation],
			} as never;
		},
	);
}

/** Every form of `body` with one bind attribute set, the attribute absent where the form has no such bind. */
function withBindAttribute(
	nodesetEnding: string,
	attribute: string,
	value: string,
): (xml: string) => string {
	return (xml) => {
		const document = parseXml(xml);
		const bind = findOne(
			(element: Element) =>
				element.name === "bind" &&
				(element.attribs.nodeset ?? "").endsWith(nodesetEnding),
			document.children.filter(isTag),
			true,
		);
		if (bind === null) return xml;
		bind.attribs[attribute] = value;
		return serializeXml(document);
	};
}

/**
 * A Save to Case row that saves the clock in the spelling Nova wrote before
 * its clock node existed: the row reads `now()` through `typedInstantValue`,
 * and the form holds no `nova_instant_` node, its data node and its bind gone.
 */
function withEarlierClockRow(property: string): (xml: string) => string {
	const earlier = serializeWire(typedInstantValue(w.call("now", [])), {
		target: "xform",
		constraint: false,
	}).text;
	return (xml) => {
		const document = parseXml(
			withBindAttribute(`/update/${property}`, "calculate", earlier)(xml),
		);
		const clock = (element: Element) =>
			element.name.startsWith("nova_instant_") ||
			(element.name === "bind" &&
				(element.attribs.nodeset ?? "")
					.split("/")
					.at(-1)
					?.startsWith("nova_instant_") === true);
		for (const element of findAll(clock, document.children.filter(isTag)))
			removeElement(element);
		return serializeXml(document);
	};
}

/** A survey of one question whose label is `label`. */
function labelledDoc(label: string): () => BlueprintDoc {
	return () =>
		buildDoc({
			modules: [
				{
					name: "Menu",
					forms: [
						{
							name: "Form",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: proseText(label) })],
						},
					],
				},
			],
		});
}

/**
 * Every literal output of a form's texts written as the text it spells, as
 * an author's form holds a no-break space or an `instance(` CommCare HQ's
 * build reads: the source Nova's print writes those characters as outputs in.
 */
function withLiteralOutputsAsText(xml: string): string {
	const document = parseXml(xml);
	const literals = findAll(
		(element: Element) =>
			element.name === "output" &&
			literalOutputText(element.attribs.value ?? "") !== undefined,
		document.children.filter(isTag),
	);
	if (literals.length === 0) return xml;
	for (const output of literals)
		replaceElement(
			output,
			new Text(literalOutputText(output.attribs.value ?? "") as string),
		);
	// Parsed again, so a value's runs of text are one text node, as a source's are.
	return serializeXml(parseXml(serializeXml(document)));
}

/** The form's `<h:title>` holding no text, as CommCare HQ's new form holds it. */
function withBlankTitle(xml: string): string {
	const document = parseXml(xml);
	const title = findOne(
		(element: Element) => element.name === "h:title",
		document.children.filter(isTag),
		true,
	);
	if (title === null) throw new Error("The export holds no <h:title>.");
	title.children = [];
	return serializeXml(document);
}

/** The form declaring the mobile reports fixture before its first bind, read by nothing, as a
 *  form CommCare HQ's form builder kept a declaration of holds it. */
function withDeclaredReports(xml: string): string {
	const document = parseXml(xml);
	const bind = findOne(
		(element: Element) => element.name === "bind",
		document.children.filter(isTag),
		true,
	);
	if (bind === null) throw new Error("The export holds no <bind>.");
	prepend(
		bind,
		new Element("instance", {
			id: "commcare:reports",
			src: "jr://fixture/commcare:reports",
		}),
	);
	return serializeXml(document);
}

// ── The register's columns ───────────────────────────────────────────────

describe("the register", () => {
	it("holds every id in registry order, and its touchesWorkers column is the client-safe one", () => {
		expect(Object.keys(FIRST_PUBLISH_CHANGES)).toEqual([
			...CURRENT_FIRST_PUBLISH_CHANGE_IDS,
		]);
		for (const id of CURRENT_FIRST_PUBLISH_CHANGE_IDS)
			expect([id, FIRST_PUBLISH_CHANGES[id].touchesWorkers]).toEqual([
				id,
				FIRST_PUBLISH_TOUCHES_WORKERS[id],
			]);
	});

	it("keeps the incomplete forms notice for a later return to Web Apps", async () => {
		const id = "incomplete-forms-tile-hidden";
		const facts = await PAIRS[id].on();
		const android = firstPublishChangesFor({
			...facts,
			choice: { ...facts.choice, runsOnlyOn: "android" },
		});
		expect(android.ids).not.toContain(id);
		const stored = {
			...firstPublishListToStore(android, facts.facts),
			webAppsOnInHq: true,
		};
		expect(
			firstPublishViewFromStored(stored, {
				connectType: null,
				appSettings: {
					runsOnlyOn: "android",
					showIncompleteForms: false,
				},
			}).ids,
		).not.toContain(id);
		expect(
			firstPublishViewFromStored(stored, {
				connectType: null,
				appSettings: {
					runsOnlyOn: "web-apps",
					showIncompleteForms: false,
				},
			}).ids,
		).toContain(id);
		expect(
			firstPublishViewFromStored(stored, {
				connectType: null,
				appSettings: { showIncompleteForms: true },
			}).ids,
		).not.toContain(id);
		expect(
			firstPublishViewFromStored(stored, {
				connectType: null,
				appSettings: { showIncompleteForms: false },
			}).ids,
		).toContain(id);
		for (const [cloudcare, properties] of [
			[false, {}],
			[true, { "cc-show-incomplete": "yes" }],
			[true, { "cc-show-incomplete": "no" }],
		] as const) {
			const reading = await readAs(registrationDoc(), {
				root: { cloudcare_enabled: cloudcare, profile: { properties } },
			});
			expect(firstPublishChangesFor(factsOf(reading)).ids).not.toContain(id);
		}
	});

	it("works out the two Web Apps lines from the declaration, and each line a worker meets on one platform alone from its reading", () => {
		expect(
			CURRENT_FIRST_PUBLISH_CHANGE_IDS.filter(
				(id) =>
					FIRST_PUBLISH_CHANGES[id].scope === "declaration" &&
					FIRST_PUBLISH_CHANGES[id].recorded === undefined,
			),
		).toEqual(["web-apps-turned-off", "web-apps-turned-on"]);
		expect(
			CURRENT_FIRST_PUBLISH_CHANGE_IDS.filter(
				(id) => FIRST_PUBLISH_CHANGES[id].recorded !== undefined,
			),
		).toEqual([...FIRST_PUBLISH_PLATFORM.keys()]);
		for (const id of FIRST_PUBLISH_PLATFORM.keys())
			expect([id, FIRST_PUBLISH_CHANGES[id].scope]).toEqual([
				id,
				"declaration",
			]);
	});

	it("maps every generated node's purpose to the entry that declares it, a guard to none", () => {
		const purposes: Record<GeneratedNodePurpose, true> = {
			"constraint-count": true,
			"constraint-message": true,
			url: true,
			datetime: true,
			trimmed: true,
			count: true,
			"query-ids": true,
			"query-count": true,
			"query-position": true,
			"query-id": true,
			"query-index": true,
			"keyed-count": true,
			keyed: true,
			condition: true,
			guard: true,
			owner: true,
			instant: true,
		};
		expect(Object.keys(GENERATED_NODE_CHANGE).sort()).toEqual(
			Object.keys(purposes).sort(),
		);
		const named: Partial<Record<GeneratedNodePurpose, string>> = {
			trimmed: "case-names-checked",
			"constraint-count": "validation-counts-moved",
			"constraint-message": "validation-messages-composed",
			guard: "identity",
		};
		for (const purpose of Object.keys(purposes) as GeneratedNodePurpose[])
			expect([purpose, GENERATED_NODE_CHANGE[purpose]]).toEqual([
				purpose,
				named[purpose] ?? "hidden-values-added",
			]);
	});

	it("declares every rewrite a worker meets under its own id, as an entry that touches workers", () => {
		const changing = Object.entries(EMISSION_REWRITES)
			.filter(([, rewrite]) => rewrite.behavior === "changes")
			.map(([id]) => id);
		expect(changing.length).toBeGreaterThan(0);
		for (const id of changing) {
			expect(CURRENT_FIRST_PUBLISH_CHANGE_IDS).toContain(id);
			expect([
				id,
				FIRST_PUBLISH_CHANGES[id as CurrentFirstPublishChangeId].touchesWorkers,
			]).toEqual([id, true]);
		}
	});

	it("names in MEDIA_REFERENCE_PATHS the pointers of exactly the slots project data reads a reference in", () => {
		const pointers: Readonly<Record<HqMediaSlot, readonly string[]>> = {
			form: ["/_attachments/*"],
			choice: ["/_attachments/*"],
			"unheld-itext": ["/_attachments/*"],
			"list-image": ["/modules/*/case_details/*/columns/*/enum/*/value/*"],
			tile: [
				"/modules/*/media_image/*",
				"/modules/*/media_audio/*",
				"/modules/*/case_list/media_image/*",
				"/modules/*/case_list/media_audio/*",
				"/modules/*/forms/*/media_image/*",
				"/modules/*/forms/*/media_audio/*",
			],
			"register-action": [
				"/modules/*/case_list_form/media_image/*",
				"/modules/*/case_list_form/media_audio/*",
			],
			logo: ["/logo_refs/*"],
		};
		expect(Object.keys(pointers).sort()).toEqual([...HQ_MEDIA_SLOTS].sort());
		expect([...new Set(Object.values(pointers).flat())].sort()).toEqual(
			[...MEDIA_REFERENCE_PATHS].sort(),
		);
	});

	it("writes every path as a pointer, and reads a pointer as covering what is under it", () => {
		for (const id of CURRENT_FIRST_PUBLISH_CHANGE_IDS)
			for (const path of FIRST_PUBLISH_CHANGES[id].paths)
				expect(path.startsWith("/") && !path.endsWith("/"), path).toBe(true);
		expect(pointerCovers("/modules/*/name", "/modules/3/name/en")).toBe(true);
		expect(pointerCovers("/modules/*/name/*", "/modules/3/name")).toBe(true);
		expect(pointerCovers("/modules/*/case_list/label", "/modules/0/name")).toBe(
			false,
		);
		expect(pointerCovers("/modules/*/name/en", "/modules/0/name")).toBe(false);
		// A record at a list or a map above a key the pattern names is not covered.
		expect(
			pointerCovers(
				"/modules/*/case_details/short/sort_elements/*/field",
				"/modules/0/case_details/short/sort_elements",
			),
		).toBe(false);
		expect(
			pointerCovers("/translations/*/app.display.name", "/translations"),
		).toBe(false);
		expect(pointerCovers("/translations/*/*", "/translations")).toBe(true);
	});
});

// ── Over the retained readings ───────────────────────────────────────────

describe("where each change stands", () => {
	it("refuses no entry of the register, and declares one change alone app-wide", () => {
		expect(firstPublishRegisterRefusals(FIRST_PUBLISH_CHANGES)).toEqual([]);
		expect(
			CURRENT_FIRST_PUBLISH_CHANGE_IDS.filter(
				(id) => "appWide" in FIRST_PUBLISH_CHANGES[id].at,
			),
		).toEqual(["forms-and-settings-rewritten"]);
	});

	it("refuses an entry that could never be seen apart from the change that stands everywhere", () => {
		const everywhere = FIRST_PUBLISH_CHANGES["forms-and-settings-rewritten"];
		const own = FIRST_PUBLISH_CHANGES["hidden-values-added"];
		expect(
			firstPublishRegisterRefusals({ a: everywhere, b: everywhere }),
		).toEqual([
			"The first-publish register declares a, b app-wide. One change alone may stand everywhere, keeping what no other change's place holds; two such changes stand at every place alike, so no difference could show one apart from the other.",
		]);
		expect(
			firstPublishRegisterRefusals({
				a: everywhere,
				b: { at: { kinds: [], places: () => [] } },
			}),
		).toEqual([
			"The first-publish change b declares no kind of place, so it stands only where the change declared app-wide stands and no difference could show it apart. Name the kinds of place its change makes a difference at.",
		]);
		expect(
			firstPublishRegisterRefusals({
				a: everywhere,
				b: {
					at: {
						kinds: ["app-wide"] as never,
						places: () => [],
					},
				},
			}),
		).toEqual([
			"The first-publish change b declares the kind of place \"app-wide\", which is the whole app's, the one app-wide change's alone.",
		]);
		expect(firstPublishRegisterRefusals({ a: everywhere, b: own })).toEqual([]);
	});

	it("refuses a change that applies and names no place, or a place of a kind its entry does not declare", async () => {
		const facts = await PAIRS["hidden-values-added"].on();
		const none: FirstPublishFacts = {
			...facts,
			generatedByForm: facts.generatedByForm.map((one) => ({
				...one,
				difference: { added: [], dropped: [], renamed: [] },
			})),
		};
		expect(() =>
			firstPublishChangePlaces(none, ["hidden-values-added"]),
		).toThrow(
			"The first-publish change hidden-values-added applies on this reading and its entry names no place it stands at.",
		);
		expect(
			firstPublishChangePlaces(facts, ["hidden-values-added"])[0]?.places,
		).not.toEqual([]);
	});

	it("places a case list icon's picture at the value that names it and among its menu's media, at the path HQ held and at the one it goes out at", async () => {
		// A short list's icon column whose picture CommCare HQ keeps at a path Nova cannot hold
		// (`assignMediaPaths` derives another): the first publish renames it there, so the map
		// and the menu's media listing lose the old path and gain the file's derivation.
		const held = `jr://file/commcare/${HASH_B}.png`;
		const iconFile = file(held, HASH_A, "first-publish-list-icon");
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name"),
			imageMapColumn(uuid(2), "status", "Status", [
				imageMapEntry("a", iconFile.assetId),
			]),
		]);
		const read = (key: string) =>
			readAs(
				doc,
				{
					expand: {
						assets: adoptionExportBoundary(doc, [], [iconFile], TARGET).assets,
					},
					...onMenu((menu) => {
						const short = (
							menu as unknown as {
								case_details: {
									short: {
										columns: { enum?: { key: string; value: Json }[] }[];
									};
								};
							}
						).case_details.short;
						for (const column of short.columns)
							for (const item of column.enum ?? []) {
								item.key = imageMapEnumKey(key);
								item.value = { en: held };
							}
					}),
				},
				{
					media: {
						resolve: (path) =>
							path === held
								? {
										kind: "asset",
										assetId: iconFile.assetId,
										mediaKind: "image",
									}
								: { kind: "no-entry" },
					},
				},
			);
		const facts = factsOf(await read("a"), { mediaFiles: [iconFile] });
		const approved = (input: FirstPublishFacts) => {
			const signed = birthPublishSubjects(
				input,
				firstPublishChangesFor(input),
			).find(([id]) => id === "media-files-renamed");
			expect(signed).toBeDefined();
			return signed;
		};
		const replacement = factsOf(await read("b"), { mediaFiles: [iconFile] });
		expect(approved(facts)).not.toEqual(approved(replacement));
		expect(applies("media-files-renamed", facts)).toBe(true);
		const [placed] = firstPublishChangePlaces(facts, ["media-files-renamed"]);
		const pointer = held.replaceAll("~", "~0").replaceAll("/", "~1");
		const derived = `jr://file/${wirePathFor(HASH_A, ".png")}`
			.replaceAll("~", "~0")
			.replaceAll("/", "~1");
		expect(placed?.places).toEqual(
			expect.arrayContaining([
				`/app/multimedia_map/${pointer}`,
				`/app/multimedia_map/${derived}`,
				"/menu/0/case_details/short/columns/1/enum/0/value",
				`/menu/0/media/${pointer}`,
				`/menu/0/media/${derived}`,
			]),
		);
	});

	it("places each missing media claim at its own slot and names only unreferenced map entries as unused", async () => {
		const neutral = {
			...LEFT_OUT_ICON,
			path: "jr://file/commcare/image/empty.png",
		};
		const broken = {
			...LEFT_OUT_ICON,
			place: {
				kind: "form",
				menu: 0,
				form: 0,
				menuName: "Menu",
				name: "First",
			},
			pointer: "/modules/0/forms/0/media_image",
			slot: "form_icon",
			resolution: "unreadable",
		} as const;
		// HQ compares the literal map keys, so this relative key stays unused even though its suffix matches.
		const unused = broken.path.slice("jr://file/".length);
		const ids = [
			"media-references-with-no-file-removed",
			"broken-pictures-removed",
			"unused-media-entries-removed",
		] as const;
		const facts = await missingMediaFacts(
			[neutral, broken],
			[broken.path, unused],
		);
		expect(firstPublishChangePlaces(facts, ids)).toEqual([
			{
				id: ids[0],
				places: [
					placeOf("app", "multimedia_map", neutral.path),
					placeOf("menu", 0, "media", neutral.path),
					"/menu/0/media_image",
				],
			},
			{
				id: ids[1],
				places: [
					placeOf("app", "multimedia_map", broken.path),
					placeOf("form", "0.0", "media", broken.path),
					"/form/0.0/media_image",
				],
			},
			{ id: ids[2], places: [placeOf("app", "multimedia_map", unused)] },
		]);
		const referencedOnly = await missingMediaFacts(
			[neutral, broken],
			[broken.path],
		);
		expect(applies("unused-media-entries-removed", referencedOnly)).toBe(false);
	});

	it("distinguishes a file referenced only by a hint from an unused map entry", async () => {
		const reading = await readUnshownHint();
		const path = HINT_IMAGE;
		const facts = factsOf(reading);
		expect(facts.facts.mediaReferences).toEqual([]);
		expect(facts.facts.pendingMedia).toEqual([]);
		expect(facts.source.multimediaMap?.map((item) => item.path)).toEqual([
			path,
		]);
		expect(applies("unused-media-entries-removed", facts)).toBe(false);
		const id = "unshown-form-media-removed";

		const itext = "/form/0.0/xform/data/note/:itext/hint/en/image";
		expect(firstPublishChangePlaces(facts, [id])).toEqual([
			{
				id,
				places: [
					placeOf("app", "multimedia_map", path),
					placeOf("form", "0.0", "media", path),
					itext,
				],
			},
		]);
		for (const usage of ["label-and-hint", "shared-text"] as const) {
			const shared = factsOf(await readUnshownHint(usage));
			expect(shared.facts.mediaReferences.map((ref) => ref.path)).toEqual([
				path,
			]);
			expect(applies(id, shared)).toBe(true);
			expect(firstPublishChangePlaces(shared, [id])).toEqual([
				{ id, places: [itext] },
			]);
		}
	});

	it("discloses only a missing file after rereading a Web Apps hint whose HQ download returned 404", async () => {
		const first = await readUnshownHint();
		const runsOn = ["web-apps"] as const;
		const planned = planReadingMedia({
			source: first.source,
			appId: first.draft.doc.appId,
			references: hqMediaReferencesOf(first.draft.facts),
			runsOn,
		});
		expect(
			planned.plan.files.map((file) => [file.key, file.availabilityOnly]),
		).toEqual([["CommCareImage/hint", true]]);
		const plan = {
			...planned.plan,
			verdicts: { "CommCareImage/hint": { kind: "missing" } as const },
		};
		const reading = await readUnshownHint("hint", plan);
		const media = readingMediaFindings({ media: planned.media, plan, runsOn });
		expect(media.findings).toEqual([]);
		expect(reading.draft.facts.unheldMedia).toEqual([]);
		expect(
			reading.draft.facts.pendingMedia.map((ref) => [ref.path, ref.slot]),
		).toEqual([[HINT_IMAGE, "unheld_itext"]]);
		const facts = factsOf(reading, { mediaClaims: media.claims });
		expect(
			firstPublishChangesFor(facts).ids.filter((id) =>
				[
					"unshown-form-media-removed",
					"media-references-with-no-file-removed",
					"broken-pictures-removed",
					"unused-media-entries-removed",
				].includes(id),
			),
		).toEqual(["media-references-with-no-file-removed"]);
	});

	it("keeps the approved broken menu picture with the HQ file and ignores its upload metadata", async () => {
		const doc = followUpDoc();
		const read = async (remoteId: string, version: number) => {
			const reading = await readAs(
				doc,
				{
					root: {
						multimedia_map: {
							[HINT_IMAGE]: { ...mediaMapItem(remoteId), version },
						},
					},
					...onMenu((menu) => {
						menu.media_image = { en: HINT_IMAGE };
					}),
				},
				{ media: { resolve: () => ({ kind: "unreadable" }) } },
			);
			const runsOn = ["web-apps"] as const;
			const plan = planHqMedia({
				references: hqMediaReferencesOf(reading.draft.facts),
				multimediaMap: reading.source.multimediaMap ?? [],
				runsOn,
				contentValid: null,
				lazyLoadVideos: false,
			});
			expect(plan.files.map((file) => file.multimediaId)).toEqual([remoteId]);
			const files = mediaFindings({
				plan,
				verdicts: { [`CommCareImage/${remoteId}`]: { kind: "missing" } },
				runsOn,
			});
			expect([...plan.findings, ...files.findings]).toEqual([]);
			expect(
				files.claims.map((claim) => [
					claim.brokenPicture,
					claim.reference.pointer,
				]),
			).toEqual([[true, "/modules/0/media_image"]]);
			const facts = factsOf(reading, { mediaClaims: files.claims });
			const signed = birthPublishSubjects(
				facts,
				firstPublishChangesFor(facts),
			).find(([id]) => id === "broken-pictures-removed");
			expect(signed).toBeDefined();
			return signed;
		};
		const before = await read("original", 1);
		expect(await read("original", 2)).toEqual(before);
		expect(await read("replacement", 2)).not.toEqual(before);
	});

	it.each([
		"choice",
		"language",
		"message",
		"shared text",
		"inherited language",
	] as const)(
		"keeps a missing Web Apps picture with its physical itext recipient (%s)",
		async (scenario) => {
			const inspect = async (
				text: string,
				languages: string[],
				shared: string | null,
				reversed = false,
				appLanguages = ["en", "es"],
			) => {
				const choices = reversed
					? ["Third", "Second", "First"]
					: ["First", "Second", "Third"];
				const doc = inSpanish(
					buildDoc({
						modules: [
							{
								uuid: "recipient-menu",
								name: "Visits",
								forms: [
									{
										uuid: "recipient-form",
										name: "Visit",
										type: "survey",
										fields: [
											f({
												uuid: testUuid("recipient-choice"),
												id: "choice",
												kind: "single_select",
												label: proseText("Pick"),
												optionsSource: {
													kind: "inline",
													options: choices.map((value) => ({
														uuid: testUuid(value),
														value: value.toLowerCase(),
														label: proseText(value),
													})),
												},
											}),
											f({
												uuid: testUuid("recipient-note"),
												id: "note",
												kind: "text",
												label: proseText("Note"),
												hint: proseText("Note hint"),
												validate: ". != 'bad'",
												validate_msg: proseText("Note warning"),
											}),
										],
									},
								],
							},
						],
					}),
					new Map(),
				);
				const reading = await readAs(doc, {
					root: { langs: appLanguages },
					xml: (xml) => {
						const parsed = parseXml(xml);
						const translations = findAll(
							(el: Element) => el.name === "translation",
							parsed.children.filter(isTag),
						);
						if (translations.length !== 2)
							throw new Error("Expected English and Spanish itext.");
						const findText = (tr: Element, contents: string) =>
							tr.children
								.filter(isTag)
								.find((el) =>
									el.children
										.filter(isTag)
										.some(
											(v) =>
												v.name === "value" &&
												v.children.some(
													(n) => n.type === "text" && n.data === contents,
												),
										),
								);
						for (const tr of translations) {
							const target = findText(tr, text);
							if (!target) throw new Error(`Source label ${text} was missing.`);
							if (languages.includes(tr.attribs.lang))
								target.children.push(
									new Element("value", { form: "image" }, [
										new Text(HINT_IMAGE),
									]),
								);
							if (shared) {
								const other = findText(tr, shared);
								if (!other)
									throw new Error("Expected the other choice's own text.");
								for (const label of findAll(
									(el: Element) =>
										el.name === "label" &&
										el.attribs.ref?.includes(`'${other.attribs.id}'`) === true,
									parsed.children.filter(isTag),
								))
									label.attribs.ref = label.attribs.ref.replace(
										other.attribs.id,
										target.attribs.id,
									);
								removeElement(other);
							}
						}
						return serializeXml(parsed);
					},
				});
				const plan = planHqMedia({
					references: hqMediaReferencesOf(reading.draft.facts),
					multimediaMap: [],
					runsOn: ["web-apps"],
					contentValid: null,
					lazyLoadVideos: false,
				});
				expect(plan.findings).toEqual([]);
				expect(plan.claims).toHaveLength(shared ? 2 : 1);
				const facts = factsOf(reading, { mediaClaims: plan.claims });
				const id = "media-references-with-no-file-removed";
				expect(firstPublishChangesFor(facts).ids).toContain(id);
				const signed = birthPublishSubjects(
					facts,
					firstPublishChangesFor(facts),
				).find(([entry]) => entry === id);
				expect(signed).toBeDefined();
				return signed;
			};
			if (scenario === "inherited language") {
				// Exactly the same English XML value. French has no translation
				// in this form and receives the default value in a French app.
				for (const text of ["First", "Note hint"]) {
					const earlier = await inspect(text, ["en"], null);
					const expanded = await inspect(text, ["en"], null, false, [
						"en",
						"es",
						"fr",
					]);
					expect(expanded).not.toEqual(earlier);
					expect(
						await inspect(text, ["en"], null, false, ["en", "fr", "es"]),
					).toEqual(expanded);
				}
			} else if (scenario === "message") {
				expect(await inspect("Note hint", ["en"], null)).not.toEqual(
					await inspect("Note warning", ["en"], null),
				);
			} else if (scenario === "shared text") {
				expect(await inspect("First", ["en"], "Second")).not.toEqual(
					await inspect("First", ["en"], "Third"),
				);
			} else {
				const first = await inspect("First", ["en"], null);
				expect(await inspect("First", ["en"], null, true)).toEqual(first);
				if (scenario === "choice")
					expect(await inspect("Second", ["en"], null, true)).not.toEqual(
						first,
					);
				else
					expect(await inspect("First", ["en", "es"], null)).not.toEqual(first);
			}
		},
	);
	it.each(["same mapping", "other mapping"] as const)(
		"recognizes the enum key whose label the first publish trims (%s)",
		async (mode) => {
			const doc = patients([
				plainColumn(uuid(1), "case_name", "Name"),
				idMappingColumn(uuid(2), "notes", "Status", [
					idMappingEntry("first", "Held"),
					idMappingEntry("second", "Held"),
				]),
			]);
			const subjects = async (key: string, reverse: boolean) => {
				const facts = factsOf(
					await readAs(
						doc,
						onMenu((menu) => {
							for (const detail of Object.values(menu.case_details) as Json[]) {
								const columns = detail.columns as
									| { enum?: { key: string; value: Json }[] }[]
									| undefined;
								for (const col of columns ?? []) {
									for (const entry of col.enum ?? [])
										if (entry.key === key) entry.value.en = " Held ";
									if (reverse) col.enum?.reverse();
								}
							}
						}),
					),
				);
				const id = facts.facts.sameStateRewrites.find((row) =>
					row.path.includes("/enum/"),
				)?.register;
				if (!id)
					throw new Error(
						"The real reader did not report the edited enum label.",
					);
				const keys = publishChangeSubjects(facts, [id]).get(id);
				return [...(keys ?? [])]
					.filter(([, place]) => place.includes("/enum/"))
					.map(([k]) => k)
					.sort();
			};
			const before = await subjects("first", false);
			expect(before.length).toBeGreaterThan(0);
			const after = await subjects(
				mode === "same mapping" ? "first" : "second",
				true,
			);
			expect(after.length).toBe(before.length);
			if (mode === "same mapping") expect(after).toEqual(before);
			else expect(after).not.toEqual(before);
		},
	);
	it("follows distinct captions of duplicate-property, duplicate-format columns", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name"),
			...["Visit", "Referral"].map((caption, i) =>
				idMappingColumn(uuid(i + 2), "notes", caption, [
					idMappingEntry("held", "Worker"),
				]),
			),
		]);
		const subjects = async (caption: string, reversed: boolean) => {
			const facts = factsOf(
				await readAs(
					doc,
					onMenu((menu) => {
						for (const detail of Object.values(menu.case_details) as Record<
							string,
							unknown
						>[]) {
							const columns = detail.columns as
								| {
										header: { en: string };
										enum?: { value: { en: string } }[];
								  }[]
								| undefined;
							if (!columns) continue;
							for (const column of columns)
								if (column.header.en === caption && column.enum?.[0])
									column.enum[0].value.en = " Worker ";
							if (reversed) columns.reverse();
						}
					}),
				),
			);
			const row = facts.facts.sameStateRewrites.find((row) =>
				row.path.includes("/enum/"),
			);
			if (!row)
				throw new Error("Expected the reader to report the changed mapping.");
			return [
				...(publishChangeSubjects(facts, [row.register]).get(row.register) ??
					[]),
			]
				.filter(([, p]) => p.includes("/enum/"))
				.map(([k]) => k)
				.sort();
		};
		const before = await subjects("Visit", false);
		expect(before.length).toBeGreaterThan(0);
		expect(await subjects("Visit", true)).toEqual(before);
		expect(await subjects("Referral", true)).not.toEqual(before);
	});
	it.each(["different meanings", "identical meanings"] as const)(
		"binds consent among equally captioned duplicate columns (%s)",
		async (scenario) => {
			const doc = patients([
				plainColumn(uuid(1), "case_name", "Name"),
				...["North", "South"].map((tail, i) =>
					idMappingColumn(uuid(2 + i), "notes", "Queue", [
						idMappingEntry("held", "Worker"),
						idMappingEntry(
							"other",
							scenario === "different meanings" ? tail : "Same",
						),
					]),
				),
			]);
			const subjects = async (owners: number[], reverse: boolean) => {
				const facts = factsOf(
					await readAs(
						doc,
						onMenu((menu) => {
							for (const detail of Object.values(menu.case_details) as Json[]) {
								const rows = detail.columns as
									| { enum?: { value: { en: string } }[] }[]
									| undefined;
								if (!rows) continue;
								const peers = rows.filter((row) => row.enum?.length);
								for (const i of owners) {
									const entry = peers[i]?.enum?.[0];
									if (!entry)
										throw new Error("Expected two matching source columns.");
									entry.value.en = " Worker ";
								}
								if (reverse) rows.reverse();
							}
						}),
					),
				);
				const row = facts.facts.sameStateRewrites.find((row) =>
					row.path.includes("/enum/"),
				);
				if (!row)
					throw new Error(
						"Expected the real reader to account for the changed labels.",
					);
				return [
					...(publishChangeSubjects(facts, [row.register]).get(row.register) ??
						[]),
				]
					.filter(([, p]) => p.includes("/enum/"))
					.map(([k]) => k)
					.sort();
			};
			const first = await subjects([0], false);
			expect(first.length).toBeGreaterThan(0);
			if (scenario === "different meanings") {
				expect.soft(await subjects([0], true)).toEqual(first);
				expect(await subjects([1], true)).not.toEqual(first);
			} else {
				// The two native recipients are indistinguishable. A loss moving to the
				// second displayed slot requires a new review. Two equal losses do not.
				expect(await subjects([0], true)).not.toEqual(first);
				expect(await subjects([0, 1], true)).toEqual(
					await subjects([0, 1], false),
				);
			}
		},
	);
	it.each(["same link", "other link"] as const)(
		"recognizes the after-submit destination receiving a missing guard (%s)",
		async (mode) => {
			const doc = produce(
				buildShape(
					[
						{ flag: 0, carry: "c0", toMenu: false },
						{ flag: 0, carry: "c1", toMenu: false },
					],
					{ kind: "none" },
				),
				(draft) => {
					const link = draft.forms[testUuid("frm-check")].formLinks?.[0];
					if (!link?.datums?.[0]) throw new Error("Expected a carried case.");
					link.target = { type: "this-form" };
					link.datums[0].name = {
						kind: "selected-case",
						module: testUuid("mod-frogs"),
					};
				},
			);
			const subjects = async (self: boolean, reverse: boolean) => {
				const facts = factsOf(
					await readAs(
						doc,
						onMenu((menu) => {
							const source = menu.forms[0];
							const links = source.form_links as Json[];
							const selected = links.find(
								(link) => (link.form_id === source.unique_id) === self,
							);
							if (!selected || typeof selected.xpath !== "string")
								throw new Error("Expected a target with a case guard.");
							const end = selected.xpath.lastIndexOf(" and count(");
							if (end < 0)
								throw new Error(`Missing native guard: ${selected.xpath}`);
							selected.xpath = selected.xpath.slice(0, end);
							if (reverse) links.reverse();
						}),
					),
				);
				const id = "link-held-case-guards-added";
				expect(
					facts.facts.sameStateRewrites.filter((row) => row.register === id),
				).toHaveLength(1);
				return [
					...(publishChangeSubjects(facts, [id]).get(id)?.keys() ?? []),
				].sort();
			};
			const prior = await subjects(true, false);
			const current = await subjects(mode === "same link", true);
			expect(
				current.every((key, index) => key === prior[index]) &&
					current.length === prior.length,
			).toBe(mode === "same link");
		},
	);
	it("keeps repeated after-submit targets with the case the worker carries", async () => {
		const doc = buildShape(
			[
				{ flag: 0, carry: "c0", toMenu: false },
				{ flag: 0, carry: "c1", toMenu: false },
			],
			{ kind: "none" },
		);
		const subjects = async (value: string, reverse: boolean) => {
			const facts = factsOf(
				await readAs(
					doc,
					onMenu((menu) => {
						const links = menu.forms[0].form_links as Json[];
						const selected = links.find(
							(row) =>
								typeof row.xpath === "string" &&
								row.xpath.includes(`'${value}'`),
						);
						if (!selected || typeof selected.xpath !== "string")
							throw new Error("Missing the native guard for the carried case.");
						const end = selected.xpath.lastIndexOf(" and count(");
						if (end < 0) throw new Error("Expected a guarded destination.");
						selected.xpath = selected.xpath.slice(0, end);
						if (reverse) links.reverse();
					}),
				),
			);
			const id = "link-held-case-guards-added";
			expect(
				facts.facts.sameStateRewrites.filter((row) => row.register === id),
			).toHaveLength(1);
			return [
				...(publishChangeSubjects(facts, [id]).get(id)?.keys() ?? []),
			].sort();
		};
		const first = await subjects("c0", false);
		expect.soft(await subjects("c0", true)).toEqual(first);
		expect(await subjects("c1", true)).not.toEqual(first);
	});
	it("keeps a validation message with the actual rule the worker must pass", async () => {
		const doc = caseListTextsDoc();
		const subjects = async (word: string) => {
			const facts = factsOf(
				await readAs(
					doc,
					onMenu((menu) => {
						const prompts = menu.search_config.properties as {
							name: string;
							validations?: { test: string; text: { en: string } }[];
						}[];
						const check = prompts.find((prompt) => prompt.name === "phone")
							?.validations?.[0];
						if (!check?.test.includes("none"))
							throw new Error("Missing the stored search check.");
						check.test = check.test.replace("none", word);
						check.text.en = " Say more ";
					}),
				),
			);
			const row = facts.facts.sameStateRewrites.find((row) =>
				row.path.endsWith("/validations/0/text"),
			);
			if (!row)
				throw new Error("Expected a concrete validation message consequence.");
			return [
				...(publishChangeSubjects(facts, [row.register]).get(row.register) ??
					[]),
			]
				.filter(([, p]) => p.endsWith("/validations/0/text"))
				.map(([key]) => key)
				.sort();
		};
		const original = await subjects("none");
		expect(original.length).toBeGreaterThan(0);
		expect(await subjects("another")).not.toEqual(original);
	});
	it.each(["same choice", "other choice"] as const)(
		"recognizes the answer whose blank translation the first publish fills (%s)",
		async (mode) => {
			const subjects = async (blank: string, reverse: boolean) => {
				const answers = reverse ? ["second", "first"] : ["first", "second"];
				const doc = inSpanish(
					buildDoc({
						modules: [
							{
								uuid: "held-choice-menu",
								name: "Visits",
								forms: [
									{
										uuid: "held-choice-form",
										type: "survey",
										name: "Visit",
										fields: [
											f({
												uuid: testUuid("held-choice-field"),
												kind: "single_select",
												id: "answer",
												label: proseText("Answer"),
												optionsSource: {
													kind: "inline",
													options: answers.map((value) => ({
														uuid: testUuid(value),
														value,
														label: proseText(value),
													})),
												},
											}),
										],
									},
								],
							},
						],
					}),
					new Map(),
				);
				const facts = factsOf(
					await readAs(doc, {
						xml: (xml) => {
							const parsed = parseXml(xml);
							const items = findAll(
								(el: Element) => el.name === "item",
								parsed.children.filter(isTag),
							);
							const item = items.find((el) =>
								el.children
									.filter(isTag)
									.some(
										(child) =>
											child.name === "value" &&
											child.children.some(
												(n) => n.type === "text" && n.data === blank,
											),
									),
							);
							const ref = item?.children
								.filter(isTag)
								.find((el) => el.name === "label")?.attribs.ref;
							if (!ref) throw new Error("Expected a choice itext reference.");
							const tr = findAll(
								(el: Element) =>
									el.name === "translation" && el.attribs.lang === "es",
								parsed.children.filter(isTag),
							)[0];
							const label = tr?.children
								.filter(isTag)
								.find((el) => ref.includes(`'${el.attribs.id}'`));
							if (!label) throw new Error("Expected a Spanish choice label.");
							for (const v of label.children.filter(isTag)) v.children = [];
							return serializeXml(parsed);
						},
					}),
				);
				expect(facts.facts.forms[0]?.blankTranslations).toBe(1);
				return [
					...(publishChangeSubjects(facts, ["blank-translations-filled"])
						.get("blank-translations-filled")
						?.keys() ?? []),
				].sort();
			};
			const before = await subjects("first", false);
			const after = await subjects(
				mode === "same choice" ? "first" : "second",
				true,
			);
			if (mode === "same choice") expect(after).toEqual(before);
			else expect(after).not.toEqual(before);
		},
	);
	it("places a search's guard at the Search field a value it guards comes from, never at another field of the menu", async () => {
		// The menu's `region` field reaches the search as quoted text, so Nova's search guards it; its
		// `dob` field holds no check either and reaches no guard, so a check added there would be a
		// change no entry declares, not this one.
		const facts = await PAIRS["search-value-guards"].on();
		const [placed] = firstPublishChangePlaces(facts, ["search-value-guards"]);
		const fields = (placed?.places ?? []).filter((place) =>
			place.includes("/search_config/properties/"),
		);
		expect(fields).toEqual(["/menu/0/search_config/properties/0/validations"]);
	});

	it("bounds consent to the affected legacy datetime writers in a form with many case properties", async () => {
		const count = 32;
		const reading = await readExport(registrationDoc(count), TARGET);
		const base = factsOf(reading);
		const readId = base.source.modules[0].forms[0].readUniqueId;
		const register = "date-and-time-saved-as-hq-stores-it" as const;
		const rows = Array.from({ length: count }, (_, i) => ({
			entry: "/form/generated/datetime-sibling",
			path: `/_attachments/${readId}.xml`,
			register,
			removedInputs: [["datetime-question", `/data/time_${i}`] as const],
		}));
		const project = (size: number) => {
			const facts = {
				...base,
				facts: { ...base.facts, sameStateRewrites: rows.slice(0, size) },
			};
			const raw = { ...facts.source.raw };
			Object.defineProperty(raw, "_attachments", {
				enumerable: true,
				get: () => {
					throw new Error("Datetime comparison read the whole attachment");
				},
			});
			return [
				...(publishChangeSubjects(
					{ ...facts, source: { ...facts.source, raw } },
					[register],
				).get(register) ?? []),
			];
		};
		const all = project(count),
			one = project(1);
		expect(one.length).toBeGreaterThan(1);
		expect(all.length).toBe(one.length * count);
		expect(all.every(([key]) => key.length === 64)).toBe(true);
	});
	it("bounds each case writer subject and keeps unrelated actions and attachments out of its approval", async () => {
		const facts = await PAIRS["case-names-checked"].on();
		const read = (input: FirstPublishFacts) => [
			...(publishChangeSubjects(input, ["case-names-checked"]).get(
				"case-names-checked",
			) ?? []),
		];
		const original = read(facts);
		expect(original.length).toBeGreaterThan(0);
		const raw = structuredClone(facts.source.raw);
		const modules = raw.modules as {
			forms: { actions: Record<string, unknown> }[];
		}[];
		modules[0].forms[0].actions.close_case = {
			condition: { type: "never" },
			diagnostic: "another independent action",
		};
		const large = "unrelated stored attachment ".repeat(4096);
		(raw._attachments as Record<string, string>)["unrelated.xml"] = large;
		// Loading an unrelated attachment or walking the action container
		// would duplicate that source for every property participating in review.
		Object.defineProperty(raw, "_attachments", {
			enumerable: true,
			get: () => {
				throw new Error("Case comparison read an attachment");
			},
		});
		expect(read({ ...facts, source: { ...facts.source, raw } })).toEqual(
			original,
		);
		for (const [key, place] of original) {
			expect(key).toMatch(/^[a-f0-9]{64}$/);
			expect(place).toContain("/form/0.0/xform/data/");
		}
	});
	it("names a stored pointer's place by the form or menu at its position", async () => {
		const { source } = await PAIRS["case-names-checked"].on();
		const positions = formPositionsOf(source);
		const readId = source.modules[0]?.forms[0]?.readUniqueId;
		expect(placeOfStoredPointer(positions, `/_attachments/${readId}.xml`)).toBe(
			"/form/0.0/xform",
		);
		expect(
			placeOfStoredPointer(positions, "/modules/0/forms/0/actions/open_case"),
		).toBe("/form/0.0/actions/open_case");
		expect(
			placeOfStoredPointer(positions, "/modules/0/case_details/short/filter"),
		).toBe("/menu/0/case_details/short/filter");
		expect(
			placeOfStoredPointer(positions, "/translations/en/app.display.name"),
		).toBe("/app/translations/en/app.display.name");
		expect(
			placeOfStoredPointer(positions, "/_attachments/no-such-form.xml"),
		).toBeNull();
	});
});

describe("over CommCare HQ's retained sources", () => {
	it("covers every same-state record by the paths of the entry it names", async () => {
		const readings = await retainedReadings();
		expect(readings.length).toBeGreaterThanOrEqual(3);
		const uncovered: string[] = [];
		for (const reading of readings)
			for (const record of reading.draft.facts.sameStateRewrites)
				if (!coveredByItsEntry(record))
					uncovered.push(`${reading.name}: ${record.register} ${record.path}`);
		expect(uncovered).toEqual([]);
	});

	it("gives each choice's list back from what the birth stores, and only the Web Apps lines and a line a worker meets on Android alone move under another declaration", async () => {
		let choices = 0;
		for (const reading of await retainedReadings()) {
			const rows = adoptedIdentityRows(
				reading.draft.identities,
				reading.input.modules,
			);
			if (!rows.ok) throw new Error(`${reading.name}: no id at ${rows.at}`);
			for (const choice of choicesOf(reading)) {
				const facts = factsOf(reading, { choice });
				const view = firstPublishChangesFor(facts);
				expect(view.ids[0]).toBe("forms-and-settings-rewritten");
				const written = adoptedAppBaselineWrite({
					remoteAppId: REMOTE_APP_ID,
					source: reading.source,
					prepared: adoptionExportBoundary(facts.doc, [], [], TARGET),
					target: TARGET_KEY,
					identity: targetWireIdentity(rows.rows),
					novaRevision: 1,
					mediaFiles: {},
					observedAt: "2026-11-15T00:00:00.000Z",
					firstPublish: firstPublishListToStore(view, reading.draft.facts),
				});
				if (
					written.firstPublish.kind !== "set" ||
					written.firstPublish.list === null
				)
					throw new Error("The birth stores no list.");
				const stored = written.firstPublish.list;
				expect(stored.of).toBe("first-publish");
				expect(firstPublishViewFromStored(stored, facts.doc)).toEqual(view);
				const moving = new Set<CurrentFirstPublishChangeId>([
					"web-apps-turned-off",
					"web-apps-turned-on",
					...FIRST_PUBLISH_PLATFORM.keys(),
				]);
				const recorded = [...FIRST_PUBLISH_PLATFORM.keys()].filter((id) =>
					FIRST_PUBLISH_CHANGES[id].recorded?.(reading.draft.facts),
				);
				for (const runsOnlyOn of ["android", "web-apps", undefined] as const) {
					const other = firstPublishViewFromStored(stored, {
						connectType: facts.doc.connectType,
						appSettings: { ...facts.doc.appSettings, runsOnlyOn },
					});
					expect(other.ids.filter((id) => !moving.has(id))).toEqual(
						view.ids.filter((id) => !moving.has(id)),
					);
					expect(
						other.ids.filter((id) => FIRST_PUBLISH_PLATFORM.has(id)),
					).toEqual(
						recorded.filter(
							(id) =>
								!runsOnlyOn || FIRST_PUBLISH_PLATFORM.get(id) === runsOnlyOn,
						),
					);
				}
				choices++;
			}
		}
		expect(choices).toBeGreaterThanOrEqual(3);
	});

	it("reads a stored list of the next publish back as a view of that kind, with a Web Apps line only where the setting differs", () => {
		const next = {
			ids: ["case-settings-respelled"] as const,
			webAppsOnInHq: true,
			of: "next-publish",
		} as const;
		expect(
			firstPublishViewFromStored(next, {
				connectType: null,
				appSettings: {
					runsOnlyOn: undefined,
					showIncompleteForms: false,
				},
			}),
		).toEqual({
			ids: ["case-settings-respelled"],
			touchesWorkers: false,
			of: "next-publish",
		});
		expect(
			firstPublishViewFromStored(next, {
				connectType: null,
				appSettings: {
					runsOnlyOn: "android",
					showIncompleteForms: false,
				},
			}),
		).toEqual({
			ids: ["case-settings-respelled", "web-apps-turned-off"],
			touchesWorkers: true,
			of: "next-publish",
		});
	});

	it("lists a form's title written anew only where the app runs on Android, and keeps it for a later declaration", {
		timeout: 60_000,
	}, async () => {
		const id = "form-titles-written";
		const recorded = await PAIRS[id].on();
		const under = (runsOnlyOn: Platform | null): FirstPublishFacts => ({
			...recorded,
			choice: { ...recorded.choice, runsOnlyOn },
		});
		expect(applies(id, under(null))).toBe(true);
		expect(applies(id, under("android"))).toBe(true);
		// Web Apps titles a form by its menu entry's text, never by its title.
		const webApps = firstPublishChangesFor(under("web-apps"));
		expect(webApps.ids).not.toContain(id);
		const list = firstPublishListToStore(webApps, recorded.facts);
		expect(list.ids).toContain(id);
		// Nova's own export writes the form's name there, so its reading records nothing.
		const plain = await PAIRS[id].off();
		expect(
			plain.facts.sameStateRewrites.filter((record) => record.register === id),
		).toEqual([]);
	});

	it("lists a Sort by entry left with a blank name only where the app runs on Android, and keeps it for a later declaration", {
		timeout: 60_000,
	}, async () => {
		const id = "sort-by-entry-with-a-blank-name-dropped";
		const recorded = await PAIRS[id].on();
		const under = (runsOnlyOn: Platform | null): FirstPublishFacts => ({
			...recorded,
			choice: { ...recorded.choice, runsOnlyOn },
		});
		expect(applies(id, under(null))).toBe(true);
		expect(applies(id, under("android"))).toBe(true);
		// Web Apps shows no Sort by entry for an invisible column.
		const webApps = firstPublishChangesFor(under("web-apps"));
		expect(webApps.ids).not.toContain(id);
		// A list stored under Web Apps alone keeps the reading's line, which shows once the app runs on Android.
		const list = firstPublishListToStore(webApps, recorded.facts);
		expect(list.ids).toContain(id);
		const stored = {
			ids: list.ids,
			webAppsOnInHq: recorded.source.cloudcareEnabled,
			of: "first-publish",
		} as const;
		expect(
			firstPublishViewFromStored(stored, {
				connectType: null,
				appSettings: {
					runsOnlyOn: "web-apps",
					showIncompleteForms: false,
				},
			}).ids,
		).not.toContain(id);
		expect(
			firstPublishViewFromStored(stored, {
				connectType: null,
				appSettings: {
					runsOnlyOn: "android",
					showIncompleteForms: false,
				},
			}).ids,
		).toContain(id);
		expect(
			firstPublishViewFromStored(stored, {
				connectType: null,
				appSettings: {
					runsOnlyOn: undefined,
					showIncompleteForms: false,
				},
			}).ids,
		).toContain(id);
		// A reading that records no such rule stores no line.
		const plain = await PAIRS[id].off();
		expect(
			firstPublishListToStore(firstPublishChangesFor(plain), plain.facts).ids,
		).not.toContain(id);
	});
});

/**
 * Every JSON Pointer at which `before` and `after` part ways, as deep as
 * either holds an object or a list there; a key of one of HQ's classes the
 * body leaves out holds the default HQ's wrap gives it
 * (`servedSchemaPropertyDefault`). A form's source is left out: the proof
 * lane compares it part by part (`proof/checks/xform_parts.py`), and a place
 * stands at a part of it.
 */
function storedDifferences(
	before: unknown,
	after: unknown,
	at = "",
): readonly string[] {
	if (at === "/_attachments") return [];
	const object = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null;
	if (!object(before) && !object(after))
		return JSON.stringify(before) === JSON.stringify(after) ? [] : [at];
	if (
		object(before) &&
		object(after) &&
		Array.isArray(before) !== Array.isArray(after)
	)
		return [at];
	const one = object(before) ? before : {};
	const other = object(after) ? after : {};
	const docType = typeof other.doc_type === "string" ? other.doc_type : null;
	return [...new Set([...Object.keys(one), ...Object.keys(other)])].flatMap(
		(key) => {
			const served =
				!(key in other) && docType !== null
					? servedSchemaPropertyDefault(docType, key)
					: undefined;
			return storedDifferences(
				one[key],
				served?.known === true ? served.default : other[key],
				`${at}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
			);
		},
	);
}

/** CommCare HQ's stored app after a first publish's import of `facts`' body over the source: every
 *  top-level key the body carries replaced whole, every other kept
 *  (`models/applications.py::_merge_source_into_app`). */
function firstPublishStored(
	facts: FirstPublishFacts,
	project: PairProjectData,
): unknown {
	return { ...facts.source.raw, ...firstPublishBody(facts, project) };
}

/** The Project data a pair's publish carries beside its document: the tables it reads, the files it holds. */
interface PairProjectData {
	readonly lookups?: readonly LookupTableDefinition[];
	readonly mediaFiles?: readonly AdoptedMediaFile[];
}

/** Whether the place `location` is `place` or under it, `**` in `place` any run of steps. */
function placeStandsAt(place: string, location: string): boolean {
	const want = placeSteps(place);
	const got = placeSteps(location);
	const go = (i: number, j: number): boolean => {
		if (i === want.length) return true;
		if (want[i] === "**") {
			for (let k = j; k <= got.length; k++) if (go(i + 1, k)) return true;
			return false;
		}
		return j < got.length && want[i] === got[j] && go(i + 1, j + 1);
	};
	return go(0, 0);
}

function coveredByItsEntry(record: SameStateRewrite): boolean {
	const entry =
		FIRST_PUBLISH_CHANGES[record.register as CurrentFirstPublishChangeId];
	return entry?.paths.some((path) => pointerCovers(path, record.path)) === true;
}

// ── Each entry applies and does not ──────────────────────────────────────

interface Pair {
	readonly on: () => Promise<FirstPublishFacts>;
	readonly off: () => Promise<FirstPublishFacts>;
}

type Json = Record<string, unknown>;

/** A stored menu as the edits below reach into it. */
type StoredMenu = Json & {
	forms: Json[];
	case_list_form: Json;
	case_details: { short: Json & { sort_elements: Json[] } };
	search_config: Json & { default_properties: Json[] };
};

/**
 * A whole reading of `doc`'s export as CommCare HQ serves it, written for the
 * reading's project space, with `edits` made to the source as HQ's pages, an
 * author or an earlier Nova would store it.
 */
async function readAs(
	doc: BlueprintDoc,
	edits: ExportEdits = {},
	input: Partial<ReaderInput> = {},
): Promise<RegisterReading> {
	const source = await sourceFromBody(
		exportedBody(doc, {
			...edits,
			expand: { attachmentTarget: TARGET, ...edits.expand },
		}),
	);
	const reading = readWhole(doc.appId, source, {
		knownCaseTypes: knownCaseTypesOf(doc),
		...input,
	});
	if (!("draft" in reading))
		throw new Error(
			`The source read to an account: ${reading.codes.join(", ")}`,
		);
	return reading;
}

/**
 * The facts of a whole reading of `doc`'s export with `edits` made, where the
 * reader itself records what the entry reads, and of the export as Nova
 * writes it, where it records nothing of the kind.
 */
function editedPair(
	doc: () => BlueprintDoc,
	edits: ExportEdits,
	input: Partial<ReaderInput> = {},
): Pair {
	return {
		on: async () => factsOf(await readAs(doc(), edits, input)),
		off: async () =>
			factsOf(
				await readAs(
					doc(),
					edits.expand === undefined ? {} : { expand: edits.expand },
					input,
				),
			),
	};
}

/** Edits of the stored menus, each given the first menu. */
function onMenu(edit: (menu: StoredMenu) => void): ExportEdits {
	return {
		modules: (modules) => {
			edit(modules[0] as StoredMenu);
			return modules;
		},
	};
}

/** Each form's bind whose nodeset ends with `nodesetEnding` changed by `edit`. */
function editBind(
	nodesetEnding: string,
	edit: (attributes: Record<string, string>) => void,
): (xml: string) => string {
	return (xml) => {
		const document = parseXml(xml);
		const bind = findOne(
			(element: Element) =>
				element.name === "bind" &&
				(element.attribs.nodeset ?? "").endsWith(nodesetEnding),
			document.children.filter(isTag),
			true,
		);
		if (bind === null) return xml;
		edit(bind.attribs);
		return serializeXml(document);
	};
}

/** `text` with every `from` written as `to`: an author's respelling of a read. */
const respelled = (text: string | undefined, from: string, to: string) =>
	(text ?? "").split(from).join(to);

const WIDTH = "instance('commcaresession')/session/context/window_width";

/** A web app whose menu shows on wide screens alone. */
function widthDoc(): BlueprintDoc {
	return buildDoc({
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		modules: [
			{
				name: "Wide",
				displayCondition: {
					kind: "gt",
					left: {
						kind: "term",
						term: { kind: "session-context", field: "window_width" },
					},
					right: { kind: "term", term: literal(400) },
				},
				forms: [
					{
						name: "Form",
						type: "survey",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
		],
	});
}

/** A survey whose question shows where one date and time is before another. */
function instantDoc(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Menu",
				forms: [
					{
						name: "Form",
						type: "survey",
						fields: [
							f({ kind: "datetime", id: "start" }),
							f({ kind: "datetime", id: "end" }),
							f({
								kind: "text",
								id: "after",
								relevant: "#form/start < #form/end",
							}),
						],
					},
				],
			},
		],
	});
}

const KINDS_TABLE = "01890000-0000-7000-8000-000000000501" as LookupTableId;
const KINDS_CODE = "01890000-0000-7000-8000-000000000502" as LookupColumnId;
const KINDS_NAME = "01890000-0000-7000-8000-000000000503" as LookupColumnId;
const KINDS = [
	{
		id: KINDS_TABLE,
		name: "Kinds",
		tag: "kinds",
		columns: [
			{ id: KINDS_CODE, wireName: "code", label: "Code", dataType: "text" },
			{ id: KINDS_NAME, wireName: "name", label: "Name", dataType: "text" },
		],
	},
] as const;

/** The name of the kind whose code is `code`, read from the project space's table of kinds. */
const kindNamed = (code: Expression): Expression => ({
	kind: "table-lookup",
	tableId: KINDS_TABLE,
	resultColumnId: KINDS_NAME,
	where: eq(term(tableColumn(KINDS_TABLE, KINDS_CODE)), code),
});

/** A survey that works out the name of the kind coded `a` from the project space's table. */
function kindsDoc(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Kinds",
				forms: [
					{
						name: "Form",
						type: "survey",
						fields: [
							f({
								kind: "hidden",
								id: "kind_name",
								calculate: kindNamed({ kind: "term", term: literal("a") }),
							}),
						],
					},
				],
			},
		],
	});
}

const ROUND_KIND = testUuid("first-publish-round-kind");

/** A survey whose repeat works out, in each entry, the name of the kind the entry gives. */
function roundsDoc(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Rounds",
				forms: [
					{
						name: "Rounds",
						type: "survey",
						fields: [
							f({
								kind: "repeat",
								id: "visits",
								children: [
									f({ kind: "text", uuid: ROUND_KIND, id: "kind" }),
									f({
										kind: "hidden",
										id: "kind_name",
										calculate: kindNamed({
											kind: "term",
											term: { kind: "field", uuid: ROUND_KIND },
										}),
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
}

/** The project space's table of kinds, as a reading is told it. */
const KINDS_INPUT: Partial<ReaderInput> = {
	lookup: {
		table: (tag) =>
			tag === "kinds"
				? {
						tableId: KINDS_TABLE,
						column: (name) =>
							KINDS[0].columns.find((column) => column.wireName === name)?.id,
					}
				: undefined,
		definitions: new Map(KINDS.map((table) => [table.id, table])),
	} as ReaderInput["lookup"],
};

/** `text`'s read with Nova's empty-rows guard taken off: `if(count(rows) > 0, read, '')` read as `read`. */
function unguarded(text: string): string {
	const read = readFormSyntax(text);
	const node = read.ok ? read.node : undefined;
	const value = node?.kind === "call" ? node.args[1] : undefined;
	if (node?.kind !== "call" || node.name !== "if" || value === undefined)
		throw new Error("Nova printed no guarded read of the table here.");
	return text.slice(value.from, value.to);
}

const NOTES: SearchInputDef = {
	uuid: uuid(9),
	name: "notes",
	label: "Notes",
	kind: "simple",
	type: "text",
	property: "notes",
};

const notesIs = (value: string) => eq(prop("patient", "notes"), literal(value));

/** One menu of patients, its list filtered as given, searched by its notes. */
function searched(
	search: CaseSearchConfig,
	filter: NonNullable<CaseListConfig["filter"]>,
): BlueprintDoc {
	return patients([plainColumn(uuid(1), "case_name", "Name")], {
		searchInputs: [NOTES],
		search,
		list: { filter },
	});
}

/** The answer to the vector document's Search field `region`, as a search row reads it. */
const REGION_ANSWER =
	"instance('search-input:results')/input/field[@name = 'region']";

/** The first stored `_xpath_query` row of the first menu's search. */
function queryRow(menu: StoredMenu): Json {
	const row = menu.search_config.default_properties.find(
		(one) => one.property === "_xpath_query",
	);
	if (row === undefined)
		throw new Error("The search holds no _xpath_query row.");
	return row;
}

/** A follow-up of patients that saves its notes and asks one more question. */
function followUpDoc(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "notes",
								caseWrite: { caseType: "patient", property: "notes" },
							}),
							f({ kind: "text", id: "other" }),
						],
					},
				],
			},
		],
	});
}

const REGISTER_FORM = testUuid("first-publish-register");

/** A menu of patients whose case list offers the registration form of another menu. */
function registeringDoc(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Registration",
				caseType: "patient",
				forms: [
					{
						uuid: "first-publish-register",
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
		],
	});
	return produce(doc, (draft) => {
		const host = Object.values(draft.modules).find(
			(one) => one.name === "Patients",
		);
		if (host !== undefined)
			host.caseListRegistrationForm = {
				kind: "always",
				formUuid: REGISTER_FORM,
				afterSubmit: "case-list",
			};
	});
}

const MENU_ICON = "jr://file/commcare/image/menu.png";

/** A two-language app of one menu, and the one icon CommCare HQ holds a file for. */
function twoLanguageDoc(): BlueprintDoc {
	return inSpanish(
		buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
						},
					],
				},
			],
		}),
		new Map(),
	);
}

const MENU_ICON_INPUT: Partial<ReaderInput> = {
	media: {
		resolve: (path) =>
			path === MENU_ICON
				? {
						kind: "asset",
						assetId: testMediaAssetId("first-publish-menu-icon"),
						mediaKind: "image",
					}
				: { kind: "no-entry" },
	},
};

/** The first translation of a language other than the first with its first label left blank, in every form it holds. */
function withBlankSecondLabel(xml: string): string {
	const document = parseXml(xml);
	const translations = findAll(
		(element: Element) => element.name === "translation",
		document.children.filter(isTag),
	);
	const second = translations.find(
		(element) => element.attribs.default === undefined,
	);
	const label = second?.children
		.filter(isTag)
		.find((text) => (text.attribs.id ?? "").endsWith("-label"));
	const values = (label?.children ?? []).filter(isTag);
	if (values.length === 0) return xml;
	for (const value of values) value.children = [];
	return serializeXml(document);
}

/** A reading of `doc`'s export, and the same reading of a source that held none of Nova's nodes. */
function generatedPair(doc: () => BlueprintDoc): Pair {
	return {
		on: async () => {
			const reading = await readExport(doc(), TARGET);
			return factsOf(reading, { facts: withNoFoldedNodes(reading) });
		},
		off: async () => factsOf(await readExport(doc(), TARGET)),
	};
}

/** The base reading under the choice running on `runsOnlyOn`, over a source whose Web App setting is `webApps`. */
async function webAppsFacts(
	runsOnlyOn: Platform | undefined,
	webApps: boolean,
): Promise<FirstPublishFacts> {
	const base = await baseReading();
	return factsOf(base, {
		choice: choiceRunningOn(base, runsOnlyOn),
		source: await sourceWith(base.source, { cloudcare_enabled: webApps }),
	});
}

async function connectReading(): Promise<RegisterReading> {
	return readExport(hydrated(connectDeliverRename()), TARGET);
}

const file = (
	hqPath: string,
	contentHash: string,
	assetId: string,
): AdoptedMediaFile => ({
	hqPath,
	assetId: asMediaAssetId(testUuid(assetId)),
	contentHash,
	extension: ".png",
});
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** A menu's name map as CommCare HQ's page stores it. */
const menuNamed = (name: Json): ExportEdits =>
	onMenu((menu) => {
		menu.name = name;
	});

/** The Project data each pair whose document reads a table or holds a file publishes with. */
const PAIR_PROJECT_DATA: Partial<
	Record<CurrentFirstPublishChangeId, PairProjectData>
> = {
	"empty-rows-guard": {
		lookups: KINDS as unknown as readonly LookupTableDefinition[],
	},
	"row-predicate-current": {
		lookups: KINDS as unknown as readonly LookupTableDefinition[],
	},
	"media-maps-respelled": {
		mediaFiles: [
			{
				hqPath: MENU_ICON,
				assetId: testMediaAssetId("first-publish-menu-icon"),
				contentHash: HASH_A,
				extension: ".png",
			},
		],
	},
};

/** A menu icon whose path names no file CommCare HQ holds, handed off by the reading. */
const LEFT_OUT_ICON = {
	path: "jr://file/commcare/image/gone.png",
	mediaKind: "image",
	resolution: "no-entry",
	place: { kind: "menu", menu: 0, name: "Menu" },
	pointer: "/modules/0/media_image",
	slot: "module_icon",
} as const;

/** Build the source and collect the same plan and file-verdict claims acceptance hands the register. */
async function missingMediaFacts(
	pendingMedia: ReadFacts["pendingMedia"],
	mapped: readonly string[],
): Promise<FirstPublishFacts> {
	const base = await baseReading();
	const source = await sourceWith(base.source, {
		multimedia_map: Object.fromEntries(
			mapped.map((path, index) => [path, mediaMapItem(String(index + 1))]),
		),
	});
	const facts = { ...base.draft.facts, pendingMedia };
	const runsOn = ["web-apps"] as const;
	const plan = planHqMedia({
		references: hqMediaReferencesOf(facts),
		multimediaMap: source.multimediaMap ?? [],
		runsOn,
		contentValid: null,
		lazyLoadVideos: false,
	});
	const files = mediaFindings({
		plan,
		verdicts: Object.fromEntries(
			plan.files.map((file) => [file.key, { kind: "missing" } as const]),
		),
		runsOn,
	});
	expect([...plan.findings, ...files.findings]).toEqual([]);
	return factsOf(base, {
		source,
		facts,
		mediaClaims: [...plan.claims, ...files.claims],
	});
}

const HINT_IMAGE = "jr://file/commcare/image/hint.png";

async function readUnshownHint(
	usage: "hint" | "label-and-hint" | "shared-text" = "hint",
	plan: ReadingMediaPlan | null = null,
): Promise<RegisterReading> {
	const path = HINT_IMAGE;
	const doc = buildDoc({
		modules: [
			{
				name: "Menu",
				forms: [
					{
						name: "Form",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "note",
								label: "Note",
								hint: proseText("Keep this hint"),
							}),
						],
					},
				],
			},
		],
	});
	return readAs(
		doc,
		{
			root: { multimedia_map: { [path]: mediaMapItem("hint") } },
			xml: (xml) => {
				const hint = "<value>Keep this hint</value>";
				const mediaValue = `<value form="image">${path}</value>`;
				const withHint = xml.replace(hint, `${hint}${mediaValue}`);

				if (usage === "shared-text")
					return xml
						.replace(
							'<text id="note-hint"><value>Keep this hint</value></text>',
							"",
						)
						.replace("&apos;note-hint&apos;", "&apos;note-label&apos;")
						.replace("<value>Note</value>", `<value>Note</value>${mediaValue}`);
				return usage === "label-and-hint"
					? withHint.replace(
							"<value>Note</value>",
							`<value>Note</value>${mediaValue}`,
						)
					: withHint;
			},
		},
		{
			media: readingMediaIndex({
				source: {
					multimediaMap: [
						{
							path,
							multimediaId: "hint",
							mediaType: "CommCareImage",
							unreadable: false,
						},
					],
				},
				appId: doc.appId,
				plan,
			}),
		},
	);
}

const PAIRS: Readonly<Record<CurrentFirstPublishChangeId, Pair>> = {
	"forms-and-settings-rewritten": {
		on: async () => factsOf(await baseReading()),
		off: async () => factsOf(await readExport(countDoc(), TARGET)),
	},
	"hidden-values-added": generatedPair(registrationDoc),
	"case-names-checked": generatedPair(registrationDoc),
	"validation-counts-moved": generatedPair(countDoc),
	"validation-messages-composed": generatedPair(
		() => constraintMessageFixture("literal").doc,
	),
	// The comparison of two dates and times an author types bare.
	"instant-comparison": editedPair(instantDoc, {
		xml: editBind("/after", (bind) => {
			bind.relevant = "/data/start < /data/end";
			bind["vellum:relevant"] = "#form/start < #form/end";
		}),
	}),
	// A read of a table's column with no guard for a table with no rows.
	"empty-rows-guard": editedPair(
		kindsDoc,
		{
			expand: { lookupNaming: lookupWireNaming(KINDS) },
			xml: editBind("/kind_name", (bind) => {
				bind.calculate = unguarded(bind.calculate ?? "");
			}),
		},
		KINDS_INPUT,
	),
	// A read of the screen's width with no guard for a device that has none.
	"absent-session-value-guard": editedPair(
		widthDoc,
		onMenu((menu) => {
			menu.module_filter = `${WIDTH} > 400`;
		}),
	),
	// An entry's own answer read inside a row filter by its absolute path.
	"row-predicate-current": editedPair(
		roundsDoc,
		{
			expand: { lookupNaming: lookupWireNaming(KINDS) },
			xml: editBind("/kind_name", (bind) => {
				bind.calculate = respelled(
					bind.calculate,
					"current()/../kind",
					"/data/visits/kind",
				);
			}),
		},
		KINDS_INPUT,
	),
	// A search's answer quoted as CommCare HQ's documentation spells it, with
	// no guard of a quote mark inside the answer.
	"search-value-guards": editedPair(
		() => csqlVectorDoc(),
		onMenu((menu) => {
			queryRow(menu).defaultValue =
				`if(count(${REGION_ANSWER}), concat('village = "', ${REGION_ANSWER}, '"'), 'match-all()')`;
		}),
	),
	// A search's `today()` sent for CommCare HQ's server to work out.
	"search-today-device-day": editedPair(
		() =>
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [NOTES],
				list: { filter: lte(prop("patient", "dob"), today()) },
			}),
		onMenu((menu) => {
			queryRow(menu).defaultValue = csqlRow("dob <= today()");
		}),
	),
	// A form's update of its case under a condition CommCare HQ's page sets.
	"case-settings-respelled": editedPair(
		followUpDoc,
		onMenu((menu) => {
			const actions = menu.forms[0]?.actions as Record<string, Json>;
			(actions.update_case as Json).condition = {
				type: "if",
				question: "/data/other",
				answer: "x",
				operator: "=",
				doc_type: "FormActionCondition",
			};
		}),
	),
	// The search's filter rows in another order.
	"search-filter-rows-recut": editedPair(
		() => {
			const field: SearchInputDef = {
				uuid: uuid(9),
				name: "number",
				label: "Number",
				kind: "advanced",
				type: "text",
				predicate: whenInput(
					input(uuid(9)),
					neq(prop("patient", "phone"), input(uuid(9))),
				),
			};
			return patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [field],
				search: {},
				list: { filter: notesIs("open") },
			});
		},
		onMenu((menu) => {
			menu.search_config.default_properties.reverse();
		}),
	),
	// A sort over a property the list does not show.
	"sort-rule-kept-as-hidden-column": editedPair(
		() => patients([plainColumn(uuid(1), "case_name", "Name")]),
		onMenu((menu) => {
			menu.case_details.short.sort_elements = [
				{
					doc_type: "SortElement",
					field: "phone",
					type: "plain",
					direction: "ascending",
					blanks: "",
					display: {},
					sort_calculation: "",
				},
			];
		}),
	),
	// A several-case list's limit of -1, which CommCare HQ reads as its own default.
	"list-settings-respelled": editedPair(
		() =>
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				list: { selection: { kind: "multiple", maximum: 100 } },
			}),
		onMenu((menu) => {
			menu.case_details.short.max_select_value = -1;
		}),
	),
	// A row that reads no field on a menu whose forms read the search.
	"search-filter-joined-to-list": editedPair(
		() => searched({ formsReadSearch: true }, notesIs("open")),
		onMenu((menu) => {
			const rows = menu.search_config.default_properties;
			const [first] = rows;
			if (first !== undefined)
				rows.push({ ...first, defaultValue: `"notes = 'other'"` });
		}),
	),
	// A list clause no row restates, on a menu whose forms read the search.
	"search-restates-list-filter": editedPair(
		() => searched({ formsReadSearch: true }, notesIs("open")),
		onMenu((menu) => {
			menu.search_config.default_properties = [];
		}),
	),
	// A link that carries a case with no guard of it.
	"link-held-case-guards-added": editedPair(
		() => buildShape([{ carry: "c0", toMenu: false }], { kind: "none" }),
		onMenu((menu) => {
			const [first] = (menu.forms[0]?.form_links ?? []) as Json[];
			if (first !== undefined) first.xpath = "";
		}),
	),
	// A Register button's label with no text.
	"registration-label-fixed": editedPair(registeringDoc, {
		modules: (modules) => {
			const host = modules.find(
				(one) => (one.name as Json | undefined)?.en === "Patients",
			) as StoredMenu | undefined;
			if (host !== undefined) host.case_list_form.label = { en: "" };
			return modules;
		},
	}),
	// A translation left blank in a language other than the first.
	"blank-translations-filled": editedPair(
		() => localizationWireFixture("bilingual"),
		{ xml: withBlankSecondLabel },
	),
	"translation-overrides-folded": {
		// A translation of the app that words the first menu's name.
		on: async () =>
			factsOf(
				await readAs(
					followUpDoc(),
					{ root: { translations: { en: { "modules.m0": "Registration" } } } },
					{ appStrings: readingAppStrings(LOOKUP_CONTEXT_UNAVAILABLE) },
				),
			),
		off: async () =>
			factsOf(
				await readAs(
					followUpDoc(),
					{},
					{ appStrings: readingAppStrings(LOOKUP_CONTEXT_UNAVAILABLE) },
				),
			),
	},
	"connect-app-captures-location": {
		on: async () => {
			const reading = await connectReading();
			return factsOf(reading, {
				source: await sourceWith(reading.source, {
					auto_gps_capture: undefined,
				}),
			});
		},
		off: async () => factsOf(await connectReading()),
	},
	"location-list-setting-reset": {
		on: async () => {
			const base = await baseReading();
			return factsOf(base, {
				source: await sourceWith(base.source, {
					location_fixture_restore: "both_fixtures",
				}),
			});
		},
		off: async () => {
			const base = await baseReading();
			return factsOf(base, {
				source: await sourceWith(base.source, {
					location_fixture_restore: "project_default",
				}),
			});
		},
	},
	"web-apps-turned-off": {
		on: () => webAppsFacts("android", true),
		off: () => webAppsFacts(undefined, true),
	},
	"incomplete-forms-tile-hidden": editedPair(registrationDoc, {
		root: { cloudcare_enabled: true, profile: { properties: {} } },
	}),
	"web-apps-turned-on": {
		on: () => webAppsFacts(undefined, false),
		off: () => webAppsFacts("android", false),
	},
	"date-and-time-questions-split": {
		on: async () => {
			const reading = await readExport(registrationDoc(), TARGET);
			const split = choicesOf(reading).find((choice) => choice.split);
			if (split === undefined)
				throw new Error("A date and time question offers no split.");
			return factsOf(reading, { choice: split });
		},
		off: async () => factsOf(await readExport(registrationDoc(), TARGET)),
	},
	// A date and time a question's sibling saves in the spelling Nova wrote before.
	"date-and-time-saved-as-hq-stores-it": editedPair(registrationDoc, {
		xml: withBindAttribute(
			"/nova_datetime_seen",
			"calculate",
			serializeWire(typedInstantValue(FormPath.root().child("seen").toWire()), {
				target: "xform",
				constraint: false,
			}).text,
		),
	}),
	"media-paths-joined": {
		on: async () =>
			factsOf(await baseReading(), {
				mediaFiles: [
					file("jr://file/commcare/image/a.png", HASH_A, "provisional-1"),
					file("jr://file/commcare/image/b.png", HASH_A, "provisional-2"),
				],
			}),
		off: async () =>
			factsOf(await baseReading(), {
				mediaFiles: [
					file("jr://file/commcare/image/a.png", HASH_A, "provisional-1"),
					file("jr://file/commcare/image/b.png", HASH_B, "provisional-2"),
				],
			}),
	},
	"media-files-renamed": {
		on: async () =>
			factsOf(await baseReading(), {
				mediaFiles: [
					file(`jr://file/commcare/${HASH_B}.png`, HASH_A, "provisional-1"),
				],
			}),
		off: async () =>
			factsOf(await baseReading(), {
				mediaFiles: [
					file("jr://file/commcare/image/a.png", HASH_A, "provisional-1"),
				],
			}),
	},
	"media-references-with-no-file-removed": {
		on: () => missingMediaFacts([LEFT_OUT_ICON], []),
		off: () => missingMediaFacts([LEFT_OUT_ICON], [LEFT_OUT_ICON.path]),
	},
	"broken-pictures-removed": {
		on: () => missingMediaFacts([LEFT_OUT_ICON], [LEFT_OUT_ICON.path]),
		off: () => missingMediaFacts([LEFT_OUT_ICON], []),
	},
	"unshown-form-media-removed": {
		on: async () => factsOf(await readUnshownHint()),
		off: async () => factsOf(await baseReading()),
	},
	"unused-media-entries-removed": {
		on: async () => {
			const base = await baseReading();
			return factsOf(base, {
				source: await sourceWith(base.source, {
					multimedia_map: {
						"jr://file/commcare/image/unused.png": mediaMapItem("unused"),
					},
				}),
			});
		},
		off: async () => {
			const base = await baseReading();
			return factsOf(base, {
				source: await sourceWith(base.source, {
					multimedia_map: {
						"jr://file/commcare/image/logo.png": mediaMapItem("logo"),
					},
					logo_refs: {
						hq_logo_web_apps: {
							path: "jr://file/commcare/image/logo.png",
							m_id: "logo",
						},
					},
				}),
			});
		},
	},
	// A menu's name with spaces at its end, which no device shows.
	"names-respelled": editedPair(followUpDoc, menuNamed({ en: "Patients  " })),
	// A menu's icon stored under the language being edited alone.
	"media-maps-respelled": {
		on: async () =>
			factsOf(
				await readAs(
					twoLanguageDoc(),
					onMenu((menu) => {
						menu.media_image = { en: MENU_ICON };
					}),
					MENU_ICON_INPUT,
				),
			),
		off: async () =>
			factsOf(
				await readAs(
					twoLanguageDoc(),
					onMenu((menu) => {
						menu.media_image = { en: MENU_ICON, es: MENU_ICON };
					}),
					MENU_ICON_INPUT,
				),
			),
	},
	// A menu's name with a space at its start, which every device shows.
	"text-spaces-dropped": editedPair(
		followUpDoc,
		menuNamed({ en: " Patients" }),
	),
	// A label whose no-break space the source holds as text.
	"form-text-characters-written-as-outputs": editedPair(
		labelledDoc("Weight\u00a0(kg)"),
		{ xml: withLiteralOutputsAsText },
	),
	// A label beside a column shown nowhere whose header is blank in every language, which
	// CommCare HQ's build lists in Android's Sort by as an entry that shows blank.
	"sort-by-entry-with-a-blank-name-dropped": editedPair(
		() =>
			patients([
				plainColumn(uuid(1), "case_name", "Name"),
				plainColumn(uuid(2), "notes", "", {
					visibleInList: false,
					visibleInDetail: false,
					sort: columnSort("asc", 0),
				}),
			]),
		onMenu((menu) => {
			for (const element of menu.case_details.short.sort_elements)
				if (element.field === "notes") element.display = { en: "Notes" };
		}),
	),
	// A form whose title holds no text, as CommCare HQ's new form holds it.
	"form-titles-written": editedPair(followUpDoc, { xml: withBlankTitle }),
	// A form declaring a fixture nothing reads that the project space may not serve.
	"unread-fixture-declarations-dropped": editedPair(followUpDoc, {
		xml: withDeclaredReports,
	}),
};

/** A media map item as CommCare HQ stores one for an image. */
function mediaMapItem(id: string): Record<string, unknown> {
	return {
		doc_type: "HQMediaMapItem",
		media_type: "CommCareImage",
		multimedia_id: id,
		unique_id: `${id}-unique`,
		version: 1,
	};
}

/** The entries whose `applies` reads only what the reader records, each pair a whole reading. */
const READER_RECORDED: readonly CurrentFirstPublishChangeId[] =
	CURRENT_FIRST_PUBLISH_CHANGE_IDS.filter(
		(id) =>
			(FIRST_PUBLISH_CHANGES[id].scope === "reading" ||
				FIRST_PUBLISH_CHANGES[id].recorded !== undefined) &&
			![
				"forms-and-settings-rewritten",
				"connect-app-captures-location",
				"location-list-setting-reset",
				"date-and-time-questions-split",
				"media-paths-joined",
				"media-files-renamed",
				"media-references-with-no-file-removed",
				"broken-pictures-removed",
				"unused-media-entries-removed",
			].includes(id),
	);

describe("each entry", () => {
	for (const id of CURRENT_FIRST_PUBLISH_CHANGE_IDS)
		it(`${id} applies on one reading and not on another`, {
			timeout: 60_000,
		}, async () => {
			const pair = PAIRS[id];
			expect(applies(id, await pair.on())).toBe(true);
			expect(applies(id, await pair.off())).toBe(
				id === "forms-and-settings-rewritten",
			);
		});

	for (const id of CURRENT_FIRST_PUBLISH_CHANGE_IDS)
		it(`${id} stands at places of its own on the reading it applies on`, {
			timeout: 60_000,
		}, async () => {
			const facts = await PAIRS[id].on();
			const [placed, ...more] = firstPublishChangePlaces(facts, [id]);
			expect(more).toEqual([]);
			expect(placed?.id).toBe(id);
			const places = placed?.places ?? [];
			if (id === "forms-and-settings-rewritten") {
				expect(places).toEqual([""]);
				return;
			}
			expect(places.length).toBeGreaterThan(0);
			const kinds = firstPublishPlaceKindsOf(id);
			const positions = formPositionsOf(facts.source);
			for (const place of places) {
				const kind = firstPublishPlaceKind(place);
				expect([place, kind !== null && kinds.includes(kind)]).toEqual([
					place,
					true,
				]);
				// A form's or a menu's place names one the source holds.
				const [root, at] = placeSteps(place);
				if (root === "form")
					expect([place, positions.all.includes(at ?? "")]).toEqual([
						place,
						true,
					]);
				if (root === "menu")
					expect([place, Number(at) < facts.source.modules.length]).toEqual([
						place,
						true,
					]);
			}
		});

	for (const id of CURRENT_FIRST_PUBLISH_CHANGE_IDS.filter(
		(one) => one !== "forms-and-settings-rewritten",
	))
		it(`${id} stands where its first publish changes what only it may change`, {
			timeout: 60_000,
		}, async () => {
			const facts = await PAIRS[id].on();
			const others = CURRENT_FIRST_PUBLISH_CHANGE_IDS.filter(
				(other) => other !== id && FIRST_PUBLISH_CHANGES[other].applies(facts),
			);
			const [placed] = firstPublishChangePlaces(facts, [id]);
			const places = placed?.places ?? [];
			const unplaced = storedDifferences(
				facts.source.raw,
				firstPublishStored(facts, PAIR_PROJECT_DATA[id] ?? {}),
			).filter(
				(pointer) =>
					FIRST_PUBLISH_CHANGES[id].paths.some((path) =>
						pointerCovers(path, pointer),
					) &&
					!others.some((other) =>
						FIRST_PUBLISH_CHANGES[other].paths.some((path) =>
							pointerCovers(path, pointer),
						),
					) &&
					!places.some((place) => {
						const at = placeOfStoredPointer(facts.positions, pointer);
						return at !== null && placeStandsAt(place, at);
					}),
			);
			expect(unplaced).toEqual([]);
		});

	it("covers each record a reading of an entry's source makes by the paths of the entry it names", {
		timeout: 120_000,
	}, async () => {
		const uncovered: string[] = [];
		for (const id of READER_RECORDED)
			for (const record of (await PAIRS[id].on()).facts.sameStateRewrites)
				if (!coveredByItsEntry(record))
					uncovered.push(`${id}: ${record.register} ${record.path}`);
		expect(uncovered).toEqual([]);
	});

	it("lists the ids that apply in registry order, touching workers where one of them does", async () => {
		const view = firstPublishChangesFor(await PAIRS["case-names-checked"].on());
		expect(view.of).toBe("first-publish");
		expect(view.ids).toEqual(
			CURRENT_FIRST_PUBLISH_CHANGE_IDS.filter((id) => view.ids.includes(id)),
		);
		expect(view.ids).toContain("case-names-checked");
		expect(view.touchesWorkers).toBe(true);
	});

	it("lists a list setting respelled where a menu that offers no search stores another auto_launch than the choice writes", {
		timeout: 60_000,
	}, async () => {
		// Nova writes such a search's `auto_launch` as whether the app runs in
		// Web Apps; a menu made in CommCare HQ's models holds `false`.
		const id = "list-settings-respelled";
		const pair = editedPair(
			() => patients([plainColumn(uuid(1), "case_name", "Name")]),
			onMenu((menu) => {
				menu.search_config.auto_launch = false;
			}),
		);
		expect(applies(id, await pair.off())).toBe(false);
		const stored = await pair.on();
		expect(applies(id, stored)).toBe(true);
		const android: FirstPublishFacts = {
			...stored,
			doc: {
				...stored.doc,
				appSettings: { ...stored.doc.appSettings, runsOnlyOn: "android" },
			},
		};
		expect(applies(id, android)).toBe(false);
	});

	it("records a label whose instance( CommCare HQ's build reads, held as text in the source, at the pointer of its form", {
		timeout: 60_000,
	}, async () => {
		const doc = labelledDoc("Ask instance('district') here")();
		const exported = exportedBody(doc, {
			expand: { attachmentTarget: TARGET },
		});
		// Nova's print writes the bracket as an output, so its own export records nothing.
		expect(JSON.stringify(exported)).toContain("instance<output");
		const on = await readAs(doc, { xml: withLiteralOutputsAsText });
		const records = on.draft.facts.sameStateRewrites.filter(
			(record) => record.register === "form-text-characters-written-as-outputs",
		);
		expect(records).toHaveLength(1);
		expect(records.every(coveredByItsEntry)).toBe(true);
		expect(on.draft.doc.fields).toEqual(
			(await readExport(doc, TARGET)).draft.doc.fields,
		);
		expect(
			applies("form-text-characters-written-as-outputs", factsOf(on)),
		).toBe(true);
	});

	it("reads a Save to Case value in the spelling Nova wrote before as the same write, holding the document the current spelling gives", async () => {
		const doc = visitDoc();
		const earlier = await readAs(doc, {
			xml: withEarlierClockRow("visited_at"),
		});
		const current = await readAs(doc);
		expect(earlier.draft.doc).toEqual(current.draft.doc);
		const records = earlier.draft.facts.sameStateRewrites.filter(
			(one) => one.register === "date-and-time-saved-as-hq-stores-it",
		);
		expect(records).toHaveLength(1);
		expect(records.every(coveredByItsEntry)).toBe(true);
		expect(
			applies("date-and-time-saved-as-hq-stores-it", factsOf(earlier)),
		).toBe(true);
		expect(
			applies("date-and-time-saved-as-hq-stores-it", factsOf(current)),
		).toBe(false);
	});

	it("records a nova_datetime_ sibling in the earlier spelling at a pointer its entry covers", async () => {
		const facts = await PAIRS["date-and-time-saved-as-hq-stores-it"].on();
		const records = facts.facts.sameStateRewrites.filter(
			(one) => one.register === "date-and-time-saved-as-hq-stores-it",
		);
		expect(records).toHaveLength(1);
		expect(records.every(coveredByItsEntry)).toBe(true);
	});
});

// ── The text a folded translation key names ──────────────────────────────

/**
 * The roles a fold in an app's source language sets (`reader/assemble.ts::sourceTextSlot`): a
 * key over any other unit folds only in another language, as that unit's translation.
 */
const SOURCE_FOLD_ROLES: ReadonlySet<string> = new Set([
	"app-name",
	"module-name",
	"form-name",
	"case-list-menu-item-label",
	"case-list-registration-label",
	"case-list-header",
	"search-input-label",
	"search-input-hint",
]);

/**
 * An override of every generated id Nova's own strings give `doc`, in each language alike, whose
 * source is one translation unit that feeds no id of several, each unit's ids at one value of its
 * own: the keys a reading folds whole (`generatedTranslationKeys.ts::classifyGeneratedTranslationKeys`
 * folds a key only where every id its unit feeds holds the same value). In the source language,
 * only the units a fold there sets. The app's name is left out: the reading reads its keys
 * itself (`appShell.ts::readTranslations`), and folds only the first language's
 * `app.display.name`, which a case adds on its own.
 */
function foldingOverrides(
	doc: BlueprintDoc,
	source: boolean,
): Record<string, string> {
	const table = localAppStringTable(doc, []);
	const units = translationUnitsById(doc);
	const feeds = new Map<string, string[]>();
	const shared = new Set<string>();
	for (const [id, from] of Object.entries(table.units)) {
		const one = typeof from === "string" ? [from] : from;
		if (one.length !== 1) for (const unit of one) shared.add(unit);
		const [unit] = one;
		if (one.length !== 1 || unit === undefined) continue;
		feeds.set(unit, [...(feeds.get(unit) ?? []), id]);
	}
	const overrides: Record<string, string> = {};
	let index = 0;
	for (const [unit, ids] of feeds) {
		if (shared.has(unit)) continue;
		if (!ids.some((id) => generatedAppStringPattern(id) !== undefined))
			continue;
		const role = units.get(unit as TranslationUnitId)?.role;
		// The app's name is read from `name` and `app.display.name` (`appShell.ts`), never by the
		// classifier: a case folds the first language's `app.display.name` on its own.
		if (role === "app-name") continue;
		if (source && (role === undefined || !SOURCE_FOLD_ROLES.has(role)))
			continue;
		index += 1;
		for (const id of ids) overrides[id] = `Folded words ${index}`;
	}
	return overrides;
}

/** The facts of a whole reading of `doc`'s export whose `translations` in `code` also hold `keys`. */
async function foldingFacts(
	doc: BlueprintDoc,
	code: string,
	keys: Readonly<Record<string, string>>,
): Promise<FirstPublishFacts> {
	const body = exportedBody(doc, { expand: { attachmentTarget: TARGET } });
	const translations = (body.translations ?? {}) as Record<
		string,
		Record<string, string>
	>;
	body.translations = {
		...translations,
		[code]: { ...translations[code], ...keys },
	};
	const reading = readWhole(doc.appId, await sourceFromBody(body), {
		knownCaseTypes: knownCaseTypesOf(doc),
		appStrings: readingAppStrings(LOOKUP_CONTEXT_UNAVAILABLE),
	});
	if (!("draft" in reading))
		throw new Error(
			`The source read to an account: ${reading.codes.join(", ")}`,
		);
	return factsOf(reading);
}

/** A phone number a worker searches by, whose rule needs no runtime guard beside it, so its
 *  validation message is a text of its own. */
const SEEN: SearchInputDef = {
	uuid: uuid(10),
	name: "phone",
	label: "Phone",
	kind: "simple",
	type: "text",
	property: "phone",
	validation: {
		rule: neq(input(uuid(10)), literal("none")),
		message: "Say more",
	},
};

/** A two-language menu of patients whose case list holds every kind of text a detail key names,
 *  and whose search has a title and a subtitle. */
function caseListTextsDoc(): BlueprintDoc {
	const doc = patients(
		[
			plainColumn(uuid(1), "case_name", "Name"),
			idMappingColumn(uuid(2), "notes", "Notes", [
				idMappingEntry("a", "Alpha"),
			]),
			intervalColumn(uuid(3), "dob", "Since", 30, "days", "flag", "Late"),
			plainColumn(uuid(4), "phone", "Phone", {
				visibleInList: false,
				sort: columnSort("asc", 0, undefined, "By phone"),
			}),
		],
		{
			searchInputs: [NOTES, SEEN],
			search: {
				searchScreenTitle: "Find patients",
				searchScreenSubtitle: "By their notes",
			},
		},
	);
	return inSpanish(
		produce(doc, (draft) => {
			const menu = draft.modules[draft.moduleOrder[0] ?? ""];
			if (menu !== undefined) menu.caseListMenuItem = { label: "All patients" };
		}),
		new Map(),
	);
}

/** A menu of patients whose case list offers another menu's registration form under a label. */
function labelledRegisteringDoc(): BlueprintDoc {
	return produce(registeringDoc(), (draft) => {
		const host = Object.values(draft.modules).find(
			(one) => one.name === "Patients",
		);
		const registration = host?.caseListRegistrationForm;
		if (registration !== undefined) registration.label = "New patient";
	});
}

/** Each form's `<h:title>` text and its data node's `name` in the body a first publish over
 *  `facts` sends, by the form's position. */
function publishedFormTitles(
	facts: FirstPublishFacts,
): ReadonlyMap<string, { readonly title: string; readonly name: string }> {
	const body = firstPublishBody(facts);
	const attachments = body._attachments as Record<string, string>;
	const titles = new Map<string, { title: string; name: string }>();
	(body.modules as Json[]).forEach((menu, m) => {
		(menu.forms as Json[]).forEach((form, f) => {
			const xml = attachments[`${String(form.unique_id)}.xml`] ?? "";
			const nodes = parseXml(xml).children.filter(isTag);
			const title = findOne((one) => one.name === "h:title", nodes, true);
			const data = findOne(
				(one) =>
					one.name === "data" &&
					one.parent !== null &&
					isTag(one.parent) &&
					one.parent.name === "instance",
				nodes,
				true,
			);
			titles.set(`${m}.${f}`, {
				title:
					title?.children
						.map((child) => (child instanceof Text ? child.data : ""))
						.join("") ?? "",
				name: data?.attribs.name ?? "",
			});
		});
	});
	return titles;
}

interface FoldCase {
	readonly doc: () => BlueprintDoc;
	/** The language whose keys fold, by its wire code, and whether it is the app's source language. */
	readonly code: string;
	readonly source: boolean;
	/** Keys the case folds beside the classifier's: the first language's `app.display.name`. */
	readonly also?: Readonly<Record<string, string>>;
	/** The rows of `FOLDED_TEXT_SLOTS` the case's folded keys are spelled by. */
	readonly patterns: readonly string[];
	/** Whether the case folds a form's name in the app's first language, which its source's title
	 *  and data node's name take. */
	readonly formTitles?: true;
}

const FOLD_CASES: Readonly<Record<string, FoldCase>> = {
	"names and a Register button's label, in the source language": {
		doc: labelledRegisteringDoc,
		code: "en",
		source: true,
		also: { "app.display.name": "Folded app" },
		formTitles: true,
		patterns: [
			"app.display.name",
			"modules.m#",
			"forms.m#f#",
			"case_list_form.m#",
		],
	},
	"a case list's texts and its search's title and subtitle, in a second language":
		{
			doc: caseListTextsDoc,
			code: "es",
			source: false,
			patterns: [
				"modules.m#",
				"forms.m#f#",
				"case_lists.m#",
				"m#.*.*_*_#.header",
				"m#.*.*_*_*.enum.*",
				"search_property.m#.*.validation.#.text",
				"search_property.m#.*",
				"case_search.m#.inputs",
				"case_search.m#.description",
			],
		},
	"a search's field texts, in the first language, which is not the source": {
		doc: () => localizationWireFixture("prompts"),
		code: "es",
		source: false,
		formTitles: true,
		patterns: [
			"modules.m#",
			"forms.m#f#",
			"m#.*.*_*_#.header",
			"search_property.m#.*.hint",
			"search_property.m#.*.required.text",
			"search_property.m#.*",
			"case_search.m#.inputs",
		],
	},
};

describe("the text a folded translation key names", () => {
	it("spells each row by one of CommCare HQ's generated patterns, and allows its slots' paths", () => {
		for (const row of FOLDED_TEXT_SLOTS) {
			expect([
				row.pattern,
				GENERATED_APP_STRING_PATTERNS.includes(row.pattern),
			]).toEqual([row.pattern, true]);
			for (const path of foldedTextPathsOf(row))
				expect(
					FIRST_PUBLISH_CHANGES["translation-overrides-folded"].paths,
				).toContain(path);
		}
	});

	it("places each key's text at the positions it spells: a column's header on its screen, and its sort element's name", () => {
		expect(
			placesOfGeneratedKey("m2.case_long.case_external-id_3.header"),
		).toEqual([
			"/menu/2/case_details/long/columns/2/header",
			"/menu/2/case_details/long/sort_elements",
		]);
		expect(placesOfGeneratedKey("m0.search_short.case_name_1.header")).toEqual([
			"/menu/0/case_details/short/columns/0/header",
			"/menu/0/case_details/short/sort_elements",
		]);
		expect(
			placesOfGeneratedKey("m1.case_short.case_zone_2.enum.knova_text_0"),
		).toEqual(["/menu/1/case_details/short/columns/1/enum"]);
		expect(placesOfGeneratedKey("search_property.m0.notes.hint")).toEqual([
			"/menu/0/search_config/properties",
		]);
		expect(placesOfGeneratedKey("forms.m1f2")).toEqual([
			"/form/1.2/name",
			"/form/1.2/xform/title",
			"/form/1.2/xform/data/@name",
		]);
		expect(placesOfGeneratedKey("app.display.name")).toEqual(["/app/name"]);
	});

	it("refuses to place a key no fold sets: a constant, a media key", () => {
		for (const key of ["m0_select_text", "case_search.m0", "forms.m0f0.icon"])
			expect(() => placesOfGeneratedKey(key)).toThrow(/FOLDED_TEXT_SLOTS/);
	});

	it("exercises every row across its cases", () => {
		expect(
			new Set(Object.values(FOLD_CASES).flatMap((one) => one.patterns)),
		).toEqual(new Set(FOLDED_TEXT_SLOTS.map((row) => row.pattern)));
	});

	for (const [title, one] of Object.entries(FOLD_CASES))
		it(`changes, where it folds ${title}, only the slots its entry allows at the places it gives`, {
			timeout: 60_000,
		}, async () => {
			const doc = one.doc();
			const keys = {
				...foldingOverrides(doc, one.source),
				...one.also,
			};
			const on = await foldingFacts(doc, one.code, keys);
			const off = await foldingFacts(doc, one.code, {});
			const entry = FIRST_PUBLISH_CHANGES["translation-overrides-folded"];

			// Every key of the case folds, each spelled by a row.
			const folded = on.facts.foldedTranslationKeys.map(
				(pointer) => placeSteps(pointer).at(-1) ?? "",
			);
			expect(new Set(folded)).toEqual(new Set(Object.keys(keys)));
			expect(
				new Set(folded.map((key) => foldedTextSlotsOf(key)?.pattern)),
			).toEqual(new Set(one.patterns));
			expect(applies("translation-overrides-folded", off)).toBe(false);

			// What the fold moves in the stored app: each difference lies under a path the entry
			// allows and at a place it stands at.
			const before = new Set(
				storedDifferences(off.source.raw, firstPublishStored(off, {})),
			);
			const moved = storedDifferences(
				on.source.raw,
				firstPublishStored(on, {}),
			).filter((pointer) => !before.has(pointer));
			const [placed] = firstPublishChangePlaces(on, [
				"translation-overrides-folded",
			]);
			const places = placed?.places ?? [];
			const unheld = moved.filter((pointer) => {
				const at = placeOfStoredPointer(on.positions, pointer);
				return !(
					entry.paths.some((path) => pointerCovers(path, pointer)) &&
					at !== null &&
					places.some((place) => placeStandsAt(place, at))
				);
			});
			expect(unheld).toEqual([]);

			// A form's source, which the comparison above leaves to the lane's parts: its title and
			// its data node's name move where the form's name folds in the first language.
			const titlesBefore = publishedFormTitles(off);
			const sourceMoves = [...publishedFormTitles(on)].flatMap(
				([position, now]) => {
					const was = titlesBefore.get(position);
					return [
						...(now.title === was?.title
							? []
							: [placeOf("form", position, "xform", "title")]),
						...(now.name === was?.name
							? []
							: [placeOf("form", position, "xform", "data", "@name")]),
					];
				},
			);
			expect(sourceMoves.length > 0).toBe(one.formTitles === true);
			expect(
				sourceMoves.filter(
					(at) =>
						!entry.paths.includes("/_attachments/*") ||
						!places.some((place) => placeStandsAt(place, at)),
				),
			).toEqual([]);

			// Each row's text moved: the key left `translations`, and its text took the value.
			for (const pattern of one.patterns) {
				const row = FOLDED_TEXT_SLOTS.find((one) => one.pattern === pattern);
				const paths = row === undefined ? [] : foldedTextPathsOf(row);
				expect([
					pattern,
					moved.some(
						(pointer) =>
							!pointer.startsWith("/translations/") &&
							paths.some((path) => pointerCovers(path, pointer)),
					),
				]).toEqual([pattern, true]);
			}
		});
});

// ── The body a first publish sends ───────────────────────────────────────

const SHELL_KEY = {
	"connect-app-captures-location": "auto_gps_capture",
	"location-list-setting-reset": "location_fixture_restore",
	"web-apps-turned-off": "cloudcare_enabled",
	"web-apps-turned-on": "cloudcare_enabled",
} as const satisfies Partial<Record<CurrentFirstPublishChangeId, string>>;

function firstPublishBody(
	facts: FirstPublishFacts,
	project: PairProjectData = {},
): Record<string, unknown> {
	return hqImportApplication({
		prepared: adoptionExportBoundary(
			facts.doc,
			project.lookups ?? [],
			project.mediaFiles ?? [],
			TARGET,
		),
		target: TARGET_KEY,
		compatibility: { advisories: [] },
		update: { appId: REMOTE_APP_ID, source: facts.source },
		identity: targetWireIdentity([]),
		languageNames: "target",
		seeds: "target",
		keyedCaseIdPrefixes: new Map(),
	}).application as unknown as Record<string, unknown>;
}

describe("the body a first publish sends", () => {
	for (const [id, key] of Object.entries(SHELL_KEY) as [
		keyof typeof SHELL_KEY,
		string,
	][])
		it(`changes ${key} from the source's value exactly where ${id} applies`, {
			timeout: 60_000,
		}, async () => {
			const on = await PAIRS[id].on();
			expect(applies(id, on)).toBe(true);
			const sent = firstPublishBody(on);
			expect(Object.hasOwn(sent, key)).toBe(true);
			expect(sent[key]).not.toEqual(on.source.raw[key]);

			const off = await PAIRS[id].off();
			expect(applies(id, off)).toBe(false);
			const kept = firstPublishBody(off);
			if (Object.hasOwn(kept, key))
				expect(kept[key]).toEqual(off.source.raw[key]);
		});
});
