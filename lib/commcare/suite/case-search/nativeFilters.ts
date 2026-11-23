import type { ModuleExpressionContexts } from "@/lib/commcare/expressionContext";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import type { DatumRef, Expression } from "@/lib/domain/expression/types";
import { XML_ELEMENT_NAME_PATTERN } from "@/lib/domain/expression/types";
import type { SearchFilterTarget } from "@/lib/domain/modules";
import type { Uuid } from "@/lib/domain/uuid";
import { isReservedSearchInputName } from "./reservedInputNames";

const attributeKey = {
	id: "@case_id",
	type: "@case_type",
	owner: "@owner_id",
	status: "@status",
} as const;
type Attribute = keyof typeof attributeKey;
const keyToAttribute = new Map<string, Attribute>(
	Object.entries(attributeKey).map(([attribute, key]) => [
		key,
		attribute as Attribute,
	]),
);

/** The native request key decides both the matcher and the grouping of values. */
export function searchFilterKey(target: SearchFilterTarget): string {
	switch (target.kind) {
		case "record-id":
			return "case_id";
		case "record-name":
		case "attribute":
		case "property": {
			const leaf =
				target.kind === "record-name"
					? "name"
					: target.kind === "attribute"
						? attributeKey[target.attribute]
						: target.property;
			return [
				...(target.ancestors ?? []).map((step) => step.identifier),
				leaf,
			].join("/");
		}
		case "owner":
			return "owner_id";
		case "project-space":
			return "commcare_project";
		case "link":
			return `indices.${target.identifier}`;
	}
}

export function readSearchFilterTarget(
	key: string,
): SearchFilterTarget | undefined {
	switch (key) {
		case "case_id":
			return { kind: "record-id" };
		case "name":
			return { kind: "record-name" };
		case "owner_id":
			return { kind: "owner" };
		case "commcare_project":
			return { kind: "project-space" };
	}
	if (key.startsWith("indices.")) {
		const identifier = key.slice("indices.".length);
		return XML_ELEMENT_NAME_PATTERN.test(identifier)
			? { kind: "link", identifier }
			: undefined;
	}
	if (isReservedSearchInputName(key)) return undefined;
	const parts = key.split("/");
	const property = parts.pop();
	if (!property || !parts.every((step) => XML_ELEMENT_NAME_PATTERN.test(step)))
		return undefined;
	const [first, ...rest] = parts;
	const path =
		first === undefined
			? {}
			: {
					ancestors: [
						{ identifier: first },
						...rest.map((identifier) => ({ identifier })),
					] as [{ identifier: string }, ...{ identifier: string }[]],
				};
	if (property === "name") return { kind: "record-name", ...path };
	const attribute = keyToAttribute.get(property);
	if (attribute) return { kind: "attribute", attribute, ...path };
	if (!authoredCasePropertyNameSchema.safeParse(property).success)
		return undefined;
	return { kind: "property", property, ...path };
}

/** Both exports and the HQ reader use this screen's actual scope: an input,
 * a prior session selection, a worker or a fixture may supply the value. */
export function emitSearchFilterValue(
	value: Expression,
	filterUuid: Uuid,
	expressions: ModuleExpressionContexts,
	searchInputInstanceId: `search-input:${string}` | undefined,
	lookupNaming: LookupWireNaming | undefined,
	datumId: ((ref: DatumRef) => string | undefined) | undefined,
) {
	return toWire(value, {
		target: "suite",
		types: expressions({ slot: "search_filter_value", member: { filterUuid } }),
		anchor: { kind: "unaddressable" },
		bindings: {
			searchInputInstanceId,
			datumId,
			...(lookupNaming === undefined
				? {}
				: { lookup: { naming: lookupNaming, instanceScope: "suite" } }),
		},
	});
}
