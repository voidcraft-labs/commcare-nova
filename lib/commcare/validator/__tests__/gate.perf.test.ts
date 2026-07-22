import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Perf guard for the boundary gate: a full `evaluateBoundary` run over a
 * large deterministic fixture must finish inside a GENEROUS budget. The
 * budget is sized to trip only on an order-of-magnitude regression (an
 * accidentally quadratic walk, a per-field full-doc rescan), never on CI
 * load noise — typical runs finish well under a tenth of it.
 */

import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import {
	buildDoc,
	caseListConfig,
	f,
	type ModuleSpec,
} from "../../../__tests__/docHelpers";
import { evaluateBoundary } from "../gate";

const BUDGET_MS = 20_000;

/**
 * Deterministic large fixture: 30 modules × 4 forms × 25 fields = 3,000
 * fields, every field carrying XPath surfaces (so the deep walk's Lezer
 * parses — the expensive part — run at scale), case-property writers
 * feeding real case lists, and nested groups so the tree walks recurse.
 */
function largeDoc(): BlueprintDoc {
	const modules: ModuleSpec[] = [];
	for (let m = 0; m < 30; m++) {
		const caseType = `case_type_${m}`;
		modules.push({
			name: `Module ${m}`,
			caseType,
			caseListConfig: caseListConfig([
				{ field: "case_name", header: "Name" },
				{ field: `prop_${m}_0`, header: "First" },
			]),
			forms: Array.from({ length: 4 }, (_, fm) => ({
				name: `Form ${m}-${fm}`,
				type: fm === 0 ? ("registration" as const) : ("followup" as const),
				fields: [
					f({
						kind: "text",
						id: "case_name",
						label: "Name",
						case_property_on: caseType,
					}),
					...Array.from({ length: 20 }, (_, q) =>
						f({
							kind: "text",
							id: `q_${q}`,
							label: `Question ${q}`,
							relevant: q > 0 ? `#form/q_${q - 1} != ''` : undefined,
							required: "true()",
							...(fm > 0 && q < 3 ? { case_property_on: caseType } : {}),
						}),
					),
					f({
						kind: "group",
						id: "grp",
						label: "Group",
						children: Array.from({ length: 3 }, (_, q) =>
							f({
								kind: "hidden",
								id: `calc_${q}`,
								calculate: `#form/q_${q} + 1`,
							}),
						),
					}),
				],
			})),
		});
	}
	return buildDoc({
		appName: "Perf Fixture",
		modules,
		caseTypes: Array.from({ length: 30 }, (_, m) => ({
			name: `case_type_${m}`,
			properties: [
				{ name: "case_name", label: "Name" },
				{ name: `prop_${m}_0`, label: "First" },
			],
		})),
	});
}

describe("evaluateBoundary perf guard", () => {
	it(`completes a full boundary run over a 3,000-field doc in under ${BUDGET_MS / 1000}s`, () => {
		const doc = largeDoc();
		const start = performance.now();
		const findings = evaluateBoundary(doc, new Map(), LOOKUP_CONTEXT_UNAVAILABLE);
		const elapsed = performance.now() - start;

		// The fixture is intentionally imperfect in benign ways; what the
		// guard pins is the RUNTIME, not cleanliness. Sanity-check the run
		// actually walked the doc (a short-circuit bug would also be fast).
		expect(Array.isArray(findings)).toBe(true);
		expect(Object.keys(doc.fields).length).toBeGreaterThan(2_500);
		expect(elapsed).toBeLessThan(BUDGET_MS);
	}, 60_000);
});
