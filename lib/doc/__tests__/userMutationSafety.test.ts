import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, withUserSequences } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import { removeUserPropertyPlan } from "@/lib/doc/userMutations";
import type { BlueprintDoc } from "@/lib/domain";
import { eq, literal, sessionUserProperty } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const PROPERTY_A = testUuid("__proto__");
const PROPERTY_B = testUuid("constructor");
const TYPE = testUuid("toString");
const PERSONA = testUuid("hasOwnProperty");

function ownRecord<T>(
	entries: ReadonlyArray<readonly [string, T]>,
): Record<string, T> {
	return Object.fromEntries(entries);
}

function fold(doc: BlueprintDoc, ...batches: Mutation[][]): BlueprintDoc {
	return produce(doc, (draft) => {
		for (const batch of batches) applyMutations(draft, batch);
	});
}

function userDoc(): BlueprintDoc {
	return withUserSequences({
		...buildDoc(),
		userProperties: ownRecord([
			[PROPERTY_A, { uuid: PROPERTY_A, slug: "__proto__", label: "Prototype" }],
			[
				PROPERTY_B,
				{ uuid: PROPERTY_B, slug: "constructor", label: "Constructor" },
			],
		]),
		userTypes: ownRecord([
			[
				TYPE,
				{
					uuid: TYPE,
					name: "Hostile-key role",
					values: ownRecord([
						[PROPERTY_A, "north"],
						[PROPERTY_B, "community"],
					]),
				},
			],
		]),
		personas: ownRecord([
			[
				PERSONA,
				{
					uuid: PERSONA,
					name: "Hostile-key persona",
					userTypeUuid: TYPE,
					values: ownRecord([[PROPERTY_A, "south"]]),
				},
			],
		]),
	});
}

function valueUpdate(
	kind: "updateUserType" | "updatePersona",
	uuid: string,
	propertyUuid: string,
	value: string | null,
): Mutation {
	return {
		kind,
		uuid: testUuid(uuid),
		patch: {},
		valuePatch: { userPropertyUuid: testUuid(propertyUuid), value },
	} as Mutation;
}

describe("user collection mutations", () => {
	it.each(["2fa_region", "-area"])(
		"refuses the XML-unsafe slug %s at the shared commit gate",
		(slug) => {
			const propertyUuid = testUuid(`property-${slug}`);
			const verdict = mutationCommitVerdict(
				buildDoc(),
				[
					{
						kind: "addUserProperty",
						property: {
							uuid: propertyUuid,
							slug,
							label: "Invalid worker information",
						},
					},
				],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);

			expect(verdict.ok).toBe(false);
			if (verdict.ok) throw new Error("invalid slug unexpectedly passed");
			expect(verdict.findings.map((finding) => finding.code)).toContain(
				"MUTATION_WIRE_CANONICALITY_INVALID",
			);
		},
	);

	it("adds, updates, and removes hostile schema-valid record keys as own data", () => {
		const empty = buildDoc();
		const added = fold(empty, [
			{
				kind: "addUserProperty",
				property: {
					uuid: PROPERTY_A,
					slug: "__proto__",
					label: "Prototype",
				},
			},
			{
				kind: "addUserType",
				userType: {
					uuid: TYPE,
					name: "Hostile-key role",
					values: ownRecord([[PROPERTY_A, "north"]]),
				},
			},
			{
				kind: "addPersona",
				persona: {
					uuid: PERSONA,
					name: "Hostile-key persona",
					userTypeUuid: TYPE,
				},
			},
		]);

		expect(Object.hasOwn(added.userProperties ?? {}, PROPERTY_A)).toBe(true);
		expect(Object.hasOwn(added.userTypes ?? {}, TYPE)).toBe(true);
		expect(Object.hasOwn(added.personas ?? {}, PERSONA)).toBe(true);
		expect(added.userProperties?.[PROPERTY_A]?.label).toBe("Prototype");

		const updated = fold(added, [
			{
				kind: "updateUserProperty",
				uuid: PROPERTY_A,
				patch: { label: "Own prototype" },
			},
			valueUpdate("updateUserType", TYPE, PROPERTY_A, "south"),
		]);
		expect(updated.userProperties?.[PROPERTY_A]?.label).toBe("Own prototype");
		expect(updated.userTypes?.[TYPE]?.values?.[PROPERTY_A]).toBe("south");

		const removed = fold(updated, [
			{ kind: "removePersona", uuid: PERSONA },
			{ kind: "removeUserType", uuid: TYPE },
			{ kind: "removeUserProperty", uuid: PROPERTY_A },
		]);
		expect(removed.personas).toBeUndefined();
		expect(removed.userTypes).toBeUndefined();
		expect(removed.userProperties).toBeUndefined();
		expect(Object.prototype).not.toHaveProperty("label");
	});

	it("merges concurrent writes to different value keys in either order", () => {
		const base = userDoc();
		const left = valueUpdate("updateUserType", TYPE, PROPERTY_A, "left");
		const right = valueUpdate("updateUserType", TYPE, PROPERTY_B, "right");

		const leftThenRight = fold(base, [left], [right]);
		const rightThenLeft = fold(base, [right], [left]);
		expect(leftThenRight.userTypes?.[TYPE]?.values).toEqual(
			ownRecord([
				[PROPERTY_A, "left"],
				[PROPERTY_B, "right"],
			]),
		);
		expect(rightThenLeft).toEqual(leftThenRight);
	});

	it("cleans a removed property with per-key mutations without clobbering a peer value", () => {
		const base = userDoc();
		const plan = removeUserPropertyPlan(base, PROPERTY_A);
		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error(plan.userMessage);
		const removal = plan.mutations;
		const cleanupEvents = removal.filter(
			(mutation) =>
				mutation.kind === "updateUserType" || mutation.kind === "updatePersona",
		);
		expect(cleanupEvents).toHaveLength(2);
		expect(
			cleanupEvents.every(
				(mutation) =>
					"valuePatch" in mutation &&
					mutation.valuePatch?.userPropertyUuid === PROPERTY_A &&
					mutation.valuePatch.value === null,
			),
		).toBe(true);

		const peer = valueUpdate("updateUserType", TYPE, PROPERTY_B, "peer edit");
		const removalThenPeer = fold(base, removal, [peer]);
		const peerThenRemoval = fold(base, [peer], removal);
		expect(removalThenPeer.userTypes?.[TYPE]?.values).toEqual(
			ownRecord([[PROPERTY_B, "peer edit"]]),
		);
		expect(peerThenRemoval).toEqual(removalThenPeer);
	});

	it("refuses removal before cleanup when XPath or Predicate ASTs keep the identity", () => {
		const propertyUuid = testUuid("worker-region");
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					displayCondition: eq(
						sessionUserProperty(propertyUuid),
						literal("north"),
					),
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "notes",
									label: proseText("Notes"),
								}),
							],
						},
					],
				},
			],
		});
		doc.userProperties = {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "region",
				label: "Region",
			},
		};
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const fieldUuid = doc.fieldOrder[formUuid][0];
		(doc.fields[fieldUuid] as { relevant?: unknown }).relevant =
			parseXPathForForm(doc, formUuid, "#user/region = 'north'");
		doc.userTypes = {
			[TYPE]: {
				uuid: TYPE,
				name: "CHW",
				values: { [propertyUuid]: "north" },
			},
		};

		const plan = removeUserPropertyPlan(doc, propertyUuid);

		expect(plan).toEqual({
			ok: false,
			referenceCount: 2,
			references: [
				"condition in module “Patients”",
				"relevant condition on “notes”",
			],
			userMessage: expect.stringContaining(
				"Update or remove those references before removing",
			),
		});
		// Refusal happens before value-cleanup mutations are constructed.
		expect(plan).not.toHaveProperty("mutations");
	});

	it("reports distinct relevant and required slots on the same field", () => {
		const propertyUuid = testUuid("worker-region");
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "notes",
									label: proseText("Notes"),
								}),
							],
						},
					],
				},
			],
		});
		doc.userProperties = {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "region",
				label: "Region",
			},
		};
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const fieldUuid = doc.fieldOrder[formUuid][0];
		const reference = parseXPathForForm(
			doc,
			formUuid,
			"#user/region = 'north'",
		);
		if (doc.fields[fieldUuid].kind !== "text") {
			throw new Error("fixture field must be text");
		}
		doc.fields[fieldUuid].relevant = reference;
		doc.fields[fieldUuid].required = reference;

		expect(removeUserPropertyPlan(doc, propertyUuid)).toMatchObject({
			ok: false,
			referenceCount: 2,
			references: [
				"relevant condition on “notes”",
				"required condition on “notes”",
			],
		});
	});
});

describe("user collection diff", () => {
	it("treats an inherited-name UUID as absent unless it is an own record key", () => {
		const before = buildDoc();
		const after: BlueprintDoc = withUserSequences({
			...before,
			userTypes: ownRecord([
				[
					testUuid("constructor"),
					{ uuid: testUuid("constructor"), name: "Constructor role" },
				],
			]),
		});

		expect(diffDocsToMutations(before, after)).toEqual([
			{
				after: null,
				kind: "addUserType",
				userType: { uuid: testUuid("constructor"), name: "Constructor role" },
			},
		]);
		expect(diffDocsToMutations(after, before)).toEqual([
			{ kind: "removeUserType", uuid: testUuid("constructor") },
		]);
	});

	it("emits one semantic mutation per changed value key", () => {
		const before = userDoc();
		const after: BlueprintDoc = withUserSequences({
			...before,
			userTypes: ownRecord([
				[
					TYPE,
					{
						...before.userTypes?.[TYPE],
						uuid: TYPE,
						name: "Hostile-key role",
						values: ownRecord([
							[PROPERTY_A, "after-a"],
							[PROPERTY_B, "after-b"],
						]),
					},
				],
			]),
		});

		const updates = diffDocsToMutations(before, after).filter(
			(mutation) => mutation.kind === "updateUserType",
		);
		expect(updates).toHaveLength(2);
		expect(
			updates.map((mutation) => mutation.valuePatch?.userPropertyUuid).sort(),
		).toEqual([PROPERTY_A, PROPERTY_B].sort());
		expect(fold(before, updates).userTypes).toEqual(after.userTypes);
	});
});
