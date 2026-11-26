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

it("refuses a learning module's answer placed out of the group that kept it apart from another of its name", () => {
	const choice = testUuid("placed-choice");
	const groupA = testUuid("placed-group-a");
	const groupB = testUuid("placed-group-b");
	const introA = testUuid("placed-intro-a");
	const module = (uuid: string) =>
		f({
			kind: "connect_activity",
			uuid,
			id: "intro",
			activity: {
				kind: "learning-module",
				name: "Intro",
				description: "Start here",
				estimatedHours: 1,
			},
		});
	const doc = buildDoc({
		connectRoles: ["learn"],
		modules: [
			{
				name: "Training",
				forms: [
					{
						name: "Lesson",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								uuid: choice,
								id: "track",
								options: [
									{ value: "a", label: "A" },
									{ value: "b", label: "B" },
								],
							}),
							f({
								kind: "group",
								uuid: groupA,
								id: "track_a",
								relevant: "#form/track = 'a'",
								children: [module(introA)],
							}),
							f({
								kind: "group",
								uuid: groupB,
								id: "track_b",
								relevant: "#form/track = 'b'",
								children: [module(testUuid("placed-intro-b"))],
							}),
						],
					},
				],
			},
		],
	});
	const form = Object.keys(doc.forms)[0] as string;
	// The two modules never coincide where each answer stands in its group.
	expect(
		mutationCommitVerdict(
			doc,
			[{ kind: "setConnectRoles", roles: ["learn"] }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		).ok,
	).toBe(true);
	const moved = mutationCommitVerdict(
		doc,
		[
			{
				kind: "moveField",
				where: "submission",
				uuid: introA,
				toParentUuid: form,
				after: null,
			},
		],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(moved.ok).toBe(false);
	if (moved.ok) return;
	expect(moved.findings.map((finding) => finding.code)).toContain(
		"CONNECT_REPEATED_LEARNING_MODULE",
	);
});
