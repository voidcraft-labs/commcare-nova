/**
 * The canonical form of a document, and the pairs its rows name.
 *
 * Contract: every row of `CANONICALIZATIONS` rewrites one member of a pair
 * into the member a reading returns, and the two members print the same
 * bytes: for each row a document holding the other member, built from the
 * production builders, is moved by the row, and its export and the row's
 * result's, under identical options, are equal file by file, the HQ import
 * file always and the local archive's every file where the app declares
 * Android (for a `not-carried` row, the content present and removed). The
 * row's result is a fixed point of the row. The two rows another test prints
 * both members of are named here with that test: `unheld-placements-are-held`
 * (`lib/commcare/__tests__/heldPlacementEmission.test.ts`) and
 * `expression-print-collisions` (`expressions/__tests__/printCollisions.test.ts`;
 * its whole-document application is held by `canonicalRowsKeepExport.test.ts`).
 * `canonDocument` is its own canonical form, for every document the proof lane
 * publishes, and a reading's own document is already canonical, for each of
 * CommCare HQ's retained sources that reads whole.
 *
 * Plausible failures: a row that hides a difference a runtime reads (its two
 * members print another form, suite or locale file); a row with no case, so
 * a row added to the list proves nothing; two rows that undo each other, so
 * the canonical form never settles; a row that moves a document the reader
 * returns, so a read back compares with a document no reading gives.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
	retainedBodyJson,
	retainedGroupRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import {
	advancedFixture,
	OP,
	read as readField,
	U,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { caseOperationFixture } from "@/lib/commcare/__tests__/caseOperationFixture";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	type CaseOperation,
	type Column,
	type Expression,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	type SearchInputDef,
	simpleSearchInputDef,
	type TranslationUnitId,
	translationSourceFingerprint,
	translationUnitsById,
	type Uuid,
} from "@/lib/domain";
import {
	and,
	concat,
	eq,
	formField,
	input,
	literal,
	matchAll,
	prop,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import {
	type CaseSearchConfig,
	columnSort,
	phoneColumn,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	type SearchInputRequired,
	tileCell,
} from "@/lib/domain/modules";
import { declaredPlatforms } from "@/lib/domain/platforms";
import { EMPTY_PROSE_TEMPLATE } from "@/lib/domain/prose";
import { searchRuntimeValidationMessage } from "@/lib/domain/searchRuntimeValidationMessages";
import { compileCcz } from "../../compiler";
import { DEFAULT_ASSESSMENT_USER_SCORE_EXPRESSION } from "../../connectDefaults";
import { expandDoc } from "../../expander";
import { withCandidate } from "../candidate";
import {
	CANONICALIZATIONS,
	type Canonicalization,
	canonDocument,
} from "../canon";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import { readHqApp } from "../index";
import { sameJson } from "../jsonCursor";
import { hydrated, publishedCorpus } from "./publishedDocuments";
import { readerInput, sourceFromBody } from "./readerInput";

// ── The two exports of a document ────────────────────────────────────────

/** Every file a document's exports hold, by name: the HQ import file, and
 *  where the app declares Android each file of the local archive Nova
 *  compiles for one project space (`lib/export/localArchive.ts` compiles the
 *  same expansion and archive for a prepared document). */
function emittedFiles(doc: BlueprintDoc): Map<string, string> {
	const files = new Map<string, string>([
		["hq-import.json", JSON.stringify(expandDoc(doc))],
	]);
	if (declaredPlatforms(doc).includes("android")) {
		const archive = new AdmZip(
			compileCcz(
				expandDoc(doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
				doc.appName,
				doc,
				{ runtimeTarget: TEST_RUNTIME_TARGET },
			),
		);
		for (const entry of archive.getEntries())
			files.set(`ccz/${entry.entryName}`, entry.getData().toString("base64"));
	}
	return files;
}

/** The names of the files two documents' exports hold that differ, or that one holds alone. */
function differingFiles(a: BlueprintDoc, b: BlueprintDoc): string[] {
	const one = emittedFiles(a);
	const other = emittedFiles(b);
	return [...new Set([...one.keys(), ...other.keys()])]
		.filter((name) => one.get(name) !== other.get(name))
		.sort();
}

const stored = (doc: BlueprintDoc) => toPersistableDoc(doc);

function row(id: string): Canonicalization {
	const found = CANONICALIZATIONS.find((one) => one.id === id);
	if (found === undefined) throw new Error(`No canonicalization ${id}.`);
	return found;
}

// ── The documents the pairs are built from ───────────────────────────────

/** A menu of clients with a registration that names the client and a follow-up that writes a note. */
function caseApp(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Clients",
				caseType: "client",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "client", property: "case_name" },
							}),
						],
					},
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "note",
								label: "Note",
								caseWrite: { caseType: "client", property: "note" },
							}),
						],
					},
				],
			},
		],
	});
}

/** A survey menu of one form holding `fields`. */
function survey(fields: ReturnType<typeof f>[]): BlueprintDoc {
	return buildDoc({
		modules: [
			{ name: "Survey", forms: [{ name: "Visit", type: "survey", fields }] },
		],
	});
}

function fieldNamed(doc: BlueprintDoc, id: string): Record<string, unknown> {
	const found = Object.values(doc.fields).find((one) => one.id === id);
	if (found === undefined) throw new Error(`No field ${id}.`);
	return found as unknown as Record<string, unknown>;
}

/** A one-form survey with French beside English, holding a menu name's
 *  translation from a model that wants review, a form name's translation
 *  equal to its source, and an app name's translation of an older source. */
function localized(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Clients",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [f({ kind: "text", id: "a", label: "A" })],
					},
				],
			},
		],
	});
	const menu = doc.moduleOrder[0] as Uuid;
	const form = doc.formOrder[menu]?.[0] as Uuid;
	return produce(doc, (draft) => {
		draft.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			wireCodes: { eng: "en", fra: "fr" },
			translations: {
				fra: {
					[makeTranslationUnitId("module", menu, "name")]: {
						value: "Les clients",
						sourceFingerprint: translationSourceFingerprint("text", "Clients"),
						origin: "ai",
						review: "needs-review",
						translatedFrom: "eng",
					},
					[makeTranslationUnitId("form", form, "name")]: {
						value: "Visit",
						sourceFingerprint: translationSourceFingerprint("text", "Visit"),
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
					[makeTranslationUnitId("app", "name")]: {
						value: "Une app",
						sourceFingerprint: translationSourceFingerprint(
							"text",
							"An older name",
						),
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			},
		} as never;
	});
}

/** A survey whose one question's label is blank in English and held in French. */
function blankSourceLabel(): BlueprintDoc {
	const doc = survey([f({ kind: "text", id: "q", label: "" })]);
	const q = fieldNamed(doc, "q").uuid as Uuid;
	const unit = makeTranslationUnitId("field", q, "label");
	return produce(doc, (draft) => {
		draft.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			wireCodes: { eng: "en", fra: "fra" },
			translations: {
				fra: {
					[unit]: {
						value: proseText("Bonjour"),
						sourceFingerprint: translationSourceFingerprint(
							"prose",
							proseText(""),
						),
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			},
		} as never;
	});
}

/** Two required Search fields of a menu of patients in English and Spanish: the first holding
 *  Nova's English sentence as its own message, translated "Complete esta respuesta antes de
 *  buscar.", the second none, Nova's own message translated "Responda esta pregunta, por favor.". */
function requiredMessages(): BlueprintDoc {
	const FIRST = testUuid("canon-required-first");
	const SECOND = testUuid("canon-required-second");
	const required = (uuid: Uuid): SearchInputRequired =>
		uuid === FIRST ? { message: SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE } : {};
	const doc = buildDoc({
		modules: [
			{
				uuid: testUuid("canon-required-menu"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(testUuid("canon-required-column"), "case_name", "Name"),
					],
					searchInputs: [
						simpleSearchInputDef(FIRST, "name", "Name", "text", "case_name", {
							required: required(FIRST),
						}),
						simpleSearchInputDef(SECOND, "phone", "Phone", "text", "phone", {
							required: required(SECOND),
						}),
					],
				},
				caseSearchConfig: {},
				forms: [
					{
						uuid: testUuid("canon-required-form"),
						name: "Register",
						type: "registration",
						fields: [
							f({
								uuid: testUuid("canon-required-name"),
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "phone", label: proseText("Phone"), data_type: "text" },
				],
			},
		],
	});
	const units = translationUnitsById(doc);
	const entry = (unitId: TranslationUnitId, value: string) => ({
		value,
		sourceFingerprint: units.get(unitId)?.sourceFingerprint,
		origin: "human",
		review: "reviewed",
		translatedFrom: "eng",
	});
	const own = makeTranslationUnitId("search-input", FIRST, "required-message");
	const system = makeTranslationUnitId("system", "search-required", "default");
	return produce(doc, (draft) => {
		draft.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: {
				spa: {
					[own]: entry(own, "Complete esta respuesta antes de buscar."),
					[system]: entry(system, "Responda esta pregunta, por favor."),
				},
			},
		} as never;
	});
}

/** The prompts fixture with English first and its source, and Spanish translating the quote
 *  guard joined after the status field's message. */
function joinedGuard(): BlueprintDoc {
	const doc = localizationWireFixture("prompts");
	const localization = doc.localization;
	const spanish = localization?.translations.spa;
	if (localization === undefined || spanish === undefined)
		throw new Error("The fixture holds no Spanish.");
	const key = searchRuntimeValidationMessage(new Set(["quote"]))?.key ?? "";
	const guard = makeTranslationUnitId("system", "search-validation", key);
	const entry = spanish[guard];
	if (entry !== undefined)
		spanish[guard] = { ...entry, value: "Quite las comillas." };
	doc.localization = {
		...localization,
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
	};
	return doc;
}

const NAME_FIELD: SearchInputDef = simpleSearchInputDef(
	uuid(9),
	"name",
	"Name",
	"text",
	"case_name",
);

/** A menu of patients listing their names, searched by `inputs` under `search`. */
function searched(
	inputs: SearchInputDef[],
	search: CaseSearchConfig | undefined,
): BlueprintDoc {
	return patients([plainColumn(uuid(1), "case_name", "Name")], {
		searchInputs: inputs,
		...(search !== undefined && { search }),
	});
}

/** The producer document whose end-of-form link carries the case it registers into a menu whose
 *  forms read the search, the link carrying nothing and holding the guards of the values
 *  automatic matching carries as its condition. */
function searchLinkGuarded(): BlueprintDoc {
	const document = publishedCorpus().find(
		(one) => one.id === "search-hidden-link",
	);
	if (document === undefined)
		throw new Error("The corpus holds the document search-hidden-link.");
	const doc = hydrated(document);
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		const [link] = form.formLinks ?? [];
		const [carried] = link?.datums ?? [];
		if (link === undefined || carried === undefined) continue;
		const caseType =
			carried.name.kind === "selected-case"
				? (doc.modules[carried.name.module]?.caseType ?? "")
				: "";
		const guard = {
			kind: "gt",
			left: {
				kind: "count",
				via: {
					kind: "cases",
					source: "casedb",
					where: [
						and(
							eq(
								{
									kind: "term",
									term: { kind: "prop", property: "case_id", caseType },
								} as Expression,
								carried.xpath,
							),
							eq(
								{ kind: "term", term: { kind: "case-row-type" } } as Expression,
								{
									kind: "term",
									term: { kind: "case-type", caseType },
								} as Expression,
							),
						),
					],
				},
			},
			right: term(literal(0)),
		} as Expression;
		return withCandidate(doc, (draft) => {
			const one = draft.forms[formUuid as Uuid]?.formLinks?.[0];
			if (one === undefined) return;
			delete one.datums;
			one.condition = guard as typeof one.condition;
		});
	}
	throw new Error("The document holds a link that carries a value.");
}

/** Two columns over patients' names and notes, the notes hidden from Results, each with a tile
 *  cell, on a list `tiled` or not. */
function tileCells(tiled: boolean): BlueprintDoc {
	return patients(
		[
			plainColumn(uuid(1), "case_name", "Name", {
				tile: tileCell(0, 0, 12, 1),
			}),
			plainColumn(uuid(2), "notes", "Notes", {
				visibleInList: false,
				tile: tileCell(0, 1, 12, 1),
			}),
		],
		tiled ? { list: { tile: {} } } : {},
	);
}

/** A follow-up of a menu of patients whose own arm changes nothing, beside an update of the
 *  session's case that writes a computed score: both print the block the own arm prints. */
function updateBesideBareOwn(): BlueprintDoc {
	const id = (key: string) => testUuid(`canon-bare-own-${key}`);
	const text = (key: string) =>
		f({ kind: "text", uuid: id(key), id: key, label: proseText(key) });
	return buildDoc(
		{
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "note", label: proseText("Note"), data_type: "text" },
						{ name: "score", label: proseText("Score"), data_type: "text" },
					],
				},
			],
			modules: [
				{
					uuid: id("menu"),
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: id("form"),
							name: "Visit",
							type: "followup",
							fields: [text("name"), text("note")],
						},
					],
				},
			],
		},
		(built) => {
			const form = built.forms[id("form")];
			if (form !== undefined)
				form.caseOperations = [
					{ uuid: id("own"), id: "own_case", action: "own" } as CaseOperation,
					{
						uuid: id("update"),
						id: "patient",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						writes: [
							{
								property: "score",
								value: concat(
									term(formField(id("note"))),
									term(literal(" points")),
								),
							},
						],
					} as CaseOperation,
				];
		},
	);
}

// ── One pair per row ──────────────────────────────────────────────────────

/** A pair: the member a reading does not return, as a production-built document. Where the row
 *  reads what the rows before it settle, `afterEarlierRows` applies those first, as
 *  `canonDocument` does. */
interface Pair {
	readonly id: string;
	readonly name: string;
	readonly other: () => BlueprintDoc;
	readonly afterEarlierRows?: true;
}

const PAIRS: readonly Pair[] = [
	{
		id: "root-question-lists-are-sections",
		name: "a root of one question list with no condition",
		other: () =>
			survey([
				f({
					kind: "group",
					id: "one",
					label: "One",
					fieldList: true,
					children: [f({ kind: "text", id: "a", label: "A" })],
				}),
			]),
	},
	{
		id: "blank-itext-takes-the-filled-text",
		name: "a label blank in English and held in French",
		other: blankSourceLabel,
	},
	{
		id: "translation-equal-to-source-is-absent",
		name: "a form name's translation equal to its source",
		other: localized,
	},
	{
		id: "plain-flag-on-blank-text-is-absent",
		name: "a plain flag on a help text blank in every language",
		other: () =>
			survey([
				f({
					kind: "text",
					id: "b",
					label: "B",
					help: EMPTY_PROSE_TEMPLATE,
					plainHelp: true,
				}),
			]),
	},
	{
		id: "plain-flag-under-plain-text-is-absent",
		name: "plain flags on a question and a choice in a form whose formatting is off",
		other: () =>
			produce(
				survey([
					f({
						kind: "single_select",
						id: "pick",
						label: "Pick",
						help: "Help",
						options: [
							{ value: "a", label: "A" },
							{ value: "b", label: "B" },
						],
					}),
				]),
				(draft) => {
					for (const form of Object.values(draft.forms)) form.plainText = true;
					const pick = Object.values(draft.fields)[0] as unknown as Record<
						string,
						unknown
					> & { optionsSource: { options: Record<string, unknown>[] } };
					pick.plainLabel = true;
					pick.plainHelp = true;
					const [first] = pick.optionsSource.options;
					if (first !== undefined) first.plainLabel = true;
				},
			),
	},
	{
		id: "blank-container-label-is-absent",
		name: "a group whose label has no parts",
		other: () =>
			survey([
				f({
					kind: "group",
					id: "g",
					label: EMPTY_PROSE_TEMPLATE,
					children: [f({ kind: "text", id: "a", label: "A" })],
				}),
			]),
	},
	{
		id: "validation-message-with-no-condition-is-absent",
		name: "a validation message on a question with no condition",
		other: () =>
			survey([
				f({
					kind: "text",
					id: "note",
					label: "Note",
					validate_msg: proseText("Never shown"),
				}),
			]),
	},
	{
		id: "translation-provenance-is-read-as-reviewed",
		name: "a current translation a model wrote that wants review",
		other: localized,
	},
	{
		id: "out-of-date-translation-is-absent",
		name: "an app name's translation of an older source",
		other: localized,
	},
	{
		id: "blank-optional-text-is-absent",
		name: "a hint, a validation message and a help text beside its picture, blank everywhere",
		other: () =>
			survey([
				f({
					kind: "text",
					id: "answer",
					label: proseText("Answer"),
					hint: EMPTY_PROSE_TEMPLATE,
					validate: "string-length(.) > 1",
					validate_msg: EMPTY_PROSE_TEMPLATE,
				}),
				f({
					kind: "text",
					id: "helped",
					label: proseText("Helped"),
					help: EMPTY_PROSE_TEMPLATE,
				}),
			]),
	},
	{
		id: "connect-defaults-are-unset",
		name: "a Connect assessment's score holding the default an unset one prints",
		other: () =>
			buildDoc({
				connectType: "learn",
				modules: [
					{
						name: "Learn",
						forms: [
							{
								name: "Lesson",
								type: "survey",
								connect: {
									assessment: {
										id: "quiz",
										user_score: DEFAULT_ASSESSMENT_USER_SCORE_EXPRESSION,
									},
								},
								fields: [f({ kind: "int", id: "points" })],
							},
						],
					},
				],
			}),
	},
	{
		id: "source-language-is-as-read",
		name: "an English source behind a Spanish first language, nothing telling them apart",
		other: () => localizationWireFixture("optional"),
	},
	{
		id: "joined-search-guards-split-as-read",
		name: "a Spanish guard joined after a field's message, split where the document splits it",
		other: joinedGuard,
	},
	{
		id: "required-messages-as-read",
		name: "Nova's sentence as the first required field's own message",
		other: requiredMessages,
	},
	{
		id: "default-search-title-is-absent",
		name: "a search titled with Nova's default title",
		other: () => searched([NAME_FIELD], { searchScreenTitle: "Search" }),
	},
	{
		id: "empty-search-settings-beside-fields-are-absent",
		name: "search settings that set nothing beside a Search field",
		other: () => searched([NAME_FIELD], {}),
	},
	{
		id: "exact-search-mode-is-absent",
		name: "a text Search field naming exact matching",
		other: () =>
			searched(
				[
					{
						uuid: uuid(9),
						name: "notes",
						label: "Field",
						kind: "simple",
						property: "notes",
						type: "text",
						mode: { kind: "exact" },
					} as SearchInputDef,
				],
				{},
			),
	},
	{
		id: "registration-form-last",
		name: "a registration offered after an empty search, first in its menu",
		other: () => {
			const register = {
				uuid: "canon-after-empty-register",
				name: "Register",
				type: "registration" as const,
				fields: [
					f({
						kind: "text",
						id: "name",
						caseWrite: { caseType: "patient", property: "case_name" },
					}),
				],
			};
			return buildDoc({
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						caseSearchConfig: { formsReadSearch: true },
						caseListRegistrationForm: { formUuid: register.uuid },
						forms: [
							register,
							{
								name: "Visit",
								type: "followup" as const,
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
		},
	},
	{
		id: "create-name-required-is-absent",
		name: "a required condition on the question that names a created case",
		other: () =>
			produce(caseApp(), (draft) => {
				const name = Object.values(draft.fields).find(
					(one) => one.id === "case_name",
				) as { required?: unknown };
				name.required = term(literal("x"));
			}),
	},
	{
		id: "default-post-submit-is-absent",
		name: "a follow-up storing its own default after-submit",
		other: () =>
			produce(caseApp(), (draft) => {
				const visit = Object.values(draft.forms).find(
					(one) => one.name === "Visit",
				);
				if (visit !== undefined) visit.postSubmit = "previous";
			}),
	},
	{
		id: "search-link-guards-are-carried-values",
		name: "a link into a menu whose forms read the search, holding the carried values' guards",
		other: searchLinkGuarded,
	},
	{
		id: "derived-search-conditions-are-simple-fields",
		name: "an advanced Search field whose condition is a simple field's derivation",
		other: () =>
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [
					{
						uuid: uuid(9),
						name: "number",
						label: "Number",
						kind: "advanced",
						type: "text",
						predicate: whenInput(
							input(uuid(9)),
							eq(prop("patient", "phone"), input(uuid(9))),
						),
					},
				],
				search: {},
			}),
	},
	{
		id: "dormant-tile-cells",
		name: "tile cells on a list that is no tile",
		other: () => tileCells(false),
	},
	{
		id: "dormant-tile-cells",
		name: "a tile cell on a column hidden from Results in a tile list",
		other: () => tileCells(true),
	},
	{
		id: "match-all-list-filter-is-absent",
		name: "a list filter that simplifies to match-all",
		other: () =>
			produce(caseApp(), (draft) => {
				const module = Object.values(draft.modules)[0];
				if (module !== undefined)
					module.caseListConfig = {
						...caseListConfig([{ field: "note", header: "Note" }]),
						filter: and(matchAll(), matchAll()),
					};
			}),
	},
	{
		id: "order-rules-on-the-columns-they-land-on",
		name: "a rule on a hidden column after a shown one over its property",
		other: () =>
			patients([
				plainColumn(uuid(1), "notes", "Notes"),
				phoneColumn(uuid(2), "notes", "Notes again", {
					visibleInList: false,
					sort: columnSort("desc", 0),
				}),
			]),
	},
	{
		id: "implicit-order-rule-is-absent",
		name: "the one rule an unsorted list with a hidden first field writes",
		other: () =>
			withCandidate(
				patients([
					plainColumn(uuid(1), "phone", "Phone", { visibleInList: false }),
					plainColumn(uuid(2), "notes", "Notes", {
						sort: columnSort("asc", 0),
					}),
					plainColumn(uuid(3), "case_name", "Name"),
				]),
				(draft) => {
					draft.caseTypes = [
						{
							name: "patient",
							properties: ["notes", "dob", "phone"].map((name) => ({
								name,
								label: proseText(name),
							})),
						},
					];
				},
			),
	},
	{
		id: "order-priorities-as-read",
		name: "two rules numbered 3 and 1, the second shown first",
		other: () =>
			patients([
				plainColumn(uuid(1), "case_name", "Name", {
					sort: columnSort("asc", 3),
				}),
				plainColumn(uuid(2), "notes", "Notes", {
					sort: columnSort("desc", 1),
				}),
			]),
	},
	{
		id: "tile-columns-shown-nowhere-are-as-read",
		name: "a sorted tile column hidden from Results and Details, with its header",
		other: () => tileFixture("tile"),
	},
	{
		id: "unsorted-hidden-tile-columns-are-off-the-list",
		name: "an unsorted tile column hidden from Results without not-on-the-list",
		other: () =>
			patients(
				[
					plainColumn(uuid(1), "case_name", "Name", {
						tile: tileCell(0, 0, 12, 1),
					}),
					plainColumn(uuid(2), "notes", "Notes", { visibleInList: false }),
				],
				{ list: { tile: {} } },
			),
	},
	{
		id: "columns-of-a-menu-that-lists-no-cases-are-off-the-detail",
		name: "a survey menu's sorted columns and its search",
		other: () =>
			buildDoc({
				modules: [
					{
						name: "Household surveys",
						caseType: "household",
						caseListConfig: {
							columns: [
								plainColumn(uuid(2), "village", "Village", {
									sort: columnSort("desc", 0),
								}),
								plainColumn(uuid(1), "case_name", "Household"),
							],
							searchInputs: [NAME_FIELD],
						},
						caseSearchConfig: { searchScreenTitle: "Find a household" },
						forms: [
							{
								name: "Survey",
								type: "survey",
								fields: [
									f({ kind: "text", id: "notes", label: proseText("Notes") }),
								],
							},
						],
					},
				],
			}),
	},
	{
		id: "columns-off-a-screen-last-in-its-order",
		name: "columns off the detail and off the list amid each screen's order",
		other: () =>
			patients(
				[
					plainColumn(uuid(1), "case_name", "Name"),
					{
						...plainColumn(uuid(2), "notes", "Notes"),
						visibleInDetail: false,
					} as Column,
					{
						...plainColumn(uuid(3), "phone", "Phone"),
						visibleInList: false,
						notOnList: true,
					} as Column,
					plainColumn(uuid(4), "dob", "Born"),
				],
				{
					listOrder: [uuid(3), uuid(2), uuid(1), uuid(4)],
					detailOrder: [uuid(2), uuid(4), uuid(3), uuid(1)],
				},
			),
	},
	{
		id: "case-catalog-is-as-read",
		name: "a catalog holding a label no export holds and a property nothing reads",
		other: () =>
			produce(caseApp(), (draft) => {
				draft.caseTypes = [
					{
						name: "client",
						properties: [
							{ name: "note", label: proseText("A label no export holds") },
							{ name: "unread", label: proseText("Nothing reads this") },
						],
					},
				];
			}),
	},
	{
		id: "case-catalog-is-as-read",
		name: "a date and time property a date-range Search field reads and nothing writes",
		other: () =>
			produce(
				patients([plainColumn(uuid(1), "case_name", "Name")], {
					searchInputs: [
						simpleSearchInputDef(uuid(9), "seen", "Seen", "date-range", "seen"),
					],
				}),
				(draft) => {
					draft.caseTypes = [
						{
							name: "patient",
							properties: [
								{
									name: "seen",
									label: proseText("Seen"),
									data_type: "datetime",
								},
							],
						},
					];
				},
			),
	},
	{
		id: "write-via-steps-are-typed",
		name: "a save to the case above through an untyped step",
		other: () => {
			const VISIT = testUuid("canon-via-visit");
			const SIZE = testUuid("canon-via-size");
			return buildDoc(
				{
					caseTypes: [
						{
							name: "household",
							properties: [{ name: "size", label: "Size", data_type: "int" }],
						},
						{ name: "member", parent_type: "household", properties: [] },
					],
					modules: [
						{
							uuid: "canon-via-households",
							name: "Households",
							caseType: "household",
							forms: [
								{
									name: "Register",
									type: "registration",
									fields: [
										f({
											kind: "text",
											id: "name",
											caseWrite: {
												caseType: "household",
												property: "case_name",
											},
										}),
									],
								},
							],
						},
						{
							name: "Members",
							caseType: "member",
							parentCaseModuleUuid: "canon-via-households",
							forms: [
								{
									uuid: "canon-via-visit",
									name: "Visit",
									type: "followup",
									fields: [f({ kind: "int", id: "size", uuid: SIZE })],
								},
							],
						},
					],
				},
				(built) => {
					built.forms[VISIT] = {
						...built.forms[VISIT],
						caseOperations: [
							{
								uuid: testUuid("canon-via-own"),
								id: "member",
								action: "own",
								writes: [
									{
										property: "size",
										value: term(formField(SIZE)),
										via: [{ identifier: "parent" }],
									},
								],
							} as CaseOperation,
						],
					} as never;
				},
			);
		},
	},
	{
		id: "opened-case-owner-acting-user-is-absent",
		name: "a create owned by the acting user",
		other: () => caseOperationFixture("sequence"),
	},
	{
		id: "update-beside-a-bare-own-arm-is-the-own-arm",
		name: "an update of the session's case writing a computed value beside a bare own arm",
		other: updateBesideBareOwn,
	},
	{
		id: "basic-slot-operation-ids-are-derived",
		name: "an own arm and a child case under ids a reading does not give",
		other: () => {
			const base = buildDoc({
				modules: [
					{
						name: "Clients",
						caseType: "client",
						forms: [
							{
								name: "Visit",
								type: "followup",
								fields: [
									f({
										kind: "text",
										id: "note",
										label: "Note",
										caseWrite: { caseType: "client", property: "note" },
									}),
								],
							},
						],
					},
					{
						name: "Visits",
						caseType: "visit",
						forms: [{ name: "Review", type: "followup", fields: [] }],
					},
				],
			});
			const visit = Object.values(base.forms).find(
				(one) => one.name === "Visit",
			);
			const note = fieldNamed(base, "note").uuid as Uuid;
			if (visit === undefined) throw new Error("The app has no Visit form.");
			return produce(base, (draft) => {
				const operations = draft.forms[visit.uuid]?.caseOperations ?? [];
				const own = operations.find((one) => one.action === "own");
				if (own !== undefined) own.id = "renamed_own";
				operations.push({
					uuid: testUuid("canon-slot-ids-child"),
					id: "a_visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: term(formField(note)),
					writes: [],
					links: [
						{
							identifier: "parent",
							targetType: "client",
							target: { kind: "session" },
							relationship: "child",
						},
					],
				} as CaseOperation);
				const form = draft.forms[visit.uuid];
				if (form !== undefined) form.caseOperations = operations;
			});
		},
	},
	{
		id: "case-management-operations-in-reading-order",
		name: "an advanced registration's worker's record before its child, under ids no action prints",
		afterEarlierRows: true,
		other: () =>
			advancedFixture({
				formType: "registration",
				operations: () => [
					{
						uuid: OP("own"),
						id: "own_case",
						action: "own",
						name: readField("name"),
					},
					{
						uuid: OP("worker"),
						id: "worker_record",
						action: "update",
						caseType: "commcare-user",
						target: { kind: "worker-record" },
						writes: [{ property: "last_household", value: readField("name") }],
					} as CaseOperation,
					{
						uuid: OP("kid"),
						id: "kid",
						action: "create",
						caseType: "member",
						target: { kind: "new" },
						name: readField("kid_name"),
						links: [
							{
								identifier: "parent",
								targetType: "household",
								target: { kind: "op", opUuid: OP("own") },
								relationship: "child",
							},
						],
						forEach: { repeat: U("kids") },
					} as CaseOperation,
				],
			}).doc,
	},
	{
		id: "purpose-notes-are-absent",
		name: "a menu's and a form's purpose note",
		other: () =>
			produce(caseApp(), (draft) => {
				for (const module of Object.values(draft.modules))
					module.purpose = "Follow each client";
				for (const form of Object.values(draft.forms)) form.purpose = "Why";
			}),
	},
	{
		id: "app-logo-is-absent",
		name: "an app's logo",
		other: () =>
			produce(caseApp(), (draft) => {
				draft.logo = "33333333-3333-4333-8333-333333333333" as never;
			}),
	},
	{
		id: "menu-and-form-ids-as-read",
		name: "menu and form ids no reading mints",
		other: () =>
			produce(
				buildDoc({
					modules: [
						{
							name: "Patients & visits",
							forms: [
								{
									name: "Visit",
									type: "survey",
									fields: [f({ kind: "text", id: "a", label: "a" })],
								},
								{
									name: "Visit",
									type: "survey",
									fields: [f({ kind: "text", id: "b", label: "b" })],
								},
							],
						},
					],
				}),
				(draft) => {
					for (const module of Object.values(draft.modules))
						module.id = "menu-authored";
					for (const form of Object.values(draft.forms))
						form.id = `form-${form.uuid.slice(0, 4)}`;
				},
			),
	},
	{
		id: "worker-fields-read-by-name-are-properties",
		name: "a worker field read by name that no worker property names",
		other: () =>
			survey([f({ kind: "hidden", id: "role", calculate: "#user/role" })]),
	},
	{
		id: "world-properties-as-read",
		name: "worker and location properties nothing reads, one with a requirement",
		other: () => {
			const UNUSED = testUuid("canon-world-unused");
			const BEDS = testUuid("canon-world-beds");
			return produce(
				survey([f({ kind: "text", id: "note", label: "Note" })]),
				(draft) => {
					draft.userProperties = {
						[UNUSED]: {
							uuid: UNUSED,
							slug: "unused",
							label: "Unused",
							required: true,
						},
					} as never;
					draft.userPropertyOrder = [UNUSED];
					draft.locationProperties = {
						[BEDS]: { uuid: BEDS, slug: "beds", label: "Beds" },
					} as never;
					draft.locationPropertyOrder = [BEDS];
				},
			);
		},
	},
	{
		id: "organization-levels-as-read",
		name: "levels with a description, a worker-less level and the child first",
		other: () => {
			const DISTRICT = testUuid("canon-level-district");
			const CLINIC = testUuid("canon-level-clinic");
			return produce(caseApp(), (draft) => {
				draft.organizationLevels = {
					[CLINIC]: {
						uuid: CLINIC,
						code: "clinic",
						name: "Clinic",
						description: "Where workers sit",
						parentLevelUuid: DISTRICT,
						caseFlow: {
							workers: "assigned",
							ownsCases: true,
							descendantCases: { kind: "none" },
						},
						addressBook: { reach: "own-branch" },
					},
					[DISTRICT]: {
						uuid: DISTRICT,
						code: "district",
						name: "District",
						caseFlow: { workers: "none", ownsCases: false },
						addressBook: { reach: "own-branch" },
					},
				} as never;
				draft.organizationLevelOrder = [CLINIC, DISTRICT];
			});
		},
	},
];

/** The rows another test prints both members of, by that test's file. */
const NAMED_ELSEWHERE: Readonly<Record<string, string>> = {
	"unheld-placements-are-held":
		"lib/commcare/__tests__/heldPlacementEmission.test.ts",
	"expression-print-collisions":
		"lib/commcare/reader/expressions/__tests__/printCollisions.test.ts",
};

describe("each canonicalization's pair", () => {
	it("is a case here or a case of the test the row names, and of no row the list lacks", () => {
		const ids = CANONICALIZATIONS.map((one) => one.id);
		const covered = new Set([
			...PAIRS.map((pair) => pair.id),
			...Object.keys(NAMED_ELSEWHERE),
		]);
		expect(ids.filter((id) => !covered.has(id))).toEqual([]);
		expect([...covered].filter((id) => !ids.includes(id))).toEqual([]);
		for (const file of Object.values(NAMED_ELSEWHERE))
			expect(existsSync(join(process.cwd(), file)), file).toBe(true);
		expect(
			PAIRS.filter((pair) => pair.id === "dormant-tile-cells"),
		).toHaveLength(2);
	});

	for (const pair of PAIRS)
		it(`prints one export for ${pair.id}: ${pair.name}`, () => {
			const chosen = row(pair.id);
			const built = pair.other();
			const before = CANONICALIZATIONS.slice(
				0,
				CANONICALIZATIONS.indexOf(chosen),
			);
			const other =
				pair.afterEarlierRows === true
					? before.reduce((one, each) => each.apply(one), built)
					: built;
			const returned = chosen.apply(other);
			// The document holds the other member, so the row moves it.
			expect(sameJson(stored(returned), stored(other))).toBe(false);
			expect(differingFiles(returned, other)).toEqual([]);
			expect(stored(chosen.apply(returned))).toEqual(stored(returned));
		});
});

/** CommCare HQ's retained sources of an app, each of which reads whole. */
const RETAINED_READ: readonly string[] = [
	"navigation-base/app-source",
	"navigation-base/app-source-after-form-builder-save",
	"case-list-inline/app-source",
];

describe("the canonical form of a document", () => {
	it("is its own canonical form, for every document the proof lane publishes", {
		timeout: 60_000,
	}, () => {
		let checked = 0;
		for (const document of publishedCorpus()) {
			const once = canonDocument(hydrated(document));
			expect(stored(canonDocument(once)), document.id).toEqual(stored(once));
			checked++;
		}
		expect(checked).toBeGreaterThan(100);
	});

	for (const file of RETAINED_READ)
		it(`is the reading itself, for CommCare HQ's retained ${file}`, async () => {
			const outcome = readHqApp({
				...readerInput(
					await sourceFromBody(retainedBodyJson(retainedGroupRead(file))),
				),
				recordDialect: recordDialectRoundTrip,
			});
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "read")
				throw new Error(
					`The retained source did not read: ${outcome.findings.map((one) => one.code).join(", ")}`,
				);
			const read = outcome.draft.doc;
			expect(stored(canonDocument(read))).toEqual(stored(read));
		});
});
