/**
 * Tests for the `data-mutations` dispatch branch in `applyStreamEvent`.
 *
 * The live server emits fine-grained `Mutation[]` batches directly via
 * `GenerationContext.emitMutations()` and now also ships the matching
 * `MutationEvent[]` envelopes in the same payload so the client can
 * mirror the persisted log into its session events buffer. These tests
 * verify that the dispatcher:
 *
 *   - applies single mutations and multi-mutation atomic batches,
 *   - appends the envelopes to the session events buffer,
 *   - gracefully ignores empty or missing payloads (neither store
 *     changes), and
 *   - carries the optional `stage` tag on each envelope.
 *
 * We use real wired stores (BlueprintDocStore + BuilderSessionStore) so
 * reducers and selectors run exactly as in production.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain";
import type { MutationEvent } from "@/lib/log/types";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { applyStreamEvent } from "../streamDispatcher";
import { createWiredStores } from "./testHelpers";

/** Build MutationEvent envelopes for each mutation, stamping the
 *  optional stage tag — mirrors what `GenerationContext.emitMutations`
 *  now produces on the server. */
function envelopes(mutations: Mutation[], stage?: string): MutationEvent[] {
	return mutations.map((mutation, i) => ({
		kind: "mutation",
		runId: "test-run",
		ts: 0,
		seq: i,
		actor: "agent",
		...(stage && { stage }),
		mutation,
	}));
}

// ── Test suite ──────────────────────────────────────────────────────────

describe("applyStreamEvent — data-mutations", () => {
	let docStore: BlueprintDocStoreApi;
	let sessionStore: BuilderSessionStoreApi;

	beforeEach(() => {
		const stores = createWiredStores();
		docStore = stores.docStore;
		sessionStore = stores.sessionStore;
	});

	it("applies a single mutation AND appends its envelope to the buffer", () => {
		const mutations: Mutation[] = [
			{ kind: "setAppName", name: "Clinical Trial App" },
		];
		const events = envelopes(mutations, "schema");

		applyStreamEvent(
			"data-mutations",
			{ mutations, events, stage: "schema" },
			docStore,
			sessionStore,
		);

		expect(docStore.getState().appName).toBe("Clinical Trial App");
		expect(sessionStore.getState().events).toEqual(events);
	});

	it("applies a multi-mutation batch atomically AND appends all envelopes", () => {
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
		const events = envelopes(mutations, "scaffold");

		applyStreamEvent(
			"data-mutations",
			{ mutations, events, stage: "scaffold" },
			docStore,
			sessionStore,
		);

		const doc = docStore.getState();
		expect(doc.appName).toBe("Field Survey");
		expect(doc.moduleOrder).toEqual([moduleUuid]);
		expect(doc.modules[moduleUuid]?.name).toBe("Intake");
		expect(doc.formOrder[moduleUuid]).toEqual([formUuid]);
		expect(doc.forms[formUuid]?.name).toBe("Enroll Participant");

		expect(sessionStore.getState().events).toHaveLength(3);
	});

	it("ignores an empty mutations array — neither store changes", () => {
		const docBefore = docStore.getState();
		const eventsBefore = sessionStore.getState().events;

		applyStreamEvent(
			"data-mutations",
			{ mutations: [] as Mutation[], events: [] as MutationEvent[] },
			docStore,
			sessionStore,
		);

		expect(docStore.getState().appName).toBe(docBefore.appName);
		expect(docStore.getState().moduleOrder).toBe(docBefore.moduleOrder);
		/* Reference-preserving on empty push. */
		expect(sessionStore.getState().events).toBe(eventsBefore);
	});

	it("ignores a payload with missing keys (no throw, no changes)", () => {
		const appNameBefore = docStore.getState().appName;
		const eventsBefore = sessionStore.getState().events;

		expect(() => {
			applyStreamEvent("data-mutations", {}, docStore, sessionStore);
		}).not.toThrow();

		expect(docStore.getState().appName).toBe(appNameBefore);
		expect(sessionStore.getState().events).toBe(eventsBefore);
	});

	it("stamps the optional `stage` tag onto every envelope", () => {
		const mutations: Mutation[] = [
			{ kind: "setAppName", name: "Staged Build" },
		];
		const events = envelopes(mutations, "scaffold");

		applyStreamEvent(
			"data-mutations",
			{ mutations, events, stage: "scaffold" },
			docStore,
			sessionStore,
		);

		expect(docStore.getState().appName).toBe("Staged Build");
		const bufferEvent = sessionStore.getState().events[0];
		expect(bufferEvent?.kind).toBe("mutation");
		expect(bufferEvent?.kind === "mutation" && bufferEvent.stage).toBe(
			"scaffold",
		);
	});
});
