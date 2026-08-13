/**
 * Implementation-coordinate derivation for committed intent provenance.
 *
 * The commit-time proof walks a step's admitted mutations and records one
 * coordinate per touched entity. The switch is compile-time exhaustive over
 * `Mutation` (a new kind is a type error, never a silent app-scope
 * fall-through); these tests pin the runtime halves that exhaustiveness
 * cannot: the worker-property trio lands entity coordinates like its
 * sibling collections, the deliberately app-scoped kinds stay app-scoped,
 * and every produced coordinate parses under the persisted schema.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { designIdSchema } from "@/lib/agent/design/ids";
import { implementationCoordinateSchema } from "@/lib/agent/design/projection/coordinates";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import { proveIntentCoverage } from "../intentCoverage";
import type { ChangeSetStep, DesignChangeSet } from "../types";

const INTENT = designIdSchema.parse("11111111-1111-4111-8111-111111111111");
const APP_ID = "app-coverage-1";

function changeSet(): DesignChangeSet {
	return {
		id: "set-1",
		kind: "app-edit",
		appId: APP_ID,
		proposedAppId: null,
		baseSeq: 1,
		baseProjectId: "project-1",
		baseSnapshotDigest: "a".repeat(64),
		revision: 1,
		nextOrdinal: 2,
		exclusiveKind: null,
		ownerUserId: "user-1",
		ownerRunId: "run-1",
		status: "open",
		committedSeq: null,
		committedBatchId: null,
		committedSnapshotDigest: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		designSessionId: "session-1",
		designRevisionId: designIdSchema.parse(
			"22222222-2222-4222-8222-222222222222",
		),
		buildPlanId: designIdSchema.parse("33333333-3333-4333-8333-333333333333"),
		sliceId: designIdSchema.parse("44444444-4444-4444-8444-444444444444"),
		designRevisionDigest: "c".repeat(64),
		buildPlanDigest: "d".repeat(64),
		attemptId: "attempt-1",
	};
}

function step(mutations: Mutation[]): ChangeSetStep {
	return {
		ordinal: 1,
		requestId: "request-1",
		toolName: "test-tool",
		mutations: admitMutationBatch(mutations),
		mutationDigest: "b".repeat(64),
		intentIds: [INTENT],
		readSet: [],
		stages: [],
	};
}

function coordinatesFor(mutations: Mutation[]) {
	return proveIntentCoverage({
		changeSet: changeSet(),
		steps: [step(mutations)],
		expectedOwningIntentIds: [INTENT],
		appId: APP_ID,
	}).provenance.map((row) => row.coordinate);
}

describe("proveIntentCoverage coordinates", () => {
	it("records worker-property coordinates for the worker-property trio", () => {
		const added = testUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
		const updated = testUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2");
		const removed = testUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3");
		const coordinates = coordinatesFor([
			{
				kind: "addUserProperty",
				property: {
					uuid: added,
					slug: "staff_role",
					label: "Staff role",
					required: false,
					choices: ["intake", "coordinator"],
				},
			},
			{ kind: "updateUserProperty", uuid: updated, patch: {} },
			{ kind: "removeUserProperty", uuid: removed },
		]);
		expect(coordinates).toEqual([
			{ kind: "worker-property", uuid: added },
			{ kind: "worker-property", uuid: updated },
			{ kind: "worker-property", uuid: removed },
		]);
	});

	it("keeps the deliberately app-scoped kinds at app scope", () => {
		const coordinates = coordinatesFor([
			{ kind: "setAppName", name: "Nutrition tracker" },
			{ kind: "declareCaseType", caseType: "visit" },
		]);
		// Both mutations dedupe onto the ONE app coordinate.
		expect(coordinates).toEqual([{ kind: "app", appId: APP_ID }]);
	});

	it("every produced coordinate parses under the persisted schema", () => {
		const moduleUuid = testUuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1");
		const propertyUuid = testUuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2");
		const coordinates = coordinatesFor([
			{ kind: "renameModule", uuid: moduleUuid, newId: "households" },
			{ kind: "removeUserProperty", uuid: propertyUuid },
			{ kind: "setAppName", name: "Renamed" },
			{
				kind: "removeCaseProperty",
				caseType: "household",
				property: "head_name",
			},
		]);
		for (const coordinate of coordinates) {
			expect(implementationCoordinateSchema.parse(coordinate)).toEqual(
				coordinate,
			);
		}
	});
});
