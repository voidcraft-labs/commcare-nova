/**
 * The value check a targeted document carries when its row's symptom is one
 * no value check reads (an editor's save, HQ's build): the answer a worker
 * gives a question of the form under test is the value the form holds there.
 * It pins Core's reading of that form on the retained inputs, as every
 * targeted document's expectations do.
 */

import type { Uuid } from "@/lib/domain";
import type { Expectation } from "../expected";

export function answerHeld(
	id: string,
	form: Uuid,
	path: string,
	value: string,
	exportName: Expectation["export"] = "local",
): Expectation {
	return {
		id,
		export: exportName,
		form,
		request: {
			answers: [{ path, value }],
			expressions: [path],
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/values/0/value", value },
		],
	};
}
