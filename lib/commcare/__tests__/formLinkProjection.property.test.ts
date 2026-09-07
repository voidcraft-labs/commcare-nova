/** Boolean guard algebra over a finite generated corpus. Native Core links proof
 * owns device XPath evaluation and actual navigation; this checks first-match
 * order against an independent boolean oracle on every three-input assignment. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { planFormLinkGuards } from "@/lib/commcare/formLinkProjection";
import { toBoolean } from "@/lib/preview/xpath/coerce";
import { evaluate } from "@/lib/preview/xpath/evaluator";

type Formula = { text: string; holds: (bits: readonly boolean[]) => boolean };
const atom = fc.integer({ min: 0, max: 2 }).map(
	(index): Formula => ({
		text: `/data/v${index} = 'yes'`,
		holds: (bits) => bits[index],
	}),
);
const formula = fc.oneof(
	atom,
	fc.tuple(atom, atom).map(
		([a, b]): Formula => ({
			text: `${a.text} or ${b.text}`,
			holds: (bits) => a.holds(bits) || b.holds(bits),
		}),
	),
	fc.tuple(atom, atom).map(
		([a, b]): Formula => ({
			text: `${a.text} and ${b.text}`,
			holds: (bits) => a.holds(bits) && b.holds(bits),
		}),
	),
	atom.map(
		(a): Formula => ({
			text: `not(${a.text})`,
			holds: (bits) => !a.holds(bits),
		}),
	),
	fc.boolean().map(
		(value): Formula => ({
			text: value ? "true()" : "false()",
			holds: () => value,
		}),
	),
);
const links = fc.tuple(
	fc.array(formula, { minLength: 1, maxLength: 5 }),
	fc.boolean(),
);
describe("first matching link guard algebra", () => {
	it("chooses the authored first match or fallback for every assignment", () => {
		fc.assert(
			fc.property(links, ([conditions, hasElse]) => {
				const authored = conditions.map((condition, index) => ({
					uuid: testUuid(`link-${index}`),
					condition: condition.text,
				}));
				const planned = planFormLinkGuards(
					hasElse ? [...authored, { uuid: testUuid("else") }] : authored,
				);
				for (let mask = 0; mask < 8; mask++) {
					const bits = [0, 1, 2].map((index) => (mask & (1 << index)) !== 0);
					const first = conditions.findIndex((condition) =>
						condition.holds(bits),
					);
					const expected =
						first >= 0 ? first : hasElse ? conditions.length : -1;
					const holds = (text: string) =>
						toBoolean(
							evaluate(text, {
								getValue: (path) =>
									bits[Number(path.slice(-1))] ? "yes" : "no",
								resolveHashtag: () => "",
								contextPath: "/data",
								position: 1,
							}),
						);
					const firing = planned.links.flatMap((link, index) =>
						link.guard === undefined || holds(link.guard) ? [index] : [],
					);
					expect(firing).toEqual(expected < 0 ? [] : [expected]);
					if (planned.fallback.kind === "guarded")
						expect(holds(planned.fallback.guard)).toBe(expected < 0);
					else expect(planned.fallback.kind).toBe("suppressed-by-else");
				}
			}),
			{ numRuns: 200 },
		);
	});
});
