/**
 * The cutover's structure phase over the pre-step fixtures read raw, the way
 * the cutover reads an app: each step's rewrite of `main`'s stored shape,
 * the facts it lifts for the semantic steps, and the head parse that must
 * read what the phase leaves.
 *
 * A step that left a key the head schema refuses would stop every app at
 * `structure-parse`; one that rewrote a key wrongly would parse and change
 * what the app does. The close conditions are held to the trees the head's
 * own parser built for part 08's case-writes witness from the same closes
 * written as text, so a hand-built tree that drifted from the parser's
 * shape fails here.
 */

import { describe, expect, it } from "vitest";
import { expressionSchema } from "@/lib/domain/expression/types";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import { migrationNoticeEntriesSchema } from "@/lib/notices/migrationNotice";
import { migrationCaseWrites } from "@/proof/targeted/documents/migrations";
import {
	copyRawDocument,
	type Json,
	type JsonRecord,
	type RawDocument,
} from "../oldShape";
import { parseHead, structurePhase } from "../structure";
import {
	PRE_STEP_FIXTURE_IDS,
	rawFixture,
	readPreStepJson,
} from "./rawFixture";

type Writable = Record<string, Json>;

function appIdOf(id: string): string {
	return (readPreStepJson(`${id}.json`) as { appId: string }).appId;
}

/** A writable copy of a fixture's raw document, to plant a shape in. */
function planted(id: string): RawDocument {
	return copyRawDocument(rawFixture(id));
}

function writable(record: JsonRecord | undefined): Writable {
	if (record === undefined)
		throw new Error("The fixture holds no such record.");
	return record as Writable;
}

function moduleNamed(raw: RawDocument, id: string): [string, JsonRecord] {
	const found = Object.entries(raw.modules).find(([, m]) => m.id === id);
	if (found === undefined) throw new Error(`No module ${id}.`);
	return found;
}

function formNamed(raw: RawDocument, name: string): [string, JsonRecord] {
	const found = Object.entries(raw.forms).find(([, f]) => f.name === name);
	if (found === undefined) throw new Error(`No form ${name}.`);
	return found;
}

function fieldWithId(raw: RawDocument, id: string): [string, JsonRecord] {
	const found = Object.entries(raw.fields).find(([, f]) => f.id === id);
	if (found === undefined) throw new Error(`No field ${id}.`);
	return found;
}

describe("renamed-concepts", () => {
	const raw = rawFixture("pre-step-renamed-concepts");
	const { persisted, facts, changes, blockers } = structurePhase(raw);

	it("makes a case-list-only menu's case list a menu entry carrying its media (M2)", () => {
		const [uuid] = moduleNamed(raw, "clinics");
		const module = persisted.modules[uuid] as JsonRecord;
		expect(module.caseListOnly).toBeUndefined();
		expect(module.caseListMenuItem).toEqual({ icon: "nova-icon:community" });
		expect((module.caseListConfig as JsonRecord).icon).toBeUndefined();
		expect(facts.deadCaseListMedia.has(uuid as never)).toBe(false);
	});

	it("drops a stored caseListOnly false (M3)", () => {
		const [uuid] = moduleNamed(raw, "households");
		const module = persisted.modules[uuid] as JsonRecord;
		expect("caseListOnly" in module).toBe(false);
		expect(module.caseListMenuItem).toBeUndefined();
	});

	it("deletes case list media no menu showed and records it (M4)", () => {
		const [uuid] = moduleNamed(raw, "visits");
		const module = persisted.modules[uuid] as JsonRecord;
		expect((module.caseListConfig as JsonRecord).icon).toBeUndefined();
		expect(module.caseListMenuItem).toBeUndefined();
		expect([...facts.deadCaseListMedia]).toEqual([[uuid, ["icon"]]]);
	});

	it("moves a no-matches form to its module and its label's translation unchanged (M5)", () => {
		const [moduleUuid] = moduleNamed(raw, "patients");
		const [formUuid] = formNamed(raw, "Register patient");
		expect(persisted.forms[formUuid]?.entry).toBeUndefined();
		expect(persisted.modules[moduleUuid]?.caseListRegistrationForm).toEqual({
			kind: "after-empty-search",
			formUuid,
			label: "Register a new patient",
		});
		const from = makeTranslationUnitId("form", formUuid, "entry-label");
		const to = makeTranslationUnitId(
			"module",
			moduleUuid,
			"case-list-registration-label",
		);
		const before = (
			raw.localization as { translations: Record<string, Writable> }
		).translations.spa;
		const after = (
			persisted.localization as { translations: Record<string, Writable> }
		).translations.spa;
		expect(before?.[from]).toBeDefined();
		expect(after?.[from]).toBeUndefined();
		expect(after?.[to]).toEqual(before?.[from]);
		expect((after?.[to] as JsonRecord | undefined)?.sourceFingerprint).toBe(
			'source-v1:text:"Register a new patient"',
		);
		expect(blockers).toEqual([]);
		expect(changes).toContainEqual({
			step: "renamed-concepts",
			kind: "case-list-registration-form",
			entityUuid: moduleUuid,
			detail: { translations: 1 },
		});
	});

	it("leaves the document the plan read as it was", () => {
		expect(raw).toEqual(rawFixture("pre-step-renamed-concepts"));
	});

	it("refuses a module holding two no-matches forms", () => {
		const doc = planted("pre-step-renamed-concepts");
		const [moduleUuid] = moduleNamed(doc, "patients");
		const [, visit] = formNamed(doc, "Patient visit");
		writable(visit).entry = { kind: "search-no-matches" };
		const result = structurePhase(doc);
		expect(result.blockers).toEqual([
			{
				code: "renamed-concept-conflict",
				count: 1,
				findingCodes: ["SEARCH_NO_MATCHES_DUPLICATE"],
				places: [
					{
						entity: { kind: "module", uuid: moduleUuid, name: "Patients" },
						findingCode: "SEARCH_NO_MATCHES_DUPLICATE",
					},
				],
			},
		]);
	});
});

describe("capture-link-writes", () => {
	const raw = rawFixture("targeted-migration-attachment");
	const { persisted, facts, notice, changes } = structurePhase(raw);
	const [photo] = fieldWithId(raw, "photo");
	const [scan] = fieldWithId(raw, "scan");

	it("drops every capture write's mode and records the attachment one (C4, C5)", () => {
		expect(raw.fields[photo]?.caseWrite).toMatchObject({ mode: "attachment" });
		expect(raw.fields[scan]?.caseWrite).toMatchObject({ mode: "url" });
		expect([...facts.attachmentFields]).toEqual([photo]);
		expect(changes.filter((c) => c.step === "capture-link-writes")).toEqual([
			{
				step: "capture-link-writes",
				kind: "attachment-mode",
				entityUuid: photo,
				detail: {},
			},
			{
				step: "capture-link-writes",
				kind: "link-mode",
				entityUuid: scan,
				detail: {},
			},
		]);
		expect(persisted.fields[photo]?.caseWrite).toBeUndefined();
	});

	it("names the attachment field, its form and its property in the notice", () => {
		expect(notice).toEqual([
			{
				kind: "document",
				reason: "capture-saves-link",
				entity: { type: "field", uuid: photo, nameAtMigration: "photo" },
				detail: { form: "Photo", property: "photo" },
			},
		]);
		expect(migrationNoticeEntriesSchema.parse(notice)).toEqual(notice);
	});
});

describe("close-condition-expression", () => {
	const witness = migrationCaseWrites().doc;
	const raw = rawFixture("targeted-migration-case-writes");
	const { persisted } = structurePhase(raw);

	it.each(["Close", "Close in repeat"])(
		"writes %s's close as the tree the head's parser builds for it (C6)",
		(name) => {
			const [formUuid] = formNamed(raw, name);
			const close = persisted.forms[formUuid]?.closeCondition;
			expect(close).toEqual(
				(
					witness.forms as unknown as Record<
						string,
						{ closeCondition?: unknown }
					>
				)[formUuid]?.closeCondition,
			);
			expect(expressionSchema.parse(close)).toEqual(close);
		},
	);

	it("reads an absent operator as = and an unmatched answer as the literal", () => {
		const doc = planted("targeted-migration-case-writes");
		const [formUuid, form] = formNamed(doc, "Close");
		const field = (form.closeCondition as JsonRecord).field as string;
		writable(form).closeCondition = { field, answer: "gone", operator: "=" };
		const close = structurePhase(doc).persisted.forms[formUuid]?.closeCondition;
		expect(close).toEqual({
			kind: "eq",
			left: { kind: "term", term: { kind: "field", uuid: field } },
			right: { kind: "term", term: { kind: "literal", value: "gone" } },
		});
		expect(expressionSchema.parse(close)).toEqual(close);
	});

	it("writes selected as multi-select-contains, with a choice and in a repeat", () => {
		const doc = planted("targeted-migration-case-writes");
		const [closeUuid, close] = formNamed(doc, "Close");
		const outcome = (close.closeCondition as JsonRecord).field as string;
		const options = (writable(doc.fields[outcome]).optionsSource as JsonRecord)
			.options as JsonRecord[];
		const moved = options.find((option) => option.value === "moved")?.uuid;
		writable(close).closeCondition = {
			field: outcome,
			answer: "moved",
			operator: "selected",
		};
		const [repeatUuid, inRepeat] = formNamed(doc, "Close in repeat");
		const departed = (inRepeat.closeCondition as JsonRecord).field as string;
		writable(inRepeat).closeCondition = {
			field: departed,
			answer: "maybe",
			operator: "selected",
		};
		const { persisted: result } = structurePhase(doc);
		const answer = { kind: "term", term: { kind: "field", uuid: outcome } };
		expect(result.forms[closeUuid]?.closeCondition).toEqual({
			kind: "multi-select-contains",
			property: answer,
			values: [{ kind: "choice", field: outcome, options: [moved] }],
			quantifier: "any",
		});
		expect(result.forms[repeatUuid]?.closeCondition).toEqual({
			kind: "gt",
			left: {
				kind: "count",
				via: {
					kind: "term",
					term: {
						kind: "field",
						uuid: departed,
						filters: [
							{
								step: { kind: "field", uuid: departed },
								where: [
									{
										kind: "multi-select-contains",
										property: {
											kind: "term",
											term: {
												kind: "field",
												uuid: departed,
												spelling: "relative",
											},
										},
										values: [{ kind: "literal", value: "maybe" }],
										quantifier: "any",
									},
								],
							},
						],
					},
				},
			},
			right: { kind: "term", term: { kind: "literal", value: 0 } },
		});
		for (const uuid of [closeUuid, repeatUuid]) {
			const tree = result.forms[uuid]?.closeCondition;
			expect(expressionSchema.parse(tree)).toEqual(tree);
		}
		expect(
			parseHead(appIdOf("targeted-migration-case-writes"), result).ok,
		).toBe(true);
	});
});

describe("field-writes-lifted", () => {
	/** Every field under `parent` in the stored JSON, each before its children. */
	function storedDataOrder(stored: JsonRecord, parent: string): string[] {
		const order = (stored.fieldOrder as Record<string, string[]>)[parent] ?? [];
		return order.flatMap((uuid) => [uuid, ...storedDataOrder(stored, uuid)]);
	}

	it.each(["targeted-migration-case-writes", "targeted-migration-attachment"])(
		"lifts every write of %s per form in data-tree order with capture set",
		(id) => {
			const stored = readPreStepJson(`${id}.json`) as JsonRecord;
			const fields = stored.fields as Record<string, JsonRecord>;
			const { persisted, facts } = structurePhase(rawFixture(id));
			const forms = Object.keys(stored.forms as JsonRecord);
			expect([...facts.fieldWrites.keys()].sort()).toEqual([...forms].sort());
			let writes = 0;
			for (const formUuid of forms) {
				const expected = storedDataOrder(stored, formUuid).flatMap((uuid) => {
					const write = fields[uuid]?.caseWrite as JsonRecord | undefined;
					if (write === undefined) return [];
					return [
						{
							fieldUuid: uuid,
							caseType: write.caseType,
							property: write.property,
							capture: [
								"image",
								"audio",
								"video",
								"signature",
								"file",
							].includes(fields[uuid]?.kind as string),
						},
					];
				});
				writes += expected.length;
				expect(facts.fieldWrites.get(formUuid as never)).toEqual(expected);
			}
			expect(writes).toBeGreaterThan(1);
			for (const field of Object.values(persisted.fields))
				expect(field.caseWrite).toBeUndefined();
		},
	);

	it("sets capture on the attachment fixture's image and file writes", () => {
		const { facts } = structurePhase(
			rawFixture("targeted-migration-attachment"),
		);
		const captures = [...facts.fieldWrites.values()]
			.flat()
			.filter((fact) => fact.capture)
			.map((fact) => fact.property);
		expect(captures).toEqual(["photo", "scan"]);
	});
});

describe("search-first-lifted", () => {
	it("lifts a stored searchFirst true and removes the key", () => {
		const raw = rawFixture("pre-step-renamed-concepts");
		const [uuid] = moduleNamed(raw, "patients");
		const { persisted, facts } = structurePhase(raw);
		expect([...facts.searchFirst]).toEqual([uuid]);
		expect(persisted.modules[uuid]?.caseSearchConfig).toEqual({});
	});
});

describe("the head parse", () => {
	it.each(PRE_STEP_FIXTURE_IDS)(
		"reads %s once the structure phase has run",
		(id) => {
			const { persisted, blockers } = structurePhase(rawFixture(id));
			expect(blockers).toEqual([]);
			const head = parseHead(appIdOf(id), persisted);
			if (!head.ok) throw new Error(head.blocker.findingCodes.join("\n"));
			expect(head.doc.appId).toBe(appIdOf(id));
			expect(Object.keys(head.doc.fieldParent).length).toBe(
				Object.keys(persisted.fields).length,
			);
		},
	);

	it("refuses a key the phase left in place as structure-parse, naming no value", () => {
		const doc = planted("pre-step-renamed-concepts");
		const [formUuid, form] = formNamed(doc, "Household visit");
		writable(form).entry = { kind: "from-somewhere-else", label: "SECRET" };
		const head = parseHead(
			appIdOf("pre-step-renamed-concepts"),
			structurePhase(doc).persisted,
		);
		expect(head).toEqual({
			ok: false,
			blocker: {
				code: "structure-parse",
				count: 1,
				findingCodes: [`unrecognized_keys:forms.${formUuid}:entry`],
			},
		});
		expect(JSON.stringify(head)).not.toContain("SECRET");
	});
});
