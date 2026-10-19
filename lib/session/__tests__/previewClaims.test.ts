/**
 * A Preview worker's claims: the searched cases it chose that its restore did
 * not hold. The reducer keys them by app and worker; the session store keeps
 * them through everything that ends no worker session and drops them at
 * every change of worker, Project or app.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { previewClaimedCaseIds } from "@/lib/preview/engine/previewAuthorization";
import type { EntryPointPreviewLaunch } from "@/lib/preview/entryPointLaunchTypes";
import {
	addClaims,
	claimsFor,
	PREVIEW_AS_ME_WORKER,
	PREVIEW_CLAIMS_LIMIT,
	previewClaimsWorker,
} from "../previewClaims";
import { createBuilderSessionStore } from "../store";

const APP = "app-1";
const NURSE = testUuid("persona-nurse");
const DOCTOR = testUuid("persona-doctor");

function claimedIn(store: ReturnType<typeof createBuilderSessionStore>) {
	const state = store.getState();
	return claimsFor(
		state.previewClaims,
		state.appId,
		previewClaimsWorker(state.previewPersonaUuid),
	);
}

function previewingAs(personaUuid: string | undefined) {
	const store = createBuilderSessionStore({
		appId: APP,
		projectId: "project-1",
		role: "owner",
		canEdit: true,
	});
	store.getState().setPreviewing(true);
	store.getState().setPreviewPersonaUuid(personaUuid);
	return store;
}

function launch(personaUuid: string | undefined): EntryPointPreviewLaunch {
	return {
		entryPointUuid: testUuid("entry-point"),
		expectedSeq: 1,
		location: { kind: "home" },
		...(personaUuid === undefined ? {} : { personaUuid }),
		menuSelections: {},
		ignoreDisplayConditions: false,
	};
}

describe("previewClaims reducer", () => {
	it("appends new claims in order and keeps each case once", () => {
		const first = addClaims(undefined, APP, NURSE, ["a", "b"]);
		const second = addClaims(first, APP, NURSE, ["b", "c", "a", "d"]);
		expect(claimsFor(second, APP, NURSE)).toEqual(["a", "b", "c", "d"]);
	});

	it("returns the same claims when nothing new is claimed", () => {
		const held = addClaims(undefined, APP, NURSE, ["a"]);
		expect(addClaims(held, APP, NURSE, ["a"])).toBe(held);
		expect(addClaims(held, APP, NURSE, [])).toBe(held);
	});

	it("reads no claims for another app or another worker", () => {
		const held = addClaims(undefined, APP, NURSE, ["a"]);
		expect(claimsFor(held, "app-2", NURSE)).toEqual([]);
		expect(claimsFor(held, APP, DOCTOR)).toEqual([]);
		expect(claimsFor(held, APP, PREVIEW_AS_ME_WORKER)).toEqual([]);
		expect(claimsFor(held, undefined, NURSE)).toEqual([]);
	});

	it("starts a fresh set when another worker claims", () => {
		const nurse = addClaims(undefined, APP, NURSE, ["a"]);
		const doctor = addClaims(nurse, APP, DOCTOR, ["b"]);
		expect(claimsFor(doctor, APP, DOCTOR)).toEqual(["b"]);
		expect(claimsFor(doctor, APP, NURSE)).toEqual([]);
	});

	it("keeps the most recent claims the server reads once the set is full", () => {
		const ids = (from: number, count: number) =>
			Array.from({ length: count }, (_, index) => `case-${from + index}`);
		const full = addClaims(undefined, APP, NURSE, ids(0, PREVIEW_CLAIMS_LIMIT));
		const past = addClaims(full, APP, NURSE, [
			"case-0",
			...ids(PREVIEW_CLAIMS_LIMIT, 2),
		]);
		const held = claimsFor(past, APP, NURSE);
		expect(held).toEqual(ids(2, PREVIEW_CLAIMS_LIMIT));
		expect(previewClaimedCaseIds([...held])).toEqual(held);
		const burst = addClaims(
			undefined,
			APP,
			NURSE,
			ids(0, PREVIEW_CLAIMS_LIMIT + 5),
		);
		expect(claimsFor(burst, APP, NURSE)).toEqual(ids(5, PREVIEW_CLAIMS_LIMIT));
	});

	it("names the signed-in member's worker apart from every persona", () => {
		expect(previewClaimsWorker(undefined)).toBe(PREVIEW_AS_ME_WORKER);
		expect(previewClaimsWorker(NURSE)).toBe(NURSE);
	});
});

describe("previewClaims in the session store", () => {
	it("claims for the current worker of the current app", () => {
		const store = previewingAs(NURSE);
		store.getState().addPreviewClaims(["a"]);
		store.getState().addPreviewClaims(["b", "a"]);
		expect(claimedIn(store)).toEqual(["a", "b"]);
		expect(store.getState().previewClaims).toEqual({
			appId: APP,
			worker: NURSE,
			caseIds: ["a", "b"],
		});
	});

	it("keeps the claims through Home and the running task's own changes", () => {
		const store = previewingAs(NURSE);
		store.getState().addPreviewClaims(["a"]);
		store.getState().setPreviewMenuCaseSelection(testUuid("module"), {
			caseType: "patient",
			cases: [{ caseId: "a" }],
		});
		store.getState().setPreviewCaseTarget({
			formUuid: testUuid("form"),
			cases: [{ caseId: "a" }],
		});
		store.getState().clearPreviewNavigation();
		store.getState().setPreviewCaseTarget(undefined);
		store.getState().setPreviewSearchState(testUuid("module"), undefined);
		expect(claimedIn(store)).toEqual(["a"]);
	});

	it("keeps the claims through a launch as the same worker", () => {
		const store = previewingAs(NURSE);
		store.getState().addPreviewClaims(["a"]);
		store.getState().installEntryPointLaunch(launch(NURSE));
		expect(claimedIn(store)).toEqual(["a"]);
	});

	it("drops the claims when the worker changes", () => {
		const store = previewingAs(NURSE);
		store.getState().addPreviewClaims(["a"]);
		store.getState().setPreviewPersonaUuid(DOCTOR);
		expect(store.getState().previewClaims).toBeUndefined();
		store.getState().setPreviewPersonaUuid(NURSE);
		expect(claimedIn(store)).toEqual([]);
	});

	it("drops the claims when an entry point launches as another worker", () => {
		const store = previewingAs(NURSE);
		store.getState().addPreviewClaims(["a"]);
		store.getState().installEntryPointLaunch(launch(undefined));
		expect(store.getState().previewClaims).toBeUndefined();
	});

	it("drops the claims when Preview closes", () => {
		const store = previewingAs(undefined);
		store.getState().addPreviewClaims(["a"]);
		store.getState().setPreviewing(false);
		expect(store.getState().previewClaims).toBeUndefined();
	});

	it("drops the claims at a confirmed change of Project, not at a refresh", () => {
		const store = previewingAs(NURSE);
		store.getState().addPreviewClaims(["a"]);
		store.getState().applyAccessSnapshot({
			projectId: "project-1",
			role: "owner",
			canEdit: true,
		});
		expect(claimedIn(store)).toEqual(["a"]);
		store.getState().applyAccessSnapshot({
			projectId: "project-2",
			role: "owner",
			canEdit: true,
		});
		expect(store.getState().previewClaims).toBeUndefined();
	});

	it("reads no claims once the app changes", () => {
		const store = previewingAs(NURSE);
		store.getState().addPreviewClaims(["a"]);
		store.getState().setAppId("app-2");
		expect(claimedIn(store)).toEqual([]);
	});

	it("drops the claims on reset", () => {
		const store = previewingAs(NURSE);
		store.getState().addPreviewClaims(["a"]);
		store.getState().reset();
		expect(store.getState().previewClaims).toBeUndefined();
	});
});
