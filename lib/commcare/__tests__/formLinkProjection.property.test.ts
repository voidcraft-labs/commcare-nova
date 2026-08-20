/**
 * Property proof for the exclusive guard plan: whatever conditions an
 * author writes, in whatever order, EXACTLY ONE of {link guards, fallback
 * guard} is true under every assignment — which is what makes "first true
 * link wins" hold on a runtime that executes every true `<create>` and
 * lands on the last one. The guards are evaluated by Preview's XPath
 * evaluator, the same engine the running app uses.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { planFormLinkGuards } from "@/lib/commcare/formLinkProjection";
import { toBoolean } from "@/lib/preview/xpath/coerce";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import type { EvalContext } from "@/lib/preview/xpath/types";

const VARS = ["v1", "v2", "v3"] as const;

/** A small boolean formula over the three variables, as session-free XPath. */
const atomArb = fc.constantFrom(...VARS).map((v) => `/data/${v} = 'yes'`);
const conditionArb: fc.Arbitrary<string> = fc.oneof(
	atomArb,
	fc.tuple(atomArb, atomArb).map(([a, b]) => `${a} or ${b}`),
	fc.tuple(atomArb, atomArb).map(([a, b]) => `${a} and ${b}`),
	atomArb.map((a) => `not(${a})`),
	fc.constant("true()"),
	fc.constant("false()"),
);

/** Links: each conditional or not, 1–6 of them. */
const linksArb = fc
	.array(fc.option(conditionArb, { nil: undefined }), {
		minLength: 1,
		maxLength: 6,
	})
	.map((conditions) =>
		conditions.map((condition, index) => ({
			uuid: testUuid(`lnk-${index}`),
			...(condition !== undefined && { condition }),
		})),
	);

const assignmentArb = fc.record({
	v1: fc.boolean(),
	v2: fc.boolean(),
	v3: fc.boolean(),
});

function contextFor(assignment: Record<string, boolean>): EvalContext {
	return {
		getValue: (path) => {
			const name = path.replace(/^\/data\//, "");
			return assignment[name] ? "yes" : "no";
		},
		resolveHashtag: () => "",
		contextPath: "/data",
		position: 1,
	};
}

function holds(guard: string, assignment: Record<string, boolean>): boolean {
	return toBoolean(evaluate(guard, contextFor(assignment)));
}

describe("planFormLinkGuards — exclusivity", () => {
	it("exactly one of the emitted guards and the fallback guard is true under every assignment", () => {
		fc.assert(
			fc.property(linksArb, assignmentArb, (links, assignment) => {
				const plan = planFormLinkGuards(links);
				// An unconditional link before the end is unreachable by the
				// validator's rule; the plan is total but not exclusive there,
				// so the property reads only admissible orders.
				const lastIndex = links.length - 1;
				fc.pre(
					links.every(
						(link, index) =>
							link.condition !== undefined || index === lastIndex,
					),
				);
				const guards = plan.links.map((link) => link.guard);
				const trueGuards = guards.filter(
					(guard) => guard === undefined || holds(guard, assignment),
				).length;
				if (plan.fallback.kind === "guarded") {
					const fallbackTrue = holds(plan.fallback.guard, assignment) ? 1 : 0;
					expect(trueGuards + fallbackTrue).toBe(1);
				} else {
					expect(trueGuards).toBe(1);
				}
			}),
			{ numRuns: 400 },
		);
	});

	it("the first true link (in authored order) is the one whose guard fires", () => {
		fc.assert(
			fc.property(linksArb, assignmentArb, (links, assignment) => {
				const lastIndex = links.length - 1;
				fc.pre(
					links.every(
						(link, index) =>
							link.condition !== undefined || index === lastIndex,
					),
				);
				const plan = planFormLinkGuards(links);
				const firstTrue = links.findIndex(
					(link) =>
						link.condition === undefined || holds(link.condition, assignment),
				);
				const firing = plan.links.findIndex(
					(link) => link.guard === undefined || holds(link.guard, assignment),
				);
				expect(firing).toBe(firstTrue);
			}),
			{ numRuns: 400 },
		);
	});

	it("the fallback guard is HQ's literal join over the emitted xpaths", () => {
		fc.assert(
			fc.property(linksArb, (links) => {
				const plan = planFormLinkGuards(links);
				if (plan.fallback.kind !== "guarded") return;
				// `_get_fallback_frame`: `' and '.join(f'not({x})' for x in
				// non-blank link xpaths)` — over what Nova sends as `xpath`.
				const expected = plan.links
					.flatMap((link) => (link.guard === undefined ? [] : [link.guard]))
					.map((guard) => `not(${guard})`)
					.join(" and ");
				expect(plan.fallback.guard).toBe(expected);
			}),
			{ numRuns: 200 },
		);
	});
});
