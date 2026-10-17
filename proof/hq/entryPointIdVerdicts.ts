/**
 * Nova's verdict on every deep link ID of one to seven characters drawn
 * from `a`, `9`, `_` and `-`, which `proof/hq/test_endpoint_ids.py` holds
 * to CommCare HQ's own rule for a session endpoint id
 * (`views/utils.py::get_cleaned_session_endpoint_id`). The four characters
 * are one of each kind the rule tells apart: a letter, a digit, and the two
 * marks `slugify` treats differently.
 *
 * Writes `[[id, problem or null], ...]`, in the order the ids are drawn,
 * where `problem` is `lib/domain/entryPoints.ts::entryPointIdProblem`'s.
 * Run from the worktree root:
 *
 *   node --conditions=react-server --import tsx \
 *     proof/hq/entryPointIdVerdicts.ts <verdicts.json>
 */

import { writeFileSync } from "node:fs";
import { entryPointIdProblem } from "@/lib/domain/entryPoints";

const ALPHABET = ["a", "9", "_", "-"] as const;
const LONGEST = 7;

function* ids(): Generator<string> {
	let layer: string[] = [""];
	for (let length = 1; length <= LONGEST; length++) {
		layer = layer.flatMap((prefix) => ALPHABET.map((char) => prefix + char));
		yield* layer;
	}
}

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --conditions=react-server --import tsx proof/hq/entryPointIdVerdicts.ts <verdicts.json>",
	);
const verdicts = [...ids()].map((id) => [id, entryPointIdProblem(id) ?? null]);
writeFileSync(output, `${JSON.stringify(verdicts)}\n`);
