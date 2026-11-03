// components/builder/case-operations/__tests__/seeds.test.ts
//
// Adding a change lands one the validator already accepts.
//
// The app is valid by construction, so "born valid" cannot be a hope
// about the seed shapes: it has to be proved against the same commit
// gate the dispatch runs through. Each seed goes through
// `mutationCommitVerdict` here for exactly that reason; a seed that
// forgets a required facet fails this test rather than the author.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { caseOperationTargetTypeAfter } from "@/lib/doc/caseOperationIntents";
import {
	addCaseOperationMutations,
	caseOperationAddVerdict,
} from "@/lib/doc/caseOperationMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type CaseOperation,
	effectiveCaseTypes,
	isCaseOperationIdentifier,
	type TargetedCaseOperation,
	type Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	actionChangeLosses,
	type CaseOperationSeedKind,
	nextLinkIdentifier,
	nextOperationId,
	reshapeForAction,
	seedCaseOperation,
	seedCaseOperationWrite,
	seedWriteValue,
	takenOperationIds,
	workerRecordSeed,
	writeSeedUnavailableReason,
} from "../seeds";

const NAME = testUuid("44444444-4444-4444-8444-444444444444");
const ANSWER = testUuid("55555555-5555-4555-8555-555555555555");

/** A seed carries no lookup carrier, so the explicit no-snapshot context
 *  is the honest one: the same one every client-side gate passes. */
const NO_LOOKUPS = LOOKUP_CONTEXT_UNAVAILABLE;

/** A case-first module: every form loads a case, so a change may act on
 *  "the case this form opened". */
function caseFirstDoc(): {
	doc: BlueprintDoc;
	formUuid: ReturnType<typeof testUuid>;
} {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "nickname", label: proseText("Nick") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "nickname", header: "Nickname" },
				]),
				forms: [
					{
						name: "Edit",
						type: "followup",
						fields: [
							f({
								uuid: NAME,
								kind: "text",
								id: "nickname",
								label: proseText("Nickname"),
								caseWrite: {
									caseType: "patient",
									property: "nickname",
								},
							}),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	return { doc, formUuid: doc.formOrder[moduleUuid][0] };
}

function commits(
	doc: BlueprintDoc,
	formUuid: ReturnType<typeof testUuid>,
	operation: CaseOperation,
) {
	return mutationCommitVerdict(
		doc,
		addCaseOperationMutations(doc, formUuid, operation),
		NO_LOOKUPS,
	);
}

describe("case-operation seeds", () => {
	const seeds: readonly CaseOperationSeedKind[] = [
		{ kind: "create", caseType: "referral" },
		{ kind: "update-session", caseType: "patient" },
	];

	for (const seed of seeds) {
		it(`"${seed.kind}" is accepted by the commit gate as-is`, () => {
			const { doc, formUuid } = caseFirstDoc();
			const verdict = commits(
				doc,
				formUuid,
				seedCaseOperation(seed, new Set()),
			);
			expect(verdict.ok).toBe(true);
		});
	}

	it("a close of the case this form opened is the form's own case, so the gate refuses it with the way forward", () => {
		// A follow-up form's own case is the case it opened, and a close form
		// is what closes it, so the add chooser offers this seed disabled with
		// the gate's sentence.
		const { doc, formUuid } = caseFirstDoc();
		expect(
			caseOperationAddVerdict(
				doc,
				formUuid,
				seedCaseOperation(
					{ kind: "close-session", caseType: "patient" },
					new Set(),
				),
			),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("a close form"),
		});
	});

	it("declares a brand-new case type in the same batch", () => {
		// The create seed may name a type the catalog has never seen; the
		// batch has to bring it with it, or the gate refuses an unknown type.
		const { doc, formUuid } = caseFirstDoc();
		const mutations = addCaseOperationMutations(
			doc,
			formUuid,
			seedCaseOperation({ kind: "create", caseType: "referral" }, new Set()),
		);
		const next = produce(doc, (draft) => {
			applyMutations(draft, mutations);
		});
		expect(
			effectiveCaseTypes(next).find((type) => type.name === "referral"),
		).toBeDefined();
		expect(
			effectiveCaseTypes(doc).find((type) => type.name === "referral"),
		).toBeUndefined();
	});

	it("gives every change a distinct, readable id", () => {
		const first = seedCaseOperation(
			{ kind: "create", caseType: "referral" },
			new Set(),
		);
		const second = seedCaseOperation(
			{ kind: "create", caseType: "referral" },
			takenOperationIds([first]),
		);
		expect(first.id).toBe("create_referral");
		expect(second.id).toBe("create_referral_2");
		expect(first.uuid).not.toBe(second.uuid);
	});

	it("makes an id legal whatever the case type is called", () => {
		expect(nextOperationId("create_2_way", new Set())).toBe("create_2_way");
		expect(nextOperationId("9lives", new Set())).toBe("lives");
		expect(nextOperationId("!!!", new Set())).toBe("change");
	});

	it.each([
		["create", "create_follow_up"],
		["update-session", "update_follow_up"],
		["close-session", "close_follow_up"],
	] as const)(
		"normalizes a legal hyphenated case type for every %s seed",
		(kind, expected) => {
			const seeded = seedCaseOperation(
				{ kind, caseType: "follow-up" } as CaseOperationSeedKind,
				new Set(),
			);
			expect(seeded.id).toBe(expected);
			expect(isCaseOperationIdentifier(seeded.id)).toBe(true);
		},
	);

	it.each(["update-session"] as const)(
		"seeds %s with the session type established by earlier retypes",
		(kind) => {
			const doc = buildDoc({
				caseTypes: [
					{ name: "patient", properties: [] },
					{ name: "visit", properties: [] },
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Case name" },
						]),
						forms: [
							{
								name: "Edit",
								type: "followup",
								fields: [
									f({
										kind: "text",
										id: "note",
										label: proseText("Note"),
									}),
								],
							},
						],
					},
				],
			});
			const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
			const retype: CaseOperation = {
				uuid: testUuid("66666666-6666-4666-8666-666666666666"),
				id: "retype_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				retype: "visit",
			};
			// The form's own case stays first; the retype follows it.
			doc.forms[formUuid].caseOperations = [
				...(doc.forms[formUuid].caseOperations ?? []),
				retype,
			];
			const rollingType = caseOperationTargetTypeAfter(
				[retype],
				{ kind: "session" },
				"patient",
			);
			expect(rollingType).toBe("visit");
			const operation = seedCaseOperation(
				{ kind, caseType: rollingType ?? "patient" },
				takenOperationIds([retype]),
			);

			expect(operation.caseType).toBe("visit");
			expect(caseOperationAddVerdict(doc, formUuid, operation)).toEqual({
				ok: true,
			});
			expect(
				caseOperationAddVerdict(
					doc,
					formUuid,
					seedCaseOperation(
						{ kind, caseType: "patient" },
						takenOperationIds([retype]),
					),
				),
			).toMatchObject({ ok: false });
		},
	);

	it("keeps link identifiers unique inside one change", () => {
		expect(nextLinkIdentifier(new Set())).toBe("parent");
		expect(nextLinkIdentifier(new Set(["parent"]))).toBe("parent_2");
		expect(nextLinkIdentifier(new Set(["parent", "parent_2"]))).toBe(
			"parent_3",
		);
	});
});

describe("the value a fresh write starts from", () => {
	// A STORED value is stricter than a compared one, and the gap is where a
	// plausible seed goes wrong: `seedLiteralForProperty` (the comparison
	// seed) produces an empty temporal literal, a text literal for a
	// multi-select, and a null for a geopoint: all three refused as
	// assignments. Every type below goes through the real validator.
	const TYPES = [
		"text",
		"int",
		"decimal",
		"date",
		"time",
		"datetime",
		"single_select",
		"multi_select",
		"geopoint",
	] as const;

	function writeCommits(
		dataType: (typeof TYPES)[number],
		fields: readonly { uuid: Uuid; dataType: (typeof TYPES)[number] }[],
	): { seeded: boolean; ok: boolean } {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "p", label: proseText("P"), data_type: dataType },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([{ field: "p", header: "P" }]),
					forms: [
						{
							name: "Edit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "note",
									label: proseText("Note"),
								}),
								...fields.map((field, index) =>
									f({
										uuid: field.uuid,
										kind: field.dataType === "int" ? "int" : field.dataType,
										id: `answer_${index}`,
										label: proseText(`Answer ${index}`),
										...(field.dataType === "single_select" ||
										field.dataType === "multi_select"
											? {
													optionsSource: {
														kind: "inline" as const,
														options: [
															{
																uuid: testUuid(`answer-${index}-yes`),
																value: "yes",
																label: proseText("Yes"),
															},
															{
																uuid: testUuid(`answer-${index}-no`),
																value: "no",
																label: proseText("No"),
															},
														],
													},
												}
											: {}),
									}),
								),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const value = seedWriteValue(dataType, fields);
		if (value === undefined) return { seeded: false, ok: false };
		const operation: CaseOperation = {
			uuid: testUuid("99999999-9999-4999-8999-999999999999"),
			id: "update_patient",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [seedCaseOperationWrite("p", value)],
		};
		return {
			seeded: true,
			ok: commits(doc, formUuid, operation).ok,
		};
	}

	for (const dataType of TYPES) {
		it(`is accepted by the gate for a ${dataType} property, or is not offered`, () => {
			const verdict = writeCommits(dataType, []);
			// Either it seeds something the gate accepts, or it declines, and
			// declining is only honest for the three types with no storable
			// constant, so the second arm cannot pass vacuously for the rest.
			// What it must never do is seed a write the gate refuses.
			if (verdict.seeded) {
				expect(verdict.ok).toBe(true);
			} else {
				expect(["time", "multi_select", "geopoint"]).toContain(dataType);
			}
		});
	}

	it("prefers a form answer, which is the only storable value for some types", () => {
		const answer = { uuid: ANSWER, dataType: "multi_select" } as const;
		const verdict = writeCommits("multi_select", [answer]);
		expect(verdict).toEqual({ seeded: true, ok: true });
		// Without one there is nothing storable to seed, so the property is
		// offered with the reason rather than seeded into a refusal.
		expect(seedWriteValue("multi_select", [])).toBeUndefined();
		expect(writeSeedUnavailableReason("multi_select")).toContain(
			"multiple-choice question",
		);
	});
});

describe("changing what a change does", () => {
	const create = seedCaseOperation(
		{ kind: "create", caseType: "patient" },
		new Set(),
	);

	it("drops exactly the facets the destination action forbids", () => {
		const asClose = reshapeForAction(
			create,
			"close",
			{ kind: "session" },
			"patient",
		);
		// Close forbids a new target, a name, an owner, a rename, a retype,
		// and links, and keeps its writes, so "record and close" is one change.
		expect(asClose.action).toBe("close");
		expect(asClose.target).toEqual({ kind: "session" });
		expect(asClose.name).toBeUndefined();
		expect("name" in asClose).toBe(false);
	});

	it("closing preserves final writes while removing every forbidden authored facet", () => {
		const writes = [
			seedCaseOperationWrite("outcome", {
				kind: "term",
				term: { kind: "literal", value: "done" },
			}),
		];
		const held: TargetedCaseOperation = {
			uuid: testUuid("closing-update"),
			id: "update_patient",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes,
			rename: { kind: "term", term: { kind: "literal", value: "New name" } },
			retype: "visit",
			owner: { kind: "term", term: { kind: "literal", value: "worker" } },
			links: [
				{
					identifier: "parent",
					targetType: "patient",
					target: null,
					relationship: "child",
				},
			],
		};
		const next = reshapeForAction(
			held,
			"close",
			{ kind: "session" },
			"patient",
		);
		expect(next).toStrictEqual({
			uuid: held.uuid,
			id: held.id,
			action: "close",
			caseType: "patient",
			target: { kind: "session" },
			writes,
		});
		expect(next.writes).toBe(writes);
		expect(actionChangeLosses(held, "close")).toStrictEqual([
			"the owner it sets",
			"its links",
			"the new name it gives the case",
			"the type change",
		]);
	});

	it("still passes the gate after the change of action", () => {
		const { doc, formUuid } = caseFirstDoc();
		for (const action of ["update"] as const) {
			const reshaped = reshapeForAction(
				create,
				action,
				{ kind: "session" },
				"patient",
			);
			expect(commits(doc, formUuid, reshaped).ok).toBe(true);
		}
	});

	it("retargets both identity and type when a referral create becomes a patient update", () => {
		const referral = seedCaseOperation(
			{ kind: "create", caseType: "referral" },
			new Set(),
		);
		const reshaped = reshapeForAction(
			referral,
			"update",
			{ kind: "session" },
			"patient",
		);
		expect(reshaped).toMatchObject({
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
		});
		expect(reshaped).not.toHaveProperty("name");
		const { doc, formUuid } = caseFirstDoc();
		expect(commits(doc, formUuid, reshaped).ok).toBe(true);
	});

	it("names what the author would lose, so the confirmation can say it", () => {
		expect(actionChangeLosses(create, "close")).toContain(
			"the new case it makes",
		);
		expect(actionChangeLosses(create, "close")).toContain("the name it sets");
		// Nothing is lost turning a plain session update into a close.
		const update = seedCaseOperation(
			{ kind: "update-session", caseType: "patient" },
			new Set(),
		);
		expect(actionChangeLosses(update, "close")).toEqual([]);
	});
});

describe("updating the worker's record", () => {
	const COLOR = testUuid("77777777-7777-4777-8777-777777777777");
	const MOOD = testUuid("88888888-8888-4888-8888-888888888888");

	/** A survey form beside the case-first one, in an app that declares two
	 *  worker properties. */
	function workerDoc(): { doc: BlueprintDoc; formUuid: Uuid } {
		const { doc, formUuid } = caseFirstDoc();
		const withWorkers = produce(doc, (draft) => {
			draft.userProperties = {
				[COLOR]: { uuid: COLOR, slug: "favorite_color", label: "Color" },
				[MOOD]: { uuid: MOOD, slug: "mood", label: "Mood" },
			} as typeof draft.userProperties;
			draft.userPropertyOrder = [COLOR, MOOD];
		});
		return { doc: withWorkers, formUuid };
	}

	const answers = [
		{ uuid: NAME, dataType: "text" as const },
		{ uuid: ANSWER, dataType: "int" as const },
	];

	it("is offered only where the app declares worker properties", () => {
		expect(workerRecordSeed([], () => undefined, answers)).toBeUndefined();
	});

	it("is born an update of the worker's record saving the first property from the first answer that fits, and the gate admits it", () => {
		const { doc, formUuid } = workerDoc();
		const seed = workerRecordSeed(
			[{ slug: "favorite_color" }, { slug: "mood" }],
			() => undefined,
			[
				{ uuid: ANSWER, dataType: "int" },
				{ uuid: NAME, dataType: "text" },
			],
		);
		if (seed === undefined) throw new Error("Expected a seed");
		const operation = seedCaseOperation(seed, new Set());
		expect(operation).toMatchObject({
			action: "update",
			caseType: "commcare-user",
			target: { kind: "worker-record" },
			writes: [
				{
					property: "favorite_color",
					value: { kind: "term", term: { kind: "field", uuid: NAME } },
				},
			],
		});
		expect(caseOperationAddVerdict(doc, formUuid, operation)).toEqual({
			ok: true,
		});
		expect(commits(doc, formUuid, operation).ok).toBe(true);
	});

	it("starts from an empty value where no answer can be stored as text", () => {
		const seed = workerRecordSeed([{ slug: "mood" }], () => undefined, [
			{ uuid: ANSWER, dataType: "geopoint" },
		]);
		expect(seed).toMatchObject({
			property: "mood",
			value: { kind: "term", term: { kind: "literal", value: "" } },
		});
	});

	it("is refused with the gate's reason once the form already updates the worker's record", () => {
		const { doc, formUuid } = workerDoc();
		const seed = workerRecordSeed([{ slug: "mood" }], () => undefined, answers);
		if (seed === undefined) throw new Error("Expected a seed");
		const first = seedCaseOperation(seed, new Set());
		const landed = produce(doc, (draft) => {
			applyMutations(draft, addCaseOperationMutations(doc, formUuid, first));
		});
		const second = seedCaseOperation(
			seed,
			takenOperationIds(landed.forms[formUuid]?.caseOperations ?? []),
		);
		const verdict = caseOperationAddVerdict(landed, formUuid, second);
		expect(verdict.ok).toBe(false);
		expect(verdict.ok ? "" : verdict.reason).toContain(
			"This form already saves to the worker's record",
		);
	});
});
