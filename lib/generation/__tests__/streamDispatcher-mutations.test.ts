/**
 * Tests for the `data-mutations` dispatch branch in `applyStreamEvent`.
 *
 * The live server emits fine-grained `Mutation[]` batches directly via
 * `GenerationContext.emitMutations()` (Phase 3, Task 15) so the client no
 * longer needs to translate snapshot-shaped events through
 * `toDocMutations`. These tests verify that the dispatcher:
 *
 *   - applies single mutations and multi-mutation atomic batches,
 *   - gracefully ignores empty or missing payloads, and
 *   - treats the optional `stage` tag as metadata only (consumed by the
 *     Phase 4 generation-log UI — the live apply path ignores it).
 *
 * We use real wired stores (BlueprintDocStore + BuilderSessionStore) so
 * reducers and selectors run exactly as in production. Fixtures mirror
 * the style of `streamDispatcher.test.ts` (same UUID shape, normalized
 * domain entities).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores } from "./testHelpers";

// ── Test suite ──────────────────────────────────────────────────────────

describe("applyStreamEvent — data-mutations", () => {
	let docStore: BlueprintDocStoreApi;
	let sessionStore: BuilderSessionStoreApi;

	beforeEach(() => {
		const stores = createWiredStores();
		docStore = stores.docStore;
		sessionStore = stores.sessionStore;
	});

	it("applies a single mutation from the batch", () => {
		/* A single `setAppName` mutation is the simplest shape — it tests
		 * that the dispatcher forwards to `applyMany` and the reducer
		 * updates the top-level `appName` field. */
		const mutations: Mutation[] = [
			{ kind: "setAppName", name: "Clinical Trial App" },
		];

		applyStreamEvent("data-mutations", { mutations }, docStore, sessionStore);

		expect(docStore.getState().appName).toBe("Clinical Trial App");
	});

	it("applies a multi-mutation batch atomically", () => {
		/* Three mutations in a single event — setAppName + addModule +
		 * addForm — must all land on the doc. This exercises the atomic
		 * `applyMany` path the live server relies on. */
		const moduleUuid = asUuid("mod-live-1");
		const formUuid = asUuid("form-live-1");

		const mutations: Mutation[] = [
			{ kind: "setAppName", name: "Field Survey" },
			{
				kind: "addModule",
				module: {
					uuid: moduleUuid,
					id: "intake",
					name: "Intake",
					caseType: "participant",
				},
			},
			{
				kind: "addForm",
				moduleUuid,
				form: {
					uuid: formUuid,
					id: "enroll",
					name: "Enroll Participant",
					type: "registration",
				},
			},
		];

		applyStreamEvent("data-mutations", { mutations }, docStore, sessionStore);

		const doc = docStore.getState();
		expect(doc.appName).toBe("Field Survey");
		expect(doc.moduleOrder).toEqual([moduleUuid]);
		expect(doc.modules[moduleUuid]?.name).toBe("Intake");
		expect(doc.formOrder[moduleUuid]).toEqual([formUuid]);
		expect(doc.forms[formUuid]?.name).toBe("Enroll Participant");
	});

	it("ignores an empty mutations array", () => {
		/* An empty batch is a no-op: the server may emit a keep-alive
		 * `data-mutations` with zero mutations (e.g. end-of-tool marker
		 * once Phase 4 lands). The dispatcher must not invoke `applyMany`
		 * or mutate the doc. The original empty doc must remain pristine. */
		const before = docStore.getState();
		const appNameBefore = before.appName;
		const moduleOrderBefore = before.moduleOrder;

		applyStreamEvent(
			"data-mutations",
			{ mutations: [] as Mutation[] },
			docStore,
			sessionStore,
		);

		const after = docStore.getState();
		expect(after.appName).toBe(appNameBefore);
		/* Reference equality — the no-op path must not churn the store. */
		expect(after.moduleOrder).toBe(moduleOrderBefore);
	});

	it("ignores a payload with a missing mutations key", () => {
		/* Defensive branch: a malformed server event without the
		 * `mutations` key must not throw. `applyMany` should never be
		 * invoked in this case. */
		const appNameBefore = docStore.getState().appName;

		expect(() => {
			applyStreamEvent("data-mutations", {}, docStore, sessionStore);
		}).not.toThrow();

		expect(docStore.getState().appName).toBe(appNameBefore);
	});

	it("passes through an optional `stage` tag without changing apply behaviour", () => {
		/* The `stage` field on the payload is metadata for the Phase 4
		 * generation-log UI — the live apply path ignores it entirely. A
		 * mutation batch with `stage: "scaffold"` must produce exactly the
		 * same doc state as the same batch without the tag. */
		const mutations: Mutation[] = [
			{ kind: "setAppName", name: "Staged Build" },
		];

		applyStreamEvent(
			"data-mutations",
			{ mutations, stage: "scaffold" },
			docStore,
			sessionStore,
		);

		expect(docStore.getState().appName).toBe("Staged Build");
	});
});
