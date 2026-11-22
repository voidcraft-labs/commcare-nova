// The places an owner moved to a place is resolved among: the ones the entry
// opened with, read from the live tree only for an entry that carried none.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	LOCATION_FORM,
	locationOwnerFixture,
} from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import { buildSubmissionOperationProgram } from "../caseDataBindingHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";
import type { ResolvedPreviewIdentity } from "../identity";

const readWorkerLocationIds = vi.hoisted(() => vi.fn());
vi.mock("../workerLocationFixture", () => ({ workerPlaceIds:readWorkerLocationIds }));

const PERSONA = testUuid("worker-places-persona");
const REGION = testUuid("worker-places-region");
const CLINIC = testUuid("worker-places-clinic");
const DISTRICT = testUuid("worker-places-district");

function submit(workerPlaceIds?: readonly string[]) {
	const doc = locationOwnerFixture("direct");
	doc.personas = {
		[PERSONA]: {
			uuid: PERSONA,
			name: "Asha",
			locations: { primaryUuid: REGION },
		},
	};
	const mutation: SubmissionMutation = {
		kind: "followup",
		formUuid: LOCATION_FORM,
		entryKey: "11111111-1111-4111-8111-111111111111",
		attachmentRefs: [],
		caseIds: ["patient-1"],
		operationAnswers: { root: [], repeats: [] },
	};
	const identity: ResolvedPreviewIdentity = {
		actorUserId: "worker-places-actor",
		ownerId: PERSONA,
		personaUuid: PERSONA,
		session: { context: {}, user: {}, userPropertySlugs: {} },
		usercase: {},
	};
	return buildSubmissionOperationProgram({
		device: webAppsDevice(),
		appId: "worker-places-app",
		committedApp: { blueprint: doc, mutation_seq: 1 },
		blueprintDigest: "0".repeat(64),
		identity,
		lookupScope: {
			projectId: "p",
			actorId: "worker-places-actor",
			role: "owner",
		},
		lookupTableSchemas: new Map(),
		mutation,
		projection: validateCaptureSubmissionProjection(mutation),
		...(workerPlaceIds === undefined ? {} : { workerPlaceIds }),
	});
}

describe("the places an owner moved to a place is resolved among", () => {
	beforeEach(() => {
		readWorkerLocationIds.mockReset();
	});

	it("are the ones the entry opened with, without reading the tree", async () => {
		const built = await submit([CLINIC]);
		expect(built.program?.workerPlaceIds).toEqual([CLINIC]);
		expect(readWorkerLocationIds).not.toHaveBeenCalled();
	});

	it("are the worker's footprint now when the entry carried none", async () => {
		readWorkerLocationIds.mockResolvedValueOnce([REGION, DISTRICT]);
		const built = await submit();
		expect(readWorkerLocationIds).toHaveBeenCalledWith("worker-places-app",expect.anything(),PERSONA);
		expect(built.program?.workerPlaceIds).toEqual([REGION, DISTRICT]);
	});
});
