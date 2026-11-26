import type { Expression } from "@/lib/domain/expression/types";
import type { ConnectActivity } from "@/lib/domain/fields/connectActivity";

export const CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn";

/**
 * Each Connect block as Vellum writes it: the wrapper's
 * `vellum:role`, the block's own element, and its leaves in order, the
 * layout HQ's form builder gives each Connect question
 * (`commcareConnect.js`, each mug's `childNodes`). The reader of CommCare
 * HQ's forms reads a block against this same layout.
 */
export const CONNECT_BLOCK_SHAPES = {
	learn_module: {
		role: "ConnectLearnModule",
		element: "module",
		leaves: ["name", "description", "time_estimate"],
	},
	assessment: {
		role: "ConnectAssessment",
		element: "assessment",
		leaves: ["user_score"],
	},
	deliver_unit: {
		role: "ConnectDeliverUnit",
		element: "deliver",
		leaves: ["name", "entity_id", "entity_name", "work_area_id"],
	},
	task: {
		role: "ConnectTask",
		element: "task",
		leaves: ["name", "description"],
	},
} as const satisfies Readonly<
	Record<
		string,
		{
			readonly role: string;
			readonly element: string;
			readonly leaves: readonly string[];
		}
	>
>;

export type ConnectBlock =
	| "learn_module"
	| "assessment"
	| "deliver_unit"
	| "task";
type CalculationSlot =
	| "assessment_user_score"
	| "deliver_entity_id"
	| "deliver_entity_name"
	| "deliver_work_area_id";

interface ActivityWireContent {
	readonly block: ConnectBlock;
	readonly texts: Readonly<Record<string, string>>;
	readonly calculations: readonly {
		readonly leaf: string;
		readonly slot: CalculationSlot;
		readonly expression: Expression | undefined;
	}[];
}

/** Vellum's commcareConnect.js defines which children hold authored text and
 * which carry a bind. XForm emission and HQ's case-load metadata share the
 * same placement and the same expression for every submitted child. */
export function activityWireContent(
	activity: ConnectActivity,
): ActivityWireContent {
	switch (activity.kind) {
		case "learning-module":
			return {
				block: "learn_module",
				texts: {
					name: activity.name,
					description: activity.description,
					time_estimate: String(activity.estimatedHours),
				},
				calculations: [],
			};
		case "assessment":
			return {
				block: "assessment",
				texts: {},
				calculations: [
					{
						leaf: "user_score",
						slot: "assessment_user_score",
						expression: activity.score,
					},
				],
			};
		case "assigned-task":
			return {
				block: "task",
				texts: { name: activity.name, description: activity.description },
				calculations: [],
			};
		case "delivery":
			return {
				block: "deliver_unit",
				texts: { name: activity.name },
				calculations: [
					{
						leaf: "entity_id",
						slot: "deliver_entity_id",
						expression: activity.entityId,
					},
					{
						leaf: "entity_name",
						slot: "deliver_entity_name",
						expression: activity.entityName,
					},
					{
						leaf: "work_area_id",
						slot: "deliver_work_area_id",
						expression: activity.workAreaId,
					},
				],
			};
	}
}
