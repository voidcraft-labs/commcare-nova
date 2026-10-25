// A form of a search-first module reads what the search found as the entry
// opened it: a device's session keeps its query step, and Preview's form keeps
// the snapshot it opened with. Every step of an App Test's entry, and its
// submission, read that one snapshot, even when the records the search reads
// change in between; a new entry reads the search again.
//
// The isolated store is replaced by a controlled one whose search population
// grows between steps; the session's own composition reads it.

import { expect, it } from "vitest";
import { buildCaseTypeMap } from "@/lib/case-store";
import {
	instanceReadsDoc,
	reads,
	searchResults,
	setCalculate,
} from "@/lib/domain/expression/__tests__/instanceReadsFixture";
import { resolveAppLanguage } from "@/lib/domain/localization";
import {
	TEST_ANDROID_DEVICE_ID,
	WEB_APPS_RULES,
} from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { serverPreviewDevice } from "@/lib/preview/engine/previewDevice";
import { previewAsMe } from "../../engine/identity";
import { previewLookupData } from "../../engine/lookupEvaluation";
import type { AppTestContext } from "../context";
import { advanceAppTest } from "../run";
import type { AppTestSessionState } from "../types";

function patient(caseId: string) {
	return {
		case_id: caseId,
		app_id: "app-1",
		case_type: "patient",
		owner_id: "worker",
		case_name: caseId,
		status: "open",
		opened_on: new Date("2026-08-01T00:00:00.000Z"),
		modified_on: new Date("2026-08-02T00:00:00.000Z"),
		closed_on: null,
		external_id: null,
		properties: { district: "north" },
	};
}

function journey() {
	const doc = instanceReadsDoc();
	setCalculate(doc, reads.found, {
		kind: "count",
		via: searchResults(),
	});
	const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
	if (identity === null) throw new Error("The fixture has no worker.");
	const population = [patient("p1")];
	let searchReads = 0;
	const store = {
		query: async () => {
			searchReads += 1;
			return population.map((row) => ({ ...row }));
		},
		count: async () => population.length,
		queryGrouped: async () => {
			throw new Error("The search read is not grouped.");
		},
		readCaseDatabasePatch: async () => ({ rows: [], indices: [] }),
	};
	const language = resolveAppLanguage(doc.localization, undefined);
	const context = {
		language,
		clock: { timeZone: "UTC", today: "2026-08-03" },
		locations: [],
		testPlaceIds: [],
		testAssignmentPersonaIds: [],
		doc: { ...doc, caseTypes: doc.caseTypes ?? [] },
		store,
		identity,
		caseTypeSchemas: buildCaseTypeMap(doc),
		restoreScope: { ownerIds: ["worker"] },
		device: serverPreviewDevice({
			platform: "web-apps",
			appLanguage: "en",
			androidDeviceId: TEST_ANDROID_DEVICE_ID,
		}),
		rules: WEB_APPS_RULES,
		lookup: previewLookupData({
			projectRevision: "0",
			definitions: [],
			rowsByTable: new Map(),
		}),
	} as unknown as AppTestContext;
	const entryCases = { rows: [patient("p1")], indices: [] };
	const state = {
		language,
		platform: "web-apps",
		androidDeviceId: TEST_ANDROID_DEVICE_ID,
		personaUuid: null,
		screen: {
			kind: "form",
			moduleUuid: reads.find,
			formUuid: reads.checkIn,
			caseIds: ["p1"],
			entryCases,
		},
		history: [{ kind: "records", moduleUuid: reads.find, searchAnswers: [] }],
		selections: {},
		deviceCases: entryCases,
		claimedCaseIds: [],
	} as unknown as AppTestSessionState;
	return {
		context,
		state,
		scope: {
			appId: "app-1",
			actorUserId: "worker",
			projectId: "project-1",
			role: "owner",
			blueprintSeq: 1,
			blueprintDigest: "digest",
		},
		grow: () => population.push(patient(`p${population.length + 1}`)),
		searchReads: () => searchReads,
	};
}

function found(state: AppTestSessionState) {
	if (state.screen.kind !== "form") throw new Error("The form closed.");
	return state.screen.searchResults?.totalMatches;
}

it("reads the search once for the whole entry, and again for a new one", async () => {
	const { context, state, scope, grow, searchReads } = journey();
	const opened = await advanceAppTest(context, scope, state, {
		kind: "observe",
	});
	expect(found(opened.state)).toBe(1);

	grow();
	const answered = await advanceAppTest(context, scope, opened.state, {
		kind: "answer",
		answers: [{ path: "name", value: "Ada" }],
	});
	const observed = await advanceAppTest(context, scope, answered.state, {
		kind: "observe",
	});
	expect(found(observed.state)).toBe(1);
	expect(searchReads()).toBe(1);

	// Going Back to the form from a later screen opens a new entry.
	const reopened = await advanceAppTest(
		context,
		scope,
		{
			...observed.state,
			screen: { kind: "home" },
			history: [...observed.state.history, observed.state.screen],
		},
		{ kind: "back" },
	);
	expect(found(reopened.state)).toBe(2);
	expect(searchReads()).toBe(2);
});
