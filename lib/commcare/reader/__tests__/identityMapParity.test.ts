/**
 * The keys a reading mints under are the keys the projection of its document
 * spells: for an app the reader reads, `draft.identities.entries` equals
 * `externalIdentityMap(doc, targetWireIdentity(rows))`, the rows being the
 * menu ids and `xmlns` the reading recorded.
 *
 * Catches a reader module that mints an entity under a key the projection
 * spells another way (another part order, another ordinal, another kind), or
 * an entity one side holds and the other does not: the two readings of a
 * change made in CommCare HQ would then bind different entities to one key.
 *
 * Over Nova's own exports of apps that, together, hold an entity of every
 * kind a key names and a case change in every place one takes, each of which
 * must read; and over the retained sources of CommCare HQ's apps under
 * `proof/hq-reads/`, the ones that read held to the same equality and the
 * others to an account, so a source that comes to read is held to it too.
 */
import { describe, expect, it } from "vitest";
import {
	type RetainedHqAnswer,
	retainedBodyJson,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	OP as ADVANCED_OP,
	U as ADVANCED_U,
	advancedFixture,
	read as advancedRead,
	chosen,
	HOUSEHOLDS,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { buildShape } from "@/lib/commcare/__tests__/formLinkDocArbitrary";
import {
	childCreate,
	OP,
	own,
	placementFixture,
	read,
} from "@/lib/commcare/__tests__/placementFixture";
import {
	type BlueprintDoc,
	type CaseOperation,
	idMappingColumn,
	phoneColumn,
	plainColumn,
} from "@/lib/domain";
import { concat, literal, term } from "@/lib/domain/expression";
import { independentChoicesBlueprint } from "@/proof/targeted/documents/independentFormChoices";
import type { HqLocationType } from "../../hq/locations";
import {
	targetWireIdentity,
	type WireIdentityOverride,
} from "../../wireIdentity";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import {
	EXTERNAL_ENTITY_KINDS,
	externalKeyText,
	type IdentityMapEntry,
} from "../identity";
import { externalIdentityMap } from "../identityMap";
import { knownCaseTypesOf, readHqApp } from "../index";
import type { ReadDraft, ReaderInput, ReadOutcome } from "../types";
import { type ExportEdits, exportedBody, inputFor } from "./novaExport";
import { readerInput, sourceFromBody } from "./readerInput";

function byKey(
	entries: readonly IdentityMapEntry[],
): readonly IdentityMapEntry[] {
	return [...entries].sort((a, b) => {
		const left = externalKeyText(a);
		const right = externalKeyText(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

/** The identity rows a reading records: each menu's id and each form's `xmlns`. */
function rowsOf(draft: ReadDraft): WireIdentityOverride[] {
	return [
		...draft.identities.modules.map(
			(module): WireIdentityOverride => ({
				entityKind: "module",
				novaEntityUuid: module.uuid,
				uniqueId: module.uniqueId,
				xmlns: null,
			}),
		),
		...draft.identities.forms.map(
			(form): WireIdentityOverride => ({
				entityKind: "form",
				novaEntityUuid: form.uuid,
				uniqueId: null,
				xmlns: form.xmlns,
			}),
		),
	];
}

function expectParity(draft: ReadDraft): void {
	expect(byKey(draft.identities.entries)).toEqual(
		byKey(externalIdentityMap(draft.doc, targetWireIdentity(rowsOf(draft)))),
	);
}

/** The draft of an outcome that must read; a finding fails the test by its code. */
function readDraft(outcome: ReadOutcome): ReadDraft {
	if (outcome.kind !== "read")
		expect(outcome.findings.map((finding) => finding.code)).toEqual([]);
	expect(outcome.kind).toBe("read");
	return (outcome as Extract<ReadOutcome, { kind: "read" }>).draft;
}

/** One of Nova's apps, exported as HQ serves it, with what the reading is handed beside it. */
interface NovaApp {
	readonly doc: () => BlueprintDoc;
	readonly edits?: ExportEdits;
	readonly input?: Partial<ReaderInput>;
}

/** The followup's worker-record update, which takes the basic usercase slot. */
function workerUpdate(): CaseOperation {
	return {
		uuid: OP("worker"),
		id: "worker",
		action: "update",
		caseType: "commcare-user",
		target: { kind: "worker-record" },
		writes: [{ property: "age", value: read("age") }],
	} as CaseOperation;
}

/** A menu, its case list and one form, each with a deep link. */
function entryPoints(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListMenuItem: {},
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
						],
					},
				],
			},
		],
	});
	const [moduleUuid] = doc.moduleOrder;
	const formUuid = doc.formOrder[moduleUuid]?.[0];
	if (moduleUuid === undefined || formUuid === undefined)
		throw new Error("The fixture holds one menu and one form.");
	doc.modules[moduleUuid] = {
		...doc.modules[moduleUuid],
		entryPoint: { uuid: testUuid("parity-ep-menu"), id: "patients" },
		caseListEntryPoint: {
			uuid: testUuid("parity-ep-list"),
			id: "patient-list",
		},
	};
	doc.forms[formUuid] = {
		...doc.forms[formUuid],
		entryPoint: { uuid: testUuid("parity-ep-form"), id: "visit" },
	};
	return doc;
}

/** A survey whose two Hidden Values a person set, in HQ, to read the worker and a place. */
function worldSurvey(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							f({ kind: "text", id: "place", label: "Place" }),
							f({ kind: "hidden", id: "district", calculate: "1" }),
							f({ kind: "hidden", id: "zone", calculate: "2" }),
						],
					},
				],
			},
		],
	});
}

/** `xml` with the one attribute `from` replaced by `to`. */
function replaceOnce(xml: string, from: string, to: string): string {
	const at = xml.indexOf(from);
	if (at < 0 || xml.indexOf(from, at + 1) >= 0)
		throw new Error(`The source holds ${from} other than once.`);
	return `${xml.slice(0, at)}${to}${xml.slice(at + from.length)}`;
}

function level(
	code: string,
	parentCode: string | null,
	sharesCases: boolean,
): HqLocationType {
	return {
		id: code,
		name: code.toUpperCase(),
		code,
		parentCode,
		administrative: false,
		sharesCases,
		viewDescendants: false,
	};
}

const LEVELS = [level("state", null, false), level("district", "state", true)];

const NOVA_APPS: Readonly<Record<string, NovaApp>> = {
	"two menus of questions, a group and choices": {
		doc: () =>
			buildDoc({
				modules: [
					{
						name: "Intake",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [
									f({ kind: "text", id: "name", label: "Name" }),
									f({
										kind: "group",
										id: "home",
										label: "Home",
										children: [f({ kind: "int", id: "rooms", label: "Rooms" })],
									}),
								],
							},
							{
								name: "Follow up",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										id: "status",
										label: "Status",
										options: [
											{ value: "well", label: "Well" },
											{ value: "ill", label: "Ill" },
										],
									}),
								],
							},
						],
					},
					{
						name: "Feedback",
						forms: [
							{
								name: "Rate",
								type: "survey",
								fields: [f({ kind: "text", id: "note", label: "Note" })],
							},
						],
					},
				],
			}),
	},
	"a followup's own case, a child, a child in each row and the worker's record":
		{
			doc: () =>
				placementFixture("followup", {
					operations: (formType) => [
						own(),
						childCreate("kid", formType),
						childCreate("row", formType, { repeat: "kids" }),
						workerUpdate(),
					],
				}).doc,
		},
	"a followup's own case written by Save to Case": {
		doc: () =>
			placementFixture("followup", {
				operations: () => [
					own({
						writes: [
							// A computed value, which Case Management cannot state, so the
							// own arm takes a block. (`status` is a word the gate reserves.)
							{
								property: "photo_url",
								value: concat(read("name"), term(literal(" seen"))),
							},
						],
					}),
				],
			}).doc,
	},
	"an advanced followup that writes its own case and the parent it chose": {
		doc: () =>
			advancedFixture({
				formType: "followup",
				menu: "members",
				operations: (): CaseOperation[] => [
					{
						uuid: ADVANCED_OP("own"),
						id: "member",
						action: "own",
						writes: [{ property: "age", value: advancedRead("age") }],
					},
					{
						uuid: ADVANCED_OP("parent"),
						id: "household",
						action: "update",
						caseType: "household",
						target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
						writes: [{ property: "remark", value: advancedRead("name") }],
					},
				],
			}).doc,
	},
	"an advanced registration with a child in each row": {
		doc: () =>
			advancedFixture({
				formType: "registration",
				operations: (): CaseOperation[] => [
					{
						uuid: ADVANCED_OP("own"),
						id: "household",
						action: "own",
						name: advancedRead("name"),
					},
					{
						uuid: ADVANCED_OP("kid"),
						id: "member",
						action: "create",
						caseType: "member",
						target: { kind: "new" },
						name: advancedRead("kid_name"),
						forEach: { repeat: ADVANCED_U("kids") },
						links: [
							{
								identifier: "parent",
								targetType: "household",
								target: { kind: "op", opUuid: ADVANCED_OP("own") },
								relationship: "child",
							},
						],
					},
				],
			}).doc,
	},
	"a case list with two columns of one kind and property, and two Search fields":
		{
			doc: () =>
				patients(
					[
						plainColumn(uuid(1), "case_name", "Name"),
						plainColumn(uuid(2), "phone", "Phone"),
						plainColumn(uuid(3), "phone", "Phone again"),
						phoneColumn(uuid(4), "phone", "Call"),
						idMappingColumn(uuid(5), "notes", "Area", [
							{ value: "a", label: "Area A" },
						]),
					],
					{
						searchInputs: [
							{
								uuid: uuid(9),
								name: "notes",
								label: "Notes",
								kind: "simple",
								type: "text",
								property: "notes",
							},
							{
								uuid: uuid(10),
								name: "phone",
								label: "Phone",
								kind: "simple",
								type: "barcode",
								property: "phone",
							},
						],
						search: {},
						list: {
							calculatedSorts: [
								{
									uuid: uuid(20),
									expression: term(literal("a")),
									direction: "asc",
									priority: 0,
									label: "Priority",
								},
							],
							detailTabs: [
								{ uuid: uuid(21), title: "Patient", startColumnUuid: uuid(1) },
								{ uuid: uuid(22), title: "Contact", startColumnUuid: uuid(4) },
							],
							// Two filters on one request key, which count apart.
							searchFilters: [
								{
									uuid: uuid(11),
									target: { kind: "owner" },
									value: term(literal("worker-a")),
								},
								{
									uuid: uuid(12),
									target: { kind: "owner" },
									value: term(literal("worker-b")),
								},
							],
						},
					},
				),
		},
	"a deep link to a menu, its case list and a form": { doc: entryPoints },
	"two choices from one list, an automatic record and a value made at entry": {
		doc: () => independentChoicesBlueprint("parity-independent-choices"),
	},
	"values two opening records and the form's own record give its questions": {
		doc: () => independentChoicesBlueprint("parity-opening-values", true),
	},
	"two links to one menu, a link to a form and a link otherwise": {
		doc: () =>
			buildShape(
				[
					{ flag: 0, toMenu: true },
					{ flag: 1, toMenu: true },
					{ carry: "c0", toMenu: false },
				],
				{ kind: "link" },
			),
	},
	"reads of the worker and of a place, in a project space with levels": {
		doc: worldSurvey,
		edits: {
			xml: (xml) =>
				replaceOnce(
					replaceOnce(
						xml,
						'calculate="1"',
						`calculate="instance('commcaresession')/session/user/data/district"`,
					),
					'calculate="2"',
					`calculate="instance('locations')/locations/location[@id = /data/place]/location_data/zone"`,
				),
		},
		input: {
			sourceProjectFactories: { locations: "flat" },
			organization: {
				levelCodes: LEVELS.map((one) => one.code),
				levels: LEVELS,
			},
		},
	},
};

async function readNovaApp(app: NovaApp): Promise<ReadDraft> {
	return readDraft(
		readHqApp(
			await inputFor(exportedBody(app.doc(), app.edits), {
				knownCaseTypes: knownCaseTypesOf(app.doc()),
				...app.input,
			}),
		),
	);
}

/** The place of a case operation's key, as far as its kind of place. */
function placeKind(entry: IdentityMapEntry): string {
	const place = entry.parts[1] as readonly unknown[];
	return place[0] === "basic" ? `basic ${String(place[1])}` : String(place[0]);
}

describe("the keys a reading of Nova's own export mints", () => {
	for (const [name, app] of Object.entries(NOVA_APPS))
		it(`are the keys the projection spells, for ${name}`, async () => {
			const draft = await readNovaApp(app);
			expect(draft.identities.entries.length).toBeGreaterThan(0);
			expectParity(draft);
		});

	it("cover every kind a key names, every place a case change takes, and the ordinals", async () => {
		const entries: IdentityMapEntry[] = [];
		for (const app of Object.values(NOVA_APPS))
			entries.push(...(await readNovaApp(app)).identities.entries);
		expect(new Set(entries.map((entry) => entry.kind))).toEqual(
			new Set(EXTERNAL_ENTITY_KINDS),
		);
		expect(
			new Set(
				entries
					.filter((entry) => entry.kind === "caseOperation")
					.map(placeKind),
			),
		).toEqual(
			new Set([
				"basic own",
				"basic subcase",
				"basic subcase-row",
				"basic usercase",
				"advanced",
				"save-to-case",
			]),
		);
		const ordinals = (kind: IdentityMapEntry["kind"]) =>
			entries
				.filter((entry) => entry.kind === kind)
				.map((entry) => entry.parts.at(-1));
		expect(ordinals("caseListColumn")).toContain(1);
		expect(ordinals("formLink")).toContain(2);
		expect(
			new Set(
				entries
					.filter((entry) => entry.kind === "entryPoint")
					.map((entry) => JSON.stringify([entry.parts[0], entry.parts[2]])),
			),
		).toEqual(
			new Set([
				JSON.stringify(["module", "menu"]),
				JSON.stringify(["module", "case-list"]),
				JSON.stringify(["form", undefined]),
			]),
		);
	});
});

async function readRetained(answer: RetainedHqAnswer): Promise<ReadOutcome> {
	return readHqApp({
		...readerInput(await sourceFromBody(retainedBodyJson(answer))),
		recordDialect: () => undefined,
	});
}

/** Retained app sources the reader reads. */
const RETAINED_READ: readonly string[] = [
	"navigation-base/app-source",
	"navigation-base/app-source-after-form-builder-save",
	"case-list-inline/app-source",
];

/**
 * Retained app sources holding content Nova does not hold, with the finding
 * that says so: a report menu beside a shared form, and a report menu beside a visit schedule. Each
 * is held to its account; one that comes to read moves to `RETAINED_READ`.
 */
const RETAINED_ACCOUNT: readonly [string, () => RetainedHqAnswer, string][] = [
	[
		"reading/source-shadow",
		() => retainedReadingRead("source-shadow"),
		"menus-and-case-lists/reportmodule-mobile-ucr-and-all-of-report-configs",
	],
	[
		"hq-built/app-source",
		() => retainedGroupRead("hq-built/app-source"),
		"menus-and-case-lists/reportmodule-mobile-ucr-and-all-of-report-configs",
	],
];

describe("the keys a reading of CommCare HQ's retained sources mints", () => {
	for (const file of RETAINED_READ)
		it(`are the keys the projection spells, for ${file}`, async () => {
			const draft = readDraft(await readRetained(retainedGroupRead(file)));
			expect(draft.identities.entries.length).toBeGreaterThan(0);
			expectParity(draft);
		});

	for (const [file, answer, code] of RETAINED_ACCOUNT)
		it(`are none for ${file}, which reads to an account`, async () => {
			const outcome = await readRetained(answer());
			expect(outcome.kind).toBe("account");
			if (outcome.kind === "account")
				expect(outcome.findings.map((finding) => finding.code)).toContain(code);
		});
});
