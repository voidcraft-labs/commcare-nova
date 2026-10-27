/**
 * The date-and-time split's planner (`lib/doc/datetimeSplit.ts`): the batch
 * it plans is admitted by the real commit gate, every slot it writes is one
 * the editor's text round-trips, the diff planner rebuilds its result (so
 * undo, the cutover's synthetic writer and the fuzz mapping replay it), ids
 * and identities never collide, and it refuses what it cannot split.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	DATETIME_SPLIT_REFUSAL_MESSAGES,
	planDatetimeSplit,
	planDatetimeSplits,
} from "@/lib/doc/datetimeSplit";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	parseFormExpressionForSlot,
	projectFormExpression,
} from "@/lib/doc/expressionText";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	collectTranslationUnits,
	type Field,
	makeTranslationUnitId,
	type TranslationEntry,
	type Uuid,
} from "@/lib/domain";
import { datetimeSplitFieldUuid } from "@/lib/domain/datetimeSplitIdentity";
import { clockKeepingJoin } from "@/lib/domain/expression/datePattern";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";
import {
	DATETIME_SPLIT_APP_ID,
	datetimeSplitNames,
	datetimeSplitOriginal,
} from "./datetimeSplitFixture";

const uuid = (name: string) => testUuid(`datetime-split:${name}`);
const names = datetimeSplitNames(uuid);

/** The batch, as the real gate admits it over `doc`: the committed document. */
function admitted(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	if (!verdict.ok) throw new Error("The split must be admitted.");
	return verdict.nextDoc;
}

/** One survey form holding `fields`, with an optional second language. */
function survey(fields: FieldSpec[]): BlueprintDoc {
	const doc = buildDoc({
		appId: "datetime-split-survey",
		modules: [
			{
				uuid: uuid("survey-module"),
				name: "Survey",
				forms: [
					{
						uuid: uuid("survey-form"),
						name: "Collect",
						type: "survey",
						fields,
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

const read = (target: Uuid): Expression => ({
	kind: "term",
	term: { kind: "field", uuid: target },
});

/** Every expression slot the split writes round-trips through the editor's
 * printer and parser to the same tree. */
function expectSlotsRoundTrip(doc: BlueprintDoc, fieldUuids: readonly Uuid[]) {
	const slots = [
		"calculate",
		"default_value",
		"validate",
		"relevant",
		"required",
	] as const;
	let checked = 0;
	for (const fieldUuid of fieldUuids) {
		const field = doc.fields[fieldUuid] as Record<string, unknown>;
		for (const slot of slots) {
			const expression = field[slot] as Expression | undefined;
			if (expression === undefined) continue;
			const ref: ExpressionSlotRef = { entity: "field", uuid: fieldUuid, slot };
			const projection = projectFormExpression(
				doc,
				ref,
				expression,
				"unavailable",
			);
			expect(projection.unresolved).toEqual([]);
			const parsed = parseFormExpressionForSlot(
				doc,
				ref,
				projection.text,
				"unavailable",
			);
			expect(parsed.ok, projection.text).toBe(true);
			if (parsed.ok) expect(parsed.expression).toEqual(expression);
			checked++;
		}
	}
	expect(checked).toBeGreaterThan(0);
}

/** The diff planner rebuilds the split from the original, through the gate. */
function expectDiffReplays(prev: BlueprintDoc, target: BlueprintDoc) {
	const replayed = admitted(prev, diffDocsToMutations(prev, target));
	expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(target));
}

describe("the split of the shared original", () => {
	const original = datetimeSplitOriginal();
	const plan = planDatetimeSplits(original);
	if (!plan.ok) throw new Error(plan.message);
	const after = admitted(original, plan.mutations);
	const [check, planned, due] = plan.splits;

	it("splits every date-and-time question in document order", () => {
		expect(plan.splits.map((split) => split.fieldUuid)).toEqual([
			names.seenAt,
			names.plannedAt,
			names.dueAt,
		]);
		expect(check).toMatchObject({
			formUuid: names.check,
			dateUuid: datetimeSplitFieldUuid(
				DATETIME_SPLIT_APP_ID,
				names.seenAt,
				"date",
			),
			timeUuid: datetimeSplitFieldUuid(
				DATETIME_SPLIT_APP_ID,
				names.seenAt,
				"time",
			),
			dateId: "seen_at_date",
			timeId: "seen_at_time",
			moved: { validate: true, defaultFrom: "preload" },
		});
		expect(planned?.moved).toEqual({ validate: false, defaultFrom: "default" });
		expect(due?.dateId).toBe("due_at_date");
	});

	it("keeps the original's identity, id, place, relevance and case write, as a Hidden Value calculated by the join", () => {
		if (check === undefined) throw new Error("No split of Check.");
		expect(after.fieldOrder[names.check]).toEqual([
			check.dateUuid,
			check.timeUuid,
			names.seenAt,
		]);
		expect(after.fields[names.seenAt]).toEqual({
			uuid: names.seenAt,
			id: "seen_at",
			kind: "hidden",
			caseWrite: { caseType: "visit", property: "seen_at" },
			calculate: clockKeepingJoin(read(check.dateUuid), read(check.timeUuid)),
		});
	});

	it("starts a preloaded writer's questions from the case, and moves its validation onto the time question", () => {
		if (check === undefined) throw new Error("No split of Check.");
		const caseValue: Expression = {
			kind: "term",
			term: { kind: "form-case", caseType: "visit", property: "seen_at" },
		};
		expect(after.fields[check.dateUuid]).toEqual({
			uuid: check.dateUuid,
			id: "seen_at_date",
			kind: "date",
			label: proseText("Seen at"),
			default_value: { kind: "date-coerce", value: caseValue },
		});
		const time = after.fields[check.timeUuid] as Field & {
			validate?: Expression;
			default_value?: Expression;
		};
		expect(time.default_value).toEqual({
			kind: "format-date",
			pattern: "%H:%M:%S.%3",
			date: {
				kind: "coalesce",
				values: [
					caseValue,
					{ kind: "term", term: { kind: "literal", value: "" } },
				],
			},
		});
		expect(
			projectFormExpression(
				after,
				{ entity: "field", uuid: check.timeUuid, slot: "validate" },
				time.validate as Expression,
				"unavailable",
			).text,
		).toBe(
			"if(#form/seen_at_date = '', true(), date(format-date(concat(#form/seen_at_date, 'T', .), '%Y-%m-%dT%H:%M:%S.%3%Z')) <= now())",
		);
		expect(
			(after.fields[check.timeUuid] as { validate_msg?: unknown }).validate_msg,
		).toEqual(proseText("Seen at can't be later than now"));
	});

	it("leaves every reader of a split question as it was", () => {
		expect(after.fields[names.note]).toEqual(original.fields[names.note]);
	});

	it("writes only slots the editor's text round-trips", () => {
		expectSlotsRoundTrip(
			after,
			plan.splits.flatMap((split) => [
				split.dateUuid,
				split.timeUuid,
				split.fieldUuid,
			]),
		);
	});

	it("is rebuilt from the original by the diff planner", () => {
		expectDiffReplays(original, after);
	});
});

describe("the split of other shapes", () => {
	it("gives a non-writer's starting value and media to both questions", () => {
		const when = uuid("media-when");
		const original = survey([
			f({
				kind: "datetime",
				uuid: when,
				id: "when",
				label: proseText("When"),
				label_media: { image: testMediaAssetId("split-when-image") },
				hint: proseText("The local time"),
				required: "true()",
				default_value: "now()",
			}),
		]);
		const plan = planDatetimeSplit(original, when);
		if (!plan.ok) throw new Error(plan.message);
		const after = admitted(original, plan.mutations);
		for (const [target, kind] of [
			[plan.dateUuid, "date"],
			[plan.timeUuid, "time"],
		] as const) {
			expect(after.fields[target]).toMatchObject({
				kind,
				label: proseText("When"),
				label_media: { image: testMediaAssetId("split-when-image") },
				hint: proseText("The local time"),
				required: { kind: "match-all" },
			});
		}
		expect(
			(after.fields[plan.dateUuid] as { default_value?: unknown })
				.default_value,
		).toEqual({ kind: "date-coerce", value: { kind: "now" } });
		// A Hidden Value holds one value source, so the default leaves it.
		expect(after.fields[when]).toEqual({
			uuid: when,
			id: "when",
			kind: "hidden",
			calculate: clockKeepingJoin(read(plan.dateUuid), read(plan.timeUuid)),
		});
		expect(plan.moved).toEqual({ validate: false, defaultFrom: "default" });
		expectSlotsRoundTrip(after, [plan.dateUuid, plan.timeUuid, when]);
		expectDiffReplays(original, after);
	});

	it("copies each language's label and hint to both questions and moves the validation message to the time question", () => {
		const at = uuid("languages-at");
		const original = survey([
			f({
				kind: "datetime",
				uuid: at,
				id: "at",
				label: proseText("Arrived"),
				hint: proseText("Local time"),
				validate: ". <= now()",
				validate_msg: proseText("Can't be later than now"),
			}),
		]);
		const units = new Map(
			collectTranslationUnits(original).map((unit) => [unit.id, unit]),
		);
		const entry = (slot: string, value: string): TranslationEntry => {
			const unit = units.get(makeTranslationUnitId("field", at, slot));
			if (unit === undefined) throw new Error(`No ${slot} unit.`);
			return {
				value: proseText(value),
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			};
		};
		original.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: {
				spa: {
					[makeTranslationUnitId("field", at, "label")]: entry(
						"label",
						"Llegó",
					),
					[makeTranslationUnitId("field", at, "hint")]: entry(
						"hint",
						"Hora local",
					),
					[makeTranslationUnitId("field", at, "validate_msg")]: entry(
						"validate_msg",
						"No puede ser después de ahora",
					),
				},
			},
		};
		assertAdmittedDoc(original);
		const plan = planDatetimeSplit(original, at);
		if (!plan.ok) throw new Error(plan.message);
		const after = admitted(original, plan.mutations);
		const spanish = after.localization?.translations.spa ?? {};
		const translated = (field: Uuid, slot: string) =>
			spanish[makeTranslationUnitId("field", field, slot)]?.value;
		for (const target of [plan.dateUuid, plan.timeUuid]) {
			expect(translated(target, "label")).toEqual(proseText("Llegó"));
			expect(translated(target, "hint")).toEqual(proseText("Hora local"));
		}
		expect(translated(plan.timeUuid, "validate_msg")).toEqual(
			proseText("No puede ser después de ahora"),
		);
		expect(translated(plan.dateUuid, "validate_msg")).toBeUndefined();
		// The Hidden Value owns no such unit, so its entries are pruned.
		for (const slot of ["label", "hint", "validate_msg"])
			expect(translated(at, slot)).toBeUndefined();
		expect(plan.moved.validate).toBe(true);
		expectDiffReplays(original, after);
	});

	it.each(["repeat", "group"] as const)(
		"splits a question inside a %s beside its siblings",
		(container) => {
			const inside = uuid(`${container}-inside`);
			const original = survey([
				f({
					kind: container,
					uuid: uuid(`${container}-container`),
					id: "visits",
					label: proseText("Visits"),
					children: [
						f({ kind: "text", id: "first", label: proseText("First") }),
						f({
							kind: "datetime",
							uuid: inside,
							id: "visit",
							label: proseText("Visit"),
							relevant: "#form/visits/first != ''",
						}),
					],
				}),
			]);
			const plan = planDatetimeSplit(original, inside);
			if (!plan.ok) throw new Error(plan.message);
			const after = admitted(original, plan.mutations);
			expect(
				after.fieldOrder[uuid(`${container}-container`)]?.slice(1),
			).toEqual([plan.dateUuid, plan.timeUuid, inside]);
			expectSlotsRoundTrip(after, [plan.dateUuid, plan.timeUuid, inside]);
			expectDiffReplays(original, after);
		},
	);

	it("splits a question inside a form's section", () => {
		const inside = uuid("section-inside");
		const original = survey([
			f({
				kind: "section",
				uuid: uuid("section"),
				id: "part",
				label: proseText("Part one"),
				children: [
					f({
						kind: "datetime",
						uuid: inside,
						id: "visit",
						label: proseText("Visit"),
					}),
				],
			}),
		]);
		const plan = planDatetimeSplit(original, inside);
		if (!plan.ok) throw new Error(plan.message);
		const after = admitted(original, plan.mutations);
		expect(after.fieldOrder[uuid("section")]).toEqual([
			plan.dateUuid,
			plan.timeUuid,
			inside,
		]);
		expectDiffReplays(original, after);
	});

	it("names the new questions so they meet no sibling or Connect block", () => {
		const visit = uuid("sibling-visit");
		const original = survey([
			f({ kind: "text", id: "visit_date", label: proseText("Booked") }),
			f({
				kind: "datetime",
				uuid: visit,
				id: "visit",
				label: proseText("Visit"),
			}),
		]);
		const plan = planDatetimeSplit(original, visit);
		if (!plan.ok) throw new Error(plan.message);
		expect([plan.dateId, plan.timeId]).toEqual(["visit_date_2", "visit_time"]);
		admitted(original, plan.mutations);
	});

	it("allocates the splits of two questions in one form in order", () => {
		const original = survey([
			f({ kind: "datetime", uuid: uuid("two-a"), id: "a", label: "A" }),
			f({ kind: "text", id: "a_time", label: "Taken" }),
			f({ kind: "datetime", uuid: uuid("two-b"), id: "b", label: "B" }),
		]);
		const plan = planDatetimeSplits(original);
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.splits.map((split) => [split.dateId, split.timeId])).toEqual([
			["a_date", "a_time_2"],
			["b_date", "b_time"],
		]);
		const after = admitted(original, plan.mutations);
		expect(
			after.fieldOrder[uuid("survey-form")]?.map(
				(field) => after.fields[field]?.id,
			),
		).toEqual(["a_date", "a_time_2", "a", "a_time", "b_date", "b_time", "b"]);
		expectDiffReplays(original, after);
	});

	it("takes the next attempt's identities when the first are taken", () => {
		const visit = uuid("attempt-visit");
		const original = survey([
			f({
				kind: "datetime",
				uuid: visit,
				id: "visit",
				label: proseText("Visit"),
			}),
			f({
				kind: "date",
				uuid: datetimeSplitFieldUuid("datetime-split-survey", visit, "date"),
				id: "kept",
				label: proseText("A question a hand join kept"),
			}),
		]);
		const plan = planDatetimeSplit(original, visit);
		if (!plan.ok) throw new Error(plan.message);
		expect([plan.dateUuid, plan.timeUuid]).toEqual([
			datetimeSplitFieldUuid("datetime-split-survey", visit, "date", 1),
			datetimeSplitFieldUuid("datetime-split-survey", visit, "time", 1),
		]);
		admitted(original, plan.mutations);
	});
});

describe("what the planner refuses", () => {
	it("refuses anything but a date-and-time question", () => {
		const original = datetimeSplitOriginal();
		for (const target of [names.note, uuid("no-such-field")]) {
			expect(planDatetimeSplit(original, target)).toEqual({
				ok: false,
				reason: "not-a-date-and-time-question",
				message:
					"Nova can split only a date-and-time question, and this question asks for something else.",
			});
		}
	});

	it("refuses a question whose own rule reads it through a filter, and stops the whole plan there", () => {
		const original = datetimeSplitOriginal();
		const filtered = produce(original, (draft) => {
			const field = draft.fields[names.plannedAt] as Record<string, unknown>;
			// `#form/planned_at[. != '']` written as stored: a read of the
			// question itself through a step filter, whose `.` is no candidate.
			field.validate = {
				kind: "neq",
				left: {
					kind: "term",
					term: {
						kind: "field",
						uuid: names.plannedAt,
						spelling: "relative",
						filters: [
							{
								step: { kind: "field", uuid: names.plannedAt },
								where: [
									{
										kind: "neq",
										left: {
											kind: "term",
											term: {
												kind: "field",
												uuid: names.plannedAt,
												spelling: "relative",
											},
										},
										right: {
											kind: "term",
											term: { kind: "literal", value: "" },
										},
									},
								],
							},
						],
					},
				},
				right: { kind: "term", term: { kind: "literal", value: "" } },
			};
		});
		const message =
			"This question's own rule reads it through a filtered repeat, which Nova can't move onto the time question. You can simplify that rule and try again.";
		expect(DATETIME_SPLIT_REFUSAL_MESSAGES["self-read-through-a-filter"]).toBe(
			message,
		);
		expect(planDatetimeSplit(filtered, names.plannedAt)).toEqual({
			ok: false,
			reason: "self-read-through-a-filter",
			message,
		});
		expect(planDatetimeSplits(filtered)).toEqual({
			ok: false,
			fieldUuid: names.plannedAt,
			reason: "self-read-through-a-filter",
			message,
		});
	});
});
