import { writeFileSync } from "node:fs";
import type { FullConfig, Reporter, Suite } from "@playwright/test/reporter";

/** JSON's spec grouping loses per-repeat identity. Capture the public TestCase
 * metadata from the same native collection, before any fixture is allocated. */
export default class SmokeDiscoveryReporter implements Reporter {
	onBegin(_config: FullConfig, suite: Suite) {
		const manifest = process.env.NOVA_E2E_DISCOVERY_MANIFEST;
		if (!manifest)
			throw new Error("Native fixture discovery requires its manifest path");
		writeFileSync(
			`${manifest}.attempts.json`,
			JSON.stringify(
				suite.allTests().map((test) => ({
					testId: test.id,
					projectId: test.parent.project()?.name,
					file: test.location.file,
					tags: test.tags,
					repeatEachIndex: test.repeatEachIndex,
					retries: test.retries,
				})),
			),
		);
	}
}
