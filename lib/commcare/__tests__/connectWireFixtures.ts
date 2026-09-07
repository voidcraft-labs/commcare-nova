import { buildDoc, f, xp, xpIn } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	type ConnectConfig,
	proseText,
} from "@/lib/domain";

/** The same admitted documents feed ordinary artifact checks and native consumers. */
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
					: {
							deliver_unit: { id: "visit", name: "Home & clinic <雪>" },
							task: {
								id: "task",
								name: "Record & review",
								description: "Ask <then> listen",
							},
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
									default_value: xp("42"),
								}),
								f({
									kind: "text",
									id: "feedback",
									label: proseText("Feedback"),
									default_value: xp("'Clinic & child'"),
								}),
							],
						},
					],
				},
			],
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const config = doc.forms[formUuid].connect;
		if (custom && config) {
			if ("assessment" in config && config.assessment)
				config.assessment.user_score = xpIn(doc, formUuid, "#form/score");
			if ("deliver_unit" in config && config.deliver_unit) {
				config.deliver_unit.entity_id = xpIn(
					doc,
					formUuid,
					"concat('visit-', #form/score)",
				);
				config.deliver_unit.entity_name = xpIn(doc, formUuid, "#form/feedback");
			}
		}
		blueprintDocSchema.parse(toPersistableDoc(doc));
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		if (findings.length)
			throw new Error(`${name}: ${JSON.stringify(findings)}`);
		return { name, doc };
	});
}
