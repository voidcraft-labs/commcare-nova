/**
 * Capability-catalog drift tripwire (plan §7.6): the catalog is generated
 * from code-owned registries, and this suite is what makes an unreviewed
 * drift fail CI —
 *
 *  - the full catalog (tool surface, field kinds, data shapes, constraint
 *    codes) pins against a checked-in snapshot, so changing a shared tool,
 *    an authored field family, or a platform constraint forces a reviewed
 *    snapshot update;
 *  - the completed complex-app program retains its architecture reference
 *    and no obsolete target-gap constraints.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCapabilityCatalog,
	renderCapabilityCatalog,
} from "@/lib/agent/design/capabilityCatalog";
import {
	PLATFORM_CONSTRAINT_CODES,
	PLATFORM_CONSTRAINTS,
} from "@/lib/agent/design/platformConstraints";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";

describe("capability catalog", () => {
	const catalog = buildCapabilityCatalog();

	it("matches the reviewed snapshot (tool surface, vocabulary, constraints)", () => {
		expect({
			catalogDigest: catalog.catalogDigest,
			toolSurface: catalog.toolSurface,
			fieldKinds: catalog.fieldKinds,
			caseDataShapes: catalog.caseDataShapes,
			constraintCodes: catalog.constraints.map((c) => c.code),
		}).toMatchSnapshot();
	});

	it("covers every shared tool — generated, so nothing can be forgotten", () => {
		expect(catalog.toolSurface).toHaveLength(SHARED_TOOL_REGISTRY.length);
		const names = new Set(catalog.toolSurface.map((tool) => tool.saName));
		for (const entry of SHARED_TOOL_REGISTRY) {
			expect(names.has(entry.saName)).toBe(true);
		}
	});

	it("retires the completed complex-app gaps and retains the architecture reference", () => {
		expect(
			Object.values(PLATFORM_CONSTRAINTS).filter(
				(constraint) => constraint.gapUnitFile !== undefined,
			),
		).toEqual([]);
		expect(
			existsSync(join(process.cwd(), "docs/architecture/complex-apps.md")),
		).toBe(true);
	});

	it("renders every constraint code into the prompt projection", () => {
		const text = renderCapabilityCatalog(catalog);
		for (const code of PLATFORM_CONSTRAINT_CODES) {
			expect(text).toContain(code);
		}
		expect(text).toContain(catalog.catalogDigest.slice(0, 16));
	});
});
