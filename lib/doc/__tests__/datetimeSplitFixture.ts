/**
 * The date-and-time split's shared original: the document before the split,
 * read by the planner's tests (`datetimeSplit.test.ts`), the targeted
 * document `targeted-datetime-split` (`proof/targeted/documents/datetimeSplit.ts`)
 * and the native `expression` family's `DatetimeSplitRuntimeTest`
 * (`proof/native/producers/emit-expression-evidence.ts`), so all three hold
 * the same questions to the same split.
 *
 * Module "Visits" on `visit` registers a visit in "Book" and checks it in
 * "Check", whose date-and-time question `seen_at` writes `visit.seen_at`,
 * starts from the case's value, and may not be later than now. Module
 * "Planning" holds the survey "Plan": two date-and-time questions that write
 * nothing, and a text question whose label, relevance and validation read
 * them, the relevance comparing one with the other, and a Hidden Value that
 * makes the same comparison.
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	proseText,
	type Uuid,
} from "@/lib/domain";

export interface DatetimeSplitOriginalOptions {
	/** The identity named `name`; the targeted document names its own. */
	readonly uuid?: (name: string) => Uuid;
	readonly appId?: string;
}

/** The identities `datetimeSplitOriginal` names, by role. */
export function datetimeSplitNames(uuid: (name: string) => Uuid) {
	return {
		visitsModule: uuid("visits-module"),
		book: uuid("book"),
		check: uuid("check"),
		seenAt: uuid("check-seen-at"),
		planningModule: uuid("planning-module"),
		plan: uuid("plan"),
		plannedAt: uuid("plan-planned-at"),
		dueAt: uuid("plan-due-at"),
		note: uuid("plan-note"),
		order: uuid("plan-order"),
	};
}

export const DATETIME_SPLIT_APP_ID = "datetime-split";

export function datetimeSplitOriginal(
	options: DatetimeSplitOriginalOptions = {},
): BlueprintDoc {
	const uuid = options.uuid ?? ((name) => testUuid(`datetime-split:${name}`));
	const names = datetimeSplitNames(uuid);
	return buildDoc({
		appId: options.appId ?? DATETIME_SPLIT_APP_ID,
		appName: "Visit times",
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{
						name: "seen_at",
						label: proseText("Seen at"),
						data_type: "datetime",
					},
				],
			},
		],
		modules: [
			{
				uuid: names.visitsModule,
				name: "Visits",
				caseType: "visit",
				caseListConfig: {
					columns: [plainColumn(uuid("name-column"), "case_name", "Name")],
					searchInputs: [],
				},
				forms: [
					{
						uuid: names.book,
						name: "Book",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("book-name"),
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "visit", property: "case_name" },
							}),
						],
					},
					{
						uuid: names.check,
						name: "Check",
						type: "followup",
						fields: [
							f({
								kind: "datetime",
								uuid: names.seenAt,
								id: "seen_at",
								label: proseText("Seen at"),
								caseWrite: { caseType: "visit", property: "seen_at" },
								default_value: "#visit/seen_at",
								validate: ". <= now()",
								validate_msg: proseText("Seen at can't be later than now"),
							}),
						],
					},
				],
			},
			{
				uuid: names.planningModule,
				name: "Planning",
				forms: [
					{
						uuid: names.plan,
						name: "Plan",
						type: "survey",
						fields: [
							f({
								kind: "datetime",
								uuid: names.plannedAt,
								id: "planned_at",
								label: proseText("Planned for"),
								default_value: "now()",
							}),
							f({
								kind: "datetime",
								uuid: names.dueAt,
								id: "due_at",
								label: proseText("Due by"),
								default_value: "now()",
							}),
							f({
								kind: "text",
								uuid: names.note,
								id: "note",
								label: {
									parts: [
										{ kind: "text", text: "Note for " },
										{ kind: "field-ref", uuid: names.plannedAt },
									],
								},
								relevant: "#form/due_at >= #form/planned_at",
								validate: "#form/planned_at <= now()",
								validate_msg: proseText("A plan is for a time up to now"),
							}),
							// The note's comparison as a value Core's evaluate can read
							// (`targeted-datetime-split`'s `split-joins-compare-*`).
							f({
								kind: "hidden",
								uuid: names.order,
								id: "order",
								calculate:
									"if(#form/due_at >= #form/planned_at, 'due later', 'due earlier')",
							}),
						],
					},
				],
			},
		],
	});
}
