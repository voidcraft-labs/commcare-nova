/**
 * The value check a targeted document carries when its row's symptom is one
 * no value check reads (an editor's save, HQ's build): the answer a worker
 * gives a question of the form under test is the value the form holds there.
 * It pins Core's reading of that form on the retained inputs, as every
 * targeted document's expectations do.
 *
 * A form that writes to its case, as every follow-up does, opens on one:
 * `session` is the form's command and the id of the case it is opened on,
 * which the form's case block reads. The block reads the id alone and
 * nothing of the case, so no restore is needed.
 */

import type { Uuid } from "@/lib/domain";
import type { Expectation } from "../expected";

/** The form's command and the case it is opened on. */
export interface HeldSession {
	readonly command: string;
	readonly caseId: string;
}

export function answerHeld(
	id: string,
	form: Uuid,
	path: string,
	value: string,
	exportName: Expectation["export"] = "local",
	session?: HeldSession,
): Expectation {
	return {
		id,
		export: exportName,
		form,
		request: {
			...(session !== undefined && {
				session: {
					command: session.command,
					data: { case_id: session.caseId },
				},
			}),
			answers: [{ path, value }],
			expressions: [path],
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/values/0/value", value },
		],
	};
}
