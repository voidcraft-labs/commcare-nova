/**
 * The Designs-in-progress row projection (§15.9) — title fallback, the
 * activity clock, and the recoverable rule, without a database. The SQL half
 * is a plain scoped select; what can actually be wrong is which of the two
 * timestamps counts as activity and whether a failed orchestration still
 * offers a resume.
 */

import { describe, expect, it } from "vitest";
import type { OrchestrationHead } from "@/lib/agent/build/orchestratorState";
import { asDesignId } from "@/lib/agent/design/ids";
import {
	type DesignInProgressRow,
	projectDesignInProgress,
	UNTITLED_DESIGN_TITLE,
} from "@/lib/db/designInProgress";

const SESSION = "11111111-1111-4111-8111-111111111111";
const REVISION = "22222222-2222-4222-8222-222222222222";
const QUESTION_ID = "55555555-5555-4555-8555-555555555555";
const SLICE_ID = "66666666-6666-4666-8666-666666666666";

function row(
	overrides: Partial<DesignInProgressRow> = {},
): DesignInProgressRow {
	return {
		id: SESSION,
		project_id: "project-1",
		app_id: null,
		state: "active",
		awaiting_input: false,
		last_error_type: null,
		updated_at: new Date("2026-08-01T10:00:00.000Z"),
		thread_summary: "Home visit tracking",
		thread_updated_at: "2026-08-01T09:00:00.000Z",
		...overrides,
	};
}

function head(state: OrchestrationHead["state"]): OrchestrationHead {
	return { revision: 3, eventId: "event-3", digest: "a".repeat(64), state };
}

describe("projectDesignInProgress", () => {
	it("names the design after its most recent conversation", () => {
		expect(projectDesignInProgress(row(), null).title).toBe(
			"Home visit tracking",
		);
	});

	it("falls back when the conversation has no usable summary", () => {
		expect(
			projectDesignInProgress(row({ thread_summary: null }), null).title,
		).toBe(UNTITLED_DESIGN_TITLE);
		expect(
			projectDesignInProgress(row({ thread_summary: "   " }), null).title,
		).toBe(UNTITLED_DESIGN_TITLE);
	});

	it("takes the later of the session's and the conversation's last write", () => {
		expect(projectDesignInProgress(row(), null).lastActivityAt).toBe(
			"2026-08-01T10:00:00.000Z",
		);
		expect(
			projectDesignInProgress(
				row({ thread_updated_at: "2026-08-01T11:30:00.000Z" }),
				null,
			).lastActivityAt,
		).toBe("2026-08-01T11:30:00.000Z");
		expect(
			projectDesignInProgress(row({ thread_updated_at: null }), null)
				.lastActivityAt,
		).toBe("2026-08-01T10:00:00.000Z");
	});

	it("reports understanding for a session whose orchestration never started", () => {
		expect(projectDesignInProgress(row(), null).stage).toBe("understanding");
	});

	it("says the build stopped when a run failed before any orchestration event", () => {
		const summary = projectDesignInProgress(
			row({ last_error_type: "provider_error" }),
			null,
		);
		expect(summary.stage).toBe("incomplete");
		expect(summary.recoverable).toBe(true);
	});

	it("says the build stopped when a run died mid-phase, not the phase it died in", () => {
		/* The head's last event says `designing`, but the session's error
		 * marker (set by every failed settle, cleared by every fresh claim)
		 * proves that run is dead — active-work copy here is a spinner over
		 * a dead run, observed live on a failed author call. */
		const summary = projectDesignInProgress(
			row({ last_error_type: "provider_error" }),
			head({
				kind: "designing",
				designSessionId: SESSION,
				sourcePackageDigest: "b".repeat(64),
			}),
		);
		expect(summary.stage).toBe("incomplete");
		expect(summary.recoverable).toBe(true);
	});

	it("reports the paused stage while the design waits on an answer", () => {
		const summary = projectDesignInProgress(
			row({ awaiting_input: true }),
			head({
				kind: "awaiting-user",
				designSessionId: SESSION,
				designRevisionId: REVISION,
				blockingQuestionIds: [asDesignId(QUESTION_ID)],
			}),
		);
		expect(summary.stage).toBe("needs-input");
		expect(summary.awaitingInput).toBe(true);
		expect(summary.recoverable).toBe(true);
	});

	it("keeps a recoverable failure resumable and reports it as incomplete", () => {
		const summary = projectDesignInProgress(
			row(),
			head({
				kind: "failed",
				failureId: "33333333-3333-4333-8333-333333333333",
				errorType: "provider",
				recoverable: true,
			}),
		);
		expect(summary.stage).toBe("incomplete");
		expect(summary.recoverable).toBe(true);
	});

	it("marks an unrecoverable failure as not resumable", () => {
		const summary = projectDesignInProgress(
			row(),
			head({
				kind: "failed",
				failureId: "44444444-4444-4444-8444-444444444444",
				errorType: "internal",
				recoverable: false,
			}),
		);
		expect(summary.stage).toBe("failed");
		expect(summary.recoverable).toBe(false);
	});

	it("reads a pre-app slice as the first workflow", () => {
		expect(
			projectDesignInProgress(
				row(),
				head({
					kind: "executing-slice",
					designRevisionId: REVISION,
					buildPlanId: REVISION,
					sliceId: asDesignId(SLICE_ID),
					changeSetId: REVISION,
					attempt: 1,
				}),
			).stage,
		).toBe("building-first-workflow");
	});
});
