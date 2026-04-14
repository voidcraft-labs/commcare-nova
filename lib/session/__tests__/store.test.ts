/**
 * BuilderSession store — reducer-shaped action invariant tests.
 *
 * Tests exercise the store directly (no React, no provider) to verify:
 * - `switchCursorMode` preserves sidebar stash/restore semantics
 * - `switchConnectMode` composite action manages the connect stash + doc
 *   mutations atomically
 *
 * Connect stash tests use a real `createBlueprintDocStore()` with a fixture
 * blueprint to verify the cross-store dispatch contract.
 */

import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { createBuilderSessionStore } from "../store";

describe("BuilderSession store", () => {
	it("1. initial state: edit mode, both sidebars open, no stash", () => {
		const store = createBuilderSessionStore();
		const s = store.getState();
		expect(s.cursorMode).toBe("edit");
		expect(s.activeFieldId).toBeUndefined();
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });
	});

	it("2. switchCursorMode('pointer') from edit: stashes open values, closes both", () => {
		const store = createBuilderSessionStore();
		store.getState().switchCursorMode("pointer");
		const s = store.getState();
		expect(s.cursorMode).toBe("pointer");
		expect(s.sidebars.chat).toEqual({ open: false, stashed: true });
		expect(s.sidebars.structure).toEqual({ open: false, stashed: true });
	});

	it("3. switchCursorMode('edit') after pointer: restores stashed values, clears stash", () => {
		const store = createBuilderSessionStore();
		store.getState().switchCursorMode("pointer");
		store.getState().switchCursorMode("edit");
		const s = store.getState();
		expect(s.cursorMode).toBe("edit");
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });
	});

	it("4. switchCursorMode('pointer') with chat already closed: restores chat-closed state exactly", () => {
		const store = createBuilderSessionStore();

		/* Close chat before entering pointer mode. */
		store.getState().setSidebarOpen("chat", false);
		expect(store.getState().sidebars.chat.open).toBe(false);

		/* Enter pointer mode — stashes the current state (chat closed). */
		store.getState().switchCursorMode("pointer");
		const pointerState = store.getState();
		expect(pointerState.sidebars.chat).toEqual({
			open: false,
			stashed: false,
		});
		expect(pointerState.sidebars.structure).toEqual({
			open: false,
			stashed: true,
		});

		/* Return to edit — restores the stashed values exactly: chat stays
		 * closed (was closed before pointer), structure reopens. */
		store.getState().switchCursorMode("edit");
		const editState = store.getState();
		expect(editState.sidebars.chat).toEqual({
			open: false,
			stashed: undefined,
		});
		expect(editState.sidebars.structure).toEqual({
			open: true,
			stashed: undefined,
		});
	});

	it("5. switchCursorMode('pointer') twice is a no-op on the second call", () => {
		const store = createBuilderSessionStore();

		/* First switch: stashes both open values. */
		store.getState().switchCursorMode("pointer");
		const afterFirst = store.getState();

		/* Second switch: same mode → no-op. The stash must NOT be
		 * overwritten with { stashed: false } (the currently-closed values). */
		store.getState().switchCursorMode("pointer");
		const afterSecond = store.getState();

		/* State must be identical (same object reference from Zustand). */
		expect(afterSecond.cursorMode).toBe("pointer");
		expect(afterSecond.sidebars).toEqual(afterFirst.sidebars);

		/* Verify the stash still holds the original pre-pointer values, not
		 * the post-close false values. */
		expect(afterSecond.sidebars.chat.stashed).toBe(true);
		expect(afterSecond.sidebars.structure.stashed).toBe(true);
	});

	it("6. setSidebarOpen changes only the targeted sidebar, stash untouched", () => {
		const store = createBuilderSessionStore();

		store.getState().setSidebarOpen("chat", false);
		const s = store.getState();
		expect(s.sidebars.chat.open).toBe(false);
		expect(s.sidebars.chat.stashed).toBeUndefined();
		/* Structure sidebar unchanged. */
		expect(s.sidebars.structure.open).toBe(true);
		expect(s.sidebars.structure.stashed).toBeUndefined();
	});

	it("setCursorMode does not stash/restore sidebars", () => {
		const store = createBuilderSessionStore();

		/* Non-atomic setter: just sets the mode, no sidebar side-effects. */
		store.getState().setCursorMode("pointer");
		const s = store.getState();
		expect(s.cursorMode).toBe("pointer");
		/* Sidebars remain as initial state — no stash, still open. */
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });
	});

	it("setActiveFieldId updates and no-ops on same value", () => {
		const store = createBuilderSessionStore();

		store.getState().setActiveFieldId("label");
		expect(store.getState().activeFieldId).toBe("label");

		/* Same value — should not trigger a new state object. */
		const prev = store.getState();
		store.getState().setActiveFieldId("label");
		expect(store.getState()).toBe(prev);

		store.getState().setActiveFieldId(undefined);
		expect(store.getState().activeFieldId).toBeUndefined();
	});

	it("setSidebarOpen no-ops on same value", () => {
		const store = createBuilderSessionStore();
		const prev = store.getState();

		/* Chat is already open — setting to true is a no-op. */
		store.getState().setSidebarOpen("chat", true);
		expect(store.getState()).toBe(prev);
	});
});

// ── Focus hint ───────────────────────────────────────────────────────────

describe("BuilderSession focus hint", () => {
	it("setFocusHint stores the value, clearFocusHint resets to undefined", () => {
		const store = createBuilderSessionStore();
		expect(store.getState().focusHint).toBeUndefined();

		store.getState().setFocusHint("case_name");
		expect(store.getState().focusHint).toBe("case_name");

		store.getState().clearFocusHint();
		expect(store.getState().focusHint).toBeUndefined();
	});
});

// ── New question marker ──────────────────────────────────────────────────

describe("BuilderSession new-question marker", () => {
	it("markNewQuestion + isNewQuestion: matches uuid, rejects others", () => {
		const store = createBuilderSessionStore();
		store.getState().markNewQuestion("q-uuid");

		expect(store.getState().isNewQuestion("q-uuid")).toBe(true);
		expect(store.getState().isNewQuestion("other")).toBe(false);
	});

	it("clearNewQuestion resets so isNewQuestion returns false for all", () => {
		const store = createBuilderSessionStore();
		store.getState().markNewQuestion("q-uuid");
		store.getState().clearNewQuestion();

		expect(store.getState().isNewQuestion("q-uuid")).toBe(false);
		expect(store.getState().isNewQuestion("anything")).toBe(false);
	});
});

// ── Connect stash ────────────────────────────────────────────────────────

/**
 * Fixture blueprint for connect stash tests. One module with two forms —
 * enough to verify per-form stash keyed by uuid.
 */
const CONNECT_FIXTURE: AppBlueprint = {
	app_name: "ConnectTest",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			name: "Mod",
			forms: [
				{ name: "Form A", type: "registration", questions: [] },
				{ name: "Form B", type: "followup", questions: [] },
			],
		},
	],
};

/**
 * Helper: create a session store wired to a real doc store loaded with
 * the fixture blueprint. Returns both stores and the form uuids.
 */
function createConnectTestStores() {
	const docStore = createBlueprintDocStore();
	docStore.getState().load(CONNECT_FIXTURE, "test-app");
	docStore.temporal.getState().resume();

	const sessionStore = createBuilderSessionStore();
	sessionStore.getState()._setDocStore(docStore);

	const docState = docStore.getState();
	const moduleUuid = docState.moduleOrder[0];
	const formUuids = docState.formOrder[moduleUuid] ?? [];

	return {
		session: sessionStore,
		doc: docStore,
		formA: formUuids[0],
		formB: formUuids[1],
	};
}

describe("BuilderSession connect stash", () => {
	it("1. switchConnectMode('learn') from undefined sets doc connectType to 'learn', stash empty", () => {
		const { session, doc } = createConnectTestStores();

		/* Precondition: connect_type starts undefined (fixture has no connect_type). */
		expect(doc.getState().connectType).toBeNull();

		session.getState().switchConnectMode("learn");

		expect(doc.getState().connectType).toBe("learn");
		/* No outgoing mode to stash — both stash records remain empty. */
		expect(session.getState().connectStash.learn).toEqual({});
		expect(session.getState().connectStash.deliver).toEqual({});
	});

	it("2. switching learn->deliver stashes learn form configs, updates doc to 'deliver'", () => {
		const { session, doc, formA } = createConnectTestStores();

		/* Start in learn mode with a form-level connect config on Form A. */
		session.getState().switchConnectMode("learn");
		const learnConfig = {
			learn_module: {
				id: "mod",
				name: "Form A",
				description: "desc",
				time_estimate: 5,
			},
		};
		doc.getState().apply({
			kind: "updateForm",
			uuid: formA,
			patch: { connect: learnConfig },
		});

		/* Switch to deliver mode. */
		session.getState().switchConnectMode("deliver");

		/* Doc should now be in deliver mode. */
		expect(doc.getState().connectType).toBe("deliver");

		/* The learn stash should have Form A's config keyed by uuid. */
		const stash = session.getState().connectStash.learn;
		expect(stash[formA]).toBeDefined();
		expect(stash[formA].learn_module?.id).toBe("mod");

		/* lastConnectType should be 'learn' (the outgoing mode). */
		expect(session.getState().lastConnectType).toBe("learn");
	});

	it("3. switching deliver->learn restores stashed learn config onto the form", () => {
		const { session, doc, formA } = createConnectTestStores();

		/* Start in learn mode with Form A having a learn config. */
		session.getState().switchConnectMode("learn");
		const learnConfig = {
			learn_module: {
				id: "mod",
				name: "Form A",
				description: "desc",
				time_estimate: 5,
			},
		};
		doc.getState().apply({
			kind: "updateForm",
			uuid: formA,
			patch: { connect: learnConfig },
		});

		/* Switch to deliver, then back to learn. */
		session.getState().switchConnectMode("deliver");
		session.getState().switchConnectMode("learn");

		/* Doc should be back in learn mode with Form A's config restored. */
		expect(doc.getState().connectType).toBe("learn");
		const restoredForm = doc.getState().forms[formA];
		expect(restoredForm?.connect?.learn_module?.id).toBe("mod");
	});

	it("4. switchConnectMode(null) clears doc connectType and all form connect configs", () => {
		const { session, doc, formA, formB } = createConnectTestStores();

		/* Start in learn mode with configs on both forms. */
		session.getState().switchConnectMode("learn");
		doc.getState().applyMany([
			{
				kind: "updateForm",
				uuid: formA,
				patch: {
					connect: {
						learn_module: {
							id: "a",
							name: "A",
							description: "A",
							time_estimate: 5,
						},
					},
				},
			},
			{
				kind: "updateForm",
				uuid: formB,
				patch: {
					connect: {
						assessment: { id: "b", user_score: "100" },
					},
				},
			},
		]);

		/* Disable connect entirely. */
		session.getState().switchConnectMode(null);

		expect(doc.getState().connectType).toBeNull();
		/* Both forms' connect should be cleared. */
		expect(doc.getState().forms[formA]?.connect).toBeUndefined();
		expect(doc.getState().forms[formB]?.connect).toBeUndefined();
	});

	it("5. switchConnectMode(undefined) with lastConnectType='deliver' resolves to 'deliver'", () => {
		const { session, doc } = createConnectTestStores();

		/* Build up lastConnectType by switching learn -> deliver -> null. */
		session.getState().switchConnectMode("learn");
		session.getState().switchConnectMode("deliver");
		session.getState().switchConnectMode(null);

		/* lastConnectType should be 'deliver' (set when switching away from deliver). */
		expect(session.getState().lastConnectType).toBe("deliver");

		/* Passing undefined should re-enable with the last active mode. */
		session.getState().switchConnectMode(undefined);
		expect(doc.getState().connectType).toBe("deliver");
	});
});
