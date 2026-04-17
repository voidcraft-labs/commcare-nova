/**
 * BuilderSession store — reducer-shaped action invariant tests.
 *
 * Tests exercise the store directly (no React, no provider) to verify:
 * - `switchCursorMode` preserves sidebar stash/restore semantics
 * - `switchConnectMode` composite action manages the connect stash + doc
 *   mutations atomically
 * - Generation lifecycle actions bracket agent writes correctly
 * - Replay state loading and message updates
 * - `reset()` clears all fields
 *
 * Connect stash and generation tests use a real `createBlueprintDocStore()`
 * with a fixture blueprint to verify the cross-store dispatch contract.
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { createBuilderSessionStore } from "../store";
import {
	GenerationStage,
	type PartialScaffoldData,
	type ReplayStage,
	STAGE_LABELS,
} from "../types";

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
 * Helper: create a session store wired to a real doc store loaded with
 * a two-form fixture. Returns both stores and the form uuids.
 *
 * One module with two forms — enough to verify per-form stash keyed by uuid.
 */
function createConnectTestStores() {
	const docStore = createBlueprintDocStore();
	docStore.getState().load(
		buildDoc({
			appId: "test-app",
			appName: "ConnectTest",
			modules: [
				{
					uuid: "module-1-uuid",
					name: "Mod",
					forms: [
						{ uuid: "form-1-uuid", name: "Form A", type: "registration" },
						{ uuid: "form-2-uuid", name: "Form B", type: "followup" },
					],
				},
			],
		}),
	);
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

// ── Generation lifecycle ────────────────────────────────────────────────

/**
 * Helper: create a session store wired to a real doc store with undo
 * tracking resumed. Optionally loads a blueprint with a module so the
 * doc has data (for postBuildEdit detection).
 */
function createTestDocStore() {
	const ds = createBlueprintDocStore();
	ds.temporal.getState().resume();
	return ds;
}

function createGenerationTestStores(withData = false) {
	const docStore = createTestDocStore();
	if (withData) {
		/* Load a minimal doc (one module, no forms) so the doc has data
		 * for postBuildEdit detection. */
		docStore.getState().load(
			buildDoc({
				appId: "test-app",
				appName: "Test",
				modules: [{ uuid: "mod-uuid", name: "Mod" }],
			}),
		);
		docStore.temporal.getState().resume();
	}

	const sessionStore = createBuilderSessionStore();
	sessionStore.getState()._setDocStore(docStore);

	return { session: sessionStore, doc: docStore };
}

describe("generation lifecycle", () => {
	it("beginAgentWrite(stage) pauses doc undo, sets agentActive + stage + statusMessage, clears error", () => {
		const { session, doc } = createGenerationTestStores();

		session.getState().beginAgentWrite(GenerationStage.Structure);
		const s = session.getState();

		expect(s.agentActive).toBe(true);
		expect(s.agentStage).toBe(GenerationStage.Structure);
		expect(s.statusMessage).toBe(STAGE_LABELS[GenerationStage.Structure]);
		expect(s.agentError).toBeNull();
		/* Doc undo should be paused — changes should not enter history.
		 * zundo's `isTracking` is false when paused. */
		expect(doc.temporal.getState().isTracking).toBe(false);
	});

	it("beginAgentWrite() without stage starts with null stage and empty status", () => {
		const { session } = createGenerationTestStores();

		session.getState().beginAgentWrite();
		const s = session.getState();

		expect(s.agentActive).toBe(true);
		expect(s.agentStage).toBeNull();
		expect(s.statusMessage).toBe("");
	});

	it("endAgentWrite() resumes doc undo, sets justCompleted, keeps agentActive", () => {
		const { session, doc } = createGenerationTestStores();

		/* Begin a write, then end it. */
		session.getState().beginAgentWrite(GenerationStage.Forms);
		session.getState().endAgentWrite();
		const s = session.getState();

		/* agentActive is NOT cleared — the chat status effect owns that
		 * lifecycle so it can read wasActive=true and stamp lastResponseAt. */
		expect(s.agentActive).toBe(true);
		expect(s.justCompleted).toBe(true);
		expect(s.agentStage).toBeNull();
		expect(s.agentError).toBeNull();
		expect(s.statusMessage).toBe("");
		expect(s.partialScaffold).toBeUndefined();
		/* Doc undo should be resumed — zundo's `isTracking` is true when active. */
		expect(doc.temporal.getState().isTracking).toBe(true);
	});

	it("failAgentWrite(msg, severity) sets error + statusMessage, keeps agentActive", () => {
		const { session } = createGenerationTestStores();

		session.getState().beginAgentWrite(GenerationStage.Validate);
		session.getState().failAgentWrite("timeout", "recovering");
		const s = session.getState();

		expect(s.agentActive).toBe(true);
		expect(s.agentError).toEqual({
			message: "timeout",
			severity: "recovering",
		});
		expect(s.statusMessage).toBe("timeout");
	});

	it("failAgentWrite defaults severity to 'failed'", () => {
		const { session } = createGenerationTestStores();

		session.getState().beginAgentWrite();
		session.getState().failAgentWrite("fatal error");
		const s = session.getState();

		expect(s.agentError).toEqual({
			message: "fatal error",
			severity: "failed",
		});
	});

	it("acknowledgeCompletion() clears justCompleted, no-ops when already false", () => {
		const { session } = createGenerationTestStores();

		/* End an agent write to get justCompleted=true. */
		session.getState().beginAgentWrite();
		session.getState().endAgentWrite();
		expect(session.getState().justCompleted).toBe(true);

		session.getState().acknowledgeCompletion();
		expect(session.getState().justCompleted).toBe(false);

		/* Second call is a no-op — verify state object identity. */
		const prev = session.getState();
		session.getState().acknowledgeCompletion();
		expect(session.getState()).toBe(prev);
	});

	it("setAgentActive(true) with doc data sets postBuildEdit=true", () => {
		const { session } = createGenerationTestStores(true);

		session.getState().setAgentActive(true);
		const s = session.getState();

		expect(s.agentActive).toBe(true);
		expect(s.postBuildEdit).toBe(true);
	});

	it("setAgentActive(true) with empty doc sets postBuildEdit=false", () => {
		const { session } = createGenerationTestStores(false);

		session.getState().setAgentActive(true);
		const s = session.getState();

		expect(s.agentActive).toBe(true);
		expect(s.postBuildEdit).toBe(false);
	});

	it("setAgentActive(false) clears agentActive, leaves postBuildEdit unchanged", () => {
		const { session } = createGenerationTestStores(true);

		/* Activate first to set postBuildEdit=true. */
		session.getState().setAgentActive(true);
		expect(session.getState().postBuildEdit).toBe(true);

		session.getState().setAgentActive(false);
		const s = session.getState();

		expect(s.agentActive).toBe(false);
		/* postBuildEdit should NOT be cleared by deactivation. */
		expect(s.postBuildEdit).toBe(true);
	});

	it("setAgentActive no-ops when value is unchanged", () => {
		const { session } = createGenerationTestStores();

		const prev = session.getState();
		session.getState().setAgentActive(false); /* already false */
		expect(session.getState()).toBe(prev);
	});

	it("advanceStage('structure') updates agentStage + statusMessage, clears error", () => {
		const { session } = createGenerationTestStores();

		session.getState().beginAgentWrite(GenerationStage.DataModel);
		session.getState().failAgentWrite("oops", "recovering");
		session.getState().advanceStage("structure");
		const s = session.getState();

		expect(s.agentStage).toBe(GenerationStage.Structure);
		expect(s.statusMessage).toBe(STAGE_LABELS[GenerationStage.Structure]);
		expect(s.agentError).toBeNull();
	});

	it("advanceStage with unknown string is a no-op", () => {
		const { session } = createGenerationTestStores();

		session.getState().beginAgentWrite(GenerationStage.DataModel);
		const prev = session.getState();
		session.getState().advanceStage("unknown-stage");
		expect(session.getState()).toBe(prev);
	});

	it("setFixAttempt updates statusMessage with error count and attempt", () => {
		const { session } = createGenerationTestStores();

		session.getState().setFixAttempt(2, 3);
		expect(session.getState().statusMessage).toBe("Fixing 3 errors, attempt 2");
	});

	it("setFixAttempt uses singular 'error' for count of 1", () => {
		const { session } = createGenerationTestStores();

		session.getState().setFixAttempt(1, 1);
		expect(session.getState().statusMessage).toBe("Fixing 1 error, attempt 1");
	});

	it("setAppId sets appId", () => {
		const store = createBuilderSessionStore();
		store.getState().setAppId("abc");
		expect(store.getState().appId).toBe("abc");
	});

	it("setAppId no-ops on same value", () => {
		const store = createBuilderSessionStore();
		store.getState().setAppId("abc");
		const prev = store.getState();
		store.getState().setAppId("abc");
		expect(store.getState()).toBe(prev);
	});

	it("setLoading toggles the loading flag", () => {
		const store = createBuilderSessionStore();
		expect(store.getState().loading).toBe(false);

		store.getState().setLoading(true);
		expect(store.getState().loading).toBe(true);

		store.getState().setLoading(false);
		expect(store.getState().loading).toBe(false);
	});

	it("setLoading no-ops on same value", () => {
		const store = createBuilderSessionStore();
		const prev = store.getState();
		store.getState().setLoading(false);
		expect(store.getState()).toBe(prev);
	});

	it("setPartialScaffold stores and clears scaffold data", () => {
		const store = createBuilderSessionStore();
		const scaffold: PartialScaffoldData = {
			appName: "Test",
			modules: [
				{ name: "Mod", forms: [{ name: "Form", type: "registration" }] },
			],
		};

		store.getState().setPartialScaffold(scaffold);
		expect(store.getState().partialScaffold).toEqual(scaffold);

		store.getState().setPartialScaffold(undefined);
		expect(store.getState().partialScaffold).toBeUndefined();
	});
});

// ── Replay ──────────────────────────────────────────────────────────────

describe("replay state", () => {
	const mockMessages: UIMessage[] = [
		{
			id: "msg-1",
			role: "assistant",
			parts: [{ type: "text", text: "Building..." }],
		},
	];

	const mockStages: ReplayStage[] = [
		{
			header: "Stage 1",
			subtitle: "Data model",
			messages: [],
			emissions: [],
		},
		{
			header: "Stage 2",
			messages: mockMessages,
			emissions: [{ type: "scaffold", data: { app_name: "Test" } }],
		},
		{
			header: "Stage 3",
			messages: [],
			emissions: [],
		},
	];

	it("loadReplay sets replay data with messages from doneIndex stage", () => {
		const store = createBuilderSessionStore();

		store.getState().loadReplay(mockStages, 1, "/build/abc");
		const replay = store.getState().replay;

		expect(replay).toBeDefined();
		expect(replay?.stages).toEqual(mockStages);
		expect(replay?.doneIndex).toBe(1);
		expect(replay?.exitPath).toBe("/build/abc");
		/* Messages should come from stage at doneIndex (stage 2). */
		expect(replay?.messages).toEqual(mockMessages);
	});

	it("loadReplay with doneIndex=0 uses first stage messages", () => {
		const store = createBuilderSessionStore();

		store.getState().loadReplay(mockStages, 0, "/exit");
		const replay = store.getState().replay;

		expect(replay?.messages).toEqual([]);
	});

	it("setReplayMessages updates replay.messages", () => {
		const store = createBuilderSessionStore();
		store.getState().loadReplay(mockStages, 0, "/exit");

		const newMessages: UIMessage[] = [
			{
				id: "msg-2",
				role: "user",
				parts: [{ type: "text", text: "Hello" }],
			},
		];
		store.getState().setReplayMessages(newMessages);

		expect(store.getState().replay?.messages).toEqual(newMessages);
	});

	it("setReplayMessages is a no-op when no replay is loaded", () => {
		const store = createBuilderSessionStore();
		const prev = store.getState();

		store.getState().setReplayMessages([]);
		expect(store.getState()).toBe(prev);
	});
});

// ── Reset ───────────────────────────────────────────────────────────────

describe("reset", () => {
	it("clears all generation, replay, appId, and transient fields", () => {
		const { session } = createGenerationTestStores(true);

		/* Populate every new field so we can verify reset clears them all. */
		session.getState().beginAgentWrite(GenerationStage.Forms);
		session.getState().failAgentWrite("err", "recovering");
		session.getState().setAppId("app-123");
		session.getState().setPartialScaffold({
			appName: "X",
			modules: [],
		});
		session
			.getState()
			.loadReplay([{ header: "S1", messages: [], emissions: [] }], 0, "/exit");
		session.getState().setLoading(true);
		session.getState().markNewQuestion("q-1");
		session.getState().setFocusHint("label");
		session.getState().setSidebarOpen("chat", false);
		session.getState().setCursorMode("pointer");

		/* Reset everything. */
		session.getState().reset();
		const s = session.getState();

		/* Generation lifecycle */
		expect(s.agentActive).toBe(false);
		expect(s.agentStage).toBeNull();
		expect(s.agentError).toBeNull();
		expect(s.statusMessage).toBe("");
		expect(s.postBuildEdit).toBe(false);
		expect(s.justCompleted).toBe(false);
		expect(s.loading).toBe(false);

		/* App identity */
		expect(s.appId).toBeUndefined();

		/* Generation UI */
		expect(s.partialScaffold).toBeUndefined();

		/* Replay */
		expect(s.replay).toBeUndefined();

		/* Interaction */
		expect(s.cursorMode).toBe("edit");
		expect(s.activeFieldId).toBeUndefined();

		/* Chrome */
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });

		/* Connect stash */
		expect(s.connectStash).toEqual({ learn: {}, deliver: {} });
		expect(s.lastConnectType).toBeUndefined();

		/* UI hints */
		expect(s.focusHint).toBeUndefined();
		expect(s.newQuestionUuid).toBeUndefined();
	});
});
