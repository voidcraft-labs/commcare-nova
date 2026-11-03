/**
 * The case-writes cutover's structure phase (step 5's part 09, sections 7.1
 * to 7.3): the five steps that rewrite an app's stored document, read as raw
 * JSON through `oldShape.ts`, until the head schema can read it, and the head
 * parse that follows them.
 *
 * Every key these steps remove is one the head schema refuses, so no schema
 * reads the document before they finish: a field's `caseWrite` (with a
 * capture's `mode`), a form's structured `closeCondition` and its `entry`, a
 * module's `caseListOnly`, its case list's `icon` and `audioLabel`, and its
 * `caseSearchConfig.searchFirst`. Each old fact the semantic steps still
 * need leaves into `LiftedFacts` on its way out. The frozen rules of `main`
 * (`frozen/*`) read the document as it was read, before the first rewrite,
 * so each sees `main`'s shape untouched.
 *
 * The phase works on its own copy of the document and never on the one the
 * plan read.
 */

import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type PersistableDoc,
} from "@/lib/domain/blueprint";
import type {
	Choice,
	Expression,
	Literal,
} from "@/lib/domain/expression/types";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import type { Uuid } from "@/lib/domain/uuid";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import { preloadedWriters } from "./frozen/casePreload";
import { labelledGroups } from "./frozen/groupLabel";
import {
	isRecord,
	RAW_CAPTURE_KINDS,
	rawDataPaths,
	rawFieldCaseWrite,
	rawFieldsInDataOrder,
	rawFormsInOrder,
	recordAt,
	recordsAt,
	stringAt,
} from "./frozen/rawForms";
import { todaysPlacements } from "./frozen/todaysPlacements";
import { captureSavesLink } from "./notice";
import {
	copyRawDocument,
	type Json,
	type JsonRecord,
	type RawDocument,
	rawDocumentAssembly,
} from "./oldShape";
import {
	type BlockerPlace,
	type CutoverBlocker,
	compareText,
	type FieldWriteFact,
	type LiftedFacts,
	type PlannedChange,
	type StructureStepId,
} from "./types";

export type { LiftedFacts };

/** What the structure phase gives the transform. */
export interface StructurePhase {
	/** The rewritten document, for `parseHead`. */
	readonly persisted: RawDocument;
	readonly facts: LiftedFacts;
	readonly changes: readonly PlannedChange[];
	readonly notice: readonly MigrationNoticeEntry[];
	readonly blockers: readonly CutoverBlocker[];
}

/** A raw record the phase rewrites in place, on its own copy. */
type Writable = Record<string, Json>;

function writable(record: JsonRecord): Writable {
	return record as Writable;
}

/** The step's record of one change, its details as counts. */
function change(
	step: StructureStepId,
	kind: string,
	entityUuid: string | null,
	detail: Readonly<Record<string, number>> = {},
): PlannedChange {
	return { step, kind, entityUuid: entityUuid as Uuid | null, detail };
}

/**
 * Run the five structure steps over a copy of `raw`, after the frozen rules
 * have read `raw` as read.
 */
export function structurePhase(raw: RawDocument): StructurePhase {
	// The frozen rules read `main`'s shape, before any step rewrites it.
	const preloaded = new Map<Uuid, readonly Uuid[]>();
	for (const [formUuid, writers] of preloadedWriters(raw))
		preloaded.set(formUuid as Uuid, writers as readonly Uuid[]);
	const labelled = new Set(labelledGroups(raw) as readonly Uuid[]);
	const placements = todaysPlacements(raw);

	const doc = copyRawDocument(raw);
	const changes: PlannedChange[] = [];
	const notice: MigrationNoticeEntry[] = [];
	const blockers: CutoverBlocker[] = [];

	const deadCaseListMedia = renamedConcepts(doc, changes, blockers);
	const attachmentFields = captureLinkWrites(doc, changes, notice);
	closeConditionExpression(doc, changes);
	const fieldWrites = fieldWritesLifted(doc, changes);
	const searchFirst = searchFirstLifted(doc, changes);

	return {
		persisted: doc,
		facts: {
			fieldWrites,
			attachmentFields,
			searchFirst,
			preloadedWriters: preloaded,
			labelledGroups: labelled,
			todaysPlacements: placements,
			deadCaseListMedia,
		},
		changes,
		notice,
		blockers,
	};
}

// ─── Step 1: renamed-concepts (part 05 §14, M2 to M5) ─────────────────────

const CASE_LIST_MEDIA = ["icon", "audioLabel"] as const;
type CaseListMedia = (typeof CASE_LIST_MEDIA)[number];

/**
 * M2 to M5 over every module and form. Returns the case list media M4
 * deleted, per module.
 */
function renamedConcepts(
	doc: RawDocument,
	changes: PlannedChange[],
	blockers: CutoverBlocker[],
): ReadonlyMap<Uuid, readonly CaseListMedia[]> {
	const dead = new Map<Uuid, readonly CaseListMedia[]>();
	for (const moduleUuid of Object.keys(doc.modules)) {
		const module = writable(doc.modules[moduleUuid] as JsonRecord);
		const caseList = recordAt(module, "caseListConfig");
		const listOnly = module.caseListOnly;
		if (listOnly === true) {
			// M2: the case list as a menu entry of its own, carrying the
			// media the case-list-only menu showed.
			const item: Writable = {};
			for (const key of CASE_LIST_MEDIA) {
				if (caseList !== undefined && caseList[key] !== undefined) {
					item[key] = caseList[key];
					delete writable(caseList)[key];
				}
			}
			module.caseListMenuItem = item;
			delete module.caseListOnly;
			changes.push(
				change("renamed-concepts", "case-list-menu-item", moduleUuid, {
					icon: item.icon === undefined ? 0 : 1,
					audioLabel: item.audioLabel === undefined ? 0 : 1,
				}),
			);
			continue;
		}
		if (listOnly === false) {
			// M3: the default, stored.
			delete module.caseListOnly;
			changes.push(
				change("renamed-concepts", "case-list-only-default", moduleUuid),
			);
		}
		// M4: case list media no menu ever showed.
		if (caseList === undefined) continue;
		const deleted = CASE_LIST_MEDIA.filter(
			(key) => caseList[key] !== undefined,
		);
		if (deleted.length === 0) continue;
		for (const key of deleted) delete writable(caseList)[key];
		dead.set(moduleUuid as Uuid, deleted);
		changes.push(
			change("renamed-concepts", "dead-case-list-media", moduleUuid, {
				icon: deleted.includes("icon") ? 1 : 0,
				audioLabel: deleted.includes("audioLabel") ? 1 : 0,
			}),
		);
	}
	caseListRegistrationForms(doc, changes, blockers);
	return dead;
}

/** A form's stored no-matches entry, where it holds one. */
function noMatchesEntry(form: JsonRecord | undefined): JsonRecord | undefined {
	const entry = recordAt(form, "entry");
	return stringAt(entry, "kind") === "search-no-matches" ? entry : undefined;
}

/**
 * M5: each module's no-matches form becomes the module's case list
 * registration form, and each target language's translation of its label
 * moves to the module's unit unchanged.
 *
 * A module holding two such forms is a document `main`'s gate never
 * admitted (`SEARCH_NO_MATCHES_DUPLICATE`): the blocker
 * `renamed-concept-conflict`. The first form in the module's order is moved
 * and the others' entries are dropped, so the judgement can still read the
 * rest of the document; the blocker leaves the app with no target.
 */
function caseListRegistrationForms(
	doc: RawDocument,
	changes: PlannedChange[],
	blockers: CutoverBlocker[],
): void {
	const conflicts: BlockerPlace[] = [];
	for (const moduleUuid of Object.keys(doc.modules)) {
		const module = writable(doc.modules[moduleUuid] as JsonRecord);
		const formUuids = (doc.formOrder[moduleUuid] ?? []).filter(
			(formUuid) => noMatchesEntry(doc.forms[formUuid]) !== undefined,
		);
		if (formUuids.length === 0) continue;
		if (formUuids.length > 1)
			conflicts.push({
				entity: {
					kind: "module",
					uuid: moduleUuid as Uuid,
					...(typeof module.name === "string" && { name: module.name }),
				},
				findingCode: "SEARCH_NO_MATCHES_DUPLICATE",
			});
		const [formUuid, ...others] = formUuids as [string, ...string[]];
		const form = writable(doc.forms[formUuid] as JsonRecord);
		const label = stringAt(noMatchesEntry(form), "label");
		module.caseListRegistrationForm = {
			kind: "after-empty-search",
			formUuid,
			// The head keeps a label only where it holds text; an empty one
			// read as the form's name at `main` as absence does here.
			...(label !== undefined && label.length > 0 && { label }),
		};
		delete form.entry;
		for (const other of others)
			delete writable(doc.forms[other] as JsonRecord).entry;
		const moved = moveLabelTranslations(doc, formUuid, moduleUuid);
		changes.push(
			change("renamed-concepts", "case-list-registration-form", moduleUuid, {
				translations: moved,
			}),
		);
	}
	if (conflicts.length > 0)
		blockers.push({
			code: "renamed-concept-conflict",
			count: conflicts.length,
			findingCodes: ["SEARCH_NO_MATCHES_DUPLICATE"],
			places: conflicts,
		});
}

/**
 * Move every target language's overlay entry of the form's entry label to
 * the module's registration label, value, provenance, review state and
 * source fingerprint as stored. Returns how many moved.
 */
function moveLabelTranslations(
	doc: RawDocument,
	formUuid: string,
	moduleUuid: string,
): number {
	if (!isRecord(doc.localization)) return 0;
	const translations = recordAt(doc.localization, "translations");
	if (translations === undefined) return 0;
	const from = makeTranslationUnitId("form", formUuid, "entry-label");
	const to = makeTranslationUnitId(
		"module",
		moduleUuid,
		"case-list-registration-label",
	);
	let moved = 0;
	for (const language of Object.keys(translations)) {
		const units = recordAt(translations, language);
		if (units === undefined || units[from] === undefined) continue;
		const entries = writable(units);
		entries[to] = entries[from] as Json;
		delete entries[from];
		moved += 1;
	}
	return moved;
}

// ─── Step 2: capture-link-writes (part 01 §22, C4 and C5) ─────────────────

/**
 * Every capture field's stored write loses its `mode`; a write that saved
 * the file itself (`attachment`) is recorded and named in the notice.
 * Returns the attachment fields.
 */
function captureLinkWrites(
	doc: RawDocument,
	changes: PlannedChange[],
	notice: MigrationNoticeEntry[],
): ReadonlySet<Uuid> {
	const attachment = new Set<Uuid>();
	for (const { formUuid, form } of rawFormsInOrder(doc)) {
		for (const fieldUuid of rawFieldsInDataOrder(doc, formUuid)) {
			const field = doc.fields[fieldUuid] as JsonRecord;
			if (!RAW_CAPTURE_KINDS.has(stringAt(field, "kind") ?? "")) continue;
			const write = recordAt(field, "caseWrite");
			if (write === undefined || write.mode === undefined) continue;
			const mode = write.mode;
			delete writable(write).mode;
			const saved = mode === "attachment";
			changes.push(
				change(
					"capture-link-writes",
					saved ? "attachment-mode" : "link-mode",
					fieldUuid,
				),
			);
			if (!saved) continue;
			attachment.add(fieldUuid as Uuid);
			const property = stringAt(write, "property");
			notice.push(
				captureSavesLink(
					{
						uuid: fieldUuid as Uuid,
						name: stringAt(field, "id") ?? fieldUuid,
					},
					{
						form: stringAt(form, "name") ?? "",
						...(property !== undefined && { property }),
					},
				),
			);
		}
	}
	return attachment;
}

// ─── Step 3: close-condition-expression (part 01 §22, C6) ─────────────────

/**
 * The answer of a close condition: the `choice` of the field's inline
 * option whose value is `answer`, else the literal `answer`.
 */
function closeAnswer(
	field: JsonRecord | undefined,
	fieldUuid: string,
	answer: string,
): Choice | Literal {
	const source = recordAt(field, "optionsSource");
	if (stringAt(source, "kind") === "inline") {
		const option = recordsAt(source, "options").find(
			(candidate) => candidate.value === answer,
		);
		const optionUuid = stringAt(option, "uuid");
		if (optionUuid !== undefined)
			return {
				kind: "choice",
				field: fieldUuid as Uuid,
				options: [optionUuid as Uuid],
			};
	}
	return { kind: "literal", value: answer };
}

/** The comparison of one answer of the field with `answer`. */
function answerComparison(
	operator: "=" | "selected",
	answerOf: Expression,
	value: Choice | Literal,
): Expression {
	return operator === "selected"
		? {
				kind: "multi-select-contains",
				property: answerOf,
				values: [value],
				quantifier: "any",
			}
		: { kind: "eq", left: answerOf, right: { kind: "term", term: value } };
}

/**
 * Each form's structured close condition `{ field, answer, operator? }`
 * becomes the `Expression` the parser would build for the same close: the
 * field's answer compared with the answer, or, for a question in a repeat,
 * `count(<answer>[<comparison of .>]) > 0`, since such a question has an
 * answer per row and the close ran where any row's answer held. A stored
 * shape other than this one is left for the head parse to refuse.
 */
function closeConditionExpression(
	doc: RawDocument,
	changes: PlannedChange[],
): void {
	for (const { formUuid, form } of rawFormsInOrder(doc)) {
		const stored = recordAt(form, "closeCondition");
		if (stored === undefined || stored.kind !== undefined) continue;
		const fieldUuid = stringAt(stored, "field");
		const answer = stringAt(stored, "answer");
		const operator = stored.operator ?? "=";
		if (
			fieldUuid === undefined ||
			answer === undefined ||
			(operator !== "=" && operator !== "selected")
		)
			continue;
		const field = doc.fields[fieldUuid];
		const value = closeAnswer(field, fieldUuid, answer);
		const inRepeat =
			rawDataPaths(doc, formUuid).nearestRepeat.get(fieldUuid) !== undefined;
		const expression: Expression = inRepeat
			? {
					kind: "gt",
					left: {
						kind: "count",
						via: {
							kind: "term",
							term: {
								kind: "field",
								uuid: fieldUuid as Uuid,
								filters: [
									{
										step: { kind: "field", uuid: fieldUuid as Uuid },
										where: [
											answerComparison(
												operator,
												{
													kind: "term",
													term: {
														kind: "field",
														uuid: fieldUuid as Uuid,
														spelling: "relative",
													},
												},
												value,
											),
										],
									},
								],
							},
						},
					},
					right: { kind: "term", term: { kind: "literal", value: 0 } },
				}
			: answerComparison(
					operator,
					{ kind: "term", term: { kind: "field", uuid: fieldUuid as Uuid } },
					value,
				);
		writable(form).closeCondition = expression as unknown as Json;
		changes.push(
			change(
				"close-condition-expression",
				operator === "selected" ? "selected" : "equals",
				formUuid,
				{
					choice: value.kind === "choice" ? 1 : 0,
					repeat: inRepeat ? 1 : 0,
				},
			),
		);
	}
}

// ─── Step 4: field-writes-lifted ──────────────────────────────────────────

/**
 * Every field's stored `caseWrite` leaves the field. Each write `main` read
 * (both its case type and property non-empty) is lifted, per form in
 * data-tree order, `capture` set for the capture kinds. Every form has an
 * entry, empty where none of its fields wrote, since every case form gets
 * its own arm whether or not it writes.
 */
function fieldWritesLifted(
	doc: RawDocument,
	changes: PlannedChange[],
): ReadonlyMap<Uuid, readonly FieldWriteFact[]> {
	const lifted = new Map<Uuid, readonly FieldWriteFact[]>();
	for (const { formUuid } of rawFormsInOrder(doc)) {
		const facts: FieldWriteFact[] = [];
		for (const fieldUuid of rawFieldsInDataOrder(doc, formUuid)) {
			const write = rawFieldCaseWrite(doc.fields[fieldUuid]);
			if (write === undefined) continue;
			facts.push({
				fieldUuid: fieldUuid as Uuid,
				caseType: write.caseType,
				property: write.property,
				capture: RAW_CAPTURE_KINDS.has(
					stringAt(doc.fields[fieldUuid], "kind") ?? "",
				),
			});
		}
		lifted.set(formUuid as Uuid, facts);
		if (facts.length > 0)
			changes.push(
				change("field-writes-lifted", "field-writes", formUuid, {
					writes: facts.length,
					captures: facts.filter((fact) => fact.capture).length,
				}),
			);
	}
	// The key leaves every field, a field no form's tree reaches included.
	for (const field of Object.values(doc.fields))
		if (field.caseWrite !== undefined) delete writable(field).caseWrite;
	return lifted;
}

// ─── Step 5: search-first-lifted ──────────────────────────────────────────

/**
 * Every stored `caseSearchConfig.searchFirst` leaves the module; the modules
 * where it was `true` are lifted for the `search-workflow` step.
 */
function searchFirstLifted(
	doc: RawDocument,
	changes: PlannedChange[],
): ReadonlySet<Uuid> {
	const lifted = new Set<Uuid>();
	for (const moduleUuid of Object.keys(doc.modules)) {
		const search = recordAt(doc.modules[moduleUuid], "caseSearchConfig");
		if (search === undefined || search.searchFirst === undefined) continue;
		const on = search.searchFirst === true;
		delete writable(search).searchFirst;
		if (on) lifted.add(moduleUuid as Uuid);
		changes.push(
			change(
				"search-first-lifted",
				on ? "search-first" : "search-first-default",
				moduleUuid,
			),
		);
	}
	return lifted;
}

// ─── The head parse (section 7.3) ─────────────────────────────────────────

/**
 * One Zod issue as a finding code: its code, its path of entity ids and
 * keys, and, for a key the schema does not know, the key's name.
 */
function issueCode(issue: {
	readonly code: string;
	readonly path: readonly PropertyKey[];
	readonly keys?: readonly string[];
}): string {
	const path = issue.path.map((segment) => String(segment)).join(".");
	const keys =
		issue.code === "unrecognized_keys" && issue.keys !== undefined
			? `:${[...issue.keys].sort(compareText).join(",")}`
			: "";
	return `${issue.code}:${path}${keys}`;
}

/** The head parse of the structure phase's document. */
export type HeadParse =
	| {
			readonly ok: true;
			readonly persisted: PersistableDoc;
			readonly doc: BlueprintDoc;
	  }
	| { readonly ok: false; readonly blocker: CutoverBlocker };

/**
 * `blueprintDocSchema.parse`, then `hydratePersistedBlueprint`, over the
 * document the structure phase left. A refusal is the blocker
 * `structure-parse`, a key the phase should have removed or rewritten; it
 * carries each Zod issue's code and its path of entity ids and keys, never
 * a value or a message.
 */
export function parseHead(appId: string, persisted: RawDocument): HeadParse {
	const parsed = blueprintDocSchema.safeParse(
		rawDocumentAssembly(appId, persisted),
	);
	if (!parsed.success) {
		const issues = parsed.error.issues;
		return {
			ok: false,
			blocker: {
				code: "structure-parse",
				count: issues.length,
				findingCodes: [...new Set(issues.map(issueCode))].sort(compareText),
			},
		};
	}
	return {
		ok: true,
		persisted: parsed.data,
		doc: hydratePersistedBlueprint(parsed.data),
	};
}
