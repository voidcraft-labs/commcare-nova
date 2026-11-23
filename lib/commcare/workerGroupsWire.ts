import type { Element } from "domhandler";
import { type WireElementContext, xel } from "./elementBuilders";
import type {
	AdvancedFormActions,
	AdvancedOpenCaseAction,
	FormActions,
} from "./types";
import { w } from "./xpath/wire/builders";
import type { WireExpr } from "./xpath/wire/tree";

export const GROUPS_INSTANCE = {
	id: "groups",
	src: "jr://fixture/user-groups",
} as const;
export const WORKER_GROUP_ROWS = w.instance(GROUPS_INSTANCE, [
	w.step("groups"),
	w.step("group"),
]);
export const DEFAULT_GROUP_OWNER = w.instance(GROUPS_INSTANCE, [
	w.step("groups"),
	w.step("group"),
	w.attr("id"),
]);
export const GROUP_OWNER_ASSERTION = {
	test: w.eq(w.call("count", [WORKER_GROUP_ROWS]), w.num(1)),
	localeId: "case_sharing.exactly_one_group",
};
export const GROUP_OWNER_MESSAGE =
	"This form needs one group to own the new case. Your supervisor can check which case-sharing group or place you belong to.";

// Mirrors xform.py's three autoset predicates. An active explicit owner write
// or an advanced extension-only open keeps HQ's unowned create and later updates.
export function advancedAutosetsOwner(action: AdvancedOpenCaseAction) {
	return (
		!Object.hasOwn(action.case_properties, "owner_id") &&
		(!action.case_indices.length ||
			action.case_indices.some((index) => index.relationship !== "extension"))
	);
}
export function basicAutosetsOwner(actions: FormActions) {
	return (
		actions.update_case.condition.type === "never" ||
		!Object.hasOwn(actions.update_case.update, "owner_id")
	);
}
export function needsSingleGroup(actions: AdvancedFormActions | FormActions) {
	if (actions.doc_type === "AdvancedFormActions")
		return actions.open_cases.some(advancedAutosetsOwner);
	return (
		(actions.open_case.condition.type !== "never" &&
			basicAutosetsOwner(actions)) ||
		actions.subcases.some(
			(action) => !Object.hasOwn(action.case_properties, "owner_id"),
		)
	);
}

/** XFormCaseBlock.add_create_block writes a group owner at form load, except
 * that each repeat iteration calculates its own. A personal owner is a bind. */
export function appendDefaultOwner(
	target: {
		binds: Element[];
		setvalues: Element[];
		context: WireElementContext;
	},
	path: WireExpr,
	owner: WireExpr,
	caseSharing: boolean,
	inRepeat: boolean,
) {
	if (caseSharing && !inRepeat) {
		target.setvalues.push(
			xel(
				"setvalue",
				{
					attributes: { event: "xforms-ready" },
					xpath: { ref: path, value: DEFAULT_GROUP_OWNER },
				},
				target.context,
			),
		);
	} else {
		target.binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: path,
						calculate: caseSharing ? DEFAULT_GROUP_OWNER : owner,
					},
				},
				target.context,
			),
		);
	}
}

/** casexml.apps.phone.xml.get_data_element sorts Unicode keys by code point. */
export function workerGroupDetails(values: Readonly<Record<string, string>>) {
	return Object.entries(values)
		.sort(([a], [b]) => {
			const left = Array.from(a),
				right = Array.from(b);
			for (let i = 0; i < Math.min(left.length, right.length); i++) {
				const difference =
					(left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
				if (difference) return difference;
			}
			return left.length - right.length;
		})
		.map(([key, value]) => ({ key, value }));
}
export function locationWorkerGroup(place: {
	id: string;
	name: string;
	path: readonly string[];
	levelName: string;
	metadata: Readonly<Record<string, string>>;
}): import("@/lib/domain/workerGroups").WorkerGroupRow {
	return {
		id: place.id,
		name: `${place.path.join("/")}-Cases`,
		details: workerGroupDetails({
			commcare_location_type: place.levelName,
			commcare_location_name: place.name,
			...Object.fromEntries(
				Object.entries(place.metadata).map(([key, value]) => [
					`commcare_location_${key}`,
					value,
				]),
			),
		}),
	};
}

export function workerGroupFieldSteps(
	field: import("@/lib/domain/expression/types").WorkerGroupField,
) {
	if (typeof field === "string")
		return [field === "id" ? w.attr("id") : w.step("name")];
	return [
		w.step("group_data"),
		w.step(
			"data",
			field.key === undefined
				? []
				: [w.eq(w.context([w.attr("key")]), w.str(field.key))],
		),
		...(field.detail === "key" ? [w.attr("key")] : []),
	];
}
