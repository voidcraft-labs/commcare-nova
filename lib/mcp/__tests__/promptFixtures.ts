import { buildDoc } from "@/lib/__tests__/docHelpers";

export function promptDoc(large = false) {
	return buildDoc({
		appId: "prompt-app",
		appName: "Vaccine Tracker",
		modules: [
			{
				id: "visits",
				name: "Clinic visits",
				forms: [
					{
						id: "intake",
						name: "Patient intake",
						type: "survey",
						fields: large
							? Array.from({ length: 220 }, (_, i) => ({
									id: `question_${i}`,
									kind: "text" as const,
									label: `Question ${i}: ${"Detailed guidance 💉 ".repeat(25)}`,
								}))
							: [{ id: "patient_name", kind: "text", label: "Patient name" }],
					},
				],
			},
		],
	});
}
