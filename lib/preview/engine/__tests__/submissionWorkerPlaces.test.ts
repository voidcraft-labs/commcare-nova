// The places an owner moved to a place is resolved among: the ones the entry
// opened with, read from the live tree only for an entry that carried none.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	LOCATION_FORM,
	LOCATION_LEVELS,
	locationOwnerFixture,
} from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import type { Uuid } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import { buildSubmissionOperationProgram } from "../caseDataBindingHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";
import type { ResolvedPreviewIdentity } from "../identity";

const readOrganizationPlaces = vi.hoisted(() => vi.fn());
vi.mock("@/lib/organization/service", () => ({ readOrganizationPlaces }));

const PERSONA = testUuid("worker-places-persona");
const REGION = testUuid("worker-places-region");
const CLINIC = testUuid("worker-places-clinic");
const OTHER_REGION = testUuid("worker-places-other-region");
const DISTRICT = testUuid("worker-places-district");

function place(id: Uuid, level: number, parentId: Uuid | null): StoredLocation {
	return {
		id,
		levelUuid: LOCATION_LEVELS[level].uuid,
		parentId,
		siteCode: id.slice(0, 8),
		name: id,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: null,
		orderKey: "a",
	};
}

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
		patch: { properties: {} },
		children: [],
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
		readOrganizationPlaces.mockReset();
	});

	it("are the ones the entry opened with, without reading the tree", async () => {
		const built = await submit([CLINIC]);
		expect(built.program?.workerPlaceIds).toEqual([CLINIC]);
		expect(readOrganizationPlaces).not.toHaveBeenCalled();
	});

	it("are the worker's footprint now when the entry carried none", async () => {
		readOrganizationPlaces.mockResolvedValueOnce([
			place(REGION, 0, null),
			place(DISTRICT, 1, REGION),
			place(OTHER_REGION, 0, null),
		]);
		const built = await submit();
		expect(readOrganizationPlaces).toHaveBeenCalledWith("worker-places-app");
		expect(built.program?.workerPlaceIds).toEqual([REGION, DISTRICT]);
	});
});
