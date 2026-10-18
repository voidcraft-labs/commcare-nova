import {
	buildDoc,
	f,
	parseFixtureExpression,
} from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	type ConnectConfig,
	proseText,
} from "@/lib/domain";

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
		const connect: ConnectConfig | undefined =
			name === "absent"
				? undefined
				: learn
					? {
							learn_module: {
								id: "lesson",
								name: "Health & care <雪>",
								description: "Read 'A' then \"B\"",
								time_estimate: 5,
							},
							assessment: { id: "quiz" },
						}
					: { deliver_unit: { id: "visit", name: "Home & clinic <雪>" } };
		const task = {
			id: "follow_up",
			name: "Record & review",
			description: "Ask <then> listen",
		};
		const doc = buildDoc({
			appName: name,
			connectType: name === "absent" ? null : learn ? "learn" : "deliver",
			modules: [
				{
					name: "Work",
					forms: [
						{
							name: "Activity",
							type: "survey",
							connect,
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
							],
						},
						...(learn || name === "absent"
							? []
							: [
									{
										uuid: `${name}-task-form`,
										name: task.name,
										type: "survey" as const,
										connect: { task },
										fields: [
											f({
												uuid: `${name}-task-note`,
												kind: "label",
												id: "note",
												label: proseText(task.description),
											}),
										],
									},
								]),
					],
				},
			],
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const config = doc.forms[formUuid].connect;
		if (custom && config) {
			if ("assessment" in config && config.assessment)
				config.assessment.user_score = parseFixtureExpression(
					doc,
					{ entity: "form", uuid: formUuid, slot: "assessment_user_score" },
					"#form/score",
				);
			if ("deliver_unit" in config && config.deliver_unit) {
				config.deliver_unit.entity_id = parseFixtureExpression(
					doc,
					{ entity: "form", uuid: formUuid, slot: "deliver_entity_id" },
					"concat('visit-', #form/score)",
				);
				config.deliver_unit.entity_name = parseFixtureExpression(
					doc,
					{ entity: "form", uuid: formUuid, slot: "deliver_entity_name" },
					"#form/feedback",
				);
			}
		}
		blueprintDocSchema.parse(toPersistableDoc(doc));
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		if (findings.length)
			throw new Error(`${name}: ${JSON.stringify(findings)}`);
		return { name, doc };
	});
}
