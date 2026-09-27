import { expect } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";

/** Runtime tests start with valid domain scaffolds and refine them through the
 * current shared tool grammar. Private construction has separate SQL evidence. */
export async function createEvaluationApp(
	modules: Parameters<typeof namedFormFixture>[0],
	setup: Array<{ toolName: string; input: unknown }>,
) {
	const harness = makeAuthoringHarness({}, namedFormFixture(modules));
	for (const { toolName, input } of setup) {
		expect(await harness.call(toolName, input)).not.toHaveProperty("error");
	}
	return harness.currentDoc();
}
