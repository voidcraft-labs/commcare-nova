/**
 * The first-publish register says exactly what Nova's first publish over an
 * app it brought in from CommCare HQ changes there.
 *
 * Contract: every entry applies on some reading and not on another, each
 * built from a retained read of CommCare HQ's or a reading of a document
 * production builders made, through `firstPublishFactsOf`
 * (`forms-and-settings-rewritten` applies on every one); the register's
 * columns agree with the client-safe copies of them and with the emitter's
 * rewrites; every same-state record a retained read makes is covered by the
 * paths of the entry it names; what the birth stores for a choice gives
 * that choice's list back under its declaration and differs only by the
 * two Web Apps lines under another; and the four entries a shell key carries
 * part ways with the source in the body a first publish sends exactly where
 * they apply.
 *
 * Plausible failures: an entry that never applies, or always does; a
 * same-state rule whose rewrite no entry allows; a rewrite a worker meets
 * that no line says; a stored list that tells a person Web Apps is turned
 * off after they turned it on; a predicate and the shell it speaks for
 * parting ways.
 */

import { type Element, isTag } from "domhandler";
import { findAll, findOne, removeElement } from "domutils";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { constraintMessageFixture } from "@/lib/commcare/__tests__/constraintMessageFixture";
import { EMISSION_REWRITES } from "@/lib/commcare/emissionRewrites";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { exportedBody } from "@/lib/commcare/reader/__tests__/novaExport";
import { hydrated } from "@/lib/commcare/reader/__tests__/publishedDocuments";
import { sourceFromBody } from "@/lib/commcare/reader/__tests__/readerInput";
import { readCases } from "@/lib/commcare/reader/caseManagement/__tests__/caseReading";
import type { ReadFacts, SameStateRewrite } from "@/lib/commcare/reader/types";
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
	type Platform,
	proseText,
} from "@/lib/domain";
import { now } from "@/lib/domain/expression/builders";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import {
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
import {
	FIRST_PUBLISH_CHANGES,
	type FirstPublishFacts,
	firstPublishChangesFor,
	firstPublishFactsOf,
	GENERATED_NODE_CHANGE,
	MEDIA_REFERENCE_PATHS,
	pointerCovers,
} from "../firstPublishChanges";
import { HQ_MEDIA_SLOTS, type HqMediaSlot } from "../projectData/media";
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
	readonly mediaLeftOut?: number;
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
		mediaLeftOut: change.mediaLeftOut ?? 0,
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

async function readEdited(
	doc: BlueprintDoc,
	xml: (xml: string) => string,
): Promise<RegisterReading> {
	const source = await sourceFromBody(
		exportedBody(doc, { xml, expand: { attachmentTarget: TARGET } }),
	);
	const reading = readWhole(doc.appId, source);
	if (!("draft" in reading))
		throw new Error(`The edited export read to an account: ${reading.codes}`);
	return reading;
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

	it("works out exactly the two Web Apps lines from the declaration", () => {
		expect(
			FIRST_PUBLISH_CHANGE_IDS.filter(
				(id) => FIRST_PUBLISH_CHANGES[id].scope === "declaration",
			),
		).toEqual(["web-apps-turned-off", "web-apps-turned-on"]);
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

	it("gives each choice's list back from what the birth stores, and only the Web Apps lines move under another declaration", async () => {
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
					firstPublish: view,
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
				const others = (["android", "web-apps", undefined] as const).map(
					(runsOnlyOn) => firstPublishViewFromStored(stored, runsOnlyOn),
				);
				const webApps = new Set<string>([
					"web-apps-turned-off",
					"web-apps-turned-on",
				]);
				for (const other of others)
					expect(other.ids.filter((id) => !webApps.has(id))).toEqual(
						view.ids.filter((id) => !webApps.has(id)),
					);
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
});

function coveredByItsEntry(record: SameStateRewrite): boolean {
	const entry = FIRST_PUBLISH_CHANGES[record.register as FirstPublishChangeId];
	return entry?.paths.some((path) => pointerCovers(path, record.path)) === true;
}

// ── Each entry applies and does not ──────────────────────────────────────

/** A same-state record of `id` at the first concrete pointer its paths give. */
function recordOf(id: FirstPublishChangeId): SameStateRewrite {
	const [path] = FIRST_PUBLISH_CHANGES[id].paths;
	return {
		entry: "test/record",
		path: (path as string).replaceAll("*", "0"),
		register: id as SameStateRewrite["register"],
	};
}

interface Pair {
	readonly on: () => Promise<FirstPublishFacts>;
	readonly off: () => Promise<FirstPublishFacts>;
}

/** Facts of the base reading with the reader's report holding `id` once, and with it held nowhere. */
function reported(
	id: FirstPublishChangeId,
	where: "rewrites" | "sameStateRewrites",
): Pair {
	return {
		on: async () => {
			const base = await baseReading();
			return factsOf(base, {
				facts:
					where === "rewrites"
						? {
								rewrites: [
									...base.draft.facts.rewrites,
									{
										id: id as ReadFacts["rewrites"][number]["id"],
										place: { kind: "app" },
										key: "test",
									},
								],
							}
						: {
								sameStateRewrites: [
									...base.draft.facts.sameStateRewrites,
									recordOf(id),
								],
							},
			});
		},
		off: async () => {
			const base = await baseReading();
			return factsOf(base, {
				facts: {
					rewrites: base.draft.facts.rewrites.filter((one) => one.id !== id),
					sameStateRewrites: base.draft.facts.sameStateRewrites.filter(
						(one) => one.register !== id,
					),
				},
			});
		},
	};
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
	"instant-comparison": reported("instant-comparison", "rewrites"),
	"empty-rows-guard": reported("empty-rows-guard", "rewrites"),
	"absent-session-value-guard": reported(
		"absent-session-value-guard",
		"rewrites",
	),
	"row-predicate-current": reported("row-predicate-current", "rewrites"),
	"search-value-guards": reported("search-value-guards", "rewrites"),
	"search-today-device-day": reported("search-today-device-day", "rewrites"),
	"case-settings-respelled": reported(
		"case-settings-respelled",
		"sameStateRewrites",
	),
	"search-filter-rows-recut": reported(
		"search-filter-rows-recut",
		"sameStateRewrites",
	),
	"sort-rule-kept-as-hidden-column": reported(
		"sort-rule-kept-as-hidden-column",
		"sameStateRewrites",
	),
	"list-settings-respelled": reported(
		"list-settings-respelled",
		"sameStateRewrites",
	),
	"search-filter-joined-to-list": reported(
		"search-filter-joined-to-list",
		"sameStateRewrites",
	),
	"search-restates-list-filter": reported(
		"search-restates-list-filter",
		"sameStateRewrites",
	),
	"link-held-case-guards-added": reported(
		"link-held-case-guards-added",
		"sameStateRewrites",
	),
	"registration-label-fixed": reported(
		"registration-label-fixed",
		"sameStateRewrites",
	),
	"date-and-time-saved-as-hq-stores-it": {
		on: async () =>
			factsOf(
				await readEdited(
					registrationDoc(),
					withBindAttribute(
						"/nova_datetime_seen",
						"calculate",
						serializeWire(
							typedInstantValue(FormPath.root().child("seen").toWire()),
							{ target: "xform", constraint: false },
						).text,
					),
				),
			),
		off: async () => factsOf(await readExport(registrationDoc(), TARGET)),
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
	"translation-overrides-folded": {
		on: async () =>
			factsOf(await baseReading(), { facts: { foldedTranslationKeys: 1 } }),
		off: async () =>
			factsOf(await baseReading(), { facts: { foldedTranslationKeys: 0 } }),
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
	"blank-translations-filled": {
		on: async () => {
			const base = await baseReading();
			return factsOf(base, {
				facts: {
					forms: base.draft.facts.forms.map((form, index) => ({
						...form,
						blankTranslations: index === 0 ? 1 : 0,
					})),
				},
			});
		},
		off: async () => factsOf(await baseReading()),
	},
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
		on: async () => factsOf(await baseReading(), { mediaLeftOut: 1 }),
		off: async () => factsOf(await baseReading(), { mediaLeftOut: 0 }),
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
	"names-respelled": reported("names-respelled", "sameStateRewrites"),
	"media-maps-respelled": reported("media-maps-respelled", "sameStateRewrites"),
	"text-spaces-dropped": reported("text-spaces-dropped", "sameStateRewrites"),
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

	it("lists the ids that apply in registry order, touching workers where one of them does", async () => {
		const view = firstPublishChangesFor(await PAIRS["case-names-checked"].on());
		expect(view.of).toBe("first-publish");
		expect(view.ids).toEqual(
			FIRST_PUBLISH_CHANGE_IDS.filter((id) => view.ids.includes(id)),
		);
		expect(view.ids).toContain("case-names-checked");
		expect(view.touchesWorkers).toBe(true);
	});

	it("applies where the Save to Case reader records a value in the spelling Nova wrote before, and not over the current spelling", async () => {
		// The case management stages alone: a whole reading of such a block is
		// refused at the settle today, which re-prints the row in the current
		// spelling beside its clock node.
		const earlier = await readCases(visitDoc(), {
			editSource: withEarlierClockRow("visited_at"),
		});
		const records = earlier.ctx.facts.sameStateRewrites.filter(
			(one) => one.register === "date-and-time-saved-as-hq-stores-it",
		);
		expect(records).toHaveLength(1);
		expect(records.every(coveredByItsEntry)).toBe(true);
		const current = await readExport(visitDoc(), TARGET);
		expect(
			applies(
				"date-and-time-saved-as-hq-stores-it",
				factsOf(current, {
					facts: {
						sameStateRewrites: [
							...current.draft.facts.sameStateRewrites,
							...records,
						],
					},
				}),
			),
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
