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
import { EMISSION_REWRITES } from "@/lib/commcare/emissionRewrites";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
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
	plainColumn,
} from "@/lib/domain/modules";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import {
	FIRST_PUBLISH_ANDROID_ONLY,
	FIRST_PUBLISH_CHANGE_IDS,
	FIRST_PUBLISH_TOUCHES_WORKERS,
	type FirstPublishChangeId,
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
	FIRST_PUBLISH_CHANGES,
	type FirstPublishFacts,
	firstPublishChangesFor,
	firstPublishFactsOf,
	firstPublishListToStore,
	GENERATED_NODE_CHANGE,
	MEDIA_REFERENCE_PATHS,
	pointerCovers,
} from "../firstPublishChanges";
import {
	HQ_MEDIA_SLOTS,
	type HqMediaSlot,
	type MediaLeftOut,
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

const NONE_LEFT_OUT: MediaLeftOut = { undrawn: 0, brokenPictures: 0 };

interface FactsChange {
	readonly choice?: DeclarationChoice;
	readonly source?: HqAppSource;
	readonly doc?: BlueprintDoc;
	readonly facts?: Partial<ReadFacts>;
	readonly mediaFiles?: readonly AdoptedMediaFile[];
	readonly mediaLeftOut?: MediaLeftOut;
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
		mediaLeftOut: change.mediaLeftOut ?? NONE_LEFT_OUT,
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

const applies = (id: FirstPublishChangeId, facts: FirstPublishFacts) =>
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
function registrationDoc(): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "seen_at", label: proseText("Seen") },
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

/** A survey whose Hidden Value `h` is calculated, beside a question `n` with a default. */
function calculatedDoc(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Menu",
				forms: [
					{
						name: "Form",
						type: "survey",
						fields: [
							f({ kind: "hidden", id: "h", calculate: "2" }),
							f({ kind: "text", id: "n", default_value: "'x'" }),
						],
					},
				],
			},
		],
	});
}

/** A default of `h` before the default of `n`, which reads neither: a source whose
 *  calculate replaces its default before anything reads it. */
function withOverwrittenDefault(xml: string): string {
	const document = parseXml(xml);
	const anchor = findOne(
		(element: Element) =>
			element.name === "setvalue" && element.attribs.ref === "/data/n",
		document.children.filter(isTag),
		true,
	);
	if (anchor === null)
		throw new Error("The export holds no setvalue that sets n.");
	prepend(
		anchor,
		new Element("setvalue", {
			event: "xforms-ready",
			ref: "/data/h",
			value: "1",
		}),
	);
	return serializeXml(document);
}

// ── The register's columns ───────────────────────────────────────────────

describe("the register", () => {
	it("holds every id in registry order, and its touchesWorkers column is the client-safe one", () => {
		expect(Object.keys(FIRST_PUBLISH_CHANGES)).toEqual([
			...FIRST_PUBLISH_CHANGE_IDS,
		]);
		for (const id of FIRST_PUBLISH_CHANGE_IDS)
			expect([id, FIRST_PUBLISH_CHANGES[id].touchesWorkers]).toEqual([
				id,
				FIRST_PUBLISH_TOUCHES_WORKERS[id],
			]);
	});

	it("works out the two Web Apps lines from the declaration, and each line a worker meets on Android alone from its reading", () => {
		expect(
			FIRST_PUBLISH_CHANGE_IDS.filter(
				(id) =>
					FIRST_PUBLISH_CHANGES[id].scope === "declaration" &&
					FIRST_PUBLISH_CHANGES[id].recorded === undefined,
			),
		).toEqual(["web-apps-turned-off", "web-apps-turned-on"]);
		expect(
			FIRST_PUBLISH_CHANGE_IDS.filter(
				(id) => FIRST_PUBLISH_CHANGES[id].recorded !== undefined,
			),
		).toEqual([...FIRST_PUBLISH_ANDROID_ONLY]);
		for (const id of FIRST_PUBLISH_ANDROID_ONLY)
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
			expect(FIRST_PUBLISH_CHANGE_IDS).toContain(id);
			expect([
				id,
				FIRST_PUBLISH_CHANGES[id as FirstPublishChangeId].touchesWorkers,
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
		for (const id of FIRST_PUBLISH_CHANGE_IDS)
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
				expect(firstPublishViewFromStored(stored, choice.runsOnlyOn)).toEqual(
					view,
				);
				const moving = new Set<FirstPublishChangeId>([
					"web-apps-turned-off",
					"web-apps-turned-on",
					...FIRST_PUBLISH_ANDROID_ONLY,
				]);
				const recorded = [...FIRST_PUBLISH_ANDROID_ONLY].filter((id) =>
					FIRST_PUBLISH_CHANGES[id].recorded?.(reading.draft.facts),
				);
				for (const runsOnlyOn of ["android", "web-apps", undefined] as const) {
					const other = firstPublishViewFromStored(stored, runsOnlyOn);
					expect(other.ids.filter((id) => !moving.has(id))).toEqual(
						view.ids.filter((id) => !moving.has(id)),
					);
					expect(
						other.ids.filter((id) => FIRST_PUBLISH_ANDROID_ONLY.has(id)),
					).toEqual(runsOnlyOn === "web-apps" ? [] : recorded);
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
		expect(firstPublishViewFromStored(next, undefined)).toEqual({
			ids: ["case-settings-respelled"],
			touchesWorkers: false,
			of: "next-publish",
		});
		expect(firstPublishViewFromStored(next, "android")).toEqual({
			ids: ["case-settings-respelled", "web-apps-turned-off"],
			touchesWorkers: true,
			of: "next-publish",
		});
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
		expect(firstPublishViewFromStored(stored, "web-apps").ids).not.toContain(
			id,
		);
		expect(firstPublishViewFromStored(stored, "android").ids).toContain(id);
		expect(firstPublishViewFromStored(stored, undefined).ids).toContain(id);
		// A reading that records no such rule stores no line.
		const plain = await PAIRS[id].off();
		expect(
			firstPublishListToStore(firstPublishChangesFor(plain), plain.facts).ids,
		).not.toContain(id);
	});
});

function coveredByItsEntry(record: SameStateRewrite): boolean {
	const entry = FIRST_PUBLISH_CHANGES[record.register as FirstPublishChangeId];
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

const PAIRS: Readonly<Record<FirstPublishChangeId, Pair>> = {
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
		on: async () =>
			factsOf(await baseReading(), {
				mediaLeftOut: { undrawn: 1, brokenPictures: 0 },
			}),
		// An icon Web Apps showed broken is said by its own line.
		off: async () =>
			factsOf(await baseReading(), {
				mediaLeftOut: { undrawn: 0, brokenPictures: 1 },
			}),
	},
	"broken-pictures-removed": {
		on: async () =>
			factsOf(await baseReading(), {
				mediaLeftOut: { undrawn: 0, brokenPictures: 1 },
			}),
		// A reference no worker saw anything for is said by another line.
		off: async () =>
			factsOf(await baseReading(), {
				mediaLeftOut: { undrawn: 1, brokenPictures: 0 },
			}),
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
	// A Hidden Value's default its calculate replaces before anything reads it.
	"hidden-value-defaults-dropped": editedPair(calculatedDoc, {
		xml: withOverwrittenDefault,
	}),
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
const READER_RECORDED: readonly FirstPublishChangeId[] =
	FIRST_PUBLISH_CHANGE_IDS.filter(
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
	for (const id of FIRST_PUBLISH_CHANGE_IDS)
		it(`${id} applies on one reading and not on another`, {
			timeout: 60_000,
		}, async () => {
			const pair = PAIRS[id];
			expect(applies(id, await pair.on())).toBe(true);
			expect(applies(id, await pair.off())).toBe(
				id === "forms-and-settings-rewritten",
			);
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
			FIRST_PUBLISH_CHANGE_IDS.filter((id) => view.ids.includes(id)),
		);
		expect(view.ids).toContain("case-names-checked");
		expect(view.touchesWorkers).toBe(true);
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

// ── The body a first publish sends ───────────────────────────────────────

const SHELL_KEY = {
	"connect-app-captures-location": "auto_gps_capture",
	"location-list-setting-reset": "location_fixture_restore",
	"web-apps-turned-off": "cloudcare_enabled",
	"web-apps-turned-on": "cloudcare_enabled",
} as const satisfies Partial<Record<FirstPublishChangeId, string>>;

function firstPublishBody(facts: FirstPublishFacts): Record<string, unknown> {
	return hqImportApplication({
		prepared: adoptionExportBoundary(facts.doc, [], [], TARGET),
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
