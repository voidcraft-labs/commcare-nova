/**
 * BuilderSession store — reducer-shaped action invariant tests.
 *
 * Tests exercise the store directly (no React, no provider) to verify:
 * - `setPreviewing` preserves sidebar stash/restore semantics
 * - `switchConnectMode` composite action manages the connect stash + doc
 *   mutations atomically
 * - Generation lifecycle actions bracket agent writes correctly
 * - Replay state loading and message updates
 * - `reset()` clears all fields
 *
 * Connect stash and generation tests use a real `createBlueprintDocStore()`
 * with a fixture blueprint to verify the cross-store dispatch contract.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, xp } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { asUuid } from "@/lib/doc/types";
import type { Event } from "@/lib/log/types";
import { toastStore } from "@/lib/ui/toastStore";
import { createBuilderSessionStore } from "../store";
import type { ReplayChapter } from "../types";

describe("BuilderSession store", () => {
	it("1. initial state: not previewing, both sidebars open, no stash", () => {
		const store = createBuilderSessionStore();
		const s = store.getState();
		expect(s.previewing).toBe(false);
		expect(s.activeFieldId).toBeUndefined();
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });
	});

	it("2. setPreviewing(true) from editing: stashes open values, closes both", () => {
		const store = createBuilderSessionStore();
		store.getState().setPreviewing(true);
		const s = store.getState();
		expect(s.previewing).toBe(true);
		expect(s.sidebars.chat).toEqual({ open: false, stashed: true });
		expect(s.sidebars.structure).toEqual({ open: false, stashed: true });
	});

	it("3. setPreviewing(false) after preview: restores stashed values, clears stash", () => {
		const store = createBuilderSessionStore();
		store.getState().setPreviewing(true);
		store.getState().setPreviewing(false);
		const s = store.getState();
		expect(s.previewing).toBe(false);
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });
	});

	it("4. setPreviewing(true) with chat already closed: restores chat-closed state exactly", () => {
		const store = createBuilderSessionStore();

		/* Close chat before entering preview. */
		store.getState().setSidebarOpen("chat", false);
		expect(store.getState().sidebars.chat.open).toBe(false);

		/* Enter preview — stashes the current state (chat closed). */
		store.getState().setPreviewing(true);
		const previewState = store.getState();
		expect(previewState.sidebars.chat).toEqual({
			open: false,
			stashed: false,
		});
		expect(previewState.sidebars.structure).toEqual({
			open: false,
			stashed: true,
		});

		/* Leave preview — restores the stashed values exactly: chat stays
		 * closed (was closed before preview), structure reopens. */
		store.getState().setPreviewing(false);
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

	it("5. setPreviewing(true) twice is a no-op on the second call", () => {
		const store = createBuilderSessionStore();

		/* First toggle: stashes both open values. */
		store.getState().setPreviewing(true);
		const afterFirst = store.getState();

		/* Second toggle: same value → no-op. The stash must NOT be
		 * overwritten with { stashed: false } (the currently-closed values). */
		store.getState().setPreviewing(true);
		const afterSecond = store.getState();

		/* State must be identical (same object reference from Zustand). */
		expect(afterSecond.previewing).toBe(true);
		expect(afterSecond.sidebars).toEqual(afterFirst.sidebars);

		/* Verify the stash still holds the original pre-preview values, not
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

	it("setPreviewCaseTarget sets the target and no-ops on a shallow-equal value", () => {
		const store = createBuilderSessionStore();
		const formUuid = asUuid("form-1");

		store.getState().setPreviewCaseTarget({ formUuid });
		expect(store.getState().previewCaseTarget).toEqual({ formUuid });

		/* Same formUuid + caseId — no new state object. */
		const prev = store.getState();
		store.getState().setPreviewCaseTarget({ formUuid });
		expect(store.getState()).toBe(prev);

		/* Adding the caseId is a real change. */
		store.getState().setPreviewCaseTarget({ formUuid, caseId: "case-1" });
		expect(store.getState().previewCaseTarget).toEqual({
			formUuid,
			caseId: "case-1",
		});
	});

	it("setPreviewSelectedCase sets the open case and no-ops on a shallow-equal value", () => {
		const store = createBuilderSessionStore();
		store.getState().setPreviewSelectedCase({ caseId: "c1", caseName: "Ana" });
		expect(store.getState().previewSelectedCase).toEqual({
			caseId: "c1",
			caseName: "Ana",
		});
		const prev = store.getState();
		store.getState().setPreviewSelectedCase({ caseId: "c1", caseName: "Ana" });
		expect(store.getState()).toBe(prev);
	});

	it("setPreviewing clears the case target AND selected case on both transitions", () => {
		const store = createBuilderSessionStore();
		const formUuid = asUuid("form-1");

		/* Entering preview clears any stray target + selection. */
		store
			.getState()
			.setPreviewCaseTarget({ formUuid, caseId: "case-1", caseName: "Ana" });
		store
			.getState()
			.setPreviewSelectedCase({ caseId: "case-1", caseName: "Ana" });
		store.getState().setPreviewing(true);
		expect(store.getState().previewCaseTarget).toBeUndefined();
		expect(store.getState().previewSelectedCase).toBeUndefined();

		/* Leaving preview clears the in-session selection — it's running-app
		 * state with no meaning outside preview. */
		store
			.getState()
			.setPreviewSelectedCase({ caseId: "case-2", caseName: "Bo" });
		store.getState().setPreviewing(false);
		expect(store.getState().previewSelectedCase).toBeUndefined();
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

// ── New field marker ─────────────────────────────────────────────────────

describe("BuilderSession new-field marker", () => {
	it("markNewField + isNewField: matches uuid, rejects others", () => {
		const store = createBuilderSessionStore();
		store.getState().markNewField("q-uuid");

		expect(store.getState().isNewField("q-uuid")).toBe(true);
		expect(store.getState().isNewField("other")).toBe(false);
	});

	it("clearNewField resets so isNewField returns false for all", () => {
		const store = createBuilderSessionStore();
		store.getState().markNewField("q-uuid");
		store.getState().clearNewField();

		expect(store.getState().isNewField("q-uuid")).toBe(false);
		expect(store.getState().isNewField("anything")).toBe(false);
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
	docStore.getState().startTracking();

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
	/** Staged learn-mode blocks for both fixture forms — what the enable
	 *  flow collects from the user when the stash has nothing. Ids are
	 *  deliberately absent: the commit path autofills them. */
	function stagedLearnBlocks(formA: string, formB: string) {
		return {
			[formA]: {
				learn_module: { name: "Form A", description: "desc", time_estimate: 5 },
			},
			[formB]: {
				assessment: { user_score: xp("#form/score") },
			},
		};
	}

	/** Staged deliver-mode blocks for both fixture forms. */
	function stagedDeliverBlocks(formA: string, formB: string) {
		return {
			[formA]: { deliver_unit: { name: "Visit A" } },
			[formB]: { deliver_unit: { name: "Visit B" } },
		};
	}

	it("0. enabling with no blocks in hand is REJECTED — the doc and stash stay untouched", () => {
		const { session, doc } = createConnectTestStores();
		toastStore.clear();

		const outcome = session.getState().switchConnectMode("learn");

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.messages.length).toBeGreaterThan(0);
		expect(doc.getState().connectType).toBeNull();
		expect(session.getState().connectStash.learn).toEqual({});
		// The default flavor announces — a rejection with no presenting
		// caller must never vanish silently.
		expect(toastStore.toasts.at(-1)?.title).toBe("Change not applied");
		toastStore.clear();
	});

	it("0b. announce:false rejects identically but stays quiet — the dialog presents the findings itself", () => {
		const { session, doc } = createConnectTestStores();
		toastStore.clear();

		const outcome = session
			.getState()
			.switchConnectMode("learn", undefined, { announce: false });

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.messages.length).toBeGreaterThan(0);
		expect(doc.getState().connectType).toBeNull();
		expect(toastStore.toasts).toHaveLength(0);
	});

	it("1. switchConnectMode('learn', staged) sets the type AND lands every form's block in one commit", () => {
		const { session, doc, formA, formB } = createConnectTestStores();

		const outcome = session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB));

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("learn");
		/* The staged blocks landed with autofilled, app-unique ids. */
		expect(doc.getState().forms[formA]?.connect?.learn_module?.name).toBe(
			"Form A",
		);
		expect(doc.getState().forms[formA]?.connect?.learn_module?.id).toBeTruthy();
		expect(doc.getState().forms[formB]?.connect?.assessment?.id).toBeTruthy();
		/* No outgoing mode to stash — both stash records remain empty. */
		expect(session.getState().connectStash.learn).toEqual({});
		expect(session.getState().connectStash.deliver).toEqual({});
	});

	it("1b. a partial staging commits — unpicked forms stay auxiliary (no block, no finding)", () => {
		/* Participation is per form: the enable flow stages blocks only for
		 * the forms the user picked, and the flip is legal as long as at
		 * least one form participates. */
		const { session, doc, formA, formB } = createConnectTestStores();

		const outcome = session.getState().switchConnectMode("learn", {
			[formA]: {
				learn_module: { name: "Form A", description: "desc", time_estimate: 5 },
			},
		});

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("learn");
		expect(doc.getState().forms[formA]?.connect?.learn_module?.name).toBe(
			"Form A",
		);
		expect(doc.getState().forms[formB]?.connect).toBeUndefined();
	});

	it("2. switching learn->deliver stashes the learn configs and lands the staged deliver blocks", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB));

		const outcome = session
			.getState()
			.switchConnectMode("deliver", stagedDeliverBlocks(formA, formB));

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("deliver");
		/* The learn stash holds both forms' configs keyed by uuid. */
		const stash = session.getState().connectStash.learn;
		expect(stash[formA]?.learn_module?.name).toBe("Form A");
		expect(stash[formB]?.assessment).toBeDefined();
		/* lastConnectType tracks the now-active mode (the field's documented
		 * "last active connect type"), so a later turn-off / off-state default
		 * returns to deliver, not the mode just left. */
		expect(session.getState().lastConnectType).toBe("deliver");
	});

	it("3. switching deliver->learn restores the stashed learn configs onto the forms", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB));
		session
			.getState()
			.switchConnectMode("deliver", stagedDeliverBlocks(formA, formB));

		/* The learn stash holds both forms' prior work. The manager seeds its
		 * learn drafts from that stash and hands the whole set back to switch
		 * mode — the store no longer restores on its own. */
		const outcome = session
			.getState()
			.switchConnectMode("learn", session.getState().connectStash.learn);

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("learn");
		expect(doc.getState().forms[formA]?.connect?.learn_module?.name).toBe(
			"Form A",
		);
	});

	it("4. switchConnectMode(null) clears doc connectType and all form connect configs", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB));

		/* Disable connect entirely — always valid. */
		const outcome = session.getState().switchConnectMode(null);

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBeNull();
		expect(doc.getState().forms[formA]?.connect).toBeUndefined();
		expect(doc.getState().forms[formB]?.connect).toBeUndefined();
	});

	it("5. switchConnectMode(undefined) resolves to the last active mode", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB));
		session
			.getState()
			.switchConnectMode("deliver", stagedDeliverBlocks(formA, formB));
		session.getState().switchConnectMode(null);

		/* lastConnectType is 'deliver' (set when switching away from it). */
		expect(session.getState().lastConnectType).toBe("deliver");

		/* `undefined` resolves to that last mode; the manager hands back the
		 * deliver stash it seeded its drafts from. */
		const outcome = session
			.getState()
			.switchConnectMode(undefined, session.getState().connectStash.deliver);
		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("deliver");
	});

	it("6. a mode switch clears the outgoing block from each form (stashed, never lingering cross-mode)", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB));

		session
			.getState()
			.switchConnectMode("deliver", stagedDeliverBlocks(formA, formB));

		/* `form.connect` holds only the active-mode config — the learn block
		 * was replaced wholesale by the deliver one, and preserved in the
		 * learn stash for switch-back. */
		expect(doc.getState().forms[formA]?.connect?.learn_module).toBeUndefined();
		expect(doc.getState().forms[formA]?.connect?.deliver_unit?.name).toBe(
			"Visit A",
		);
		expect(
			session.getState().connectStash.learn[formA]?.learn_module,
		).toBeDefined();
	});

	it("7. learn->null->learn round-trip restores the original learn configs (no work lost)", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB));

		/* Disable connect entirely (clears every form.connect, stashing the
		 * learn configs first), then re-enable the SAME mode by handing back
		 * the stash — the manager's seed-then-apply round-trip. */
		session.getState().switchConnectMode(null);
		expect(doc.getState().forms[formA]?.connect).toBeUndefined();

		const outcome = session
			.getState()
			.switchConnectMode("learn", session.getState().connectStash.learn);
		expect(outcome.ok).toBe(true);
		const restored = doc.getState().forms[formA]?.connect;
		expect(restored?.learn_module?.name).toBe("Form A");
	});

	it("8. two staged blocks deriving the same slug land UNIQUE ids (one accumulating scope)", () => {
		const { session, doc, formA, formB } = createConnectTestStores();

		/* Both deliver units share a name, so a naive per-form autofill would
		 * derive the same slug twice — the flip's single id scope must
		 * disambiguate the second. */
		const outcome = session.getState().switchConnectMode("deliver", {
			[formA]: { deliver_unit: { name: "Visit" } },
			[formB]: { deliver_unit: { name: "Visit" } },
		});

		expect(outcome.ok).toBe(true);
		const idA = doc.getState().forms[formA]?.connect?.deliver_unit?.id;
		const idB = doc.getState().forms[formB]?.connect?.deliver_unit?.id;
		expect(idA).toBeTruthy();
		expect(idB).toBeTruthy();
		expect(idA).not.toBe(idB);
	});

	it("9. an app with ZERO forms enables Connect as the bare type flip — nothing to stage", () => {
		/* An MCP-born empty app is complete and opens in the builder; its
		 * Connect toggle must work like the SA's `updateApp` flip on the
		 * same empty app (the participation floor binds only once forms
		 * exist), not silently no-op. */
		const docStore = createBlueprintDocStore();
		docStore
			.getState()
			.load(buildDoc({ appId: "empty-app", appName: "Empty" }));
		docStore.getState().startTracking();
		const session = createBuilderSessionStore();
		session.getState()._setDocStore(docStore);

		const outcome = session.getState().switchConnectMode("learn");

		expect(outcome).toEqual({ ok: true });
		expect(docStore.getState().connectType).toBe("learn");

		/* And the always-valid OFF direction still works on the same app. */
		expect(session.getState().switchConnectMode(null)).toEqual({ ok: true });
		expect(docStore.getState().connectType).toBeNull();
	});

	it("10. a same-mode apply edits an existing block (keeping its id) and drops a form left out of the set", () => {
		/* The manager hands the COMPLETE participating set for the current
		 * mode. A form whose block changed updates; a form omitted from the
		 * set stops participating; an existing id round-trips unchanged so
		 * Connect's slug never churns. */
		const { session, doc, formA, formB } = createConnectTestStores();
		session.getState().switchConnectMode("learn", {
			[formA]: {
				learn_module: { name: "Form A", description: "d", time_estimate: 5 },
			},
			[formB]: {
				learn_module: { name: "Form B", description: "d", time_estimate: 5 },
			},
		});
		const idA = doc.getState().forms[formA]?.connect?.learn_module?.id;
		expect(idA).toBeTruthy();

		const outcome = session.getState().switchConnectMode("learn", {
			[formA]: {
				learn_module: {
					id: idA,
					name: "Renamed",
					description: "d",
					time_estimate: 9,
				},
			},
		});

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("learn");
		expect(doc.getState().forms[formA]?.connect?.learn_module?.name).toBe(
			"Renamed",
		);
		expect(
			doc.getState().forms[formA]?.connect?.learn_module?.time_estimate,
		).toBe(9);
		/* The id was kept verbatim — no re-slugging. */
		expect(doc.getState().forms[formA]?.connect?.learn_module?.id).toBe(idA);
		/* Form B was omitted from the desired set → auxiliary again. */
		expect(doc.getState().forms[formB]?.connect).toBeUndefined();
		/* …but its dropped block is stashed (same-mode drop stays reversible,
		 * the per-form-toggle guarantee), so re-adding B restores its config. */
		expect(
			session.getState().connectStash.learn[formB]?.learn_module?.name,
		).toBe("Form B");
	});

	it("11. an apply that already matches the doc commits nothing (no undo entry)", () => {
		const { session, doc, formA } = createConnectTestStores();
		session.getState().switchConnectMode("learn", {
			[formA]: {
				learn_module: { name: "Form A", description: "d", time_estimate: 5 },
			},
		});
		const before = doc.temporal.getState().pastStates.length;

		/* Re-apply the doc's current state verbatim — no field changed. */
		const current = doc.getState().forms[formA]?.connect;
		const outcome = session.getState().switchConnectMode("learn", {
			[formA]: current as NonNullable<typeof current>,
		});

		expect(outcome.ok).toBe(true);
		expect(doc.temporal.getState().pastStates.length).toBe(before);
	});

	it("12. enabling a mode from OFF sets lastConnectType to THAT mode, not a stale prior", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		/* Use deliver, then turn off — lastConnectType remembers deliver. */
		session
			.getState()
			.switchConnectMode("deliver", stagedDeliverBlocks(formA, formB));
		session.getState().switchConnectMode(null);
		expect(session.getState().lastConnectType).toBe("deliver");

		/* Enabling learn FROM OFF must move lastConnectType to learn — otherwise
		 * it stays pointing at the previously-disabled deliver and a later
		 * `switchConnectMode(undefined)` would resolve to the wrong mode. */
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB));
		expect(doc.getState().connectType).toBe("learn");
		expect(session.getState().lastConnectType).toBe("learn");
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
	ds.getState().startTracking();
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
		docStore.getState().startTracking();
	}

	const sessionStore = createBuilderSessionStore();
	sessionStore.getState()._setDocStore(docStore);

	return { session: sessionStore, doc: docStore };
}

describe("generation lifecycle", () => {
	it("beginRun pauses doc undo + clears events buffer + clears runCompletedAt", () => {
		const { session, doc } = createGenerationTestStores();

		/* Seed some events + a completion stamp so we can verify they clear. */
		session.getState().pushEvents([
			{
				kind: "mutation",
				runId: "prev",
				ts: 0,
				seq: 0,
				source: "chat",
				actor: "agent",
				mutation: { kind: "setAppName", name: "old" },
			},
		]);
		session.getState().markRunCompleted();

		session.getState().beginRun();
		const s = session.getState();

		expect(s.events).toEqual([]);
		expect(s.runCompletedAt).toBeUndefined();
		/* Doc undo paused — zundo isTracking=false. */
		expect(doc.temporal.getState().isTracking).toBe(false);
	});

	it("endRun clears events buffer + resumes doc undo; does NOT stamp runCompletedAt", () => {
		/* Stream-close is not the completion signal. A run that closes
		 * without `data-done` (askQuestions, clarifying text, edit-tool
		 * response) ends silently — buffer cleared, no celebration stamp. */
		const { session, doc } = createGenerationTestStores();

		session.getState().beginRun();
		session.getState().pushEvents([
			{
				kind: "conversation",
				runId: "r",
				ts: 0,
				seq: 0,
				source: "chat",
				payload: { type: "user-message", text: "hi" },
			},
		]);
		expect(session.getState().events.length).toBe(1);

		session.getState().endRun();
		const s = session.getState();

		expect(s.events).toEqual([]);
		expect(s.runCompletedAt).toBeUndefined();
		expect(doc.temporal.getState().isTracking).toBe(true);
	});

	it("markRunCompleted stamps runCompletedAt without clearing events", () => {
		/* `data-done` fires from the route's drain-end finalize, before
		 * the stream closes — the events buffer still has the run's
		 * mutations. Only `runCompletedAt` flips. */
		const { session } = createGenerationTestStores();
		session.getState().beginRun();
		session.getState().pushEvents([
			{
				kind: "mutation",
				runId: "r",
				ts: 0,
				seq: 0,
				source: "chat",
				actor: "agent",
				stage: "schema",
				mutation: { kind: "setAppName", name: "x" },
			},
		]);

		session.getState().markRunCompleted();
		const s = session.getState();
		expect(s.runCompletedAt).toEqual(expect.any(Number));
		/* Buffer untouched — endRun is the only thing that clears it. */
		expect(s.events.length).toBe(1);
	});

	it("full build flow: beginRun → markRunCompleted → endRun → acknowledgeCompletion", () => {
		/* End-to-end: models the real chat-transport + dispatcher sequence
		 * for a successful build. Each transition is independent. */
		const { session } = createGenerationTestStores();

		session.getState().beginRun();

		/* `data-done` arrives from the route's drain-end finalize. */
		session.getState().markRunCompleted();
		expect(session.getState().runCompletedAt).toEqual(expect.any(Number));

		/* Stream closes. Buffer clears, but completion stamp survives. */
		session.getState().endRun();
		expect(session.getState().events).toEqual([]);
		expect(session.getState().runCompletedAt).toEqual(expect.any(Number));

		/* 3.5s later: signal grid celebration animation settled. */
		session.getState().acknowledgeCompletion();
		expect(session.getState().runCompletedAt).toBeUndefined();
	});

	it("askQuestions-only run: no markRunCompleted, endRun closes silently (regression)", () => {
		/* Regression for the "celebration fired for a text-only response"
		 * bug. An askQuestions run never sees `data-done`, so the only
		 * transition on stream close is clearing the events buffer. */
		const { session } = createGenerationTestStores();

		session.getState().beginRun();
		session.getState().pushEvents([
			{
				kind: "conversation",
				runId: "r",
				ts: 0,
				seq: 0,
				source: "chat",
				payload: {
					type: "tool-call",
					toolCallId: "tc-1",
					toolName: "askQuestions",
					input: {},
				},
			},
		]);

		session.getState().endRun();
		const s = session.getState();
		expect(s.events).toEqual([]);
		expect(s.runCompletedAt).toBeUndefined();
	});

	it("acknowledgeCompletion clears runCompletedAt; no-ops when already cleared", () => {
		const { session } = createGenerationTestStores();

		session.getState().markRunCompleted();
		session.getState().acknowledgeCompletion();
		expect(session.getState().runCompletedAt).toBeUndefined();

		const prev = session.getState();
		session.getState().acknowledgeCompletion();
		expect(session.getState()).toBe(prev);
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
});

// ── Replay ──────────────────────────────────────────────────────────────

describe("replay state", () => {
	/**
	 * Fixture event log — a minimal but realistic mix of conversation and
	 * mutation events representing the shape the extractor emits. All events
	 * share a runId and use monotonic seq numbers so they'd sort chronologically
	 * on disk exactly as they appear here.
	 */
	const mockEvents: Event[] = [
		{
			kind: "conversation",
			runId: "run-1",
			ts: 1000,
			seq: 0,
			source: "chat",
			payload: { type: "user-message", text: "Build me an app" },
		},
		{
			kind: "conversation",
			runId: "run-1",
			ts: 1100,
			seq: 1,
			source: "chat",
			payload: { type: "assistant-text", text: "Sure, building..." },
		},
		{
			kind: "mutation",
			runId: "run-1",
			ts: 1200,
			seq: 2,
			source: "chat",
			actor: "agent",
			stage: "scaffold",
			mutation: { kind: "setAppName", name: "Test App" },
		},
		{
			kind: "conversation",
			runId: "run-1",
			ts: 1300,
			seq: 3,
			source: "chat",
			payload: { type: "assistant-text", text: "Done." },
		},
	];

	/**
	 * Two chapters covering the four events above. The second chapter starts
	 * where the first ends — chapters are contiguous scrub targets over the
	 * same underlying stream, not separate event buckets.
	 */
	const mockChapters: ReplayChapter[] = [
		{ header: "Setup", subtitle: "App meta", startIndex: 0, endIndex: 2 },
		{ header: "Wrap-up", startIndex: 3, endIndex: 3 },
	];

	it("loadReplay stores events, chapters, cursor, and exitPath", () => {
		const store = createBuilderSessionStore();

		store.getState().loadReplay({
			events: mockEvents,
			chapters: mockChapters,
			initialCursor: 2,
			exitPath: "/build/abc",
		});
		const replay = store.getState().replay;

		expect(replay).toBeDefined();
		expect(replay?.events).toEqual(mockEvents);
		expect(replay?.chapters).toEqual(mockChapters);
		expect(replay?.cursor).toBe(2);
		expect(replay?.exitPath).toBe("/build/abc");
	});

	it("loadReplay with initialCursor=0 lands on the first event", () => {
		const store = createBuilderSessionStore();

		store.getState().loadReplay({
			events: mockEvents,
			chapters: mockChapters,
			initialCursor: 0,
			exitPath: "/exit",
		});

		expect(store.getState().replay?.cursor).toBe(0);
	});

	it("setReplayCursor updates the cursor in place", () => {
		const store = createBuilderSessionStore();
		store.getState().loadReplay({
			events: mockEvents,
			chapters: mockChapters,
			initialCursor: 0,
			exitPath: "/exit",
		});

		store.getState().setReplayCursor(3);

		const replay = store.getState().replay;
		expect(replay?.cursor).toBe(3);
		/* Events and chapters are untouched — only the cursor moves. */
		expect(replay?.events).toEqual(mockEvents);
		expect(replay?.chapters).toEqual(mockChapters);
	});

	it("setReplayCursor is a no-op when no replay is loaded", () => {
		const store = createBuilderSessionStore();
		const prev = store.getState();

		store.getState().setReplayCursor(0);
		expect(store.getState()).toBe(prev);
	});

	it("setReplayCursor clamps negative input to 0", () => {
		const store = createBuilderSessionStore();
		store.getState().loadReplay({
			events: mockEvents,
			chapters: mockChapters,
			initialCursor: 2,
			exitPath: "/exit",
		});

		store.getState().setReplayCursor(-1);

		/* Negative cursors never make sense for an array index — clamp to 0
		 * so UI callers can pass deltas like `cursor - 1` without guarding. */
		expect(store.getState().replay?.cursor).toBe(0);
	});

	it("setReplayCursor clamps overflow to events.length - 1", () => {
		const store = createBuilderSessionStore();
		store.getState().loadReplay({
			events: mockEvents,
			chapters: mockChapters,
			initialCursor: 0,
			exitPath: "/exit",
		});

		/* events.length === 4, so the last valid index is 3. Passing
		 * events.length must clamp down, not index past the array. */
		store.getState().setReplayCursor(mockEvents.length);

		expect(store.getState().replay?.cursor).toBe(mockEvents.length - 1);
	});

	it("setReplayCursor is a state-identity no-op when cursor is unchanged", () => {
		const store = createBuilderSessionStore();
		store.getState().loadReplay({
			events: mockEvents,
			chapters: mockChapters,
			initialCursor: 2,
			exitPath: "/exit",
		});

		const prev = store.getState();
		/* Setting the same cursor must not allocate a new state object —
		 * matches the setLoading / setAppId / setSidebarOpen no-op idiom
		 * so subscribers don't re-render on redundant writes. */
		store.getState().setReplayCursor(2);
		expect(store.getState()).toBe(prev);
	});

	it("loadReplay with empty events/chapters pins cursor at 0", () => {
		const store = createBuilderSessionStore();

		/* Edge case: an admin replay for a run that produced no events.
		 * `replay` should still be defined (replay mode is active), but the
		 * cursor degenerates to 0 since there's nothing to index into. */
		store.getState().loadReplay({
			events: [],
			chapters: [],
			initialCursor: 0,
			exitPath: "/exit",
		});

		const replay = store.getState().replay;
		expect(replay).toBeDefined();
		expect(replay?.events).toEqual([]);
		expect(replay?.chapters).toEqual([]);
		expect(replay?.cursor).toBe(0);
	});
});

// ── Reset ───────────────────────────────────────────────────────────────

describe("reset", () => {
	it("clears all generation, replay, appId, and transient fields", () => {
		const { session } = createGenerationTestStores(true);

		/* Populate every new field so we can verify reset clears them all. */
		session.getState().beginRun();
		session.getState().pushEvents([
			{
				kind: "mutation",
				runId: "r",
				ts: 0,
				seq: 0,
				source: "chat",
				actor: "agent",
				stage: "schema",
				mutation: { kind: "setAppName", name: "x" },
			},
		]);
		session.getState().markRunCompleted();
		session.getState().endRun();
		session.getState().setAppId("app-123");
		session.getState().loadReplay({
			events: [],
			chapters: [{ header: "S1", startIndex: 0, endIndex: 0 }],
			initialCursor: 0,
			exitPath: "/exit",
		});
		session.getState().setLoading(true);
		session.getState().markNewField("q-1");
		session.getState().setFocusHint("label");
		session.getState().setSidebarOpen("chat", false);
		session.getState().setPreviewing(true);

		/* Reset everything. */
		session.getState().reset();
		const s = session.getState();

		/* Generation lifecycle */
		expect(s.events).toEqual([]);
		expect(s.runCompletedAt).toBeUndefined();
		expect(s.loading).toBe(false);

		/* App identity */
		expect(s.appId).toBeUndefined();

		/* Replay */
		expect(s.replay).toBeUndefined();

		/* Interaction */
		expect(s.previewing).toBe(false);
		expect(s.activeFieldId).toBeUndefined();

		/* Chrome */
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });

		/* Connect stash */
		expect(s.connectStash).toEqual({ learn: {}, deliver: {} });
		expect(s.lastConnectType).toBeUndefined();

		/* UI hints */
		expect(s.focusHint).toBeUndefined();
		expect(s.newFieldUuid).toBeUndefined();
	});
});

// ── Events buffer + run lifecycle ────────────────────────────────────────

/** Minimal MutationEvent factory — shape matches the Phase-4 event log
 *  envelope. `stage` is optional so tests can cover the no-stage branch. */
function makeMutationEvent(stage: string | undefined, seq: number): Event {
	return {
		kind: "mutation",
		runId: "test-run",
		ts: 0,
		seq,
		source: "chat",
		actor: "agent",
		...(stage && { stage }),
		mutation: { kind: "setAppName", name: "x" },
	};
}

describe("events buffer + run lifecycle", () => {
	it("initial state: empty events, no runCompletedAt", () => {
		const store = createBuilderSessionStore();
		expect(store.getState().events).toEqual([]);
		expect(store.getState().runCompletedAt).toBeUndefined();
	});

	it("beginRun clears the events buffer + runCompletedAt", () => {
		const store = createBuilderSessionStore();
		store.getState().pushEvents([makeMutationEvent("schema", 0)]);
		store.getState().markRunCompleted();

		store.getState().beginRun();
		expect(store.getState().events).toEqual([]);
		expect(store.getState().runCompletedAt).toBeUndefined();
	});

	it("pushEvents appends in order", () => {
		const store = createBuilderSessionStore();
		store.getState().beginRun();
		const e1 = makeMutationEvent("schema", 0);
		const e2 = makeMutationEvent("scaffold", 1);
		store.getState().pushEvents([e1, e2]);
		expect(store.getState().events).toEqual([e1, e2]);
	});

	it("pushEvent appends a single event", () => {
		const store = createBuilderSessionStore();
		const e = makeMutationEvent("schema", 0);
		store.getState().pushEvent(e);
		expect(store.getState().events).toEqual([e]);
	});

	it("pushEvents on empty array is a no-op", () => {
		const store = createBuilderSessionStore();
		const prev = store.getState();
		store.getState().pushEvents([]);
		expect(store.getState()).toBe(prev);
	});

	it("replaceEvents swaps the buffer wholesale (scrub reconstruction)", () => {
		const store = createBuilderSessionStore();
		store.getState().pushEvents([makeMutationEvent("schema", 0)]);
		const replacement = [
			makeMutationEvent("scaffold", 0),
			makeMutationEvent("module:0", 1),
		];
		store.getState().replaceEvents(replacement);
		expect(store.getState().events).toEqual(replacement);
	});

	it("markRunCompleted stamps runCompletedAt", () => {
		const store = createBuilderSessionStore();
		store.getState().beginRun();
		store.getState().markRunCompleted();
		expect(store.getState().runCompletedAt).toEqual(expect.any(Number));
	});

	it("endRun does NOT stamp runCompletedAt (stream-close is not completion)", () => {
		const store = createBuilderSessionStore();
		store.getState().beginRun();
		store.getState().endRun();
		expect(store.getState().runCompletedAt).toBeUndefined();
	});

	it("acknowledgeCompletion clears runCompletedAt", () => {
		const store = createBuilderSessionStore();
		store.getState().markRunCompleted();
		store.getState().acknowledgeCompletion();
		expect(store.getState().runCompletedAt).toBeUndefined();
	});

	it("reset clears the events buffer and runCompletedAt", () => {
		const store = createBuilderSessionStore();
		store.getState().beginRun();
		store.getState().pushEvents([makeMutationEvent("schema", 0)]);
		store.getState().markRunCompleted();
		store.getState().endRun();

		store.getState().reset();
		const s = store.getState();
		expect(s.events).toEqual([]);
		expect(s.runCompletedAt).toBeUndefined();
	});
});
