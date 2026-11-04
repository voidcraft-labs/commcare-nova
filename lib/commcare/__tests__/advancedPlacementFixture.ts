/**
 * A household app shaped for advanced placement: households, members chosen
 * under their household, and visits, each a menu of its own. The form under
 * test stands in the Households menu (the root of a parent selection), the
 * Members menu (chosen under a household) or the Visits menu (a child case
 * chosen on its own), with a question of every kind a
 * clause reads and two repeats. Its menu's kind is held advanced unless a
 * test asks otherwise, so the form is planned as an advanced form whatever
 * its links carry. Each test builds a fresh document, so the per-document
 * memoization of the planners never sees a document change.
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	type Form,
	proseText,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { OPT, U } from "./placementFixture";

export { OP, OPT, read, U } from "./placementFixture";

export const HOUSEHOLDS = testUuid("adv-households");
export const MEMBERS = testUuid("adv-members");
export const VISITS = testUuid("adv-visits");
export const UNDER_TEST = testUuid("adv-under-test");
export const HOUSEHOLD_VISIT = testUuid("adv-household-visit");
export const VISIT_REVIEW = testUuid("adv-visit-review");

export interface AdvancedFixtureOptions {
	readonly formType: Form["type"];
	/** The menu holding the form under test. */
	readonly menu?: "households" | "members" | "visits";
	readonly operations?: () => CaseOperation[];
	readonly form?: Partial<
		Pick<
			Form,
			"openCondition" | "closeCondition" | "ownClosePlacement" | "formLinks"
		>
	>;
	/** Holds the form's menu advanced (default `true`). */
	readonly heldKind?: boolean;
	/** Makes Members a menu inside Households, aligned with its root menu. */
	readonly nested?: boolean;
	readonly configure?: (doc: BlueprintDoc) => void;
}

export interface AdvancedFixture {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly moduleUuid: Uuid;
}

function inline(values: readonly string[]) {
	return {
		kind: "inline" as const,
		options: values.map((value) => ({
			value,
			label: proseText(value),
			uuid: OPT(value),
		})),
	};
}

export function advancedFixture(
	options: AdvancedFixtureOptions,
): AdvancedFixture {
	const menu = options.menu ?? "households";
	const field = (spec: Parameters<typeof f>[0]) =>
		f({ ...spec, uuid: `fld-${spec.id}` });
	const underTest = {
		uuid: "adv-under-test",
		name: "Under test",
		type: options.formType,
		fields: [
			field({ kind: "text", id: "name" }),
			field({ kind: "int", id: "age" }),
			field({
				kind: "single_select",
				id: "status",
				optionsSource: inline(["yes", "no"]),
			}),
			field({ kind: "label", id: "note" }),
			field({ kind: "text", id: "owner_q" }),
			field({
				kind: "repeat",
				id: "kids",
				repeat_mode: "user_controlled",
				children: [
					field({ kind: "text", id: "kid_name" }),
					field({ kind: "int", id: "kid_age" }),
				],
			}),
			field({
				kind: "repeat",
				id: "pets",
				repeat_mode: "user_controlled",
				children: [field({ kind: "text", id: "pet_name" })],
			}),
		],
	};
	const columns = () =>
		caseListConfig([{ field: "case_name", header: "Name" }]);
	/** A follow-up of its menu's case with one question, so the app's other
	 *  forms are ones Nova admits. */
	const other = (name: string, uuid?: string) => ({
		...(uuid !== undefined && { uuid }),
		name,
		type: "followup" as const,
		fields: [f({ kind: "text", id: "remark" })],
	});
	const doc = buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "remark", label: "Remark" },
				],
			},
			{
				name: "member",
				parent_type: "household",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "age", label: "Age" },
				],
			},
			{
				name: "visit",
				parent_type: "household",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "remark", label: "Remark" },
				],
			},
			// A case type no menu lists, which a create may still make.
			{ name: "pet", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				uuid: "adv-households",
				name: "Households",
				caseType: "household",
				caseListConfig: columns(),
				forms: [
					other("Visit", "adv-household-visit"),
					...(menu === "households" ? [underTest] : []),
				],
			},
			{
				uuid: "adv-members",
				name: "Members",
				caseType: "member",
				parentCaseModuleUuid: "adv-households",
				caseListConfig: columns(),
				forms: [menu === "members" ? underTest : other("Check in")],
			},
			{
				uuid: "adv-visits",
				name: "Visits",
				caseType: "visit",
				caseListConfig: columns(),
				forms: [
					other("Review", "adv-visit-review"),
					...(menu === "visits" ? [underTest] : []),
				],
			},
		],
	});
	const moduleUuid =
		menu === "households" ? HOUSEHOLDS : menu === "members" ? MEMBERS : VISITS;
	if (options.heldKind !== false)
		doc.modules[moduleUuid] = {
			...doc.modules[moduleUuid],
			heldKind: "advanced",
		};
	if (options.nested === true)
		doc.modules[MEMBERS] = {
			...doc.modules[MEMBERS],
			parentModuleUuid: HOUSEHOLDS,
		};
	doc.forms[UNDER_TEST] = {
		...doc.forms[UNDER_TEST],
		...(options.form ?? {}),
		caseOperations: options.operations?.() ?? [],
	};
	options.configure?.(doc);
	return { doc, formUuid: UNDER_TEST, moduleUuid };
}

/** The selected case of `module`, read as a session datum. */
export function chosen(module: Uuid): Expression {
	return {
		kind: "term",
		term: { kind: "session-datum", datum: { kind: "selected-case", module } },
	} as Expression;
}

/** One of a select's own choices. */
export function choice(fieldId: string, ...values: string[]): Expression {
	return {
		kind: "term",
		term: { kind: "choice", field: U(fieldId), options: values.map(OPT) },
	} as Expression;
}
