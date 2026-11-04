/**
 * One patient app shaped for placement: a form of a chosen type in the
 * Patients menu, with a question of every kind a placement rule reads, two
 * repeats, and the case types the subcase rules name: `kid` and `visit`
 * have menus of their own, `household` has none. Each test writes the
 * form's case operations and conditions onto a fresh document, so the
 * per-document memoization of the planners never sees a document change.
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationLink,
	type Form,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";

export const U = (id: string): Uuid => testUuid(`fld-${id}`);
export const OPT = (value: string): Uuid => testUuid(`opt-${value}`);
export const OP = (key: string): Uuid => testUuid(`op-${key}`);
export const OWN = OP("own");

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

export interface PlacementFixture {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly moduleUuid: Uuid;
}

export interface FixtureOptions {
	readonly operations?: (formType: Form["type"]) => CaseOperation[];
	readonly form?: Partial<
		Pick<Form, "openCondition" | "closeCondition" | "ownClosePlacement">
	>;
	readonly severalCases?: boolean;
	/** Extra root questions, written before the fixture's own. */
	readonly extraRoot?: Parameters<typeof f>[0][];
}

export function placementFixture(
	formType: Form["type"],
	options: FixtureOptions = {},
): PlacementFixture {
	const field = (spec: Parameters<typeof f>[0]) =>
		f({ ...spec, uuid: `fld-${spec.id}` });
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "age", label: "Age" },
					{ name: "status", label: "Status" },
					{ name: "photo_url", label: "Photo" },
				],
			},
			{
				name: "kid",
				parent_type: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "age", label: "Age" },
				],
			},
			{
				name: "visit",
				parent_type: "household",
				properties: [{ name: "case_name", label: "Name" }],
			},
			{
				name: "household",
				properties: [{ name: "case_name", label: "Name" }],
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
						uuid: "form-under-test",
						name: "Under test",
						type: formType,
						fields: [
							...(options.extraRoot ?? []).map(field),
							field({ kind: "text", id: "name" }),
							field({ kind: "int", id: "age" }),
							field({
								kind: "single_select",
								id: "status",
								optionsSource: inline(["yes", "no", "it's", '"q"']),
							}),
							field({
								kind: "multi_select",
								id: "tags",
								optionsSource: inline(["red", "blue"]),
							}),
							field({ kind: "hidden", id: "flag" }),
							field({ kind: "label", id: "note" }),
							field({ kind: "image", id: "photo" }),
							field({
								kind: "group",
								id: "grp",
								children: [field({ kind: "text", id: "inner" })],
							}),
							field({
								kind: "repeat",
								id: "kids",
								repeat_mode: "user_controlled",
								children: [
									field({ kind: "text", id: "kid_name" }),
									field({ kind: "int", id: "kid_age" }),
									field({ kind: "hidden", id: "kid_flag" }),
								],
							}),
							field({
								kind: "repeat",
								id: "pets",
								repeat_mode: "user_controlled",
								children: [field({ kind: "text", id: "pet_name" })],
							}),
						],
					},
				],
			},
			{
				name: "Kids",
				caseType: "kid",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [{ name: "Kid survey", type: "survey" }],
			},
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [{ name: "Visit survey", type: "survey" }],
			},
		],
	});
	const formUuid = testUuid("form-under-test");
	const moduleUuid = doc.moduleOrder[0];
	if (options.severalCases) {
		const mod = doc.modules[moduleUuid];
		const config = mod.caseListConfig;
		if (config === undefined) throw new Error("The fixture lists cases.");
		doc.modules[moduleUuid] = {
			...mod,
			caseListConfig: {
				...config,
				selection: { kind: "multiple", maximum: 10 },
			},
		};
	}
	doc.forms[formUuid] = {
		...doc.forms[formUuid],
		...(options.form ?? {}),
		caseOperations: options.operations?.(formType) ?? [],
	};
	return { doc, formUuid, moduleUuid };
}

/** A bare read of the question `id`. */
export function read(id: string): Expression {
	return term(formField(U(id)));
}

/** The own arm, first in the form. */
export function own(extra: Partial<CaseOperation> = {}): CaseOperation {
	return { uuid: OWN, id: "patient", action: "own", ...extra } as CaseOperation;
}

/** The link HQ's basic subcase writes: `parent`, a child of the own case. */
export function ownCaseLink(
	formType: Form["type"],
	relationship: CaseOperationLink["relationship"] = "child",
): CaseOperationLink {
	return {
		identifier: "parent",
		targetType: "patient",
		target:
			formType === "registration"
				? { kind: "op", opUuid: OWN }
				: { kind: "session" },
		relationship,
	};
}

/** A create of a `kid` child of the own case, named by `kid_name` in
 *  `kids` (or by `name` at the root). */
export function childCreate(
	key: string,
	formType: Form["type"],
	extra: Partial<CaseOperation> & { repeat?: string } = {},
): CaseOperation {
	const { repeat, ...rest } = extra;
	return {
		uuid: OP(key),
		id: key,
		action: "create",
		caseType: "kid",
		target: { kind: "new" },
		name: read(
			repeat === undefined
				? "name"
				: repeat === "kids"
					? "kid_name"
					: "pet_name",
		),
		links: [ownCaseLink(formType)],
		...(repeat !== undefined && { forEach: { repeat: U(repeat) } }),
		...rest,
	} as CaseOperation;
}
