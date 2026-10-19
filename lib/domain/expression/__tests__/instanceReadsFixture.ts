import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { simpleSearchInputDef } from "@/lib/domain/modules";
import type { OrganizationLevel } from "@/lib/domain/organization";
import { proseText } from "@/lib/domain/prose";
import type { ExpressionContext } from "../context";
import { slotContext } from "../context";
import type { Expression, SlotContextRef } from "../types";

export const reads = Object.fromEntries(
	[
		"find",
		"checkIn",
		"note",
		"register",
		"link",
		"district",
		"found",
		"name",
		"greeting",
		"choice",
		"yes",
		"no",
		"registerProbe",
		"households",
		"visit",
		"visitProbe",
		"batch",
		"close",
		"closeProbe",
		"region",
		"plainModule",
		"plainForm",
		"plainProbe",
	].map((name) => [name, testUuid(`instance-reads-${name}`)]),
) as Record<
	| "find"
	| "checkIn"
	| "note"
	| "register"
	| "link"
	| "district"
	| "found"
	| "name"
	| "greeting"
	| "choice"
	| "yes"
	| "no"
	| "registerProbe"
	| "households"
	| "visit"
	| "visitProbe"
	| "batch"
	| "close"
	| "closeProbe"
	| "region"
	| "plainModule"
	| "plainForm"
	| "plainProbe",
	ReturnType<typeof testUuid>
>;

export function regionLevel(): OrganizationLevel {
	return {
		uuid: reads.region,
		code: "region",
		name: "Region",
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	};
}

/**
 * The reads instance arms make, in one app:
 * - "Find patient", a search-first module on `patient` (a `district`
 *   prompt), whose follow-up "Check in" holds a Hidden Value `found`, a
 *   question `name`, a Hidden Value `greeting`, a select `choice` and an
 *   after-submit link to its second follow-up "Note"; and its no-matches
 *   registration "Register patient";
 * - "Households", an ordinary module on `household` with a follow-up
 *   "Visit";
 * - "Batch", a several-case module on `household` with a follow-up
 *   "Close household".
 * With `organization`, the app has one level, Region.
 */
export function instanceReadsDoc(
	options: { readonly organization?: boolean } = {},
): BlueprintDoc {
	const search = caseListConfig([{ field: "case_name", header: "Name" }]);
	search.searchInputs = [
		simpleSearchInputDef(
			reads.district,
			"district",
			"District",
			"text",
			"district",
		),
	];
	const doc = buildDoc({
		appName: "Instance reads",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "district", label: "District", data_type: "text" },
					{ name: "seen_at", label: "Seen at", data_type: "datetime" },
				],
			},
			{
				name: "household",
				properties: [{ name: "district", label: "District" }],
			},
		],
		modules: [
			{
				uuid: reads.find,
				name: "Find patient",
				caseType: "patient",
				caseListConfig: search,
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						uuid: reads.checkIn,
						name: "Check in",
						type: "followup",
						formLinks: [
							{
								uuid: reads.link,
								target: {
									type: "form",
									moduleUuid: reads.find,
									formUuid: reads.note,
								},
							},
						],
						fields: [
							f({ uuid: reads.found, id: "found", kind: "hidden" }),
							f({ uuid: reads.name, id: "name", kind: "text", label: "Name" }),
							f({ uuid: reads.greeting, id: "greeting", kind: "hidden" }),
							f({
								uuid: reads.choice,
								id: "choice",
								kind: "single_select",
								label: "Choice",
								options: [
									{ uuid: reads.yes, value: "yes", label: "Yes" },
									{ uuid: reads.no, value: "no", label: "No" },
								],
							}),
						],
					},
					{
						uuid: reads.note,
						name: "Note",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
					{
						uuid: reads.register,
						name: "Register patient",
						type: "registration",
						entry: { kind: "search-no-matches" },
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({ uuid: reads.registerProbe, id: "probe", kind: "hidden" }),
						],
					},
				],
			},
			{
				uuid: reads.households,
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: reads.visit,
						name: "Visit",
						type: "followup",
						fields: [
							f({ uuid: reads.visitProbe, id: "probe", kind: "hidden" }),
						],
					},
				],
			},
			{
				uuid: reads.batch,
				name: "Batch",
				caseType: "household",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					selection: { kind: "multiple", maximum: 10 },
				},
				forms: [
					{
						uuid: reads.close,
						name: "Close household",
						type: "followup",
						fields: [
							f({ uuid: reads.closeProbe, id: "probe", kind: "hidden" }),
						],
					},
				],
			},
		],
	});
	if (options.organization === true) {
		doc.organizationLevels = { [reads.region]: regionLevel() };
		doc.organizationLevelOrder = [reads.region];
	}
	return doc;
}

/** A Hidden Value's calculate. */
export const calculate = (uuid: (typeof reads)["found"]): SlotContextRef => ({
	entity: "field",
	uuid,
	slot: "calculate",
});
/** The link's condition. */
export const linkCondition: SlotContextRef = {
	entity: "form",
	uuid: reads.checkIn,
	slot: "form_link_condition",
	member: { linkUuid: reads.link },
};

export function readsContext(
	doc: BlueprintDoc,
	slot: SlotContextRef,
): ExpressionContext {
	const ctx = slotContext(doc, slot, new Map());
	if (ctx === undefined)
		throw new Error(`The fixture has no owning slot: ${JSON.stringify(slot)}`);
	return ctx;
}

/** `instance('results:inline')/results/case[not(commcare_is_related_case = true())][…]`. */
export function searchResults(...where: Expression[]): Expression {
	return { kind: "cases", source: "search-results", where };
}
/** Set a Hidden Value's calculate. */
export function setCalculate(
	doc: BlueprintDoc,
	uuid: (typeof reads)["found"],
	expression: Expression,
): void {
	const field = doc.fields[uuid];
	if (field?.kind !== "hidden")
		throw new Error("The fixture's Hidden Value is missing.");
	field.calculate = expression;
}
/** Set the after-submit link's condition, with the app home as the
 * fallback when it is false. */
export function setLinkCondition(
	doc: BlueprintDoc,
	expression: Expression,
): void {
	const link = doc.forms[reads.checkIn].formLinks?.[0];
	if (link === undefined) throw new Error("The link fixture is missing.");
	link.condition = expression;
	doc.forms[reads.checkIn].postSubmit = "app_home";
}
