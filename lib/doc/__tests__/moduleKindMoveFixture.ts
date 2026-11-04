/**
 * A household app the commit gate admits, shaped for moves of a menu's
 * kind: Households (its visit form saves the household's size), Members
 * chosen under their household (its check-in saves the member's age), and
 * Visits with a review form that saves a note, and Directory, a case list
 * of households with no forms, shown as a menu item. The household visit can create a visit,
 * which an after-submit link to the review can carry.
 * Every form's case changes are planned by the production "Saves to"
 * planner, and a test holds what a publish would record before it edits.
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression/builders";
import { holdPlanned } from "./placementMoveFixture";

export const K = (id: string): Uuid => testUuid(`kind-fld-${id}`);
export const KOP = (id: string): Uuid => testUuid(`kind-op-${id}`);
export const HOUSEHOLDS = testUuid("kind-mod-households");
export const MEMBERS = testUuid("kind-mod-members");
export const VISITS = testUuid("kind-mod-visits");
export const DIRECTORY = testUuid("kind-mod-directory");
export const HOUSEHOLD_VISIT = testUuid("kind-form-household-visit");
export const CHECK_IN = testUuid("kind-form-check-in");
export const REVIEW = testUuid("kind-form-review");
export const CARRY_LINK = testUuid("kind-link-carry");

const field = (spec: Parameters<typeof f>[0]) =>
	f({ ...spec, uuid: `kind-fld-${spec.id}` });

export function kindFixture(): BlueprintDoc {
	return buildDoc({
		appName: "Menu kinds",
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "size", label: "Size", data_type: "int" },
				],
			},
			{
				name: "member",
				parent_type: "household",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "age", label: "Age", data_type: "int" },
				],
			},
			{
				name: "visit",
				parent_type: "household",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "note", label: "Note" },
				],
			},
		],
		modules: [
			{
				uuid: "kind-mod-households",
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "kind-form-household-visit",
						name: "Household visit",
						type: "followup",
						fields: [
							field({
								kind: "int",
								id: "size",
								caseWrite: { caseType: "household", property: "size" },
							}),
							field({ kind: "text", id: "visit_name" }),
						],
					},
				],
			},
			{
				uuid: "kind-mod-members",
				name: "Members",
				caseType: "member",
				parentCaseModuleUuid: "kind-mod-households",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "kind-form-check-in",
						name: "Member check-in",
						type: "followup",
						fields: [
							field({
								kind: "int",
								id: "age",
								caseWrite: { caseType: "member", property: "age" },
							}),
							field({ kind: "text", id: "member_visit" }),
						],
					},
				],
			},
			{
				uuid: "kind-mod-visits",
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "kind-form-review",
						name: "Review",
						type: "followup",
						fields: [
							field({
								kind: "text",
								id: "review_note",
								caseWrite: { caseType: "visit", property: "note" },
							}),
						],
					},
				],
			},
			{
				uuid: "kind-mod-directory",
				name: "Directory",
				caseType: "household",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
			},
		],
	});
}

/** Hold `moduleUuid`'s kind advanced and every placement its forms are
 *  planned, as a publish records an advanced menu. */
export function publishedAdvanced(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): BlueprintDoc {
	doc.modules[moduleUuid] = {
		...doc.modules[moduleUuid],
		heldKind: "advanced",
	};
	for (const formUuid of doc.formOrder[moduleUuid] ?? [])
		holdPlanned(doc, formUuid);
	return doc;
}

/** Hold every placement `moduleUuid`'s forms are planned, as a publish
 *  records an ordinary menu. */
export function publishedBasic(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): BlueprintDoc {
	for (const formUuid of doc.formOrder[moduleUuid] ?? [])
		holdPlanned(doc, formUuid);
	return doc;
}

/**
 * The batch that has a follow-up (the household visit, unless another is
 * named) create a visit for the case it opened on and carry it to the
 * visit's review: an extension of that case, which a basic form gives no
 * session value, so the menu becomes advanced.
 */
export function carryVisit(
	formUuid: Uuid = HOUSEHOLD_VISIT,
	hostType: "household" | "member" = "household",
): Mutation[] {
	const visit = {
		uuid: KOP("visit"),
		id: "visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: term(
			formField(K(hostType === "household" ? "visit_name" : "member_visit")),
		),
		links: [
			{
				identifier: "host",
				targetType: hostType,
				target: { kind: "session" },
				relationship: "extension",
			},
		],
	} as CaseOperation;
	return [
		{
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationChange: { operation: "add", value: visit },
		} as Mutation,
		{
			kind: "addFormLink",
			formUuid,
			link: {
				uuid: CARRY_LINK,
				target: { type: "form", moduleUuid: VISITS, formUuid: REVIEW },
			},
		} as Mutation,
	];
}

/** Two creates in the household visit that link a member to the household
 *  under two names, so a chain from households to members follows no one
 *  index. */
export const memberUnderTwoNames: Mutation[] = (
	["household", "home"] as const
).map(
	(identifier) =>
		({
			kind: "updateForm",
			uuid: HOUSEHOLD_VISIT,
			patch: {},
			caseOperationChange: {
				operation: "add",
				value: {
					uuid: KOP(`member-${identifier}`),
					id: `member_${identifier}`,
					action: "create",
					caseType: "member",
					target: { kind: "new" },
					name: term(formField(K("visit_name"))),
					links: [
						{
							identifier,
							targetType: "household",
							target: { kind: "session" },
							relationship: "child",
						},
					],
				} as CaseOperation,
			},
		}) as Mutation,
);
