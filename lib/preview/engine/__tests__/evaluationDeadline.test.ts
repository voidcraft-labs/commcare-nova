import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import { evaluateForm } from "../evaluateForm";
import {
	EvaluationDeadlineError,
	withEvaluationDeadline,
} from "../evaluationDeadline";
import { previewAsMe } from "../identity";
import { webAppsDevice } from "./fixtures/previewDevices";

it("cancels and joins a real evaluation worker at the shared call deadline", async () => {
	const doc = namedFormFixture([
		{ name: "Visits", forms: [{ name: "Visit", type: "survey" }] },
	]);
	const identity = previewAsMe({ id: "tester", name: "Tester" }, doc);
	if (!identity) throw new Error("Missing fixture identity");
	const formUuid = Object.values(doc.forms)[0].uuid;
	const terminate = Worker.prototype.terminate;
	let joined = false;
	const termination = vi
		.spyOn(Worker.prototype, "terminate")
		.mockImplementation(async function (this: Worker) {
			const result = await terminate.call(this);
			joined = true;
			return result;
		});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const pending = withEvaluationDeadline(Date.now() + 5000, () =>
			evaluateForm(
				doc,
				{ formUuid, answers: [] },
				{
					identity,
					device: webAppsDevice(),
					cases: { rows: [], indices: [] },
					lookup: {
						projectRevision: "0",
						definitions: [],
						rowsByTable: new Map(),
					},
				},
			),
		);
		const rejected = expect(pending).rejects.toBeInstanceOf(
			EvaluationDeadlineError,
		);
		// Fire the owner timer before yielding to worker messages. Native worker
		// termination remains real and must join before the rejection is observed.
		vi.advanceTimersByTime(5000);
		await rejected;
		expect(termination).toHaveBeenCalledTimes(1);
		expect(joined).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
		termination.mockRestore();
	}
});
