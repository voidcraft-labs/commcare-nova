/**
 * Design-progress state model — the stage fold and the slice counter, driven
 * by scripted frame sequences exactly as the orchestrator writes them.
 *
 * The interesting cases are the ones a screenshot would never catch: the
 * FIRST slice commits as the materialization receipt (no `slice-committed`
 * frame at all), a replayed reconnect must be idempotent, and a frame naming
 * another design session must be dropped rather than half-applied.
 */

import { describe, expect, it } from "vitest";
import {
	createDesignProgressStore,
	type DesignProgressStoreApi,
	deriveDesignProgressView,
} from "@/lib/session/designProgressStore";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";

function envelope(designSessionId: string, data: unknown, revision = 1) {
	return {
		eventVersion: 1,
		designSessionId,
		orchestrationEventId: `event-${revision}`,
		orchestrationRevision: revision,
		data,
	};
}

const OUTLINE = {
	objective: "Track home visits for community health workers.",
	actors: ["Community health worker", "Supervisor"],
	tasks: ["Register a household", "Record a visit"],
	records: ["Household", "Visit"],
	readModels: ["Households due this week"],
	assumptions: ["Every worker has one assigned area"],
	blockingQuestions: [],
	outOfScope: ["Stock management"],
	reviewed: true,
};

const PLAN = {
	sliceCount: 3,
	sliceNames: ["Register a household", "Record a visit", "Weekly queue"],
	externalActionCount: 0,
};

function view(store: DesignProgressStoreApi) {
	return deriveDesignProgressView(store.getState());
}

function openSession(store: DesignProgressStoreApi) {
	store
		.getState()
		.beginSession({ designSessionId: SESSION, materializedAppId: null });
}

describe("design progress stage fold", () => {
	it("reports no stage until a design session opens", () => {
		const store = createDesignProgressStore();
		expect(view(store).active).toBe(false);
		expect(view(store).stage).toBeNull();
	});

	it("walks understanding to ready across the orchestrator's frame sequence", () => {
		const store = createDesignProgressStore();
		const { applyProgressFrame, markMaterialized } = store.getState();

		openSession(store);
		expect(view(store).stage).toBe("understanding");

		applyProgressFrame("data-design-outline", envelope(SESSION, OUTLINE, 1));
		expect(view(store).stage).toBe("designing");

		applyProgressFrame("data-build-plan-summary", envelope(SESSION, PLAN, 1));
		expect(view(store).stage).toBe("planning");

		applyProgressFrame(
			"data-build-slice-started",
			envelope(
				SESSION,
				{ sliceId: "s1", sliceName: "Register a household" },
				2,
			),
		);
		expect(view(store).stage).toBe("building-first-workflow");
		expect(view(store).currentSliceName).toBe("Register a household");

		markMaterialized("app-1");
		expect(view(store).stage).toBe("building");
		expect(view(store).materialized).toBe(true);

		applyProgressFrame(
			"data-build-slice-started",
			envelope(SESSION, { sliceId: "s2", sliceName: "Record a visit" }, 3),
		);
		applyProgressFrame(
			"data-build-slice-committed",
			envelope(
				SESSION,
				{ sliceId: "s2", sliceName: "Record a visit", seq: 2 },
				3,
			),
		);
		expect(view(store).stage).toBe("building");
		expect(view(store).committedSliceNames).toEqual([
			"Register a household",
			"Record a visit",
		]);

		applyProgressFrame(
			"data-build-completion",
			envelope(SESSION, { appId: "app-1", appSeq: 3, plannedSlices: 3 }, 4),
		);
		expect(view(store).stage).toBe("ready");
		expect(view(store).working).toBe(false);
	});

	it("walks the design span phase by phase on live pulses", () => {
		const store = createDesignProgressStore();
		const { applyProgressFrame } = store.getState();
		openSession(store);
		expect(view(store).stage).toBe("understanding");

		applyProgressFrame(
			"data-design-pulse",
			envelope(SESSION, { phase: "design", chars: 900 }, 1),
		);
		expect(view(store).stage).toBe("designing");

		applyProgressFrame(
			"data-design-pulse",
			envelope(SESSION, { phase: "review", chars: 300 }, 1),
		);
		expect(view(store).stage).toBe("reviewing-design");

		applyProgressFrame(
			"data-design-pulse",
			envelope(SESSION, { phase: "revise", chars: 100 }, 1),
		);
		expect(view(store).stage).toBe("revising-design");

		applyProgressFrame(
			"data-design-pulse",
			envelope(SESSION, { phase: "plan", chars: 50 }, 1),
		);
		expect(view(store).stage).toBe("planning");

		/* Progress outranks the pulse: a started slice means the design span
		 * is over, whatever pulse arrived last. */
		applyProgressFrame(
			"data-build-slice-started",
			envelope(SESSION, { sliceId: "s1", sliceName: "Register" }, 2),
		);
		expect(view(store).stage).toBe("building-first-workflow");
	});

	it("clears a stale pulse at the next turn boundary", () => {
		const store = createDesignProgressStore();
		const { applyProgressFrame } = store.getState();
		openSession(store);
		applyProgressFrame(
			"data-design-pulse",
			envelope(SESSION, { phase: "review", chars: 300 }, 1),
		);
		expect(view(store).stage).toBe("reviewing-design");

		/* The stream died and a new turn opened: the pulse described only the
		 * stream it rode on, so the stage falls back to the durable fold. */
		openSession(store);
		expect(view(store).stage).toBe("understanding");
	});

	it("counts the materialized first slice, which never emits a committed frame", () => {
		const store = createDesignProgressStore();
		openSession(store);
		const { applyProgressFrame, markMaterialized } = store.getState();
		applyProgressFrame("data-build-plan-summary", envelope(SESSION, PLAN, 1));
		applyProgressFrame(
			"data-build-slice-started",
			envelope(
				SESSION,
				{ sliceId: "s1", sliceName: "Register a household" },
				2,
			),
		);
		expect(view(store).sliceProgress).toEqual({ committed: 0, planned: 3 });

		markMaterialized("app-1");
		expect(view(store).sliceProgress).toEqual({ committed: 1, planned: 3 });
		expect(view(store).currentSliceName).toBeNull();
	});

	it("offers no slice count without an active plan", () => {
		const store = createDesignProgressStore();
		openSession(store);
		expect(view(store).sliceProgress).toBeNull();

		const { applyProgressFrame } = store.getState();
		applyProgressFrame("data-build-plan-summary", envelope(SESSION, PLAN, 1));
		expect(view(store).sliceProgress).toEqual({ committed: 0, planned: 3 });

		applyProgressFrame(
			"data-build-completion",
			envelope(SESSION, { appId: "app-1", appSeq: 4, plannedSlices: 3 }, 5),
		);
		expect(view(store).sliceProgress).toBeNull();
	});

	it("shows needs-input while a question round is waiting, then resumes", () => {
		const store = createDesignProgressStore();
		openSession(store);
		store
			.getState()
			.applyProgressFrame("data-design-outline", envelope(SESSION, OUTLINE, 1));

		store.getState().setAwaitingInput(true);
		expect(view(store).stage).toBe("needs-input");
		expect(view(store).working).toBe(false);
		/* The outline stays on screen while the question is answered — the
		 * design did not stop existing. */
		expect(view(store).outline?.objective).toBe(OUTLINE.objective);

		store.getState().setAwaitingInput(false);
		expect(view(store).stage).toBe("designing");
	});

	it("shows failed on a fatal error and clears it when the next turn opens", () => {
		const store = createDesignProgressStore();
		openSession(store);
		store.getState().markFailed("The model provider stopped responding.", {
			recoverable: false,
		});
		expect(view(store).stage).toBe("failed");
		expect(view(store).failure).toBe("The model provider stopped responding.");

		openSession(store);
		expect(view(store).stage).toBe("understanding");
		expect(view(store).failure).toBeNull();
	});

	it("shows a recoverable error as stopped, never as still working", () => {
		/* Observed live: the run died with a retryable error, the toast said
		 * "send again", and the stage line kept spinning "Designing your
		 * app". A recoverable stop is still a STOP. */
		const store = createDesignProgressStore();
		openSession(store);
		store.getState().applyProgressFrame("data-design-pulse", {
			eventVersion: 1,
			designSessionId: SESSION,
			orchestrationEventId: "event-1",
			orchestrationRevision: 1,
			data: { phase: "design", chars: 900 },
		});
		expect(view(store).stage).toBe("designing");

		store.getState().markFailed("The design step didn't come back usable.", {
			recoverable: true,
		});
		expect(view(store).stage).toBe("incomplete");
		expect(view(store).working).toBe(false);
		expect(view(store).failure).toBe(
			"The design step didn't come back usable.",
		);

		/* The retry send opens a new turn: the stop clears with it. */
		openSession(store);
		expect(view(store).stage).toBe("understanding");
		expect(view(store).failure).toBeNull();
	});

	it("keeps a paused round below a fatal error in the priority chain", () => {
		const store = createDesignProgressStore();
		openSession(store);
		store.getState().setAwaitingInput(true);
		store.getState().markFailed("The run was rejected before it started.", {
			recoverable: false,
		});
		expect(view(store).stage).toBe("failed");
	});
});

describe("resumed design seed", () => {
	it("reports the server's load-time stage before any frame arrives", () => {
		const store = createDesignProgressStore();
		store.getState().seedSession({
			designSessionId: SESSION,
			materializedAppId: null,
			stage: "needs-input",
		});
		expect(view(store).active).toBe(true);
		expect(view(store).stage).toBe("needs-input");
		/* Nothing else is reconstructed: the outline and plan exist only in the
		 * frames a run streams. */
		expect(view(store).outline).toBeNull();
		expect(view(store).plannedSliceNames).toEqual([]);
	});

	it("stops reporting the load-time stage once a turn opens", () => {
		const store = createDesignProgressStore();
		store.getState().seedSession({
			designSessionId: SESSION,
			materializedAppId: null,
			stage: "incomplete",
		});
		store.getState().noteTurnOpened();
		expect(view(store).stage).toBe("understanding");
	});

	it("lets a live turn's frames supersede the seeded stage", () => {
		const store = createDesignProgressStore();
		store.getState().seedSession({
			designSessionId: SESSION,
			materializedAppId: null,
			stage: "incomplete",
		});
		openSession(store);
		store
			.getState()
			.applyProgressFrame("data-design-outline", envelope(SESSION, OUTLINE, 1));
		expect(view(store).stage).toBe("designing");
	});
});

describe("design progress frame admission", () => {
	it("drops a frame naming a different design session", () => {
		const store = createDesignProgressStore();
		openSession(store);
		const consumed = store
			.getState()
			.applyProgressFrame(
				"data-design-outline",
				envelope(OTHER_SESSION, OUTLINE, 1),
			);
		expect(consumed).toBe(true);
		expect(view(store).outline).toBeNull();
		expect(view(store).stage).toBe("understanding");
	});

	it("drops a frame carrying an unknown event version", () => {
		const store = createDesignProgressStore();
		openSession(store);
		store.getState().applyProgressFrame("data-design-outline", {
			...envelope(SESSION, OUTLINE, 1),
			eventVersion: 2,
		});
		expect(view(store).outline).toBeNull();
	});

	it("drops a payload missing a field rather than rendering half of it", () => {
		const store = createDesignProgressStore();
		openSession(store);
		const { objective: _dropped, ...incomplete } = OUTLINE;
		store
			.getState()
			.applyProgressFrame(
				"data-design-outline",
				envelope(SESSION, incomplete, 1),
			);
		expect(view(store).outline).toBeNull();
	});

	it("leaves a frame type it does not own unconsumed", () => {
		const store = createDesignProgressStore();
		openSession(store);
		expect(
			store.getState().applyProgressFrame("data-mutations", { mutations: [] }),
		).toBe(false);
	});

	it("is idempotent across a reconnect replay of the same frames", () => {
		const store = createDesignProgressStore();
		const script: [string, unknown][] = [
			["data-design-outline", envelope(SESSION, OUTLINE, 1)],
			["data-build-plan-summary", envelope(SESSION, PLAN, 1)],
			[
				"data-build-slice-started",
				envelope(SESSION, { sliceId: "s1", sliceName: "Register" }, 2),
			],
			[
				"data-build-slice-committed",
				envelope(SESSION, { sliceId: "s1", sliceName: "Register", seq: 2 }, 2),
			],
		];
		for (const pass of [0, 1]) {
			store
				.getState()
				.beginSession({ designSessionId: SESSION, materializedAppId: null });
			for (const [type, data] of script) {
				store.getState().applyProgressFrame(type, data);
			}
			expect(view(store).committedSliceNames, `pass ${pass}`).toEqual([
				"Register",
			]);
		}
	});

	it("never un-says materialization when a pre-app scope frame replays", () => {
		const store = createDesignProgressStore();
		openSession(store);
		store.getState().markMaterialized("app-1");
		store
			.getState()
			.beginSession({ designSessionId: SESSION, materializedAppId: null });
		expect(view(store).materialized).toBe(true);
	});

	it("resets completely when the conversation switches to another design", () => {
		const store = createDesignProgressStore();
		openSession(store);
		store
			.getState()
			.applyProgressFrame("data-design-outline", envelope(SESSION, OUTLINE, 1));
		store.getState().beginSession({
			designSessionId: OTHER_SESSION,
			materializedAppId: null,
		});
		expect(view(store).outline).toBeNull();
		expect(view(store).stage).toBe("understanding");
	});

	it("clears everything on reset", () => {
		const store = createDesignProgressStore();
		openSession(store);
		store
			.getState()
			.applyProgressFrame("data-design-outline", envelope(SESSION, OUTLINE, 1));
		store.getState().reset();
		expect(view(store).active).toBe(false);
		expect(view(store).outline).toBeNull();
	});
});
