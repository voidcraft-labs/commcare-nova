/**
 * The ordered transform over every frozen fixture: what it does to the
 * stored document, that its output is a document the tree's schema, gate
 * and export readiness admit, that a second application changes nothing,
 * that authored question paths and derived case schemas hold, and the
 * notice lines each step mints. Each pull request that registers a step adds
 * its expectations here.
 */

import { describe, expect, it } from "vitest";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import {
	exportReadinessFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	makeTranslationUnitId,
	translationSourceFingerprint,
} from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import { casePropertyOptionTranslationUnitId } from "@/lib/domain/translationUnits";
import { migrationNoticeEntrySchema } from "@/lib/notices/migrationNotice";
import { renderNoticeEntry } from "@/lib/notices/migrationNoticeCopy";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { lookupContextOf } from "@/proof/corpus/documents";
import { legacyWireCodes } from "../legacyLanguageWireCodes";
import {
	copyRawDocument,
	type Json,
	type JsonRecord,
	type RawDocument,
	rawDocumentAssembly,
	rawDocumentDigest,
	readRawDocument,
} from "../oldShape";
import { caseSchemaDifferences, contentBlockerPlaces } from "../plan";
import { questionPaths } from "../questionPaths";
import { EMPTY_FORM_NOTE_TEXT } from "../steps/emptyForms";
import { optionLabelsStep } from "../steps/optionLabels";
import { rawText } from "../steps/relativePaths";
import {
	CUTOVER_STEPS,
	type DocumentChange,
	type StepContext,
	transformDocument,
} from "../transform";
import { readLegacyApp } from "./fixtures/legacyBodies";
import {
	fixtureMediaRecords,
	migratedFixtureDocument,
	readFixtureCarriers,
	readFixtureManifest,
	readFixturePaths,
	readFixtureProject,
	readFixtureSchemas,
} from "./fixtures/preStep";

const PROJECT = "fixture-project";

function contextFor(appId: string): StepContext {
	return {
		appId,
		projectId: PROJECT,
		lookupColumnTypes: new Map(),
		deployments: [
			{
				deploymentId: "00000000-0000-7000-8000-00000000d001",
				outcome: "unreadable",
				profileProperties: null,
			},
		],
	};
}

const manifest = readFixtureManifest().fixtures;
const fixtures = manifest.map((fixture) => fixture.id);

/** Whether a fixture is built to witness a blocker code. */
function witnesses(id: string, code: string): boolean {
	return (
		manifest.find((fixture) => fixture.id === id)?.blockers.includes(code) ===
		true
	);
}

/**
 * The fixtures whose stored shape no step rewrites and the gate refuses, by
 * the codes it refuses them under. A link identifier and a source write the
 * cutover keeps are the identity of case data, and a read of the form's root
 * is a person's call (part 08 of step 2's plan): each is a content blocker
 * of the plan as well.
 */
const GATE_REFUSED: Readonly<Record<string, readonly string[]>> = {
	"hand-link-identifier-reserved": ["CASE_OPERATION_LINK_INVALID"],
	"hand-reserved-property-write": [
		"CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP",
	],
	"hand-form-root-read": ["INVALID_REF"],
};

/**
 * The fixture as the steps leave its question paths: each field a step
 * renames under its new id, nothing else changed.
 */
function renamedSource(
	id: string,
	changes: readonly DocumentChange[],
): RawDocument {
	const source = copyRawDocument(readRawDocument(id, readFixtureCarriers(id)));
	for (const change of changes) {
		if (change.reason !== "question-renamed") continue;
		const field = source.fields[change.entity.uuid ?? ""];
		if (field !== undefined && change.detail?.to !== undefined) {
			(field as { id: string }).id = change.detail.to;
		}
	}
	return source;
}

/** The target without the forms and fields a step adds. */
function withoutAdditions(
	target: RawDocument,
	source: RawDocument,
): RawDocument {
	const kept = copyRawDocument(target) as unknown as {
		forms: Record<string, JsonRecord>;
		fields: Record<string, JsonRecord>;
		formOrder: Record<string, string[]>;
		fieldOrder: Record<string, string[]>;
	};
	for (const uuid of Object.keys(kept.forms)) {
		if (source.forms[uuid] === undefined) delete kept.forms[uuid];
	}
	for (const uuid of Object.keys(kept.fields)) {
		if (source.fields[uuid] === undefined) delete kept.fields[uuid];
	}
	for (const [parent, order] of Object.entries(kept.formOrder)) {
		kept.formOrder[parent] = order.filter((uuid) => uuid in kept.forms);
	}
	for (const parent of Object.keys(kept.fieldOrder)) {
		if (!(parent in kept.forms) && !(parent in kept.fields)) {
			delete kept.fieldOrder[parent];
			continue;
		}
		kept.fieldOrder[parent] = (kept.fieldOrder[parent] ?? []).filter(
			(uuid) => uuid in kept.fields,
		);
	}
	return kept as unknown as RawDocument;
}

describe("the ordered transform", () => {
	it("registers its steps in the one fixed order", () => {
		const order = [
			"language-wire-codes",
			"media-slots",
			"hidden-inert-default",
			"search-button-label",
			"question-ids",
			"case-operation-ids",
			"connect-ids",
			"connect-task-forms",
			"entry-point-ids",
			"option-values",
			"option-labels",
			"empty-forms",
			"unsupplied-session-reads",
			"reserved-search-inputs",
			"time-ordering",
			"hidden-from-menu",
			"post-submit",
			"id-mapping-keys",
			"date-patterns",
			"tile-hidden-calculated-sort",
			"sort-property-ownership",
			"tile-cells",
			"app-settings",
		];
		const registered = CUTOVER_STEPS.map((step) => step.id);
		expect(registered).toEqual(order.filter((id) => registered.includes(id)));
	});

	describe.each(fixtures)("over %s", (id) => {
		const raw = readRawDocument(id, readFixtureCarriers(id));
		const project = readFixtureProject(id);
		const result = transformDocument(raw, contextFor(id));

		it("leaves the document the plan read untouched", () => {
			expect(rawDocumentDigest(raw)).toBe(
				rawDocumentDigest(readRawDocument(id, readFixtureCarriers(id))),
			);
		});

		it("changes nothing a second time", () => {
			const again = transformDocument(result.target, contextFor(id));
			expect(again.changes).toEqual([]);
			expect(rawDocumentDigest(again.target)).toBe(
				rawDocumentDigest(result.target),
			);
		});

		it("writes a target the schema, the gate and export readiness admit", () => {
			const parsed = blueprintDocSchema.safeParse(
				rawDocumentAssembly(id, result.target),
			);
			expect(parsed.success).toBe(true);
			if (!parsed.success) return;
			const doc = hydratePersistedBlueprint(parsed.data);
			const lookupContext = lookupContextOf(project.lookup as never);
			const verdict = mutationCommitVerdict(doc, [], lookupContext);
			expect(
				verdict.ok ? [] : [...new Set(verdict.findings.map((f) => f.code))],
			).toEqual(GATE_REFUSED[id] ?? []);
			const media = new Map(
				fixtureMediaRecords(
					project,
					lookupContext.kind === "available"
						? lookupContext.projectId
						: PROJECT,
					"fixture-owner",
				).map((record) => [record.id as string, record]),
			);
			const exportFindings = exportReadinessFindings(
				doc,
				lookupContext,
				media,
			).map((f) => f.code);
			if (witnesses(id, "target-export-readiness")) {
				expect(exportFindings).toContain("MEDIA_ASSET_NOT_FOUND");
			} else {
				expect([...new Set(exportFindings)]).toEqual(GATE_REFUSED[id] ?? []);
			}
		});

		it("keeps every authored question path a step does not rename", () => {
			expect(questionPaths(raw)).toEqual(readFixturePaths(id));
			const source = renamedSource(id, result.changes);
			expect(questionPaths(withoutAdditions(result.target, source))).toEqual(
				questionPaths(source),
			);
		});

		it("derives the case schemas the fixture's stored rows hold", () => {
			const parsed = blueprintDocSchema.parse(
				rawDocumentAssembly(id, result.target),
			);
			const doc = hydratePersistedBlueprint(parsed);
			const stored = readFixtureSchemas(id);
			if (witnesses(id, "case-schema-change")) {
				expect(
					caseSchemaDifferences(
						doc,
						new Map(
							Object.entries(stored).map(([name, schema]) => [
								name,
								JSON.stringify(schema),
							]),
						),
					),
				).toBeGreaterThan(0);
				return;
			}
			expect(
				caseSchemaDifferences(
					doc,
					new Map(
						Object.entries(stored).map(([name, schema]) => [
							name,
							JSON.stringify(schema),
						]),
					),
				),
			).toBe(0);
			expect(
				Object.fromEntries(
					[...buildCaseTypeMap(doc)].map(([name, caseType]) => [
						name,
						canonicalJsonDigest(caseTypeToJsonSchema(caseType)),
					]),
				),
			).toEqual(
				Object.fromEntries(
					Object.entries(stored).map(([name, schema]) => [
						name,
						canonicalJsonDigest(schema),
					]),
				),
			);
		});
	});

	it("counts a stored schema that differs, a derived type with no row and a row with no derived type", () => {
		const id = "case-operation-query";
		const doc = migratedFixtureDocument(id);
		const stored = new Map(
			Object.entries(readFixtureSchemas(id)).map(([name, schema]) => [
				name,
				JSON.stringify(schema),
			]),
		);
		expect(caseSchemaDifferences(doc, stored)).toBe(0);
		const [first] = [...stored.keys()];
		if (first === undefined)
			throw new Error("The fixture derives no case type.");
		const retyped = new Map(stored);
		retyped.set(first, JSON.stringify({ type: "object", properties: {} }));
		expect(caseSchemaDifferences(doc, retyped)).toBe(1);
		const missing = new Map(stored);
		missing.delete(first);
		expect(caseSchemaDifferences(doc, missing)).toBe(1);
		const extra = new Map(stored);
		extra.set(
			"retired_type",
			JSON.stringify({ type: "object", properties: {} }),
		);
		expect(caseSchemaDifferences(doc, extra)).toBe(1);
	});
});

describe("step language-wire-codes", () => {
	const corpus = manifest.filter((fixture) => fixture.kind === "corpus");

	it.each(corpus.map((fixture) => fixture.id))(
		"gives %s the codes its pre-step export sent",
		(id) => {
			const raw = readRawDocument(id, readFixtureCarriers(id));
			const { target, steps } = transformDocument(raw, contextFor(id));
			expect(
				steps.find((step) => step.stepId === "language-wire-codes")?.changes,
			).toEqual([]);
			const sent = readLegacyApp(id, "create").langs as string[];
			if (raw.localization === null) {
				expect(target.localization).toBeNull();
				expect(sent).toEqual(["en"]);
				return;
			}
			const localization = target.localization as {
				languageOrder: string[];
				wireCodes: Record<string, string>;
			};
			expect(
				localization.languageOrder.map((tag) => localization.wireCodes[tag]),
			).toEqual(sent);
		},
	);

	it("is held by at least one corpus fixture with a stored root", () => {
		expect(
			corpus.some(
				(fixture) =>
					readRawDocument(fixture.id, readFixtureCarriers(fixture.id))
						.localization !== null,
			),
		).toBe(true);
	});

	it("keeps the pre-step grouping, which suffixed every language of a shared spelling", () => {
		expect(legacyWireCodes({ languageOrder: ["eng", "spa", "fra"] })).toEqual({
			eng: "en",
			spa: "es",
			fra: "fra",
		});
		expect(
			legacyWireCodes({ languageOrder: ["eng", "cmn-Hans", "cmn-Hant"] }),
		).toEqual({ eng: "en", "cmn-Hans": "cmn-hans", "cmn-Hant": "cmn-hant" });
		expect(legacyWireCodes({ languageOrder: ["eng", "cmn-Hans"] })).toEqual({
			eng: "en",
			"cmn-Hans": "zho",
		});
		expect(
			legacyWireCodes({ languageOrder: ["eng", "spa", "eng-GB"] }),
		).toEqual({ eng: "eng-", spa: "es", "eng-GB": "eng-gb" });
	});
});

describe("step option-labels", () => {
	const WITNESS = "hand-option-labels";
	const FORM = "cd8766da-7326-51ee-aa0b-f8101304f9ea";
	const FIELD = "00000000-0000-4000-8000-000000000301";
	const BLANK = "00000000-0000-4000-8000-000000000302";
	const BLANK_UNIT = makeTranslationUnitId("field", FIELD, "option", BLANK);

	function witness(): RawDocument {
		return copyRawDocument(
			readRawDocument(WITNESS, readFixtureCarriers(WITNESS)),
		);
	}

	type WritableOption = { label: Json; media?: Json };
	function blankOption(document: RawDocument): WritableOption {
		const source = document.fields[FIELD]?.optionsSource as {
			options: { uuid: string }[];
		};
		const option = source.options.find((candidate) => candidate.uuid === BLANK);
		if (option === undefined)
			throw new Error("The witness lost its blank choice.");
		return option as unknown as WritableOption;
	}

	function optionLabels(document: RawDocument): {
		value: string;
		label: Json;
	}[] {
		const source = document.fields[FIELD]?.optionsSource as {
			options: { value: string; label: Json }[];
		};
		return source.options.map(({ value, label }) => ({ value, label }));
	}

	/** The witness with a Spanish translation of its blank choice. */
	function translated(entry: Record<string, Json>): RawDocument {
		const document = witness();
		(document as { localization: Json }).localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			translations: {
				spa: {
					[BLANK_UNIT]: {
						sourceFingerprint: translationSourceFingerprint("prose", {
							parts: [],
						}),
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
						...entry,
					},
				},
			},
		};
		return document;
	}

	function admitted(document: RawDocument): string[] {
		const parsed = blueprintDocSchema.parse(
			rawDocumentAssembly(WITNESS, document),
		);
		const verdict = mutationCommitVerdict(
			hydratePersistedBlueprint(parsed),
			[],
			lookupContextOf(readFixtureProject(WITNESS).lookup as never),
		);
		return verdict.ok ? [] : verdict.findings.map((finding) => finding.code);
	}

	function run(document: RawDocument) {
		const result = transformDocument(document, contextFor(WITNESS));
		return {
			target: result.target,
			changes:
				result.steps.find((step) => step.stepId === "option-labels")?.changes ??
				[],
		};
	}

	it("gives a choice blank in every language its own value, and names it once", () => {
		const { target, changes } = run(witness());
		expect(optionLabels(target)).toEqual([
			{ value: "home", label: { parts: [{ kind: "text", text: "home" }] } },
			{ value: "clinic", label: { parts: [{ kind: "text", text: "Clinic" }] } },
		]);
		expect(changes).toEqual([
			{
				reason: "option-label-filled",
				entity: { type: "form", uuid: FORM, nameAtMigration: "Visit" },
				detail: { question: "visit_kind", value: "home" },
			},
		]);
	});

	it("is refused by the gate where the step does not run", () => {
		const document = witness();
		const steps = CUTOVER_STEPS.filter((step) => step.id !== "option-labels");
		expect(
			admitted(transformDocument(document, contextFor(WITNESS), steps).target),
		).toContain("SELECT_OPTION_LABEL_EMPTY");
	});

	it("leaves a choice that carries media, which the gate admits blank", () => {
		const document = witness();
		blankOption(document).media = {
			image: "00000000-0000-4000-8000-0000000003a1",
		};
		const { target, changes } = run(document);
		expect(changes).toEqual([]);
		expect(blankOption(target).label).toEqual({ parts: [] });
	});

	it("leaves a choice another language translates, which the gate admits", () => {
		const { target, changes } = run(
			translated({
				value: { parts: [{ kind: "text", text: "Casa" }] },
			}),
		);
		expect(changes).toEqual([]);
		expect(blankOption(target).label).toEqual({ parts: [] });
		expect(admitted(target)).toEqual([]);
	});

	it("fills a choice whose only translation is blank, out of date or adds a reference", () => {
		const entries: Record<string, Json>[] = [
			{ value: { parts: [] } },
			{
				value: { parts: [{ kind: "text", text: "Casa" }] },
				sourceFingerprint: translationSourceFingerprint("prose", {
					parts: [{ kind: "text", text: "Home" }],
				}),
			},
			{
				value: {
					parts: [
						{ kind: "text", text: "Casa " },
						{ kind: "case-ref", caseType: "patient", property: "notes" },
					],
				},
			},
		];
		for (const entry of entries) {
			const { target, changes } = run(translated(entry));
			expect(changes.map((change) => change.detail)).toEqual([
				{ question: "visit_kind", value: "home" },
			]);
			expect(blankOption(target).label).toEqual({
				parts: [{ kind: "text", text: "home" }],
			});
			expect(admitted(target)).toEqual([]);
		}
	});

	it("leaves a lookup-backed and a case-backed select byte for byte", () => {
		const document = witness();
		const backed: Record<string, JsonRecord> = {};
		for (const [fixture, field] of [
			["hand-lookup-tag-collision", "5894e1e5-a263-56a1-aa32-7fa739231835"],
			["case-choice-attendance", "4a0f488e-e51b-546a-a045-f0f077ec6c7e"],
		] as const) {
			const record = readRawDocument(fixture, readFixtureCarriers(fixture))
				.fields[field];
			if (record === undefined) throw new Error(`${fixture} lost ${field}.`);
			backed[field] = record;
		}
		const writable = document as unknown as {
			fields: Record<string, JsonRecord>;
			fieldOrder: Record<string, readonly string[]>;
		};
		for (const [uuid, record] of Object.entries(backed)) {
			writable.fields[uuid] = record;
			writable.fieldOrder[FORM] = [...(writable.fieldOrder[FORM] ?? []), uuid];
		}
		const changes = optionLabelsStep.apply(document, contextFor(WITNESS));
		expect(changes.map((change) => change.detail?.question)).toEqual([
			"visit_kind",
		]);
		for (const [uuid, record] of Object.entries(backed)) {
			expect(JSON.stringify(document.fields[uuid])).toBe(
				JSON.stringify(record),
			);
		}
	});
});

// ── Pull request 10: identifiers and form content ───────────────────

/** A writable copy of a frozen fixture. */
function fixtureCopy(id: string): RawDocument {
	return copyRawDocument(readRawDocument(id, readFixtureCarriers(id)));
}

type Writable = {
	fields: Record<string, JsonRecord>;
	forms: Record<string, JsonRecord>;
	modules: Record<string, JsonRecord>;
	fieldOrder: Record<string, string[]>;
	formOrder: Record<string, string[]>;
	caseTypes: Json;
	localization: Json;
};

function writable(document: RawDocument): Writable {
	return document as unknown as Writable;
}

/** Add a field under a form or a container. */
function addField(
	document: RawDocument,
	parent: string,
	field: Record<string, Json>,
): void {
	const doc = writable(document);
	const uuid = field.uuid as string;
	doc.fields[uuid] = field as JsonRecord;
	doc.fieldOrder[parent] = [...(doc.fieldOrder[parent] ?? []), uuid];
	if (
		field.kind === "group" ||
		field.kind === "repeat" ||
		field.kind === "section"
	) {
		doc.fieldOrder[uuid] = doc.fieldOrder[uuid] ?? [];
	}
}

function xpathText(value: string): Json {
	return { parts: [{ kind: "text", text: value }] };
}

function textOf(document: RawDocument, uuid: string, slot: string): string {
	const value = document.fields[uuid]?.[slot] as
		| { parts: { kind: string; text?: string; uuid?: string }[] }
		| undefined;
	return (value?.parts ?? [])
		.map((part) =>
			part.kind === "text" ? part.text : `{${part.kind}:${part.uuid}}`,
		)
		.join("");
}

/** The target parsed, hydrated and judged by the gate, as plan.ts judges it. */
function gateCodes(id: string, document: RawDocument): string[] {
	const doc = parsedTarget(id, document);
	const verdict = mutationCommitVerdict(
		doc,
		[],
		lookupContextOf(readFixtureProject(id).lookup as never),
	);
	return verdict.ok ? [] : [...new Set(verdict.findings.map((f) => f.code))];
}

function parsedTarget(id: string, document: RawDocument): BlueprintDoc {
	return hydratePersistedBlueprint(
		blueprintDocSchema.parse(rawDocumentAssembly(id, document)),
	);
}

function stepChanges(
	result: ReturnType<typeof transformDocument>,
	stepId: string,
) {
	return result.steps.find((step) => step.stepId === stepId)?.changes ?? [];
}

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

describe("step question-ids", () => {
	const ID = "targeted-invalid-question-ids";
	const FORM = "6674aa53-075e-5e5f-a650-342956a17903";
	const NOTES = "39160b11-9a57-5bd5-ad4d-5763f2529661";
	const META = "4cdc70c4-40a5-5f60-a6f5-61867579a734";
	const XML = "d0b66252-a2f7-5d8e-a0e9-cc900926e1a2";
	const GROUP = uuid(0x1001);
	const INNER = uuid(0x1002);
	const COPY = uuid(0x1003);
	const ECHO = uuid(0x1004);
	const AGAIN = uuid(0x1005);
	const DEEP = uuid(0x1006);
	const CASE = uuid(0x1007);
	const TAKEN = uuid(0x1008);
	const ELSEWHERE = uuid(0x1009);

	/** The fixture with every shape the rule renames, and the paths that read them. */
	function document(): RawDocument {
		const doc = fixtureCopy(ID);
		addField(doc, FORM, {
			uuid: GROUP,
			kind: "group",
			id: "meta",
			label: xpathText("Meta"),
		});
		addField(doc, GROUP, {
			uuid: INNER,
			kind: "text",
			id: "inner",
			label: xpathText("Inner"),
		});
		addField(doc, GROUP, {
			uuid: DEEP,
			kind: "hidden",
			id: "deep",
			calculate: xpathText("../../_notes"),
		});
		addField(doc, FORM, {
			uuid: COPY,
			kind: "hidden",
			id: "detail_copy",
			calculate: { parts: [{ kind: "field-ref", uuid: INNER }] },
		});
		addField(doc, FORM, {
			uuid: ECHO,
			kind: "hidden",
			id: "echo",
			calculate: xpathText("concat(../_notes, ' ', ./../XMLcode)"),
		});
		addField(doc, FORM, {
			uuid: AGAIN,
			kind: "text",
			id: "again",
			label: xpathText("Again"),
			default_value: xpathText("current()/../_notes"),
		});
		addField(doc, FORM, {
			uuid: TAKEN,
			kind: "text",
			id: "q_case",
			label: xpathText("Taken"),
		});
		addField(doc, FORM, {
			uuid: CASE,
			kind: "text",
			id: "case",
			label: xpathText("Case"),
		});
		addField(doc, FORM, {
			uuid: ELSEWHERE,
			kind: "hidden",
			id: "elsewhere",
			calculate: xpathText(
				"instance('casedb')/casedb/case[@case_id = ../_notes]/_notes",
			),
		});
		return doc;
	}

	it("renames each refused id to the free editor-safe id and names the field's kind", () => {
		const result = transformDocument(document(), contextFor(ID));
		expect(
			stepChanges(result, "question-ids").map((change) => ({
				uuid: change.entity.uuid,
				...change.detail,
			})),
		).toEqual([
			{
				uuid: NOTES,
				form: "Intake",
				kind: "question",
				from: "_notes",
				to: "notes",
			},
			{
				uuid: XML,
				form: "Intake",
				kind: "question",
				from: "XMLcode",
				to: "qXMLcode",
			},
			{
				uuid: META,
				form: "Intake",
				kind: "question",
				from: "Meta",
				to: "q_Meta",
			},
			{
				uuid: GROUP,
				form: "Intake",
				kind: "group",
				from: "meta",
				to: "q_meta",
			},
			{
				uuid: CASE,
				form: "Intake",
				kind: "question",
				from: "case",
				to: "q_case_2",
			},
		]);
		expect(result.blockers).toEqual([]);
	});

	it("rewrites the paths written as text that reach a renamed node, and leaves a reference and another document alone", () => {
		const { target } = transformDocument(document(), contextFor(ID));
		expect(textOf(target, DEEP, "calculate")).toBe("../../notes");
		expect(textOf(target, ECHO, "calculate")).toBe(
			"concat(../notes, ' ', ./../qXMLcode)",
		);
		expect(textOf(target, AGAIN, "default_value")).toBe("current()/../notes");
		expect(textOf(target, COPY, "calculate")).toBe(`{field-ref:${INNER}}`);
		expect(textOf(target, ELSEWHERE, "calculate")).toBe(
			"instance('casedb')/casedb/case[@case_id = ../_notes]/_notes",
		);
		expect(gateCodes(ID, target)).toEqual([]);
	});

	it("renames the names HQ's editors warn about or can't open, in any case where the rule says so", () => {
		const doc = fixtureCopy(ID);
		const ids = [
			"registration",
			"Script",
			"instance",
			"bind",
			"parsererror",
			"Instance",
			"scripts",
		];
		for (const [index, id] of ids.entries()) {
			addField(doc, FORM, {
				uuid: uuid(0x1100 + index),
				kind: "text",
				id,
				label: xpathText(id),
			});
		}
		const result = transformDocument(doc, contextFor(ID));
		expect(
			stepChanges(result, "question-ids")
				.slice(3)
				.map((change) => [change.detail?.from, change.detail?.to]),
		).toEqual([
			["registration", "q_registration"],
			["Script", "q_Script"],
			["instance", "q_instance"],
			["bind", "q_bind"],
			["parsererror", "q_parsererror"],
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("stops on a relative path that names a renamed question and reaches no node", () => {
		const result = transformDocument(
			fixtureCopy("hand-unresolved-relative-path"),
			contextFor("hand-unresolved-relative-path"),
		);
		expect(result.blockers).toEqual([
			{
				code: "unresolved-relative-path",
				entity: {
					type: "field",
					uuid: "00000000-0000-4000-8000-000000000a01",
					nameAtMigration: "echo",
				},
				detail: {
					form: "Intake",
					slot: "calculate",
					name: "_notes",
					expression: "../../_notes",
				},
			},
		]);
		expect(
			textOf(
				result.target,
				"00000000-0000-4000-8000-000000000a01",
				"calculate",
			),
		).toBe("../../_notes");
	});
});

describe("step case-operation-ids", () => {
	const ID = "hand-case-operation-ids";

	it("renames an operation named instance and keeps an underscore id, which HQ's form builder keeps", () => {
		const doc = fixtureCopy(ID);
		const form = writable(doc).forms["66666666-6666-4666-8666-666666666666"];
		const operations = form?.caseOperations as { id: string }[];
		const unlink = operations.find(
			(operation) => operation.id === "unlink_visit",
		);
		if (unlink === undefined) throw new Error("The fixture lost unlink_visit.");
		unlink.id = "_close";
		const result = transformDocument(doc, contextFor(ID));
		expect(stepChanges(result, "case-operation-ids")).toEqual([
			{
				reason: "case-operation-renamed",
				entity: {
					type: "form",
					uuid: "66666666-6666-4666-8666-666666666666",
					nameAtMigration: "Edit",
				},
				detail: { from: "instance", to: "q_instance" },
			},
		]);
		const ids = (
			(
				result.target.forms[
					"66666666-6666-4666-8666-666666666666"
				] as JsonRecord
			).caseOperations as { id: string }[]
		).map((operation) => operation.id);
		expect(ids).toEqual([
			"create_visit",
			"q_instance",
			"_close",
			"finish_visit",
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});
});

describe("step connect-ids", () => {
	it("renames the learn app's module and assessment to the ids the grammar admits", () => {
		const ID = "targeted-invalid-connect-ids";
		const FORM = "830417a1-dbc6-5455-a130-97c3d916a951";
		const doc = fixtureCopy(ID);
		addField(doc, FORM, {
			uuid: uuid(0x2001),
			kind: "hidden",
			id: "module_name",
			calculate: xpathText("../_lesson/module/name"),
		});
		const result = transformDocument(doc, contextFor(ID));
		expect(
			stepChanges(result, "connect-ids").map((change) => change.detail),
		).toEqual([
			{ block: "learn_module", from: "_lesson", to: "lesson" },
			{ block: "assessment", from: "XMLquiz", to: "qXMLquiz" },
		]);
		expect(textOf(result.target, uuid(0x2001), "calculate")).toBe(
			"../lesson/module/name",
		);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("keeps a 50-character id at 50 and cuts only a collision's tail", () => {
		const ID = "targeted-invalid-connect-ids";
		const FORM = "830417a1-dbc6-5455-a130-97c3d916a951";
		const doc = fixtureCopy(ID);
		const long = "_1st_lesson".padEnd(50, "x");
		const connect = writable(doc).forms[FORM]?.connect as {
			learn_module: { id: string };
			assessment: { id: string };
		};
		connect.learn_module.id = long;
		connect.assessment.id = "qXMLquiz";
		const alone = stepChanges(
			transformDocument(doc, contextFor(ID)),
			"connect-ids",
		).map((change) => change.detail?.to);
		expect(alone).toEqual(["q1st_lesson".padEnd(50, "x")]);
		connect.assessment.id = "q1st_lesson".padEnd(50, "x");
		const collided = stepChanges(
			transformDocument(doc, contextFor(ID)),
			"connect-ids",
		).map((change) => change.detail?.to);
		expect(collided).toEqual([`${"q1st_lesson".padEnd(48, "x")}_2`]);
	});

	/* A block's wrapper sits beside the form's top-level fields, so neither
	 * id step may land a field and a block on one name. */
	it("renames a refused block id clear of a top-level field of its form", () => {
		const ID = "targeted-invalid-connect-ids";
		const FORM = "830417a1-dbc6-5455-a130-97c3d916a951";
		const doc = fixtureCopy(ID);
		addField(doc, FORM, {
			uuid: uuid(0x2002),
			kind: "text",
			id: "lesson",
			label: xpathText("Lesson"),
		});
		const result = transformDocument(doc, contextFor(ID));
		expect(
			stepChanges(result, "connect-ids").map((change) => change.detail),
		).toEqual([
			{ block: "learn_module", from: "_lesson", to: "lesson_2" },
			{ block: "assessment", from: "XMLquiz", to: "qXMLquiz" },
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("renames a refused top-level field id clear of its form's block ids", () => {
		const ID = "targeted-invalid-connect-ids";
		const FORM = "830417a1-dbc6-5455-a130-97c3d916a951";
		const doc = fixtureCopy(ID);
		addField(doc, FORM, {
			uuid: uuid(0x2003),
			kind: "text",
			id: "_qXMLquiz",
			label: xpathText("Quiz"),
		});
		const connect = writable(doc).forms[FORM]?.connect as {
			assessment: { id: string };
		};
		connect.assessment.id = "qXMLquiz";
		const result = transformDocument(doc, contextFor(ID));
		expect(
			stepChanges(result, "question-ids")
				.filter((change) => change.entity.uuid === uuid(0x2003))
				.map((change) => change.detail?.to),
		).toEqual(["qXMLquiz_2"]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	/* The validator refuses a top-level field named like one of its form's
	 * blocks (FIELD_ID_NAMES_CONNECT_BLOCK); the field moves, the block keeps
	 * the id Connect keys its unit on. */
	it("renames a top-level field named like one of its form's blocks, and its readers follow", () => {
		const ID = "targeted-invalid-connect-ids";
		const FORM = "830417a1-dbc6-5455-a130-97c3d916a951";
		const QUIZ = uuid(0x2004);
		const doc = fixtureCopy(ID);
		const connect = writable(doc).forms[FORM]?.connect as {
			assessment: { id: string };
		};
		connect.assessment.id = "quiz";
		addField(doc, FORM, {
			uuid: QUIZ,
			kind: "text",
			id: "quiz",
			label: xpathText("Quiz"),
		});
		addField(doc, FORM, {
			uuid: uuid(0x2006),
			kind: "hidden",
			id: "echo",
			calculate: xpathText("concat(../quiz, ' ', current()/../quiz)"),
		});
		addField(doc, FORM, {
			uuid: uuid(0x2008),
			kind: "hidden",
			id: "copy",
			calculate: { parts: [{ kind: "field-ref", uuid: QUIZ }] },
		});
		const unrenamed = transformDocument(
			doc,
			contextFor(ID),
			CUTOVER_STEPS.filter((step) => step.id !== "question-ids"),
		);
		expect(gateCodes(ID, unrenamed.target)).toEqual([
			"FIELD_ID_NAMES_CONNECT_BLOCK",
		]);
		const result = transformDocument(doc, contextFor(ID));
		expect(
			stepChanges(result, "question-ids").filter(
				(change) => change.entity.uuid === QUIZ,
			),
		).toEqual([
			{
				reason: "question-renamed",
				entity: { type: "field", uuid: QUIZ, nameAtMigration: "quiz_2" },
				detail: {
					form: rawText(result.target.forms[FORM]?.name),
					kind: "question",
					from: "quiz",
					to: "quiz_2",
				},
			},
		]);
		expect(
			stepChanges(result, "connect-ids").map((change) => change.detail?.from),
		).toEqual(["_lesson"]);
		expect(textOf(result.target, uuid(0x2006), "calculate")).toBe(
			"concat(../quiz_2, ' ', current()/../quiz_2)",
		);
		expect(textOf(result.target, uuid(0x2008), "calculate")).toBe(
			`{field-ref:${QUIZ}}`,
		);
		expect(result.blockers).toEqual([]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	/* Nova's validator reads no path into a block, so a stored one is the
	 * gate's to refuse; the rewrite still follows it to the block. */
	it("leaves a path that steps into the block of the field's name on the block", () => {
		const ID = "targeted-invalid-connect-ids";
		const FORM = "830417a1-dbc6-5455-a130-97c3d916a951";
		const doc = fixtureCopy(ID);
		const connect = writable(doc).forms[FORM]?.connect as {
			assessment: { id: string };
		};
		connect.assessment.id = "quiz";
		addField(doc, FORM, {
			uuid: uuid(0x2007),
			kind: "text",
			id: "quiz",
			label: xpathText("Quiz"),
		});
		addField(doc, FORM, {
			uuid: uuid(0x200b),
			kind: "hidden",
			id: "score_read",
			calculate: xpathText("../quiz/assessment/user_score"),
		});
		const result = transformDocument(doc, contextFor(ID));
		expect(textOf(result.target, uuid(0x200b), "calculate")).toBe(
			"../quiz/assessment/user_score",
		);
		expect(result.blockers).toEqual([]);
	});

	it("stops on a path that reads a field and a block of one name alike", () => {
		const ID = "targeted-invalid-connect-ids";
		const FORM = "830417a1-dbc6-5455-a130-97c3d916a951";
		const doc = fixtureCopy(ID);
		const connect = writable(doc).forms[FORM]?.connect as {
			assessment: { id: string };
		};
		connect.assessment.id = "quiz";
		addField(doc, FORM, {
			uuid: uuid(0x2009),
			kind: "text",
			id: "quiz",
			label: xpathText("Quiz"),
		});
		addField(doc, FORM, {
			uuid: uuid(0x200a),
			kind: "hidden",
			id: "either",
			calculate: xpathText("count(../quiz/*)"),
		});
		const result = transformDocument(doc, contextFor(ID));
		expect(result.blockers).toMatchObject([
			{
				code: "unresolved-relative-path",
				detail: { name: "quiz", expression: "count(../quiz/*)" },
			},
		]);
	});

	it("renames a task named like one of Connect's own keys, which the next step moves to a form of its own", () => {
		const ID = "connect-deliver-default";
		const result = transformDocument(fixtureCopy(ID), contextFor(ID));
		expect(stepChanges(result, "connect-ids")).toEqual([
			{
				reason: "connect-block-renamed",
				entity: {
					type: "form",
					uuid: "c908c5a3-5d53-556f-a21a-3cd50e8658b3",
					nameAtMigration: "Activity",
				},
				detail: { block: "task", from: "task", to: "q_task" },
			},
		]);
	});
});

describe("step connect-task-forms", () => {
	const ID = "connect-deliver-default";
	const SOURCE = "c908c5a3-5d53-556f-a21a-3cd50e8658b3";
	const MODULE = "fe250245-35e0-5099-a17f-efd368120035";

	it("moves the task into a survey form after its source, with one label, and keeps its id", () => {
		const result = transformDocument(fixtureCopy(ID), contextFor(ID));
		const [change] = stepChanges(result, "connect-task-forms");
		const added = change?.detail?.newFormUuid ?? "";
		expect(change).toEqual({
			reason: "connect-task-moved-to-own-form",
			entity: { type: "form", uuid: SOURCE, nameAtMigration: "Activity" },
			detail: {
				task: "q_task",
				newFormUuid: added,
				newForm: "Record & review",
			},
		});
		expect(result.target.formOrder[MODULE]).toEqual([SOURCE, added]);
		expect(result.target.forms[SOURCE]?.connect).toEqual({
			deliver_unit: { id: "visit", name: "Home & clinic <雪>" },
		});
		expect(result.target.forms[added]).toMatchObject({
			uuid: added,
			name: "Record & review",
			type: "survey",
			connect: {
				task: {
					id: "q_task",
					name: "Record & review",
					description: "Ask <then> listen",
				},
			},
		});
		const [note] = result.target.fieldOrder[added] ?? [];
		expect(result.target.fields[note ?? ""]).toEqual({
			uuid: note,
			id: "note",
			kind: "label",
			label: { parts: [{ kind: "text", text: "Ask <then> listen" }] },
		});
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("derives both new uuids, so a second plan writes the same target", () => {
		const first = transformDocument(fixtureCopy(ID), contextFor(ID));
		const second = transformDocument(fixtureCopy(ID), contextFor(ID));
		expect(rawDocumentDigest(first.target)).toBe(
			rawDocumentDigest(second.target),
		);
	});

	it("labels the new form with the task's name where its description is blank", () => {
		const doc = fixtureCopy(ID);
		(
			(writable(doc).forms[SOURCE] as JsonRecord).connect as {
				task: { description: string };
			}
		).task.description = "  ";
		const result = transformDocument(doc, contextFor(ID));
		const added =
			stepChanges(result, "connect-task-forms")[0]?.detail?.newFormUuid ?? "";
		const [note] = result.target.fieldOrder[added] ?? [];
		expect(result.target.fields[note ?? ""]?.label).toEqual({
			parts: [{ kind: "text", text: "Record & review" }],
		});
	});
});

describe("step entry-point-ids", () => {
	const ID = "targeted-invalid-question-ids";
	const MODULE = "c575a671-c3c1-5045-a884-3757f5b918a1";

	it("rewrites each id HQ would not save to its slug, free across the app", () => {
		const doc = fixtureCopy(ID);
		const menu = writable(doc).modules[MODULE] as Record<string, Json>;
		menu.entryPoint = { uuid: uuid(0x3001), id: "intake" };
		menu.caseListEntryPoint = { uuid: uuid(0x3002), id: "a--b-" };
		const result = transformDocument(doc, contextFor(ID));
		expect(stepChanges(result, "entry-point-ids")).toEqual([
			{
				reason: "entry-point-renamed",
				entity: {
					type: "entryPoint",
					uuid: uuid(0x3002),
					nameAtMigration: "a-b",
				},
				detail: { from: "a--b-", to: "a-b" },
			},
			{
				reason: "entry-point-renamed",
				entity: {
					type: "entryPoint",
					uuid: "8a8e7e87-2b04-53bb-a4b3-b44509bbb157",
					nameAtMigration: "intake_2",
				},
				detail: { from: "intake_", to: "intake_2" },
			},
		]);
	});

	it("gives an id with nothing to keep the id entry", () => {
		const doc = fixtureCopy(ID);
		(
			writable(doc).forms["6674aa53-075e-5e5f-a650-342956a17903"]
				?.entryPoint as {
				id: string;
			}
		).id = "-_-";
		const result = transformDocument(doc, contextFor(ID));
		expect(stepChanges(result, "entry-point-ids")[0]?.detail).toEqual({
			from: "-_-",
			to: "entry",
		});
	});
});

describe("step option-values", () => {
	const ID = "hand-option-values";
	const FIELD = "00000000-0000-4000-8000-000000000201";

	function values(document: RawDocument, field: string): string[] {
		return (
			(document.fields[field] as JsonRecord).optionsSource as {
				options: { value: string }[];
			}
		).options.map((option) => option.value);
	}

	function catalog(document: RawDocument, property: string): string[] {
		const patient = (
			document.caseTypes as {
				name: string;
				properties: { name: string; options?: { value: string }[] }[];
			}[]
		).find((type) => type.name === "patient");
		return (
			patient?.properties.find((candidate) => candidate.name === property)
				?.options ?? []
		).map((option) => option.value);
	}

	it("gives each later holder of a value a value of its own, in a field and in a catalog", () => {
		const result = transformDocument(fixtureCopy(ID), contextFor(ID));
		expect(values(result.target, FIELD)).toEqual(["yes", "yes_2", "no"]);
		expect(catalog(result.target, "risk")).toEqual(["high", "high_2"]);
		expect(stepChanges(result, "option-values")).toEqual([
			{
				reason: "option-value-split",
				entity: { type: "app", nameAtMigration: result.target.appName },
				detail: {
					caseType: "patient",
					property: "risk",
					value: "high",
					to: "high_2",
					keptLabel: "High",
					label: "Very high",
				},
			},
			{
				reason: "option-value-split",
				entity: {
					type: "form",
					uuid: "cd8766da-7326-51ee-aa0b-f8101304f9ea",
					nameAtMigration: "Visit",
				},
				detail: {
					question: "consent",
					value: "yes",
					to: "yes_2",
					keptLabel: "Yes",
					label: "Agreed",
				},
			},
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("keeps a field and its catalog property in agreement, a list with fewer holders using fewer", () => {
		const doc = fixtureCopy(ID);
		const field = writable(doc).fields[FIELD] as Record<string, Json>;
		field.caseWrite = { caseType: "patient", property: "risk" };
		field.optionsSource = {
			kind: "inline",
			options: [
				{ uuid: uuid(0x4001), value: "high", label: xpathText("High") },
				{ uuid: uuid(0x4002), value: "high", label: xpathText("Higher") },
			],
		};
		const patient = (
			writable(doc).caseTypes as {
				name: string;
				properties: { name: string; options?: Json[] }[];
			}[]
		).find((type) => type.name === "patient");
		const risk = patient?.properties.find(
			(property) => property.name === "risk",
		);
		if (risk === undefined) throw new Error("The fixture lost risk.");
		risk.options = [
			{ value: "high", label: xpathText("High") },
			{ value: "high", label: xpathText("Very high") },
			{ value: "high", label: xpathText("Highest") },
		];
		const result = transformDocument(doc, contextFor(ID));
		expect(catalog(result.target, "risk")).toEqual([
			"high",
			"high_2",
			"high_3",
		]);
		expect(values(result.target, FIELD)).toEqual(["high", "high_2"]);
	});

	it("moves a catalog choice's translation to its new key", () => {
		const doc = fixtureCopy(ID);
		const moved = casePropertyOptionTranslationUnitId(
			"patient",
			"risk",
			"high",
			1,
		);
		const entry = {
			sourceFingerprint: "fixture",
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
			value: xpathText("Muy alto"),
		};
		writable(doc).localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			translations: { spa: { [moved]: entry } },
		};
		const { target } = transformDocument(doc, contextFor(ID));
		expect(
			(target.localization as { translations: { spa: Record<string, Json> } })
				.translations.spa,
		).toEqual({
			[casePropertyOptionTranslationUnitId("patient", "risk", "high_2", 0)]:
				entry,
		});
	});
});

describe("step empty-forms", () => {
	const ID = "hand-empty-forms";
	const FLAT = "00000000-0000-4000-8000-000000000401";
	const SECTIONED = "00000000-0000-4000-8000-000000000402";
	const SECTION = "00000000-0000-4000-8000-000000000404";
	const EMPTY = "00000000-0000-4000-8000-000000000406";
	const EMPTY_FORM_CHANGE = {
		reason: "empty-form-label-added",
		entity: { type: "form", uuid: EMPTY, nameAtMigration: "Empty tally" },
	};

	it("labels a form holding only an empty group, and leaves a form whose only field is a Hidden Value, which the rule counts as a question", () => {
		const result = transformDocument(fixtureCopy(ID), contextFor(ID));
		expect(stepChanges(result, "empty-forms")).toEqual([EMPTY_FORM_CHANGE]);
		const [box, note] = result.target.fieldOrder[EMPTY] ?? [];
		expect(box).toBe("00000000-0000-4000-8000-000000000407");
		expect(result.target.fields[note ?? ""]).toMatchObject({
			id: "note",
			kind: "label",
			label: { parts: [{ kind: "text", text: EMPTY_FORM_NOTE_TEXT }] },
		});
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("names a root label clear of the form's Connect block ids", () => {
		const doc = fixtureCopy(ID);
		writable(doc).forms[EMPTY] = {
			...writable(doc).forms[EMPTY],
			connect: { deliver_unit: { id: "note", name: "Note" } },
		};
		const result = transformDocument(doc, contextFor(ID));
		const note = result.target.fieldOrder[EMPTY]?.at(-1) ?? "";
		expect(result.target.fields[note]).toMatchObject({
			id: "note_2",
			kind: "label",
		});
	});

	it("adds one label at the root of a flat form, and inside the first section of a sectioned one", () => {
		const doc = fixtureCopy(ID);
		for (const hidden of [
			"00000000-0000-4000-8000-000000000403",
			"00000000-0000-4000-8000-000000000405",
		]) {
			const field = writable(doc).fields[hidden] as Record<string, Json>;
			field.kind = "group";
			field.label = xpathText("Empty");
			delete field.calculate;
			writable(doc).fieldOrder[hidden] = [];
		}
		const result = transformDocument(doc, contextFor(ID));
		expect(stepChanges(result, "empty-forms")).toEqual([
			{
				reason: "empty-form-label-added",
				entity: { type: "form", uuid: FLAT, nameAtMigration: "Tally" },
			},
			{
				reason: "empty-form-label-added",
				entity: {
					type: "form",
					uuid: SECTIONED,
					nameAtMigration: "Sectioned tally",
				},
			},
			EMPTY_FORM_CHANGE,
		]);
		const flatNote = result.target.fieldOrder[FLAT]?.at(-1) ?? "";
		const sectionNote = result.target.fieldOrder[SECTION]?.at(-1) ?? "";
		for (const note of [flatNote, sectionNote]) {
			expect(result.target.fields[note]).toMatchObject({
				id: "note",
				kind: "label",
				label: { parts: [{ kind: "text", text: EMPTY_FORM_NOTE_TEXT }] },
			});
		}
		expect(result.target.fieldOrder[SECTIONED]).toEqual([SECTION]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});
});

describe("step unsupplied-session-reads", () => {
	const ID = "hand-unsupplied-session-reads";
	const REFERRER = "00000000-0000-4000-8000-000000000501";
	const VISIT = "cd8766da-7326-51ee-aa0b-f8101304f9ea";
	const REGISTER = "cb8763b4-7126-5ec8-ac0b-fb361104f6c4";

	it("replaces each read no entry supplies by '' and leaves a supplied read byte for byte", () => {
		const doc = fixtureCopy(ID);
		addField(doc, VISIT, {
			uuid: uuid(0x5001),
			kind: "hidden",
			id: "own_case",
			calculate: xpathText("instance('commcaresession')/session/data/case_id"),
		});
		addField(doc, REGISTER, {
			uuid: uuid(0x5002),
			kind: "hidden",
			id: "mixed",
			calculate: xpathText(
				"concat( instance('commcaresession')/session/data/referrer_id , 'x', instance('commcaresession')/session/data/case_id_new_patient_0)",
			),
		});
		const result = transformDocument(doc, contextFor(ID));
		expect(textOf(result.target, REFERRER, "calculate")).toBe("''");
		expect(textOf(result.target, uuid(0x5002), "calculate")).toBe(
			"concat( '' , 'x', instance('commcaresession')/session/data/case_id_new_patient_0)",
		);
		expect(textOf(result.target, uuid(0x5001), "calculate")).toBe(
			"instance('commcaresession')/session/data/case_id",
		);
		expect(stepChanges(result, "unsupplied-session-reads")).toEqual([
			{
				reason: "session-read-removed",
				entity: { type: "field", uuid: REFERRER, nameAtMigration: "referrer" },
				detail: { form: "Register", datum: "referrer_id" },
			},
			{
				reason: "session-read-removed",
				entity: { type: "field", uuid: uuid(0x5002), nameAtMigration: "mixed" },
				detail: { form: "Register", datum: "referrer_id" },
			},
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("is refused by the gate where the step does not run", () => {
		const steps = CUTOVER_STEPS.filter(
			(step) => step.id !== "unsupplied-session-reads",
		);
		expect(
			gateCodes(
				ID,
				transformDocument(fixtureCopy(ID), contextFor(ID), steps).target,
			),
		).toEqual(["SESSION_DATUM_NOT_SUPPLIED"]);
	});
});

describe("the content blockers", () => {
	/** The codes a fixture's target meets, as plan.ts reads them. */
	function blockerCodes(id: string, document = fixtureCopy(id)): string[] {
		const result = transformDocument(document, contextFor(id));
		const parsed = blueprintDocSchema.safeParse(
			rawDocumentAssembly(id, result.target),
		);
		return [
			...new Set(
				contentBlockerPlaces(
					result.target,
					parsed.success ? hydratePersistedBlueprint(parsed.data) : undefined,
					result.blockers,
				).map((place) => place.code),
			),
		];
	}

	it.each([
		["hand-unresolved-relative-path", "unresolved-relative-path"],
		["hand-link-identifier-reserved", "link-identifier-reserved"],
		["hand-reserved-property-write", "reserved-property-write"],
		["hand-form-root-read", "form-root-read"],
	])("finds %s's blocker", (id, code) => {
		expect(blockerCodes(id)).toEqual([code]);
	});

	it.each(
		fixtures.filter(
			(id) =>
				!id.startsWith("hand-unresolved") &&
				!id.startsWith("hand-link") &&
				!id.startsWith("hand-reserved") &&
				!id.startsWith("hand-form-root"),
		),
	)("finds none in %s", (id) => {
		expect(blockerCodes(id)).toEqual([]);
	});

	const EDIT = "66666666-6666-4666-8666-666666666666";

	function operationsOf(document: RawDocument) {
		return writable(document).forms[EDIT]?.caseOperations as {
			id: string;
			links?: { identifier: string }[];
			writes?: { property: string }[];
		}[];
	}

	it.each(["close", "create"])(
		"stops on a link identifier %s, which HQ's form builder reads as the block's own action",
		(identifier) => {
			const doc = fixtureCopy("hand-case-operation-ids");
			const create = operationsOf(doc).find(
				(operation) => operation.id === "create_visit",
			);
			const link = create?.links?.[0];
			if (link === undefined) throw new Error("The fixture lost its link.");
			link.identifier = identifier;
			expect(blockerCodes("hand-case-operation-ids", doc)).toEqual([
				"link-identifier-reserved",
			]);
		},
	);

	function renameProperty(document: RawDocument, from: string, to: string) {
		for (const caseType of writable(document).caseTypes as {
			properties: { name: string }[];
		}[]) {
			for (const property of caseType.properties) {
				if (property.name === from) property.name = to;
			}
		}
	}

	it("stops on a property named close written by a case change, which the form's source holds", () => {
		const doc = fixtureCopy("hand-case-operation-ids");
		const finish = operationsOf(doc).find(
			(operation) => operation.id === "finish_visit",
		);
		const write = finish?.writes?.[0];
		if (write === undefined) throw new Error("The fixture lost its write.");
		write.property = "close";
		renameProperty(doc, "final_note", "close");
		expect(blockerCodes("hand-case-operation-ids", doc)).toEqual([
			"reserved-property-write",
		]);
	});

	it("keeps a property named close written only through a basic action, which HQ's build adds", () => {
		const doc = fixtureCopy("navigation-base");
		const answer = writable(doc).fields[
			"f8d4b97c-9f51-5998-aa67-295205b7246c"
		] as Record<string, Json>;
		answer.caseWrite = { caseType: "patient", property: "close" };
		renameProperty(doc, "notes", "close");
		expect(blockerCodes("navigation-base", doc)).toEqual([]);
	});
});

// ── Pull request 11: case lists ─────────────────────────────────────

/** The writable list of one menu of a fixture copy. */
function listOf(
	document: RawDocument,
	moduleUuid: string,
): {
	columns: Record<string, Json>[];
	listColumnOrder: string[];
	detailColumnOrder: string[];
	tile?: Json;
} {
	const config = writable(document).modules[moduleUuid]?.caseListConfig;
	if (config === undefined || config === null) {
		throw new Error(`Menu ${moduleUuid} has no list.`);
	}
	return config as never;
}

function columnOf(
	document: RawDocument,
	moduleUuid: string,
	columnUuid: string,
): Record<string, Json> {
	const column = listOf(document, moduleUuid).columns.find(
		(candidate) => candidate.uuid === columnUuid,
	);
	if (column === undefined) throw new Error(`No column ${columnUuid}.`);
	return column;
}

/** Add a column last on Results and on Details. */
function addColumn(
	document: RawDocument,
	moduleUuid: string,
	column: Record<string, Json>,
): void {
	const list = listOf(document, moduleUuid);
	list.columns.push(column);
	list.listColumnOrder.push(column.uuid as string);
	list.detailColumnOrder.push(column.uuid as string);
}

/** Every step but one. */
function without(stepId: string) {
	return CUTOVER_STEPS.filter((step) => step.id !== stepId);
}

const PATIENTS_MENU = "17a69048-be0c-59d4-a7a2-9bda805659b8";
const VISITS_TILE_MENU = "bef89ddc-ad95-56a8-ae3c-244a80822eec";

describe("step id-mapping-keys", () => {
	const ID = "hand-id-mapping-keys";
	const COLUMN = uuid(0x601);
	const unit = (value: string) =>
		makeTranslationUnitId("column", COLUMN, "mapping", value);

	it("removes each entry whose value holds one of the five characters, with its translations, and keeps the others", () => {
		const doc = fixtureCopy(ID);
		const column = columnOf(doc, PATIENTS_MENU, COLUMN);
		column.mapping = [
			{ value: "a&b", label: "Both" },
			{ value: "plain", label: "Plain" },
			{ value: "<x>", label: "Angled" },
			{ value: 'say"so', label: "Quoted" },
			{ value: "it's", label: "Apostrophe" },
		];
		const translation = (value: string) => ({
			sourceFingerprint: "fixture",
			value,
		});
		writable(doc).localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			translations: {
				spa: {
					[unit("a&b")]: translation("Ambos"),
					[unit("plain")]: translation("Simple"),
					[unit("it's")]: translation("Apóstrofo"),
				},
			},
		};
		const result = transformDocument(
			doc,
			contextFor(ID),
			CUTOVER_STEPS.filter((step) => step.id === "id-mapping-keys"),
		);
		expect(columnOf(result.target, PATIENTS_MENU, COLUMN).mapping).toEqual([
			{ value: "plain", label: "Plain" },
		]);
		expect(
			Object.keys(
				(
					writable(result.target).localization as {
						translations: { spa: Record<string, Json> };
					}
				).translations.spa,
			),
		).toEqual([unit("plain")]);
		expect(stepChanges(result, "id-mapping-keys")).toEqual(
			["a&b", "<x>", 'say"so', "it's"].map((value) => ({
				reason: "id-mapping-entry-removed",
				entity: {
					type: "caseListColumn",
					uuid: COLUMN,
					nameAtMigration: "Notes",
				},
				detail: { menu: "Patients", value },
			})),
		);
	});

	it("leaves a document the gate admits, which it refuses where the step does not run", () => {
		const result = transformDocument(fixtureCopy(ID), contextFor(ID));
		expect(columnOf(result.target, PATIENTS_MENU, COLUMN).mapping).toEqual([
			{ value: "plain", label: "Plain" },
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
		expect(
			gateCodes(
				ID,
				transformDocument(
					fixtureCopy(ID),
					contextFor(ID),
					without("id-mapping-keys"),
				).target,
			),
		).toEqual(["CASE_LIST_ID_MAPPING_KEY_CHARACTERS"]);
	});
});

describe("step date-patterns", () => {
	const ID = "hand-date-patterns";
	const ONE = uuid(0x701);
	const TWO = uuid(0x7001);
	const NONE = uuid(0x7002);
	const UNTYPED = uuid(0x7003);

	function withPatterns(): RawDocument {
		const doc = fixtureCopy(ID);
		addColumn(doc, PATIENTS_MENU, {
			uuid: TWO,
			kind: "date",
			field: "date_opened",
			header: "Opened twice",
			pattern: "'%d '%y",
		});
		addColumn(doc, PATIENTS_MENU, {
			uuid: NONE,
			kind: "date",
			field: "date_opened",
			header: "Opened plainly",
			pattern: "%Y-%m-%d",
		});
		const [patient] = writable(doc).caseTypes as { properties: Json[] }[];
		patient?.properties.push({
			name: "visit_day",
			label: { parts: [{ kind: "text", text: "Visit day" }] },
		});
		addColumn(doc, PATIENTS_MENU, {
			uuid: UNTYPED,
			kind: "date",
			field: "visit_day",
			header: "Visit day",
			pattern: "%d %b '%y",
		});
		return doc;
	}

	it("curves each straight apostrophe of every date pattern and moves nothing else", () => {
		const source = withPatterns();
		const result = transformDocument(
			source,
			contextFor(ID),
			CUTOVER_STEPS.filter((step) => step.id === "date-patterns"),
		);
		const expected = copyRawDocument(source);
		for (const [column, pattern] of [
			[ONE, "%d %b ’%y"],
			[TWO, "’%d ’%y"],
			[UNTYPED, "%d %b ’%y"],
		] as const) {
			columnOf(expected, PATIENTS_MENU, column).pattern = pattern;
		}
		expect(result.target).toEqual(expected);
		expect(columnOf(result.target, PATIENTS_MENU, NONE).pattern).toBe(
			"%Y-%m-%d",
		);
		expect(stepChanges(result, "date-patterns")).toEqual(
			[
				[ONE, "Opened"],
				[TWO, "Opened twice"],
				[UNTYPED, "Visit day"],
			].map(([column, name]) => ({
				reason: "date-pattern-apostrophe-replaced",
				entity: { type: "caseListColumn", uuid: column, nameAtMigration: name },
				detail: { menu: "Patients" },
			})),
		);
	});

	it("leaves a document the gate admits, which it refuses where the step does not run", () => {
		const result = transformDocument(fixtureCopy(ID), contextFor(ID));
		expect(gateCodes(ID, result.target)).toEqual([]);
		expect(
			gateCodes(
				ID,
				transformDocument(
					fixtureCopy(ID),
					contextFor(ID),
					without("date-patterns"),
				).target,
			),
		).toEqual(["CASE_LIST_DATE_PATTERN_APOSTROPHE"]);
	});
});

describe("step tile-hidden-calculated-sort", () => {
	const ID = "hand-tile-hidden-calculated-sort";
	const CALCULATED = uuid(0x801);
	const RECORD = uuid(0x8001);
	const OWNER = uuid(0x8002);
	const STATUS = uuid(0x8003);
	const VILLAGE = uuid(0x8004);

	function withHiddenRules(): RawDocument {
		const doc = fixtureCopy(ID);
		addColumn(doc, VISITS_TILE_MENU, {
			uuid: RECORD,
			kind: "plain",
			field: "case_id",
			header: "Record",
			visibleInList: false,
			sort: { direction: "desc", priority: 1 },
		});
		addColumn(doc, VISITS_TILE_MENU, {
			uuid: OWNER,
			kind: "plain",
			field: "owner_id",
			header: "Owner",
			visibleInList: false,
			sort: { direction: "asc", priority: 2 },
		});
		addColumn(doc, VISITS_TILE_MENU, {
			uuid: STATUS,
			kind: "plain",
			field: "status",
			header: "Status",
			visibleInList: false,
			sort: { direction: "desc", priority: 3 },
		});
		addColumn(doc, VISITS_TILE_MENU, {
			uuid: VILLAGE,
			kind: "plain",
			field: "village",
			header: "Village order",
			visibleInList: false,
			sort: { direction: "asc", priority: 4 },
		});
		return doc;
	}

	it("removes a hidden calculated and a hidden case_id order rule in a tile list, keeps each column, and keeps hidden owner_id, status and authored-property rules", () => {
		const result = transformDocument(withHiddenRules(), contextFor(ID));
		const list = listOf(result.target, VISITS_TILE_MENU);
		expect(list.columns.map((column) => column.uuid)).toEqual(
			listOf(withHiddenRules(), VISITS_TILE_MENU).columns.map(
				(column) => column.uuid,
			),
		);
		expect(columnOf(result.target, VISITS_TILE_MENU, CALCULATED).sort).toBe(
			undefined,
		);
		expect(columnOf(result.target, VISITS_TILE_MENU, RECORD).sort).toBe(
			undefined,
		);
		expect(columnOf(result.target, VISITS_TILE_MENU, OWNER).sort).toEqual({
			direction: "asc",
			priority: 2,
		});
		expect(columnOf(result.target, VISITS_TILE_MENU, STATUS).sort).toEqual({
			direction: "desc",
			priority: 3,
		});
		expect(columnOf(result.target, VISITS_TILE_MENU, VILLAGE).sort).toEqual({
			direction: "asc",
			priority: 4,
		});
		expect(stepChanges(result, "tile-hidden-calculated-sort")).toEqual([
			{
				reason: "tile-order-rule-removed",
				entity: {
					type: "caseListColumn",
					uuid: CALCULATED,
					nameAtMigration: "Order",
				},
				detail: { menu: "Visits", shape: "calculated" },
			},
			{
				reason: "tile-order-rule-removed",
				entity: {
					type: "caseListColumn",
					uuid: RECORD,
					nameAtMigration: "Record",
				},
				detail: { menu: "Visits", shape: "case_id" },
			},
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("is refused by the gate where the step does not run", () => {
		expect(
			gateCodes(
				ID,
				transformDocument(
					withHiddenRules(),
					contextFor(ID),
					without("tile-hidden-calculated-sort"),
				).target,
			),
		).toEqual(["CASE_TILE_HIDDEN_CALCULATED_SORT"]);
	});

	it("leaves a list with no tile layout as it is", () => {
		const doc = withHiddenRules();
		delete listOf(doc, VISITS_TILE_MENU).tile;
		const result = transformDocument(
			doc,
			contextFor(ID),
			CUTOVER_STEPS.filter((step) => step.id === "tile-hidden-calculated-sort"),
		);
		expect(stepChanges(result, "tile-hidden-calculated-sort")).toEqual([]);
		expect(columnOf(result.target, VISITS_TILE_MENU, CALCULATED).sort).toEqual({
			direction: "asc",
			priority: 0,
		});
		expect(columnOf(result.target, VISITS_TILE_MENU, RECORD).sort).toEqual({
			direction: "desc",
			priority: 1,
		});
	});
});

describe("step sort-property-ownership", () => {
	const ID = "hand-sort-property-ownership";
	const NAME = "56aac6e0-30dd-5cf4-aa85-c23ed492bfd0";
	const NAME_AGAIN = uuid(0x901);
	const NOTES_CODE = uuid(0x902);
	const NOTES = uuid(0x903);

	function sorts(document: RawDocument): Record<string, Json | undefined> {
		return Object.fromEntries(
			listOf(document, PATIENTS_MENU).columns.map((column) => [
				column.uuid as string,
				column.sort,
			]),
		);
	}

	it("removes the later of two rules over one value, then moves a rule to the first column with its value, in that order", () => {
		const result = transformDocument(fixtureCopy(ID), contextFor(ID));
		expect(sorts(result.target)).toEqual({
			[NAME]: { direction: "asc", priority: 0 },
			[NAME_AGAIN]: undefined,
			[NOTES_CODE]: { direction: "asc", priority: 2 },
			[NOTES]: undefined,
		});
		expect(stepChanges(result, "sort-property-ownership")).toEqual([
			{
				reason: "order-rule-removed-same-property",
				entity: {
					type: "caseListColumn",
					uuid: NAME_AGAIN,
					nameAtMigration: "Name again",
				},
				detail: { menu: "Patients", kept: "Name" },
			},
			{
				reason: "order-rule-moved-to-first-column",
				entity: {
					type: "caseListColumn",
					uuid: NOTES,
					nameAtMigration: "Notes",
				},
				detail: { menu: "Patients", first: "Notes code" },
			},
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("moves an ID mapping's rule to a plain column over its property that comes first", () => {
		const doc = fixtureCopy(ID);
		const list = listOf(doc, PATIENTS_MENU);
		list.listColumnOrder = list.listColumnOrder.filter(
			(column) => column !== NOTES_CODE,
		);
		list.listColumnOrder.push(NOTES_CODE);
		columnOf(doc, PATIENTS_MENU, NOTES_CODE).sort = {
			direction: "desc",
			priority: 2,
		};
		delete columnOf(doc, PATIENTS_MENU, NOTES).sort;
		const result = transformDocument(doc, contextFor(ID));
		expect(sorts(result.target)[NOTES]).toEqual({
			direction: "desc",
			priority: 2,
		});
		expect(sorts(result.target)[NOTES_CODE]).toBe(undefined);
		expect(stepChanges(result, "sort-property-ownership")).toContainEqual({
			reason: "order-rule-moved-to-first-column",
			entity: {
				type: "caseListColumn",
				uuid: NOTES_CODE,
				nameAtMigration: "Notes code",
			},
			detail: { menu: "Patients", first: "Notes" },
		});
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("leaves a hidden column's rule after a shown column over its property, which orders alike", () => {
		const doc = fixtureCopy(ID);
		for (const column of [NAME_AGAIN, NOTES_CODE, NOTES]) {
			const list = listOf(doc, PATIENTS_MENU);
			list.columns = list.columns.filter(
				(candidate) => candidate.uuid !== column,
			);
			list.listColumnOrder = list.listColumnOrder.filter(
				(uuid) => uuid !== column,
			);
			list.detailColumnOrder = list.detailColumnOrder.filter(
				(uuid) => uuid !== column,
			);
		}
		delete columnOf(doc, PATIENTS_MENU, NAME).sort;
		addColumn(doc, PATIENTS_MENU, {
			uuid: uuid(0x9001),
			kind: "plain",
			field: "case_name",
			header: "Hidden name",
			visibleInList: false,
			sort: { direction: "asc", priority: 0 },
		});
		const result = transformDocument(doc, contextFor(ID));
		expect(stepChanges(result, "sort-property-ownership")).toEqual([]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("is refused by the gate where the step does not run", () => {
		expect(
			gateCodes(
				ID,
				transformDocument(
					fixtureCopy(ID),
					contextFor(ID),
					without("sort-property-ownership"),
				).target,
			),
		).toEqual(["CASE_LIST_SORT_PROPERTY_AMBIGUOUS"]);
	});
});

describe("step tile-cells", () => {
	const ID = "targeted-custom-tile";
	const NAME = "318190ef-08d8-5ce3-ab07-f22d8b9bbf5f";

	function cells(document: RawDocument): Json[] {
		return listOf(document, VISITS_TILE_MENU).columns.map(
			(column) => column.tile,
		);
	}

	it("fills each slot a cell lacks, keeps a slot a cell states, and names the tile list once", () => {
		const doc = fixtureCopy(ID);
		(
			columnOf(doc, VISITS_TILE_MENU, NAME).tile as Record<string, Json>
		).fontSize = "large";
		const result = transformDocument(doc, contextFor(ID));
		expect(cells(result.target)).toEqual([
			{
				x: 0,
				y: 0,
				width: 6,
				height: 1,
				fontSize: "large",
				horizontalAlign: "left",
				verticalAlign: "top",
			},
			{
				x: 6,
				y: 0,
				width: 6,
				height: 1,
				horizontalAlign: "left",
				verticalAlign: "top",
				fontSize: "medium",
			},
			{
				x: 0,
				y: 1,
				width: 12,
				height: 1,
				horizontalAlign: "left",
				verticalAlign: "top",
				fontSize: "medium",
			},
		]);
		expect(stepChanges(result, "tile-cells")).toEqual([
			{
				reason: "tile-cell-defaults-set",
				entity: {
					type: "module",
					uuid: VISITS_TILE_MENU,
					nameAtMigration: "Visits",
				},
			},
		]);
	});

	it("fills the cells a list keeps with its tile layout switched off, and names nothing", () => {
		const doc = fixtureCopy(ID);
		delete listOf(doc, VISITS_TILE_MENU).tile;
		const result = transformDocument(doc, contextFor(ID));
		expect(stepChanges(result, "tile-cells")).toEqual([]);
		for (const cell of cells(result.target)) {
			expect(cell).toMatchObject({
				horizontalAlign: "left",
				verticalAlign: "top",
				fontSize: "medium",
			});
		}
		expect(gateCodes(ID, result.target)).toEqual([]);
	});
});

// ── Pull request 12: menus, navigation and search settings ──────────

describe("step search-button-label", () => {
	const ID = "targeted-search-button-label";
	const MENU = "ccc35682-a556-5426-ac5a-74a8e3b814b2";
	const GONE_MENU = uuid(0x1201);
	const button = (menu: string) =>
		makeTranslationUnitId("module", menu, "search-button");
	const translation = (value: string) => ({
		value,
		sourceFingerprint: "fixture",
		origin: "human",
		review: "reviewed",
		translatedFrom: "eng",
	});

	/** The witness in three languages, its button translated in two. */
	function translated(defaultLanguage: string): RawDocument {
		const doc = fixtureCopy(ID);
		const nameUnit = makeTranslationUnitId("module", MENU, "name");
		writable(doc).localization = {
			sourceLanguage: "eng",
			defaultLanguage,
			languageOrder:
				defaultLanguage === "eng"
					? ["eng", "spa", "fra"]
					: [defaultLanguage, "eng", "fra"],
			translations: {
				spa: {
					[button(MENU)]: translation("Buscar un paciente"),
					[button(GONE_MENU)]: translation("Buscar"),
					[nameUnit]: translation("Pacientes"),
				},
				fra: { [button(MENU)]: translation("Chercher un patient") },
			},
		};
		return doc;
	}

	function translations(document: RawDocument): Record<string, string[]> {
		const localization = writable(document).localization as {
			translations: Record<string, Record<string, Json>>;
		};
		return Object.fromEntries(
			Object.entries(localization.translations).map(([language, entries]) => [
				language,
				Object.keys(entries),
			]),
		);
	}

	function searchConfig(document: RawDocument): JsonRecord {
		return writable(document).modules[MENU]?.caseSearchConfig as JsonRecord;
	}

	it("deletes the stored label and every language's button text, whichever menu it names, and keeps the other translations", () => {
		const doc = translated("eng");
		(searchConfig(doc) as Record<string, Json>).searchButtonLabel =
			"Find a patient";
		const result = transformDocument(doc, contextFor(ID));
		expect(searchConfig(result.target)).not.toHaveProperty("searchButtonLabel");
		expect(translations(result.target)).toEqual({
			spa: [makeTranslationUnitId("module", MENU, "name")],
			fra: [],
		});
		expect(stepChanges(result, "search-button-label")).toEqual([
			{
				reason: "search-button-text-changed",
				entity: { type: "module", uuid: MENU, nameAtMigration: "Patients" },
				detail: { from: "Find a patient" },
			},
		]);
		expect(
			blueprintDocSchema.safeParse(rawDocumentAssembly(ID, result.target))
				.success,
		).toBe(true);
	});

	it("deletes a label beside no translation, and a translation beside no label, each on its own", () => {
		const labelled = fixtureCopy(ID);
		const alone = transformDocument(labelled, contextFor(ID)).target;
		expect(searchConfig(alone)).not.toHaveProperty("searchButtonLabel");

		const unlabelled = translated("eng");
		delete (searchConfig(unlabelled) as Record<string, Json>).searchButtonLabel;
		const result = transformDocument(unlabelled, contextFor(ID));
		expect(translations(result.target).fra).toEqual([]);
		expect(stepChanges(result, "search-button-label")).toEqual([
			{
				reason: "search-button-text-changed",
				entity: { type: "module", uuid: MENU, nameAtMigration: "Patients" },
				detail: { from: "Search" },
			},
		]);
	});

	it("gives the former text in the default language, where it is translated", () => {
		const result = transformDocument(translated("spa"), contextFor(ID));
		expect(stepChanges(result, "search-button-label")).toEqual([
			{
				reason: "search-button-text-changed",
				entity: { type: "module", uuid: MENU, nameAtMigration: "Patients" },
				detail: { from: "Buscar un paciente" },
			},
		]);
	});

	it("names no menu without a search", () => {
		const result = transformDocument(
			fixtureCopy("navigation-base"),
			contextFor("navigation-base"),
		);
		expect(stepChanges(result, "search-button-label")).toEqual([]);
	});
});

describe("step reserved-search-inputs", () => {
	const ID = "hand-xpath-query-input";
	const MENU = "1fefe8ae-743a-5a32-ac35-daf498a2c2be";
	const VISIT = "15456004-1da7-58f0-a1da-1afa4dc338d4";
	const INCLUDE = "bbb0148d-0ba6-5781-a4de-61fbf12d63bd";
	const OWNER = "c70c116d-da4c-5ad9-aea7-3f4b9aa8cebd";
	const QUERY = uuid(0xf01);
	const CASE_TYPE = uuid(0x1211);
	const CARRIED = uuid(0x1212);
	const includeTerm = {
		kind: "term",
		term: { kind: "input", searchInputUuid: INCLUDE },
	};

	function config(document: RawDocument): Record<string, Json> {
		const list = writable(document).modules[MENU]?.caseListConfig;
		if (list === undefined || list === null) {
			throw new Error("The witness lost its list.");
		}
		return list as never;
	}

	function inputs(document: RawDocument): JsonRecord[] {
		return config(document).searchInputs as never;
	}

	it("removes an own-key reserved input, renames a remaining _xpath_query, and keeps the rest", () => {
		const doc = fixtureCopy(ID);
		inputs(doc).push({
			uuid: CASE_TYPE,
			kind: "advanced",
			label: "Kind",
			name: "case_type",
			type: "text",
			predicate: {
				kind: "when-input-present",
				input: { kind: "input", searchInputUuid: CASE_TYPE },
				clause: {
					kind: "eq",
					left: {
						kind: "term",
						term: { kind: "prop", caseType: "patient", property: "case_name" },
					},
					right: {
						kind: "term",
						term: { kind: "input", searchInputUuid: CASE_TYPE },
					},
				},
			},
		});
		const result = transformDocument(doc, contextFor(ID));
		expect(
			inputs(result.target).map((input) => [input.uuid, input.name]),
		).toEqual([
			[OWNER, "owner_id"],
			[QUERY, "_xpath_query_2"],
			[CASE_TYPE, "case_type"],
		]);
		expect(stepChanges(result, "reserved-search-inputs")).toEqual([
			{
				reason: "search-input-removed",
				entity: {
					type: "searchInput",
					uuid: INCLUDE,
					nameAtMigration: "include_closed",
				},
				detail: { menu: "Patients", expressions: "0" },
			},
			{
				reason: "search-input-renamed",
				entity: { type: "searchInput", uuid: QUERY, nameAtMigration: "Query" },
				detail: {
					menu: "Patients",
					from: "_xpath_query",
					to: "_xpath_query_2",
				},
			},
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("removes an own-key input named _xpath_query rather than renaming it", () => {
		const doc = fixtureCopy(ID);
		const query = inputs(doc).find((input) => input.uuid === QUERY) as Record<
			string,
			Json
		>;
		query.property = "_xpath_query";
		const result = transformDocument(doc, contextFor(ID));
		expect(inputs(result.target).map((input) => input.uuid)).toEqual([OWNER]);
		expect(
			stepChanges(result, "reserved-search-inputs").map((change) => [
				change.reason,
				change.entity.nameAtMigration,
			]),
		).toEqual([
			["search-input-removed", "include_closed"],
			["search-input-removed", "_xpath_query"],
		]);
	});

	it("gives each expression that reads a removed input the unanswered reading, and counts them", () => {
		const doc = fixtureCopy(ID);
		config(doc).filter = {
			kind: "when-input-present",
			input: { kind: "input", searchInputUuid: INCLUDE },
			clause: {
				kind: "eq",
				left: {
					kind: "term",
					term: {
						kind: "prop",
						caseType: "patient",
						property: "include_closed",
					},
				},
				right: includeTerm,
			},
		};
		const owner = inputs(doc).find((input) => input.uuid === OWNER) as Record<
			string,
			Json
		>;
		owner.validation = {
			rule: { kind: "not", clause: { kind: "is-blank", left: includeTerm } },
			message: "Say whether to include closed cases.",
		};
		addField(doc, VISIT, {
			uuid: CARRIED,
			kind: "hidden",
			id: "carried",
			calculate: {
				parts: [
					{ kind: "text", text: "concat(" },
					{ kind: "search-answer-ref", searchInputUuid: INCLUDE },
					{ kind: "text", text: ", 'x')" },
				],
			},
		});
		const result = transformDocument(doc, contextFor(ID));
		expect(config(result.target).filter).toEqual({ kind: "match-all" });
		expect(
			(
				inputs(result.target).find(
					(input) => input.uuid === OWNER,
				) as never as {
					validation: Json;
				}
			).validation,
		).toEqual({
			rule: {
				kind: "not",
				clause: {
					kind: "is-blank",
					left: { kind: "term", term: { kind: "literal", value: "" } },
				},
			},
			message: "Say whether to include closed cases.",
		});
		expect(textOf(result.target, CARRIED, "calculate")).toBe("concat('', 'x')");
		expect(
			stepChanges(result, "reserved-search-inputs").find(
				(change) => change.reason === "search-input-removed",
			)?.detail?.expressions,
		).toBe("3");
	});

	it("leaves a reserved name on an input that does not reach HQ as its own key", () => {
		const doc = fixtureCopy(ID);
		const include = inputs(doc).find(
			(input) => input.uuid === INCLUDE,
		) as Record<string, Json>;
		include.mode = { kind: "starts-with" };
		const result = transformDocument(doc, contextFor(ID));
		expect(inputs(result.target).map((input) => input.uuid)).toContain(INCLUDE);
	});
});

describe("step hidden-from-menu", () => {
	const ID = "hand-hidden-from-menu";
	const CHECKS = uuid(0xc01);
	const CHECK = uuid(0xc02);
	const NEVER = { kind: "match-none" };
	const x = {
		kind: "is-blank",
		left: {
			kind: "term",
			term: { kind: "prop", caseType: "patient", property: "visit_time" },
		},
	};
	const y = {
		kind: "not",
		clause: {
			kind: "is-blank",
			left: {
				kind: "term",
				term: { kind: "prop", caseType: "patient", property: "case_name" },
			},
		},
	};

	function withConditions(menu: Json, form: Json): RawDocument {
		const doc = fixtureCopy(ID);
		writable(doc).modules[CHECKS] = {
			...writable(doc).modules[CHECKS],
			displayCondition: menu,
		} as JsonRecord;
		writable(doc).forms[CHECK] = {
			...writable(doc).forms[CHECK],
			displayCondition: form,
		} as JsonRecord;
		return doc;
	}

	function carriers(document: RawDocument) {
		const { displayCondition: menu, hiddenFromMenu: menuHidden } =
			document.modules[CHECKS] ?? {};
		const { displayCondition: form, hiddenFromMenu: formHidden } =
			document.forms[CHECK] ?? {};
		return { menu, menuHidden, form, formHidden };
	}

	it("marks a menu whose condition is never and a form whose condition is never and one more clause", () => {
		const result = transformDocument(
			withConditions(NEVER, { kind: "and", clauses: [NEVER, x] }),
			contextFor(ID),
		);
		expect(carriers(result.target)).toEqual({
			menu: undefined,
			menuHidden: true,
			form: x,
			formHidden: true,
		});
		expect(stepChanges(result, "hidden-from-menu")).toEqual([
			{
				reason: "hidden-from-menu-set",
				entity: { type: "module", uuid: CHECKS, nameAtMigration: "Checks" },
			},
			{
				reason: "hidden-from-menu-set",
				entity: { type: "form", uuid: CHECK, nameAtMigration: "Check" },
			},
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("keeps the rest of never and x and y as their own and, and leaves x and never as written", () => {
		const result = transformDocument(
			withConditions(
				{ kind: "and", clauses: [NEVER, x, y] },
				{ kind: "and", clauses: [x, NEVER] },
			),
			contextFor(ID),
		);
		expect(carriers(result.target)).toEqual({
			menu: { kind: "and", clauses: [x, y] },
			menuHidden: true,
			form: { kind: "and", clauses: [x, NEVER] },
			formHidden: undefined,
		});
		expect(
			stepChanges(result, "hidden-from-menu").map(
				(change) => change.entity.type,
			),
		).toEqual(["module"]);
	});

	it("stops on a menu it marks that a form link targets, or that holds an entry point", () => {
		const doc = withConditions(NEVER, x);
		writable(doc).forms["cd8766da-7326-51ee-aa0b-f8101304f9ea"] = {
			...writable(doc).forms["cd8766da-7326-51ee-aa0b-f8101304f9ea"],
			formLinks: [
				{ uuid: uuid(0x1221), target: { type: "module", moduleUuid: CHECKS } },
			],
		} as JsonRecord;
		writable(doc).modules[CHECKS] = {
			...writable(doc).modules[CHECKS],
			entryPoint: { uuid: uuid(0x1222), id: "checks" },
		} as JsonRecord;
		const result = transformDocument(doc, contextFor(ID));
		const menu = { type: "module", uuid: CHECKS, nameAtMigration: "Checks" };
		expect(result.blockers).toEqual([
			{
				code: "hidden-menu-is-a-destination",
				entity: menu,
				detail: { pointer: "link", form: "Visit" },
			},
			{
				code: "hidden-menu-is-a-destination",
				entity: menu,
				detail: { pointer: "entry-point" },
			},
		]);
		expect(
			contentBlockerPlaces(result.target, undefined, result.blockers).map(
				(place) => [place.code, place.message],
			),
		).toEqual([
			[
				"hidden-menu-is-a-destination",
				'"Checks" is now off the menu, because its display condition could never be true, and the after-submit link from "Visit" opens it. Point it at a form inside the module, or change the condition so it can be true.',
			],
			[
				"hidden-menu-is-a-destination",
				'"Checks" is now off the menu, because its display condition could never be true, and its entry point opens it. Point it at a form inside the module, or change the condition so it can be true.',
			],
		]);
	});
});

describe("step post-submit", () => {
	const ID = "hand-post-submit";
	const BATCHES = "1749f35c-6375-5a08-a7ef-4b1e499c902c";
	const SAMPLES = "a476cee3-04c0-58a7-afa3-f5d91687b913";
	const REVIEW_BATCHES = "6328425f-f277-5dc3-a39d-c38944b0deef";
	const UNDER_BATCHES = "71758067-5fb8-5433-aab4-e621619e2937";
	const UNDER_SAMPLES = "76468f4a-b34b-560e-a19a-39e0371c79da";
	const REVIEW_SAMPLES = "84afd5f8-3ab4-5ae4-a9ec-c24e94c487a8";

	function form(document: RawDocument, formUuid: string): Record<string, Json> {
		const found = writable(document).forms[formUuid];
		if (found === undefined) throw new Error(`No form ${formUuid}.`);
		return found as Record<string, Json>;
	}

	function destinations(document: RawDocument): Record<string, Json> {
		return Object.fromEntries(
			[REVIEW_BATCHES, UNDER_BATCHES, UNDER_SAMPLES, REVIEW_SAMPLES].map(
				(formUuid) => [formUuid, form(document, formUuid).postSubmit ?? null],
			),
		);
	}

	const moved = (
		formUuid: string,
		name: string,
		detail: Record<string, string>,
	) => ({
		reason: "after-submit-destination-moved",
		entity: { type: "form", uuid: formUuid, nameAtMigration: name },
		detail,
	});

	it("writes module for previous in a menu that selects several cases, and firstMenu under one, relying on the default", () => {
		const result = transformDocument(fixtureCopy(ID), contextFor(ID));
		expect(destinations(result.target)).toEqual({
			[REVIEW_BATCHES]: "module",
			[UNDER_BATCHES]: "firstMenu",
			[UNDER_SAMPLES]: "module",
			[REVIEW_SAMPLES]: null,
		});
		expect(stepChanges(result, "post-submit")).toEqual([
			moved(REVIEW_BATCHES, "Review batches", {
				from: "previous",
				to: "module",
				cause: "multi-select-menu",
				menu: "Batches",
			}),
			moved(UNDER_BATCHES, "Review single-under-batches", {
				from: "previous",
				to: "firstMenu",
				cause: "multi-select-parent",
				menu: "One sample",
			}),
			moved(UNDER_SAMPLES, "Review batch-under-samples", {
				from: "previous",
				to: "module",
				cause: "multi-select-menu",
				menu: "Several samples",
			}),
		]);
		expect(gateCodes(ID, result.target)).toEqual([]);
	});

	it("moves a stored previous and a stored module the same way, and keeps a stored module in a menu that selects several cases", () => {
		const doc = fixtureCopy(ID);
		form(doc, REVIEW_BATCHES).postSubmit = "previous";
		form(doc, UNDER_BATCHES).postSubmit = "module";
		form(doc, UNDER_SAMPLES).postSubmit = "module";
		const result = transformDocument(doc, contextFor(ID));
		expect(destinations(result.target)).toMatchObject({
			[REVIEW_BATCHES]: "module",
			[UNDER_BATCHES]: "firstMenu",
			[UNDER_SAMPLES]: "module",
		});
		expect(
			stepChanges(result, "post-submit").map((change) => change.detail),
		).toEqual([
			{
				from: "previous",
				to: "module",
				cause: "multi-select-menu",
				menu: "Batches",
			},
			{
				from: "module",
				to: "firstMenu",
				cause: "multi-select-parent",
				menu: "One sample",
			},
		]);
	});

	it("pins the default of a form with links where it now changes, and keeps a stored fallback, with no line", () => {
		const doc = fixtureCopy(ID);
		const link = (n: number) => [
			{ uuid: uuid(n), target: { type: "module", moduleUuid: SAMPLES } },
		];
		form(doc, REVIEW_BATCHES).formLinks = link(0x1231);
		form(doc, UNDER_SAMPLES).formLinks = link(0x1232);
		form(doc, UNDER_SAMPLES).postSubmit = "previous";
		const result = transformDocument(doc, contextFor(ID));
		expect(destinations(result.target)).toMatchObject({
			[REVIEW_BATCHES]: "previous",
			[UNDER_SAMPLES]: "previous",
		});
		expect(
			stepChanges(result, "post-submit").map((change) => change.entity.uuid),
		).toEqual([UNDER_BATCHES]);
	});

	it("writes firstMenu for a form of a menu step hidden-from-menu takes off the menu, with or without links", () => {
		const doc = fixtureCopy(ID);
		writable(doc).modules[SAMPLES] = {
			...writable(doc).modules[SAMPLES],
			displayCondition: { kind: "match-none" },
		} as JsonRecord;
		form(doc, REVIEW_SAMPLES).formLinks = [
			{ uuid: uuid(0x1233), target: { type: "module", moduleUuid: BATCHES } },
		];
		const result = transformDocument(doc, contextFor(ID));
		expect(form(result.target, REVIEW_SAMPLES).postSubmit).toBe("firstMenu");
		expect(stepChanges(result, "post-submit")).toContainEqual(
			moved(REVIEW_SAMPLES, "Review samples", {
				from: "previous",
				to: "firstMenu",
				cause: "off-the-menu",
				menu: "Samples",
			}),
		);
	});

	it("writes firstMenu for a no-matches form that holds app_home, with no line", () => {
		const id = "no-matches-parent";
		const doc = fixtureCopy(id);
		const noMatches = Object.entries(writable(doc).forms).find(
			([, candidate]) =>
				(candidate.entry as JsonRecord | undefined)?.kind ===
				"search-no-matches",
		);
		if (noMatches === undefined) throw new Error("No no-matches form.");
		(noMatches[1] as Record<string, Json>).postSubmit = "app_home";
		const result = transformDocument(doc, contextFor(id));
		expect(form(result.target, noMatches[0]).postSubmit).toBe("firstMenu");
		expect(stepChanges(result, "post-submit")).toEqual([]);
		expect(gateCodes(id, result.target)).toEqual([]);
	});
});

describe("the lines pull request 12's steps write", () => {
	/** Each change as its stored entry, rendered as a member reads it once the entity is gone. */
	function rendered(changes: readonly DocumentChange[]): string[] {
		return changes.map(
			(change) =>
				renderNoticeEntry(
					migrationNoticeEntrySchema.parse({ kind: "document", ...change }),
					{ nameOf: () => null },
				).text,
		);
	}

	function changesOf(
		id: string,
		document: RawDocument,
		stepId: string,
	): readonly DocumentChange[] {
		return stepChanges(transformDocument(document, contextFor(id)), stepId);
	}

	it("render as the notice's copy", () => {
		const labelled = fixtureCopy("targeted-search-button-label");
		(
			writable(labelled).modules["ccc35682-a556-5426-ac5a-74a8e3b814b2"]
				?.caseSearchConfig as Record<string, Json>
		).searchButtonLabel = "Find a patient";
		expect(
			rendered(
				changesOf(
					"targeted-search-button-label",
					labelled,
					"search-button-label",
				),
			),
		).toEqual([
			"Patients: the search button now reads “Search All Cases”. It read “Find a patient” before. CommCare HQ always shows its own text there.",
		]);
		expect(
			rendered(
				changesOf(
					"hand-xpath-query-input",
					fixtureCopy("hand-xpath-query-input"),
					"reserved-search-inputs",
				),
			),
		).toEqual([
			"Patients: the search input include_closed was removed. CommCare reads that name as part of the search request, so it never searched a property.",
			"Patients: the search input _xpath_query is now _xpath_query_2. CommCare reads the earlier name as part of the search itself.",
		]);
		const hidden = fixtureCopy("hand-hidden-from-menu");
		writable(hidden).modules[uuid(0xc01)] = {
			...writable(hidden).modules[uuid(0xc01)],
			displayCondition: { kind: "match-none" },
		} as JsonRecord;
		writable(hidden).forms[uuid(0xc02)] = {
			...writable(hidden).forms[uuid(0xc02)],
			displayCondition: { kind: "match-none" },
		} as JsonRecord;
		expect(
			rendered(changesOf("hand-hidden-from-menu", hidden, "hidden-from-menu")),
		).toEqual([
			"Checks: this module is now marked as not on the menu, because its display condition could never be true. Its settings show what can still open it.",
			"Check: this form is now marked as not on the menu, because its display condition could never be true. Its settings show what can still open it.",
		]);
		expect(
			rendered(changesOf("hand-hidden-from-menu", hidden, "post-submit")),
		).toEqual([
			"Check: after submitting, workers now go to the app's first menu (First menu in its settings). It was set to the previous screen, and Checks is now off the menu, so there is no screen of it to go back to.",
		]);
		expect(
			rendered(
				changesOf(
					"hand-post-submit",
					fixtureCopy("hand-post-submit"),
					"post-submit",
				),
			),
		).toEqual([
			"Review batches: after submitting, workers now go back to this module's case list. It was set to the previous screen, which CommCare HQ doesn't offer in a module that selects several cases.",
			"Review single-under-batches: after submitting, workers now go to the app's first menu (First menu in its settings). It was set to the previous screen, which CommCare HQ doesn't offer in a module under one that selects several cases.",
			"Review batch-under-samples: after submitting, workers now go back to this module's case list. It was set to the previous screen, which CommCare HQ doesn't offer in a module that selects several cases.",
		]);
	});
});
