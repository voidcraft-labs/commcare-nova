import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, proseText } from "@/lib/domain";
import {
	DEFAULT_ASSESSMENT_USER_SCORE_EXPRESSION,
	DEFAULT_DELIVER_ENTITY_ID_EXPRESSION,
	DEFAULT_DELIVER_ENTITY_NAME_EXPRESSION,
} from "./releasedConnectDefaults";

/**
 * The same admitted documents feed ordinary artifact checks and native
 * consumers. A deliver scenario's menu holds two forms: the first holds the
 * deliver unit, and the second, named for the task, holds the task and one
 * label with the task's description, since Connect turns away the visit of a
 * form that also completes a task. The entities beyond the first form carry
 * named uuids, so adding them moves no other document's minted identities.
 */
export function connectWireFixtures() {
	return [
		"learn-default",
		"learn-custom",
		"deliver-default",
		"deliver-custom",
		"absent",
	].map((name) => {
		const learn = name.startsWith("learn");
		const custom = name.endsWith("custom");
		const activities =
			name === "absent"
				? []
				: learn
					? [
							f({
								uuid: `${name}-lesson`,
								kind: "connect_activity",
								id: "lesson",
								activity: {
									kind: "learning-module",
									name: "Health & care <雪>",
									description: "Read 'A' then \"B\"",
									estimatedHours: 5,
								},
							}),
							f({
								uuid: `${name}-quiz`,
								kind: "connect_activity",
								id: "quiz",
								activity: {
									kind: "assessment",
									score: custom
										? "#form/score"
										: DEFAULT_ASSESSMENT_USER_SCORE_EXPRESSION,
								},
							}),
						]
					: [
							f({
								uuid: `${name}-visit`,
								kind: "connect_activity",
								id: "visit",
								activity: {
									kind: "delivery",
									name: "Home & clinic <雪>",
									entityId: custom
										? "concat('visit-', #form/score)"
										: DEFAULT_DELIVER_ENTITY_ID_EXPRESSION,
									entityName: custom
										? "#form/feedback"
										: DEFAULT_DELIVER_ENTITY_NAME_EXPRESSION,
								},
							}),
						];
		const task = {
			id: "follow_up",
			name: "Record & review",
			description: "Ask <then> listen",
		};
		const doc = buildDoc({
			appName: name,
			connectRoles: name === "absent" ? [] : [learn ? "learn" : "deliver"],
			modules: [
				{
					name: "Work",
					forms: [
						{
							name: "Activity",
							type: "survey",
							fields: [
								f({
									kind: "int",
									id: "score",
									label: proseText("Score"),
									default_value: "42",
								}),
								f({
									kind: "text",
									id: "feedback",
									label: proseText("Feedback"),
									default_value: "'Clinic & child'",
								}),
								...activities,
							],
						},
						...(learn || name === "absent"
							? []
							: [
									{
										uuid: `${name}-task-form`,
										name: task.name,
										type: "survey" as const,
										fields: [
											f({
												uuid: `${name}-task-note`,
												kind: "label",
												id: "note",
												label: proseText(task.description),
											}),
											f({
												uuid: `${name}-task`,
												kind: "connect_activity",
												id: task.id,
												activity: {
													kind: "assigned-task",
													name: task.name,
													description: task.description,
												},
											}),
										],
									},
								]),
					],
				},
			],
		});
		blueprintDocSchema.parse(toPersistableDoc(doc));
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		if (findings.length)
			throw new Error(`${name}: ${JSON.stringify(findings)}`);
		return { name, doc };
	});
}
