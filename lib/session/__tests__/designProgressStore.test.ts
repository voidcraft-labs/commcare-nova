import { expect, it } from "vitest";
import {
	createDesignProgressStore,
	deriveDesignProgressView,
} from "../designProgressStore";

const scope = { designSessionId: "session", materializedAppId: null };
const plan = {
	revision: 2,
	markdown: "Register loans, then return the selected loan.",
	reviewedRevision: 2,
};

it("keeps cold-loaded state ahead of old or unrelated replay frames", () => {
	const store = createDesignProgressStore();
	store
		.getState()
		.seedSession({ ...scope, revision: 8, stage: "building", plan });
	const before = store.getState();
	store.getState().applyProgressFrame("data-authoring-progress", {
		sessionId: "session",
		revision: 7,
		stage: "planning",
	});
	store.getState().applyProgressFrame("data-authoring-progress", {
		sessionId: "other",
		revision: 9,
		stage: "ready",
	});
	store.getState().applyProgressFrame("data-authoring-progress", {
		sessionId: "session",
		revision: "nine",
		stage: "ready",
	});
	expect(store.getState()).toEqual(before);
	store.getState().applyProgressFrame("data-authoring-progress", {
		sessionId: "session",
		revision: 9,
		stage: "reviewing-app",
	});
	expect(deriveDesignProgressView(store.getState())).toMatchObject({
		stage: "reviewing-app",
		working: true,
		plan,
	});
});

it("projects actual plan revisions and preserves review completion on duplicate frames", () => {
	const store = createDesignProgressStore();
	store.getState().beginSession(scope);
	const frame = (value: typeof plan) =>
		store.getState().applyProgressFrame("data-authoring-plan", {
			sessionId: "session",
			plan: value,
		});
	frame(plan);
	frame({ ...plan, revision: 1, markdown: "Old plan", reviewedRevision: 1 });
	frame({ ...plan, markdown: "Conflicting duplicate" });
	expect(store.getState().plan).toEqual(plan);
	frame({
		revision: 3,
		markdown: "Record the tool's condition on return.",
		reviewedRevision: 2,
	});
	frame({
		revision: 3,
		markdown: "Record the tool's condition on return.",
		reviewedRevision: 3,
	});
	expect(store.getState().plan).toEqual({
		revision: 3,
		markdown: "Record the tool's condition on return.",
		reviewedRevision: 3,
	});
});

it("retains ongoing work through app birth and reconnect, then clears it for an ordinary edit", () => {
	const store = createDesignProgressStore();
	store
		.getState()
		.seedSession({ ...scope, revision: 4, stage: "reviewing-app", plan });
	store.getState().markMaterialized("app");
	store.getState().noteTurnOpened();
	store.getState().beginSession({ ...scope, materializedAppId: "app" });
	expect(deriveDesignProgressView(store.getState())).toMatchObject({
		stage: "reviewing-app",
		materialized: true,
		plan,
	});
	store.getState().applyProgressFrame("data-authoring-progress", {
		sessionId: "session",
		revision: 5,
		stage: "ready",
	});
	store.getState().markFailed("The stream disconnected", { recoverable: true });
	expect(deriveDesignProgressView(store.getState())).toMatchObject({
		stage: "ready",
		working: false,
	});
	store.getState().noteTurnOpened();
	expect(deriveDesignProgressView(store.getState())).toMatchObject({
		active: false,
		plan: null,
	});
});

it("resumes stopped work without dropping the plan or exposing another session's state", () => {
	const store = createDesignProgressStore();
	store.getState().seedSession({
		...scope,
		materializedAppId: "app",
		revision: 6,
		stage: "incomplete",
		plan,
	});
	store.getState().noteTurnOpened();
	expect(deriveDesignProgressView(store.getState())).toMatchObject({
		stage: "building",
		working: true,
		plan,
	});
	store.getState().setAwaitingInput(true);
	expect(deriveDesignProgressView(store.getState())).toMatchObject({
		stage: "needs-input",
		working: false,
	});
	store.getState().markFailed("Access was revoked", { recoverable: false });
	expect(deriveDesignProgressView(store.getState())).toMatchObject({
		stage: "failed",
		working: false,
	});
	store
		.getState()
		.beginSession({ designSessionId: "other", materializedAppId: null });
	expect(deriveDesignProgressView(store.getState())).toMatchObject({
		stage: "planning",
		materialized: false,
		plan: null,
		failure: null,
	});
});
