/**
 * Capability-catalog drift tripwire (plan §7.6): the catalog is generated
 * from code-owned registries, and this suite is what makes an unreviewed
 * drift fail CI —
 *
 *  - the full catalog (tool surface, field kinds, data shapes, constraint
 *    codes) pins against a checked-in snapshot, so changing a shared tool,
 *    an authored field family, or a platform constraint forces a reviewed
 *    snapshot update;
 *  - the deliberate-gap constraints pin against the complex-app unit FILES:
 *    a gap code must name a unit file that still exists, and every
 *    remaining unit file must carry a gap code — shipping a unit (its file
 *    disappears) forces the vocabulary to shed the code.
 */

import { existsSync, readdirSync } from "node:fs";
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

const COMPLEX_APP_DIR = join(process.cwd(), "docs/plans/complex-app");

/** Unit files that deliberately carry no gap code. `00-contracts.md` is the
 *  binding rules file, not a remaining unit. */
const GAP_EXEMPT_FILES = new Set(["00-contracts.md"]);

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

	it("every gap constraint names a complex-app unit file that still exists", () => {
		for (const code of PLATFORM_CONSTRAINT_CODES) {
			const constraint = PLATFORM_CONSTRAINTS[code];
			if (!constraint.gapUnitFile) continue;
			expect(
				existsSync(join(COMPLEX_APP_DIR, constraint.gapUnitFile)),
				`${code} names ${constraint.gapUnitFile}, which no longer exists — the unit shipped, so this gap code must be retired from platformConstraints.ts (and any design artifacts citing it re-reviewed on their next revision).`,
			).toBe(true);
		}
	});

	it("every remaining complex-app unit file carries a gap code", () => {
		const gapFiles = new Set(
			Object.values(PLATFORM_CONSTRAINTS)
				.map((constraint) => constraint.gapUnitFile)
				.filter((file): file is string => file !== undefined),
		);
		const unitFiles = readdirSync(COMPLEX_APP_DIR).filter(
			(file) => file.endsWith(".md") && !GAP_EXEMPT_FILES.has(file),
		);
		for (const file of unitFiles) {
			expect(
				gapFiles.has(file),
				`docs/plans/complex-app/${file} is a remaining unit with no gap code — add one to platformConstraints.ts (or exempt the file here with a reason) so reviewers can cite the gap.`,
			).toBe(true);
		}
	});

	it("renders every constraint code into the prompt projection", () => {
		const text = renderCapabilityCatalog(catalog);
		for (const code of PLATFORM_CONSTRAINT_CODES) {
			expect(text).toContain(code);
		}
		expect(text).toContain(catalog.catalogDigest.slice(0, 16));
	});
});
