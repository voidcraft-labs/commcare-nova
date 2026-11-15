// Until the signed-in member's session resolves, the session holds none of
// the worker's keys, and a device refuses a read of a key its worker lacks.
// So no entry opens against it: the controller holds the requested entry and
// opens it when the worker arrives, never showing the refusal a device shows
// for a worker who lacks the key. A worker arriving for an entry refused as
// it opened opens it again, since this worker can hold what it lacked.

import { afterEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { sessionUser, term } from "@/lib/domain/expression";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { EngineController } from "../engineController";
import { previewAsMe, type ResolvedPreviewIdentity } from "../identity";

const FORM = testUuid("identity-pending-form");
const ANSWER = testUuid("identity-pending-answer");
const MEMBER = {
	id: "worker-1",
	name: "Amina Diallo",
	email: "amina@example.org",
};

/** A survey whose one question starts on a worker key: the first name every
 *  device holds, or the primary place a worker assigned nowhere lacks. */
function controller(
	async: boolean,
	key: "commcare_first_name" | "commcare_location_id",
) {
	const doc = buildDoc({
		appName: "Identity pending",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: ANSWER,
								kind: "text",
								id: "who",
								label: "Who",
								default_value: term(sessionUser(key)),
							}),
						],
					},
				],
			},
		],
	});
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length > 0) throw new Error(JSON.stringify(findings));
	const store = createBlueprintDocStore();
	store.getState().load(toPersistableDoc(doc));
	store.getState().startTracking();
	const ctrl = new EngineController(
		async
			? new XPathRuntime({ workerFactory: createInProcessXPathWorkerFactory() })
			: undefined,
	);
	controllers.push(ctrl);
	ctrl.setDocStore(store);
	const report = vi.fn();
	ctrl.setFaultReporter(report);
	return { ctrl, report };
}

const controllers: EngineController[] = [];
afterEach(async () => {
	for (const stop of unsubscribes.splice(0)) stop();
	for (const ctrl of controllers.splice(0)) {
		ctrl.dispose();
		await ctrl.awaitSettled();
	}
});

async function activate(ctrl: EngineController, async: boolean) {
	if (async) await ctrl.activateFormAsync(FORM);
	else ctrl.activateForm(FORM);
	await ctrl.awaitSettled();
}

/** What the engine provider installs as the member's session resolves, or
 *  stops resolving (`EngineController.installSessionIdentity`). */
function install(
	ctrl: EngineController,
	identity: ResolvedPreviewIdentity | null,
) {
	ctrl.installSessionIdentity(identity);
}

/** Every entry refusal the controller publishes from now on, however
 *  briefly it stands. */
function refusalsPublished(ctrl: EngineController) {
	const seen: unknown[] = [];
	const stop = ctrl.entryStore.subscribe((state) => {
		if (state.refusal !== undefined) seen.push(state.refusal);
	});
	unsubscribes.push(stop);
	return seen;
}
const unsubscribes: (() => void)[] = [];

const member = (): ResolvedPreviewIdentity => {
	const identity = previewAsMe(MEMBER);
	if (identity === null) throw new Error("The member has no identity.");
	return identity;
};

/** The member assigned a primary place, which their session then holds. */
const placedMember = (): ResolvedPreviewIdentity => {
	const identity = member();
	return {
		...identity,
		session: {
			...identity.session,
			user: { ...identity.session.user, commcare_location_id: "north" },
		},
	};
};

for (const async of [false, true]) {
	const path = async ? "worker" : "synchronous";

	describe(`a session waiting for its worker (${path} path)`, () => {
		it("holds the entry, refusing nothing, and opens it as the worker arrives", async () => {
			const { ctrl, report } = controller(async, "commcare_first_name");
			const refusals = refusalsPublished(ctrl);
			install(ctrl, null);
			await activate(ctrl, async);

			expect(ctrl.entryStore.getState()).toMatchObject({
				formUuid: undefined,
				ready: false,
				fault: undefined,
				refusal: undefined,
			});

			install(ctrl, member());
			await ctrl.awaitSettled();

			expect(ctrl.entryStore.getState()).toMatchObject({
				formUuid: FORM,
				ready: true,
				fault: undefined,
				refusal: undefined,
			});
			expect(ctrl.store.getState()[ANSWER]?.value).toBe("Amina");
			expect(refusals).toEqual([]);
			expect(report).not.toHaveBeenCalled();
		});

		it("is what keeps the refusal away: an entry opened over a session with no worker is refused", async () => {
			const { ctrl } = controller(async, "commcare_first_name");
			await activate(ctrl, async);

			expect(ctrl.entryStore.getState().refusal).toMatchObject({
				kind: "data",
				formUuid: FORM,
				reason: { kind: "empty-instance", instanceId: "commcaresession" },
			});
		});

		it("ends a live entry when the session stops resolving, and opens it again when it resolves", async () => {
			const { ctrl, report } = controller(async, "commcare_first_name");
			install(ctrl, member());
			await activate(ctrl, async);
			const first = ctrl.entryKey;
			expect(ctrl.store.getState()[ANSWER]?.value).toBe("Amina");
			const refusals = refusalsPublished(ctrl);

			install(ctrl, null);
			await ctrl.awaitSettled();
			expect(ctrl.entryStore.getState()).toMatchObject({
				formUuid: undefined,
				refusal: undefined,
				fault: undefined,
			});

			install(ctrl, member());
			await ctrl.awaitSettled();
			expect(ctrl.entryStore.getState()).toMatchObject({
				formUuid: FORM,
				ready: true,
			});
			expect(ctrl.entryKey).not.toBe(first);
			expect(refusals).toEqual([]);
			expect(report).not.toHaveBeenCalled();
		});
	});

	describe(`an entry refused for the worker's session (${path} path)`, () => {
		it("opens again, as a new entry, when a worker holding the key arrives", async () => {
			const { ctrl, report } = controller(async, "commcare_location_id");
			install(ctrl, member());
			await activate(ctrl, async);
			expect(ctrl.entryStore.getState()).toMatchObject({
				formUuid: undefined,
				refusal: {
					kind: "data",
					formUuid: FORM,
					reason: { kind: "empty-instance", instanceId: "commcaresession" },
				},
			});

			install(ctrl, placedMember());
			await ctrl.awaitSettled();

			expect(ctrl.entryStore.getState()).toMatchObject({
				formUuid: FORM,
				ready: true,
				refusal: undefined,
			});
			expect(ctrl.store.getState()[ANSWER]?.value).toBe("north");
			expect(report).not.toHaveBeenCalled();
		});

		it("stays refused for an identity that is the same worker again", async () => {
			const { ctrl } = controller(async, "commcare_location_id");
			install(ctrl, member());
			await activate(ctrl, async);
			const refusal = ctrl.entryStore.getState().refusal;
			expect(refusal).toBeDefined();

			install(ctrl, member());
			await ctrl.awaitSettled();

			expect(ctrl.entryStore.getState().refusal).toBe(refusal);
		});
	});
}
