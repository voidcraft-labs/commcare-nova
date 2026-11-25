import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";

it("requires removal of a submitted activity before turning its role off and admits the two edits together", () => {
	const lesson = testUuid("role-owned-lesson");
	const doc = buildDoc({
		connectRoles: ["learn", "deliver"],
		modules: [
			{
				name: "Outreach",
				forms: [
					{
						name: "Training and visits",
						type: "survey",
						fields: [
							f({ kind: "text", id: "name" }),
							f({
								kind: "connect_activity",
								uuid: lesson,
								id: "hand_washing",
								activity: {
									kind: "learning-module",
									name: "Hand washing",
									description: "Practice",
									estimatedHours: 0,
								},
							}),
							f({
								kind: "connect_activity",
								id: "visit",
								activity: { kind: "delivery", name: "Visit" },
							}),
						],
					},
				],
			},
		],
	});
	const removeRole = {
		kind: "setConnectRoles" as const,
		roles: ["deliver" as const],
	};
	const refused = mutationCommitVerdict(
		doc,
		[removeRole],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(refused.ok).toBe(false);
	expect(doc.fields[lesson]?.id).toBe("hand_washing");
	const accepted = mutationCommitVerdict(
		doc,
		[{ kind: "removeField", uuid: lesson }, removeRole],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!accepted.ok) throw new Error(JSON.stringify(accepted.findings));
	expect(accepted.nextDoc.connectRoles).toEqual(["deliver"]);
	expect(
		Object.values(accepted.nextDoc.fields).map((field) => field.id),
	).toEqual(["name", "visit"]);
});
