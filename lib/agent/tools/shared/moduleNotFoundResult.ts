/**
 * `moduleNotFoundResult` — typed Elm-style error result the SA tool
 * families return when a positional `moduleIndex` resolves to neither
 * a uuid in `doc.moduleOrder` nor a module in `doc.modules`.
 *
 * Lives at `tools/shared/` because more than one tool family consumes
 * it. The case-list-config family (`addCaseListColumns`,
 * `setCaseListFilter`, …) was the first family; the case-search-config
 * tools (`setCaseSearchDisplay`, `setCaseSearchAdvanced`) are the second.
 * Centralizing the shape keeps the SA-facing message uniform across
 * families.
 *
 * The helper is generic over the success arm so each tool can pin its
 * own structured result type. The returned union widens to
 * `MutatingToolResult<R | { error: string }>` — the call site narrows
 * back to its own typed success on the happy path.
 */

import type { BlueprintDoc } from "@/lib/domain";
import type { MutatingToolResult } from "../common";

/**
 * Construct the canonical no-op `MutatingToolResult` returned when
 * `moduleIndex` resolves to neither a uuid in `doc.moduleOrder` nor a
 * module in `doc.modules`. The mutation list is empty + the doc is
 * threaded through unchanged so the SA's working state stays in sync
 * with the tool's no-op outcome.
 *
 * `actionPhrase` names the verb-phrase the tool was attempting (e.g.
 * `"add a case list column"`, `"set the case-search advanced cluster"`);
 * it lands in the SA-facing message verbatim. The hint at the end
 * nudges the SA toward `getModule`'s projection — the canonical
 * recovery path for an out-of-range or stale `moduleIndex`.
 */
export function moduleNotFoundResult<R>(
	doc: BlueprintDoc,
	moduleIndex: number,
	actionPhrase: string,
): MutatingToolResult<R | { error: string }> {
	return {
		kind: "mutate" as const,
		mutations: [],
		newDoc: doc,
		result: {
			error: `Tried to ${actionPhrase} on module index ${moduleIndex}. Found no module at that index. Look at \`getModule\`'s projection for valid indices.`,
		},
	};
}
