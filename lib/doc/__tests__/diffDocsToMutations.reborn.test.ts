/**
 * A field whose kind changes to one no conversion makes, which the diff
 * writes as its removal by name and its re-add under the same uuid, where
 * something else names that uuid: the case operation that saves its answer,
 * another question's logic, or a choice it owned. Each draw runs the
 * production boundary whole: the diff, sent as JSON and parsed again, judged
 * by the commit verdict (identity admission, the reducer and the gate), with
 * the reference index the replay maintains held to a rebuild.
 *
 * It would catch: a re-add that drops a case write keyed by the field, so a
 * question stops saving to its case property with no line saying so; a read
 * of the field left naming nothing, or rewritten to another field; a choice
 * the re-add leaves out still read by uuid in the committed document; the
 * reference index going stale across the removal and the re-add.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	expressionSlotValues,
	type Uuid,
} from "@/lib/domain";
import {
	eq,
	formField,
	gt,
	isBlank,
	literal,
	not,
	term,
} from "@/lib/domain/expression/builders";
import type { Choice } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("reborn-bound-module");
const FORM = testUuid("reborn-bound-form");
const NAME = testUuid("reborn-bound-name");
const AGE = testUuid("reborn-bound-age");
const NOTE = testUuid("reborn-bound-note");
const SUMMARY = testUuid("reborn-bound-summary");
const STATUS = testUuid("reborn-bound-status");
const ACTIVE = testUuid("reborn-bound-active");
const CLOSED = testUuid("reborn-bound-closed");
const REASON = testUuid("reborn-bound-reason");

/** A document through the strict stored schema, derived state rebuilt. */
function stored(doc: BlueprintDoc): BlueprintDoc {
	return hydratePersistedBlueprint(
		blueprintDocSchema.parse(toPersistableDoc(doc)),
	);
}

/** The diff as it crosses a wire: JSON, then each mutation parsed again. */
function wireDiff(prev: BlueprintDoc, next: BlueprintDoc): Mutation[] {
	const wire: unknown = JSON.parse(
		JSON.stringify(diffDocsToMutations(prev, next)),
	);
	if (!Array.isArray(wire)) throw new Error("A diff is an array.");
	return wire.map((mutation) => mutationSchema.parse(mutation));
}

/** The reference index the replay of `diff` maintains, and a rebuild of it. */
function indexes(prev: BlueprintDoc, diff: readonly Mutation[]) {
	const replayed = produce(stored(prev), (draft) => {
		applyMutations(draft, admitMutationBatch(diff));
	});
	return {
		kept: replayed.refIndex,
		rebuilt: buildReferenceIndex(replayed),
	};
}

/** The diff of two admitted documents commits to the second exactly, reads intact. */
function assertRebornCommits(prevRaw: BlueprintDoc, nextRaw: BlueprintDoc) {
	const prev = stored(prevRaw);
	const next = stored(nextRaw);
	assertAdmittedDoc(prev);
	assertAdmittedDoc(next);
	const diff = wireDiff(prev, next);
	expect(diff.some((m) => m.kind === "convertField")).toBe(false);
	const verdict = mutationCommitVerdict(prev, diff, LOOKUP_CONTEXT_UNAVAILABLE);
	expect(verdict.ok, JSON.stringify(verdict.ok ? [] : verdict.findings)).toBe(
		true,
	);
	if (!verdict.ok) return diff;
	expect(toPersistableDoc(verdict.nextDoc)).toEqual(toPersistableDoc(next));
	const { kept, rebuilt } = indexes(prev, diff);
	expect(kept).toEqual(rebuilt);
	return diff;
}

/** Every field and choice uuid any expression slot of `doc` reads. */
function readUuids(doc: BlueprintDoc): Set<string> {
	const read = new Set<string>();
	for (const [entity, owners] of [
		["field", doc.fields],
		["form", doc.forms],
		["module", doc.modules],
	] as const) {
		for (const owner of Object.values(owners)) {
			for (const { expression } of expressionSlotValues(doc, {
				entity,
				uuid: owner.uuid,
			})) {
				walkExpression(expression, {
					visitTerm: (found) => {
						if (found.kind === "field") read.add(found.uuid);
						if (found.kind === "choice") {
							read.add(found.field);
							for (const option of found.options) read.add(option);
						}
					},
				});
			}
		}
	}
	return read;
}

/** Every inline choice the document's questions hold. */
function inlineChoiceUuids(doc: BlueprintDoc): Set<string> {
	const held = new Set<string>();
	for (const field of Object.values(doc.fields)) {
		const source = (field as { optionsSource?: unknown }).optionsSource as
			| { kind: string; options?: readonly { uuid: string }[] }
			| undefined;
		if (source?.kind !== "inline") continue;
		for (const option of source.options ?? []) held.add(option.uuid);
	}
	return held;
}

/**
 * A registration for patients: a name and an age saved to the case, a note
 * whose logic reads the age, a Hidden Value calculated from it, and a status
 * choice another question reads by its choice.
 */
function registration(options: {
	readonly ageKind: "text" | "int";
	readonly statusKind: "single_select" | "int";
	readonly readsActive: boolean;
}): BlueprintDoc {
	const active: Choice = { kind: "choice", field: STATUS, options: [ACTIVE] };
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "age", label: "Age" }],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Register",
						type: "registration",
						fields: [
							{
								uuid: NAME,
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							},
							{
								uuid: AGE,
								kind: options.ageKind,
								id: "age",
								caseWrite: { caseType: "patient", property: "age" },
							},
							{
								uuid: NOTE,
								kind: "text",
								id: "note",
								relevant: not(isBlank(formField(AGE))),
								...(options.ageKind === "int"
									? { validate: gt(formField(AGE), literal(0)) }
									: {}),
							},
							{
								uuid: SUMMARY,
								kind: "hidden",
								id: "summary",
								calculate: term(formField(AGE)),
							},
							options.statusKind === "single_select"
								? {
										uuid: STATUS,
										kind: "single_select",
										id: "status",
										options: [
											{ uuid: ACTIVE, value: "active", label: "Active" },
											{ uuid: CLOSED, value: "closed", label: "Closed" },
										],
									}
								: { uuid: STATUS, kind: "int", id: "status" },
							{
								uuid: REASON,
								kind: "text",
								id: "reason",
								...(options.readsActive
									? { relevant: eq(active, literal("active")) }
									: {}),
							},
						],
					},
				],
			},
		],
	});
}

/** The case operations of the registration form, as stored. */
function caseOperationsOf(doc: BlueprintDoc) {
	return JSON.parse(JSON.stringify(doc.forms[FORM]?.caseOperations ?? null));
}

/** Every operation write that names `uuid` as its answer. */
function writesNaming(doc: BlueprintDoc, uuid: Uuid): number {
	return JSON.stringify(caseOperationsOf(doc)).split(uuid).length - 1;
}

describe("a field reborn under its own uuid", () => {
	it("keeps the case write that saves a question to its case property, both ways", () => {
		const text = registration({
			ageKind: "text",
			statusKind: "single_select",
			readsActive: false,
		});
		const number = registration({
			ageKind: "int",
			statusKind: "single_select",
			readsActive: false,
		});
		expect(writesNaming(text, AGE)).toBeGreaterThan(0);
		for (const [prev, next] of [
			[text, number],
			[number, text],
		] as const) {
			const diff = assertRebornCommits(prev, next);
			expect(diff.filter((m) => m.kind === "removeField")).toEqual([
				{ kind: "removeField", uuid: AGE },
			]);
			expect(
				diff.flatMap((m) => (m.kind === "addField" ? [m.field.uuid] : [])),
			).toEqual([AGE]);
			const verdict = mutationCommitVerdict(
				stored(prev),
				diff,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			if (!verdict.ok) throw new Error("The diff commits.");
			expect(caseOperationsOf(verdict.nextDoc)).toEqual(caseOperationsOf(next));
			expect(writesNaming(verdict.nextDoc, AGE)).toBe(writesNaming(next, AGE));
		}
	});

	it("keeps every read of it in another question's logic and a Hidden Value's calculation, naming it", () => {
		const text = registration({
			ageKind: "text",
			statusKind: "single_select",
			readsActive: true,
		});
		const number = registration({
			ageKind: "int",
			statusKind: "single_select",
			readsActive: true,
		});
		for (const [prev, next] of [
			[text, number],
			[number, text],
		] as const) {
			assertRebornCommits(prev, next);
			const verdict = mutationCommitVerdict(
				stored(prev),
				wireDiff(stored(prev), stored(next)),
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			if (!verdict.ok) throw new Error("The diff commits.");
			const committed = verdict.nextDoc;
			expect(committed.fields[NOTE]).toEqual(next.fields[NOTE]);
			expect(committed.fields[SUMMARY]).toEqual(next.fields[SUMMARY]);
			const read = readUuids(committed);
			expect(read.has(AGE)).toBe(true);
			for (const uuid of read) {
				expect(
					committed.fields[uuid as Uuid] !== undefined ||
						inlineChoiceUuids(committed).has(uuid),
					`${uuid} names something the document holds`,
				).toBe(true);
			}
		}
	});

	it("refuses a re-add that drops a choice another question still reads, and commits it once nothing reads the choice", () => {
		const select = registration({
			ageKind: "text",
			statusKind: "single_select",
			readsActive: true,
		});
		/* The target as a careless writer would make it: the status is a
		 * number now, which no conversion makes from a choice question, and
		 * the reason's logic still reads its Active choice. */
		const dangling = produce(
			registration({
				ageKind: "text",
				statusKind: "int",
				readsActive: false,
			}),
			(draft) => {
				(draft.fields[REASON] as { relevant?: unknown }).relevant = eq(
					{ kind: "choice", field: STATUS, options: [ACTIVE] },
					literal("active"),
				);
			},
		);
		const prev = stored(select);
		const diff = diffDocsToMutations(prev, dangling);
		expect(diff.filter((m) => m.kind === "removeField")).toEqual([
			{ kind: "removeField", uuid: STATUS },
		]);
		const refused = mutationCommitVerdict(
			prev,
			diff,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(refused.ok).toBe(false);
		/* Refused for the read of the choice the re-add left out, and for
		 * nothing else. */
		if (refused.ok) throw new Error("The dangling read is refused.");
		expect(refused.findings.map((finding) => JSON.stringify(finding))).toEqual([
			expect.stringContaining(REASON),
		]);

		/* The target that no longer reads the choice commits, and no read of
		 * either choice is left. */
		const text = registration({
			ageKind: "text",
			statusKind: "int",
			readsActive: false,
		});
		assertRebornCommits(select, text);
		const verdict = mutationCommitVerdict(
			prev,
			wireDiff(prev, stored(text)),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error("The diff commits.");
		const read = readUuids(verdict.nextDoc);
		expect(read.has(ACTIVE)).toBe(false);
		expect(read.has(CLOSED)).toBe(false);
		expect(JSON.stringify(toPersistableDoc(verdict.nextDoc))).not.toContain(
			ACTIVE,
		);
	});
});
