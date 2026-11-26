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

it("refuses moving a learning module into the same submission as another of its name", () => {
	const choice = testUuid("placed-choice");
	const groupA = testUuid("placed-group-a");
	const groupB = testUuid("placed-group-b");
	const details = testUuid("placed-details");
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
							f({
								kind: "group",
								uuid: details,
								id: "details",
								children: [f({ kind: "text", id: "note", label: "Notes" })],
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
	// HQ will not keep a grouped question's answer at the form root.
	const atRoot = mutationCommitVerdict(
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
	expect(atRoot.ok ? [] : atRoot.findings.map(({ code }) => code)).toContain(
		"FIELD_SUBMISSION_PLACEMENT",
	);
	// Moving the question itself to the unguarded Details group has an
	// ordinary HQ placement, but can send both learning modules.
	const inDetails = mutationCommitVerdict(
		doc,
		[{ kind: "moveField", uuid: introA, toParentUuid: details, after: null }],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(
		inDetails.ok ? [] : inDetails.findings.map(({ code }) => code),
	).toEqual(["CONNECT_REPEATED_LEARNING_MODULE"]);
});
