/**
 * BuilderSession store — reducer-shaped action invariant tests.
 *
 * Tests exercise the store directly (no React, no provider) to verify:
 * - `setPreviewing` preserves sidebar stash/restore semantics
 * - `switchConnectMode` composite action manages the connect stash + doc
 *   mutations atomically
 * - Generation lifecycle actions bracket agent writes correctly
 * - `reset()` clears all fields
 *
 * Connect stash and generation tests use a real `createBlueprintDocStore()`
 * with a fixture blueprint to verify the cross-store dispatch contract.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import type { ProvisionedWorker } from "@/lib/deployment/workerProvisionPlan";
import { provisioningOutcomeKey } from "@/lib/deployment/workerProvisionPlan";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { canonicalAppGenesis } from "@/lib/doc/scaffolds";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { ConnectConfig } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import type { Event } from "@/lib/log/types";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { toastStore } from "@/lib/ui/toastStore";
import { type ConnectSwitchGate, createBuilderSessionStore } from "../store";

/** The fixture docs carry no lookup reference, so an unavailable context is
 *  the honest gate for them — what the hook binds when nothing is loaded. */
const NO_LOOKUPS: ConnectSwitchGate = {
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
};

describe("BuilderSession store", () => {
	it("1. initial state: not previewing, both sidebars open, no stash", () => {
		const store = createBuilderSessionStore();
		const s = store.getState();
		expect(s.previewing).toBe(false);
		expect(s.activeFieldId).toBeUndefined();
		expect(s.sidebars.chat).toEqual({ open: true, stashed: undefined });
		expect(s.sidebars.structure).toEqual({ open: true, stashed: undefined });
	});

	it("owns one atomic mutable access tuple and coalesces a refresh epoch", () => {
		const store = createBuilderSessionStore({
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});

		const firstEpoch = store.getState().beginAccessRefresh();
		const coalescedEpoch = store.getState().beginAccessRefresh();
		expect(firstEpoch).toBe(1);
		expect(coalescedEpoch).toBe(1);
		expect(store.getState()).toMatchObject({
			projectId: "project-source",
			role: "editor",
			canEdit: false,
			accessPhase: "refreshing",
			scopeEpoch: 1,
		});

		store.getState().markAccessReconnecting();
		expect(store.getState().accessPhase).toBe("reconnecting");
		store.getState().applyAccessSnapshot({
			projectId: "project-destination",
			role: "viewer",
			canEdit: false,
		});
		expect(store.getState()).toMatchObject({
			projectId: "project-destination",
			role: "viewer",
			canEdit: false,
			accessPhase: "authorized",
			scopeEpoch: 1,
		});

		store.getState().beginAccessRefresh();
		expect(store.getState().scopeEpoch).toBe(2);
		store.getState().requireClientUpgrade();
		expect(store.getState().accessPhase).toBe("upgradeRequired");
		store.getState().revokeAccess();
		expect(store.getState().accessPhase).toBe("revoked");
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

	it("leaving Preview clears the acting persona before edit-mode data tools return", () => {
		const store = createBuilderSessionStore();
		store.getState().setPreviewing(true);
		store.getState().setPreviewPersonaUuid("persona-a");
		expect(store.getState().previewPersonaUuid).toBe("persona-a");

		store.getState().setPreviewing(false);

		expect(store.getState().previewPersonaUuid).toBeUndefined();
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
		const formUuid = testUuid("form-1");

		store.getState().setPreviewCaseTarget({ formUuid });
		expect(store.getState().previewCaseTarget).toEqual({ formUuid });

		/* Same formUuid + cases — no new state object. */
		const prev = store.getState();
		store.getState().setPreviewCaseTarget({ formUuid });
		expect(store.getState()).toBe(prev);

		/* Adding the ordered cases is a real change. */
		store.getState().setPreviewCaseTarget({
			formUuid,
			cases: [{ caseId: "case-1" }],
		});
		expect(store.getState().previewCaseTarget).toEqual({
			formUuid,
			cases: [{ caseId: "case-1" }],
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

	it("keeps module-menu case selections separate and uuid-keyed", () => {
		const store = createBuilderSessionStore();
		const moduleUuid = testUuid("module-1");
		const selected = {
			caseType: "household",
			cases: [{ caseId: "case-1", caseName: "Ana's household" }],
		};

		store.getState().setPreviewMenuCaseSelection(moduleUuid, selected);
		expect(store.getState().previewMenuCaseSelections[moduleUuid]).toEqual(
			selected,
		);
		expect(store.getState().previewCaseTarget).toBeUndefined();

		const prev = store.getState();
		store.getState().setPreviewMenuCaseSelection(moduleUuid, { ...selected });
		expect(store.getState()).toBe(prev);

		store.getState().setPreviewMenuCaseSelection(moduleUuid, undefined);
		expect(store.getState().previewMenuCaseSelections).toEqual({});
	});

	it("tracks a case-parent selection return independently of menu selections", () => {
		const store = createBuilderSessionStore();
		const request = {
			selectingModuleUuid: testUuid("case-parent-module"),
			returnModuleUuids: [testUuid("nested-child-module")],
			resumeLocation: {
				kind: "form" as const,
				moduleUuid: testUuid("nested-child-module"),
				formUuid: testUuid("requested-form"),
			},
			cancelLocation: { kind: "home" as const },
		};
		store.getState().setPreviewParentCaseRequest(request);
		expect(store.getState().previewParentCaseRequest).toEqual(request);
		expect(store.getState().previewMenuCaseSelections).toEqual({});

		const prev = store.getState();
		store.getState().setPreviewParentCaseRequest({ ...request });
		expect(store.getState()).toBe(prev);

		store.getState().setPreviewParentCaseRequest({
			...request,
			resumeLocation: {
				...request.resumeLocation,
				selectedUuid: testUuid("requested-field"),
			},
		});
		expect(store.getState()).not.toBe(prev);
	});

	it("setPreviewing clears all case state on both transitions", () => {
		const store = createBuilderSessionStore();
		const formUuid = testUuid("form-1");

		/* Entering preview clears any stray target + selection. */
		store.getState().setPreviewCaseTarget({
			formUuid,
			cases: [{ caseId: "case-1", caseName: "Ana" }],
		});
		store
			.getState()
			.setPreviewSelectedCase({ caseId: "case-1", caseName: "Ana" });
		store.getState().setPreviewMenuCaseSelection(testUuid("module-1"), {
			caseType: "household",
			cases: [{ caseId: "case-1", caseName: "Ana" }],
		});
		store.getState().setPreviewing(true);
		expect(store.getState().previewCaseTarget).toBeUndefined();
		expect(store.getState().previewSelectedCase).toBeUndefined();
		expect(store.getState().previewMenuCaseSelections).toEqual({});

		/* Leaving preview clears the in-session selection — it's running-app
		 * state with no meaning outside preview. */
		store
			.getState()
			.setPreviewSelectedCase({ caseId: "case-2", caseName: "Bo" });
		store.getState().setPreviewing(false);
		expect(store.getState().previewSelectedCase).toBeUndefined();
	});

	it("defers preview worker/case retirement until a snapshot confirms a Project change", () => {
		const store = createBuilderSessionStore({
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		const formUuid = testUuid("form-1");
		store.getState().setPreviewing(true);
		store
			.getState()
			.setPreviewPersonaUuid("11111111-1111-4111-8111-111111111111");
		store.getState().setPreviewCaseTarget({
			formUuid,
			cases: [{ caseId: "case-from-source-project" }],
		});
		store.getState().setPreviewSelectedCase({
			caseId: "case-from-source-project",
			caseName: "Source household",
		});

		store.getState().resetProjectScope();

		expect(store.getState().previewing).toBe(true);
		expect(store.getState().previewCaseTarget?.cases?.[0]?.caseId).toBe(
			"case-from-source-project",
		);
		expect(store.getState().previewSelectedCase?.caseId).toBe(
			"case-from-source-project",
		);
		expect(store.getState().previewPersonaUuid).toBe(
			"11111111-1111-4111-8111-111111111111",
		);

		store.getState().applyAccessSnapshot({
			projectId: "project-source",
			role: "editor",
			canEdit: true,
		});
		expect(store.getState().previewCaseTarget?.cases?.[0]?.caseId).toBe(
			"case-from-source-project",
		);
		expect(store.getState().previewPersonaUuid).toBe(
			"11111111-1111-4111-8111-111111111111",
		);

		store.getState().applyAccessSnapshot({
			projectId: "project-destination",
			role: "editor",
			canEdit: true,
		});
		expect(store.getState().previewCaseTarget).toBeUndefined();
		expect(store.getState().previewSelectedCase).toBeUndefined();
		expect(store.getState().previewPersonaUuid).toBeUndefined();
	});

	it("Project-scope reset retires attachment/tool run payloads and phase state", () => {
		const sourceAsset = testMediaAssetId("source-asset");
		const store = createBuilderSessionStore();
		store.getState().beginRun({ startedWithData: true });
		store.getState().pushEvents([
			{
				kind: "conversation",
				runId: "source-run",
				ts: 1,
				seq: 1,
				source: "chat",
				payload: {
					type: "user-message",
					text: "Use this",
					attachments: [
						{
							assetId: sourceAsset,
							kind: "pdf",
							filename: "source.pdf",
							mimeType: "application/pdf",
						},
					],
				},
			},
			{
				kind: "conversation",
				runId: "source-run",
				ts: 2,
				seq: 2,
				source: "chat",
				payload: {
					type: "tool-call",
					toolCallId: "tool-1",
					toolName: "attach_media",
					input: { assetId: "source-asset" },
				},
			},
		]);
		store.getState().markRunCompleted();

		store.getState().resetProjectScope();

		expect(store.getState().events).toEqual([]);
		expect(store.getState().runStartedWithData).toBe(false);
		expect(store.getState().runCompletedAt).toBeUndefined();
		expect(JSON.stringify(store.getState().events)).not.toContain(
			"source-asset",
		);
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
function createConnectTestStores(
	opts: { readonly formAFields?: Parameters<typeof f>[0][] } = {},
) {
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
						{
							uuid: "form-1-uuid",
							name: "Form A",
							type: "survey",
							fields: (
								opts.formAFields ?? [{ kind: "text", id: "question_a" }]
							).map(f),
						},
						{
							uuid: "form-2-uuid",
							name: "Form B",
							type: "survey",
							fields: [f({ kind: "text", id: "question_b" })],
						},
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
	 *  flow finalizes before calling the session action. */
	function stagedLearnBlocks(formA: string, formB: string) {
		return {
			[formA]: {
				learn_module: {
					id: "form_a",
					name: "Form A",
					description: "desc",
					time_estimate: 5,
				},
			},
			[formB]: {
				assessment: { id: "form_b_assessment", user_score: xp("100") },
			},
		};
	}

	/** Staged deliver-mode blocks for both fixture forms. */
	function stagedDeliverBlocks(formA: string, formB: string) {
		return {
			[formA]: { deliver_unit: { id: "visit_a", name: "Visit A" } },
			[formB]: { deliver_unit: { id: "visit_b", name: "Visit B" } },
		};
	}

	function learnModule(config: ConnectConfig | undefined) {
		return config !== undefined && "learn_module" in config
			? config.learn_module
			: undefined;
	}

	function assessment(config: ConnectConfig | undefined) {
		return config !== undefined && "assessment" in config
			? config.assessment
			: undefined;
	}

	function deliverUnit(config: ConnectConfig | undefined) {
		return config !== undefined && "deliver_unit" in config
			? config.deliver_unit
			: undefined;
	}

	it("0. enabling with no blocks in hand is REJECTED — the doc and stash stay untouched", () => {
		const { session, doc } = createConnectTestStores();
		toastStore.clear();

		const outcome = session
			.getState()
			.switchConnectMode("learn", undefined, NO_LOOKUPS);

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

		const outcome = session.getState().switchConnectMode("learn", undefined, {
			...NO_LOOKUPS,
			announce: false,
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.messages.length).toBeGreaterThan(0);
		expect(doc.getState().connectType).toBeNull();
		expect(toastStore.toasts).toHaveLength(0);
	});

	/* The gate is absolute: a lookup reference it cannot check is a soundness
	 * finding, whatever the batch touched. On a doc that carries a
	 * lookup-backed select the switch must run under the Project's lookup
	 * context the hook binds; an unavailable one refuses every switch. */
	describe("on a doc that carries a lookup source", () => {
		const TABLE = lookupTableIdSchema.parse(
			"01912d68-783e-7000-8000-00000000a001",
		);
		const VALUE = lookupColumnIdSchema.parse(
			"01912d68-783e-7000-8000-00000000c001",
		);
		const LABEL = lookupColumnIdSchema.parse(
			"01912d68-783e-7000-8000-00000000c002",
		);
		const REVISION = parseLookupRevision("1");
		const AVAILABLE: LookupValidationContext = {
			kind: "available",
			projectId: "project-1",
			projectRevision: REVISION,
			definitions: [
				{
					id: TABLE,
					name: "Destinations",
					tag: "destinations",
					definitionRevision: REVISION,
					columns: [
						{ id: VALUE, wireName: "code", label: "Code", dataType: "text" },
						{ id: LABEL, wireName: "name", label: "Name", dataType: "text" },
					],
				},
			],
		};
		const lookupSelect = {
			kind: "single_select" as const,
			id: "destination",
			label: proseText("Destination"),
			optionsSource: {
				kind: "lookup",
				tableId: TABLE,
				valueColumnId: VALUE,
				labelColumnId: LABEL,
			},
		};

		it("switches modes under the Project's lookup context", () => {
			const { session, doc, formA, formB } = createConnectTestStores({
				formAFields: [lookupSelect],
			});

			const outcome = session
				.getState()
				.switchConnectMode("learn", stagedLearnBlocks(formA, formB), {
					lookupContext: AVAILABLE,
				});

			expect(outcome).toEqual({ ok: true });
			expect(doc.getState().connectType).toBe("learn");
		});

		it("refuses the same switch when the lookup context is unavailable — fail closed", () => {
			const { session, doc, formA, formB } = createConnectTestStores({
				formAFields: [lookupSelect],
			});

			const outcome = session
				.getState()
				.switchConnectMode("learn", stagedLearnBlocks(formA, formB), {
					lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
					announce: false,
				});

			expect(outcome.ok).toBe(false);
			expect(doc.getState().connectType).toBeNull();
		});
	});

	it("1. switchConnectMode('learn', staged) sets the type AND lands every form's block in one commit", () => {
		const { session, doc, formA, formB } = createConnectTestStores();

		const outcome = session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB), NO_LOOKUPS);

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("learn");
		expect(learnModule(doc.getState().forms[formA]?.connect)?.name).toBe(
			"Form A",
		);
		expect(learnModule(doc.getState().forms[formA]?.connect)?.id).toBe(
			"form_a",
		);
		expect(assessment(doc.getState().forms[formB]?.connect)?.id).toBe(
			"form_b_assessment",
		);
		/* No outgoing mode to stash — both stash records remain empty. */
		expect(session.getState().connectStash.learn).toEqual({});
		expect(session.getState().connectStash.deliver).toEqual({});
	});

	it("1b. a partial staging commits — unpicked forms stay auxiliary (no block, no finding)", () => {
		/* Participation is per form: the enable flow stages blocks only for
		 * the forms the user picked, and the flip is legal as long as at
		 * least one form participates. */
		const { session, doc, formA, formB } = createConnectTestStores();

		const outcome = session.getState().switchConnectMode(
			"learn",
			{
				[formA]: {
					learn_module: {
						id: "form_a",
						name: "Form A",
						description: "desc",
						time_estimate: 5,
					},
				},
			},
			NO_LOOKUPS,
		);

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("learn");
		expect(learnModule(doc.getState().forms[formA]?.connect)?.name).toBe(
			"Form A",
		);
		expect(doc.getState().forms[formB]?.connect).toBeUndefined();
	});

	it("2. switching learn->deliver stashes the learn configs and lands the staged deliver blocks", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB), NO_LOOKUPS);

		const outcome = session
			.getState()
			.switchConnectMode(
				"deliver",
				stagedDeliverBlocks(formA, formB),
				NO_LOOKUPS,
			);

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("deliver");
		/* The learn stash holds both forms' configs keyed by uuid. */
		const stash = session.getState().connectStash.learn;
		expect(learnModule(stash[formA])?.name).toBe("Form A");
		expect(assessment(stash[formB])).toBeDefined();
		/* lastConnectType tracks the now-active mode (the field's documented
		 * "last active connect type"), so a later turn-off / off-state default
		 * returns to deliver, not the mode just left. */
		expect(session.getState().lastConnectType).toBe("deliver");
	});

	it("3. switching deliver->learn restores the stashed learn configs onto the forms", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB), NO_LOOKUPS);
		session
			.getState()
			.switchConnectMode(
				"deliver",
				stagedDeliverBlocks(formA, formB),
				NO_LOOKUPS,
			);

		/* The learn stash holds both forms' prior work. The manager seeds its
		 * learn drafts from that stash and hands the whole set back to switch
		 * mode — the store no longer restores on its own. */
		const outcome = session
			.getState()
			.switchConnectMode(
				"learn",
				session.getState().connectStash.learn,
				NO_LOOKUPS,
			);

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("learn");
		expect(learnModule(doc.getState().forms[formA]?.connect)?.name).toBe(
			"Form A",
		);
	});

	it("4. switchConnectMode(null) clears doc connectType and all form connect configs", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB), NO_LOOKUPS);

		/* Disable connect entirely — always valid. */
		const outcome = session
			.getState()
			.switchConnectMode(null, undefined, NO_LOOKUPS);

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBeNull();
		expect(doc.getState().forms[formA]?.connect).toBeUndefined();
		expect(doc.getState().forms[formB]?.connect).toBeUndefined();
	});

	it("5. lastConnectType remains a UI default while re-enable states the mode exactly", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB), NO_LOOKUPS);
		session
			.getState()
			.switchConnectMode(
				"deliver",
				stagedDeliverBlocks(formA, formB),
				NO_LOOKUPS,
			);
		session.getState().switchConnectMode(null, undefined, NO_LOOKUPS);

		/* lastConnectType is 'deliver' (set when switching away from it). */
		expect(session.getState().lastConnectType).toBe("deliver");

		/* The manager uses that hint for its selector, but the document command
		 * still states the exact target mode and complete participants. */
		const outcome = session
			.getState()
			.switchConnectMode(
				"deliver",
				session.getState().connectStash.deliver,
				NO_LOOKUPS,
			);
		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("deliver");
	});

	it("6. a mode switch clears the outgoing block from each form (stashed, never lingering cross-mode)", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB), NO_LOOKUPS);

		session
			.getState()
			.switchConnectMode(
				"deliver",
				stagedDeliverBlocks(formA, formB),
				NO_LOOKUPS,
			);

		/* `form.connect` holds only the active-mode config — the learn block
		 * was replaced wholesale by the deliver one, and preserved in the
		 * learn stash for switch-back. */
		expect(learnModule(doc.getState().forms[formA]?.connect)).toBeUndefined();
		expect(deliverUnit(doc.getState().forms[formA]?.connect)?.name).toBe(
			"Visit A",
		);
		expect(
			learnModule(session.getState().connectStash.learn[formA]),
		).toBeDefined();
	});

	it("7. learn->null->learn round-trip restores the original learn configs (no work lost)", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB), NO_LOOKUPS);

		/* Disable connect entirely (clears every form.connect, stashing the
		 * learn configs first), then re-enable the SAME mode by handing back
		 * the stash — the manager's seed-then-apply round-trip. */
		session.getState().switchConnectMode(null, undefined, NO_LOOKUPS);
		expect(doc.getState().forms[formA]?.connect).toBeUndefined();

		const outcome = session
			.getState()
			.switchConnectMode(
				"learn",
				session.getState().connectStash.learn,
				NO_LOOKUPS,
			);
		expect(outcome.ok).toBe(true);
		const restored = doc.getState().forms[formA]?.connect;
		expect(learnModule(restored)?.name).toBe("Form A");
	});

	it("8. duplicate final ids reject atomically instead of being rewritten", () => {
		const { session, doc, formA, formB } = createConnectTestStores();

		const outcome = session.getState().switchConnectMode(
			"deliver",
			{
				[formA]: { deliver_unit: { id: "visit", name: "Visit A" } },
				[formB]: { deliver_unit: { id: "visit", name: "Visit B" } },
			},
			NO_LOOKUPS,
		);

		expect(outcome.ok).toBe(false);
		expect(doc.getState().connectType).toBeNull();
		expect(doc.getState().forms[formA]?.connect).toBeUndefined();
		expect(doc.getState().forms[formB]?.connect).toBeUndefined();
	});

	it("8a. a stashed explicit id that was claimed while inactive is refused without rewriting the stash", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		session.getState().switchConnectMode(
			"learn",
			{
				[formA]: {
					learn_module: {
						id: "shared",
						name: "Form A",
						description: "Stashed exact content",
						time_estimate: 5,
					},
				},
				[formB]: {
					learn_module: {
						id: "form_b",
						name: "Form B",
						description: "Live content",
						time_estimate: 5,
					},
				},
			},
			NO_LOOKUPS,
		);
		/* Drop A from the exact participant set so its block is stashed, then
		 * let the remaining participant claim A's now-free explicit id. */
		expect(
			session.getState().switchConnectMode(
				"learn",
				{
					[formB]: {
						learn_module: {
							id: "form_b",
							name: "Form B",
							description: "Live content",
							time_estimate: 5,
						},
					},
				},
				NO_LOOKUPS,
			),
		).toEqual({ ok: true });
		expect(
			session.getState().switchConnectMode(
				"learn",
				{
					[formB]: {
						learn_module: {
							id: "shared",
							name: "Form B",
							description: "Claimed while A was inactive",
							time_estimate: 5,
						},
					},
				},
				NO_LOOKUPS,
			),
		).toEqual({ ok: true });

		const exactStash = session.getState().connectStash.learn[formA];
		expect(learnModule(exactStash)?.id).toBe("shared");
		const liveB = doc.getState().forms[formB]?.connect;
		if (!exactStash || !liveB) {
			throw new Error("Expected exact stashed and live Connect blocks.");
		}
		const outcome = session.getState().switchConnectMode(
			"learn",
			{
				[formA]: exactStash,
				[formB]: liveB,
			},
			NO_LOOKUPS,
		);

		expect(outcome.ok).toBe(false);
		expect(doc.getState().forms[formA]?.connect).toBeUndefined();
		expect(learnModule(doc.getState().forms[formB]?.connect)?.id).toBe(
			"shared",
		);
		expect(learnModule(session.getState().connectStash.learn[formA])?.id).toBe(
			"shared",
		);
	});

	it("9. canonical genesis always has a starter form and refuses bare Connect enablement", () => {
		/* Every persisted app is born from the same export-ready genesis,
		 * including MCP creation. There is no zero-form app exception. */
		const root = buildDoc({ appId: "genesis-app", appName: "" });
		const genesis = canonicalAppGenesis(root);
		const born = mutationCommitVerdict(
			root,
			genesis.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!born.ok) throw new Error("canonical genesis was rejected");
		const docStore = createBlueprintDocStore();
		docStore.getState().load(born.nextDoc);
		docStore.getState().startTracking();
		const session = createBuilderSessionStore();
		session.getState()._setDocStore(docStore);

		const outcome = session
			.getState()
			.switchConnectMode("learn", undefined, NO_LOOKUPS);

		expect(docStore.getState().formOrder[genesis.moduleUuid]).toEqual([
			genesis.formUuid,
		]);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("bare Connect enablement was accepted");
		expect(outcome.messages).not.toHaveLength(0);
		expect(docStore.getState().connectType).toBeNull();
		/* The always-valid OFF target remains an exact no-op. */
		expect(
			session.getState().switchConnectMode(null, undefined, NO_LOOKUPS),
		).toEqual({ ok: true });
		expect(docStore.getState().connectType).toBeNull();
	});

	it("10. a same-mode apply edits an existing block (keeping its id) and drops a form left out of the set", () => {
		/* The manager hands the COMPLETE participating set for the current
		 * mode. A form whose block changed updates; a form omitted from the
		 * set stops participating; an existing id round-trips unchanged so
		 * Connect's slug never churns. */
		const { session, doc, formA, formB } = createConnectTestStores();
		session.getState().switchConnectMode(
			"learn",
			{
				[formA]: {
					learn_module: {
						id: "form_a",
						name: "Form A",
						description: "d",
						time_estimate: 5,
					},
				},
				[formB]: {
					learn_module: {
						id: "form_b",
						name: "Form B",
						description: "d",
						time_estimate: 5,
					},
				},
			},
			NO_LOOKUPS,
		);
		const idA = learnModule(doc.getState().forms[formA]?.connect)?.id;
		expect(idA).toBeTruthy();
		if (idA === undefined) throw new Error("Expected finalized Connect id");

		const outcome = session.getState().switchConnectMode(
			"learn",
			{
				[formA]: {
					learn_module: {
						id: idA,
						name: "Renamed",
						description: "d",
						time_estimate: 9,
					},
				},
			},
			NO_LOOKUPS,
		);

		expect(outcome.ok).toBe(true);
		expect(doc.getState().connectType).toBe("learn");
		expect(learnModule(doc.getState().forms[formA]?.connect)?.name).toBe(
			"Renamed",
		);
		expect(
			learnModule(doc.getState().forms[formA]?.connect)?.time_estimate,
		).toBe(9);
		/* The id was kept verbatim — no re-slugging. */
		expect(learnModule(doc.getState().forms[formA]?.connect)?.id).toBe(idA);
		/* Form B was omitted from the desired set → auxiliary again. */
		expect(doc.getState().forms[formB]?.connect).toBeUndefined();
		/* …but its dropped block is stashed (same-mode drop stays reversible,
		 * the per-form-toggle guarantee), so re-adding B restores its config. */
		expect(
			learnModule(session.getState().connectStash.learn[formB])?.name,
		).toBe("Form B");
	});

	it("11. an apply that already matches the doc commits nothing (no undo entry)", () => {
		const { session, doc, formA } = createConnectTestStores();
		session.getState().switchConnectMode(
			"learn",
			{
				[formA]: {
					learn_module: {
						id: "form_a",
						name: "Form A",
						description: "d",
						time_estimate: 5,
					},
				},
			},
			NO_LOOKUPS,
		);
		const before = doc.getState().canUndo ? 1 : 0;

		/* Re-apply the doc's current state verbatim — no field changed. */
		const current = doc.getState().forms[formA]?.connect;
		const outcome = session.getState().switchConnectMode(
			"learn",
			{
				[formA]: current as NonNullable<typeof current>,
			},
			NO_LOOKUPS,
		);

		expect(outcome.ok).toBe(true);
		expect(doc.getState().canUndo ? 1 : 0).toBe(before);
	});

	it("12. enabling a mode from OFF sets lastConnectType to THAT mode, not a stale prior", () => {
		const { session, doc, formA, formB } = createConnectTestStores();
		/* Use deliver, then turn off — lastConnectType remembers deliver. */
		session
			.getState()
			.switchConnectMode(
				"deliver",
				stagedDeliverBlocks(formA, formB),
				NO_LOOKUPS,
			);
		session.getState().switchConnectMode(null, undefined, NO_LOOKUPS);
		expect(session.getState().lastConnectType).toBe("deliver");

		/* Enabling learn FROM OFF moves the manager's UI default to learn. */
		session
			.getState()
			.switchConnectMode("learn", stagedLearnBlocks(formA, formB), NO_LOOKUPS);
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
		/* The run's writes are one step, so an edit inside it records none. */
		doc.getState().applyMany([{ kind: "setAppName", name: "InRun" }]);
		expect(doc.getState().canUndo).toBe(false);
	});

	it("beginRun captures runStartedWithData from the doc by default", () => {
		const { session } = createGenerationTestStores(/* withData */ true);
		session.getState().beginRun();
		expect(session.getState().runStartedWithData).toBe(true);
	});

	it("beginRun honors the startedWithData override (a reconnected build resume)", () => {
		/* A page refresh mid-BUILD reconnects to the run with the build's
		 * committed modules already in the loaded doc — the default capture
		 * would misread the resumed build as an edit. The override keeps the
		 * lifecycle derivations (phase chrome, appReady) on the build arm. */
		const { session } = createGenerationTestStores(/* withData */ true);
		session.getState().beginRun({ startedWithData: false });
		expect(session.getState().runStartedWithData).toBe(false);
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
		/* Outside a run, an edit is its own step. */
		doc.getState().applyMany([{ kind: "setAppName", name: "Edited" }]);
		expect(doc.getState().canUndo).toBe(true);
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

	it("promotes a created app with its authoritative Project tuple atomically", () => {
		const store = createBuilderSessionStore({
			projectId: "project-from-stale-tab",
			role: "viewer",
			canEdit: false,
		});
		store.getState().beginAccessRefresh();

		store.getState().activateCreatedApp("app-in-seeded-project", {
			projectId: "project-seeded-by-build-new",
			role: "editor",
			canEdit: true,
		});

		expect(store.getState()).toMatchObject({
			appId: "app-in-seeded-project",
			projectId: "project-seeded-by-build-new",
			role: "editor",
			canEdit: true,
			accessPhase: "authorized",
			hasWaitingAccessChanges: false,
		});
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

// ── Reset ───────────────────────────────────────────────────────────────

describe("reset", () => {
	it("clears all generation, appId, and transient fields", () => {
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

	it("preserves the buildUnfinished latch instead of re-seeding it from init", () => {
		/* The latch is APP truth, not session state: re-seeding from the frozen
		 * constructor init would resurrect a released latch (the app completed
		 * its build, but a reset re-prices every edit as a build) and clear a
		 * legitimately armed one. Both directions must survive a reset. */
		const released = createBuilderSessionStore({ buildUnfinished: true });
		released.getState().markBuildFinished();
		released.getState().reset();
		expect(released.getState().buildUnfinished).toBe(false);

		const latched = createBuilderSessionStore();
		latched.getState().markBuildUnfinished();
		latched.getState().reset();
		expect(latched.getState().buildUnfinished).toBe(true);
	});

	it("keeps Project edit authority for chat while locking direct initial-build authoring", () => {
		const store = createBuilderSessionStore({
			canEdit: true,
			buildUnfinished: true,
		});
		expect(store.getState()).toMatchObject({
			projectCanEdit: true,
			canEdit: false,
			buildUnfinished: true,
		});

		/* An access refresh must not accidentally unlock an unfinished build. */
		store.getState().applyAccessSnapshot({
			projectId: "project-test",
			role: "editor",
			canEdit: true,
		});
		expect(store.getState().canEdit).toBe(false);

		store.getState().markBuildFinished();
		expect(store.getState()).toMatchObject({
			projectCanEdit: true,
			canEdit: true,
			buildUnfinished: false,
		});
	});

	it("ignores a stale re-arm after an observed completion (one-way per build)", () => {
		/* The seq-less app-status frames carry no ordering, so a `generating`
		 * frame read milliseconds before the completing run committed can be
		 * delivered AFTER this tab's own `data-done` released the latch.
		 * `complete` is terminal in the app lifecycle, so any arming signal
		 * after an observed completion is stale by definition and must not
		 * re-price a finished app's sends as builds. */
		const store = createBuilderSessionStore({ buildUnfinished: true });
		store.getState().markBuildFinished();
		store.getState().markBuildUnfinished();
		expect(store.getState().buildUnfinished).toBe(false);

		/* Before any observed completion the arm channels work normally: the
		 * creation handoff, and an `error` frame repairing a missed seed. */
		const fresh = createBuilderSessionStore();
		fresh.getState().markBuildUnfinished();
		expect(fresh.getState().buildUnfinished).toBe(true);

		/* A born-complete tab that observes the connect-time `complete` frame
		 * is equally protected from a later stale frame. */
		const bornComplete = createBuilderSessionStore();
		bornComplete.getState().markBuildFinished();
		bornComplete.getState().markBuildUnfinished();
		expect(bornComplete.getState().buildUnfinished).toBe(false);
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

// ── Publish dialog request (one-shot) ─────────────────────────────────────

describe("BuilderSession publish dialog request", () => {
	it("starts empty and holds the latest request", () => {
		const store = createBuilderSessionStore();
		expect(store.getState().publishDialogRequest).toBeNull();

		store.getState().requestPublishDialog({ domain: "alpha" });
		expect(store.getState().publishDialogRequest).toEqual({ domain: "alpha" });

		store.getState().requestPublishDialog({ domain: "beta" });
		expect(store.getState().publishDialogRequest).toEqual({ domain: "beta" });
	});

	it("clears once and no-ops on an already-empty request", () => {
		const store = createBuilderSessionStore();
		store.getState().requestPublishDialog({ domain: "alpha" });
		store.getState().clearPublishDialogRequest();
		expect(store.getState().publishDialogRequest).toBeNull();

		/* A second clear must not write: the consumer clears as it opens, and
		 * a redundant write would re-notify every subscriber for nothing. */
		const prev = store.getState();
		store.getState().clearPublishDialogRequest();
		expect(store.getState()).toBe(prev);
	});

	it("is dropped by reset and by the Project-scope boundary", () => {
		const viaReset = createBuilderSessionStore();
		viaReset.getState().requestPublishDialog({ domain: "alpha" });
		viaReset.getState().reset();
		expect(viaReset.getState().publishDialogRequest).toBeNull();

		const viaScope = createBuilderSessionStore();
		viaScope.getState().requestPublishDialog({ domain: "alpha" });
		viaScope.getState().resetProjectScope();
		expect(viaScope.getState().publishDialogRequest).toBeNull();
	});
});

describe("BuilderSession deployment records revision", () => {
	it("counts every record write and is rewound by reset", () => {
		const store = createBuilderSessionStore();
		expect(store.getState().deploymentRecordsRevision).toBe(0);
		store.getState().noteDeploymentRecordsChanged();
		store.getState().noteDeploymentRecordsChanged();
		expect(store.getState().deploymentRecordsRevision).toBe(2);
		store.getState().reset();
		expect(store.getState().deploymentRecordsRevision).toBe(0);
	});
});

describe("BuilderSession held provisioning outcomes", () => {
	const worker = (
		overrides: Partial<ProvisionedWorker>,
	): ProvisionedWorker => ({
		personaUuid: "persona-1",
		personaName: "Asha",
		username: "asha@space.commcarehq.org",
		userId: "hq-user-1",
		created: true,
		adopted: false,
		password: "shown-once",
		...overrides,
	});

	it("accumulates workers per target and keeps a made password through an update", () => {
		const store = createBuilderSessionStore();
		store.getState().recordProvisioningOutcome({
			server: "production",
			domain: "space",
			workers: [worker({})],
			refusal: null,
		});
		// A later call updates the same account; updates carry no password.
		store.getState().recordProvisioningOutcome({
			server: "production",
			domain: "space",
			workers: [
				worker({ created: false, password: null }),
				worker({
					personaUuid: "persona-2",
					personaName: "Bilal",
					username: "bilal@space.commcarehq.org",
					password: "second-password",
				}),
			],
			refusal: null,
		});
		const held =
			store.getState().provisioningOutcomes[
				provisioningOutcomeKey("production", "space")
			];
		expect(held.workers).toHaveLength(2);
		expect(held.workers[0].password).toBe("shown-once");
		expect(held.workers[1].password).toBe("second-password");
	});

	it("keys outcomes by server AND domain, and clears them on reset", () => {
		const store = createBuilderSessionStore();
		store.getState().recordProvisioningOutcome({
			server: "production",
			domain: "space",
			workers: [worker({})],
			refusal: null,
		});
		expect(
			store.getState().provisioningOutcomes[
				provisioningOutcomeKey("india", "space")
			],
		).toBeUndefined();
		store.getState().reset();
		expect(store.getState().provisioningOutcomes).toEqual({});
	});
});
