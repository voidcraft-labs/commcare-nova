import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { parseFormExpressionForSlot } from "@/lib/doc/expressionText";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { eq, formField, literal } from "@/lib/domain/expression";
import {
	formFixture,
	ids,
} from "@/lib/domain/expression/__tests__/formFixture";
import { findCaseInsensitiveMatch } from "@/lib/domain/expressionFunctions";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { formExpressionRuntime } from "@/lib/preview/engine/formExpressionRuntime";
import { buildDoc, type FieldSpec, f } from "../../__tests__/docHelpers";
import { buildFieldTree } from "../../preview/engine/fieldTree";
import { TriggerDag } from "../../preview/engine/triggerDag";
import { validateBlueprintDeep } from "../validator";
import { runValidation } from "../validator/runner";

function assertAdmitted(doc: BlueprintDoc): void {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
}

// The parser and DAG sections deliberately exercise private partial contexts,
// including invalid graphs. Whole-document success claims use full admission.
// Native XPath dispatch/arity and container execution have independent Core
// fixtures; these tests own Nova diagnostics, identity resolution and graph state.

// ── Function Registry ───────────────────────────────────────────────

describe("functionRegistry", () => {
	describe("findCaseInsensitiveMatch", () => {
		it("finds Today → today", () => {
			expect(findCaseInsensitiveMatch("Today")).toBe("today");
		});

		it("returns undefined for truly unknown functions", () => {
			expect(findCaseInsensitiveMatch("foobar")).toBeUndefined();
		});
	});
});

// ── TriggerDag Cycle Reporting ──────────────────────────────────────

/**
 * Small adapter: TriggerDag takes a `FieldTreeNode[]`. Tests construct a
 * throwaway doc so we can exercise the DAG without depending on the
 * runner. `buildFieldTree` is the same rose-tree builder the real
 * validator uses.
 */
function treeFromFields(fields: FieldSpec[]) {
	const doc = buildDoc({
		appName: "Test",
		modules: [{ name: "M", forms: [{ name: "F", type: "survey", fields }] }],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	return {
		tree: buildFieldTree(formUuid, doc.fields, doc.fieldOrder),
		doc,
	};
}

const DAG_LOOKUP_TABLE = lookupTableIdSchema.parse(
	"30000000-0000-7000-8000-000000000001",
);
const DAG_LOOKUP_COLUMN = lookupColumnIdSchema.parse(
	"40000000-0000-7000-8000-000000000001",
);

function lookupSelectForDag(
	uuid: ReturnType<typeof testUuid>,
	id: string,
	dependsOn: ReturnType<typeof testUuid>,
): FieldSpec {
	return f({
		uuid,
		kind: "single_select",
		id,
		label: id.toUpperCase(),
		optionsSource: {
			kind: "lookup",
			tableId: DAG_LOOKUP_TABLE,
			valueColumnId: DAG_LOOKUP_COLUMN,
			labelColumnId: DAG_LOOKUP_COLUMN,
			filter: eq(formField(dependsOn), literal("yes")),
		},
	});
}

describe("TriggerDag.reportCycles", () => {
	// A field that carries `calculate` is a computed field, which in the
	// domain is the `hidden` kind (visible inputs don't carry `calculate`).
	// The leaf the others read (`a`) is a plain user input — a visible `int`.
	it("returns empty for acyclic graph", () => {
		const dag = new TriggerDag();
		const { tree, doc } = treeFromFields([
			f({ kind: "int", id: "a", label: proseText("A") }),
			f({ kind: "hidden", id: "b", calculate: "/data/a + 1" }),
		]);
		expect(
			dag.reportCycles(tree, doc, doc.formOrder[doc.moduleOrder[0]][0]),
		).toEqual([]);
	});

	it("detects A→B→A cycle", () => {
		const dag = new TriggerDag();
		const { tree, doc } = treeFromFields([
			f({ kind: "hidden", id: "a", calculate: "/data/b + 1" }),
			f({ kind: "hidden", id: "b", calculate: "/data/a + 1" }),
		]);
		expect(
			dag.reportCycles(tree, doc, doc.formOrder[doc.moduleOrder[0]][0]).length,
		).toBeGreaterThan(0);
	});

	it.each(["required", "validate"] as const)(
		"admits a parsed %s rule that reads its own answer",
		(slot) => {
			const uuid = testUuid(`self-${slot}`);
			const { doc } = treeFromFields([
				f({ uuid, kind: "text", id: "name", label: "Name" }),
			]);
			const parsed = parseFormExpressionForSlot(
				doc,
				{ entity: "field", uuid, slot },
				"string-length(.) > 2",
				"unavailable",
			);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok || parsed.expression === undefined)
				throw new Error("The self-read rule did not parse.");
			const verdict = mutationCommitVerdict(
				doc,
				[
					{
						kind: "updateField",
						uuid,
						targetKind: "text",
						patch: { [slot]: parsed.expression },
					},
				],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok).toBe(true);
		},
	);

	it("admits required metadata that reads a calculation of the same answer", () => {
		const { doc } = treeFromFields([
			f({ kind: "text", id: "answer", required: "#form/size > 2" }),
			f({
				kind: "hidden",
				id: "size",
				calculate: "string-length(#form/answer)",
			}),
		]);
		assertAdmitted(doc);
	});

	it.each(["calculate", "relevant"] as const)(
		"still rejects a self-read in cascading %s",
		(slot) => {
			const { tree, doc } = treeFromFields([
				slot === "calculate"
					? f({ kind: "hidden", id: "self", calculate: "number(.) + 1" })
					: f({ kind: "text", id: "self", relevant: "string-length(.) > 2" }),
			]);
			expect(
				new TriggerDag().reportCycles(
					tree,
					doc,
					doc.formOrder[doc.moduleOrder[0]][0],
				),
			).toContainEqual({ path: ["/data/self", "/data/self"] });
		},
	);

	it("handles diamond dependency (no cycle)", () => {
		const dag = new TriggerDag();
		const { tree, doc } = treeFromFields([
			f({ kind: "int", id: "a", label: proseText("A") }),
			f({ kind: "hidden", id: "b", calculate: "/data/a + 1" }),
			f({ kind: "hidden", id: "c", calculate: "/data/a + 2" }),
			f({
				kind: "hidden",
				id: "d",
				calculate: "/data/b + /data/c",
			}),
		]);
		expect(
			dag.reportCycles(tree, doc, doc.formOrder[doc.moduleOrder[0]][0]),
		).toEqual([]);
	});

	it("includes field defaults and lookup filters in the authoring-time cycle proof", () => {
		const fieldA = testUuid("20000000-0000-7000-8000-0000000000a1");
		const fieldB = testUuid("20000000-0000-7000-8000-0000000000b1");
		const { tree, doc } = treeFromFields([
			f({
				uuid: fieldA,
				kind: "text",
				id: "a",
				label: proseText("A"),
				default_value: "/data/b",
			}),
			lookupSelectForDag(fieldB, "b", fieldA),
		]);

		// The cycle's reported rotation depends on edge-registration order
		// (lookup filter edges register during expression collection since
		// their runtime promotion); assert the cycle itself, not a rotation.
		const cycles = new TriggerDag().reportCycles(
			tree,
			doc,
			doc.formOrder[doc.moduleOrder[0]][0],
		);
		expect(
			cycles.some(
				({ path: cycle }) =>
					cycle.length === 3 &&
					cycle[0] === cycle[2] &&
					cycle.includes("/data/a") &&
					cycle.includes("/data/b"),
			),
		).toBe(true);
	});

	it("detects a calculate-to-options cycle", () => {
		const fieldA = testUuid("20000000-0000-7000-8000-0000000000a3");
		const fieldB = testUuid("20000000-0000-7000-8000-0000000000b3");
		const { tree, doc } = treeFromFields([
			f({
				uuid: fieldA,
				kind: "hidden",
				id: "a",
				calculate: "/data/b",
			}),
			lookupSelectForDag(fieldB, "b", fieldA),
		]);

		expect(
			new TriggerDag().reportCycles(
				tree,
				doc,
				doc.formOrder[doc.moduleOrder[0]][0],
			),
		).toContainEqual({
			path: ["/data/a", "/data/b", "/data/a"],
		});
	});

	it("detects a multi-hop relevance/options cycle", () => {
		const fieldA = testUuid("20000000-0000-7000-8000-0000000000a4");
		const fieldB = testUuid("20000000-0000-7000-8000-0000000000b4");
		const fieldC = testUuid("20000000-0000-7000-8000-0000000000c4");
		const { tree, doc } = treeFromFields([
			f({
				uuid: fieldA,
				kind: "text",
				id: "a",
				label: proseText("A"),
				relevant: "/data/c = 'yes'",
			}),
			lookupSelectForDag(fieldB, "b", fieldA),
			f({
				uuid: fieldC,
				kind: "hidden",
				id: "c",
				calculate: "/data/b",
			}),
		]);

		expect(
			new TriggerDag().reportCycles(
				tree,
				doc,
				doc.formOrder[doc.moduleOrder[0]][0],
			),
		).toContainEqual({
			path: ["/data/a", "/data/b", "/data/c", "/data/a"],
		});
	});

	// JavaRosa cascades a group's or repeat's `relevant` to everything inside
	// it (`commcare-core .../model/condition/Condition.java::
	// isCascadingToChildren`), and `FormDef.java::finalizeTriggerables` makes
	// every condition that reads a descendant depend on the container's
	// condition. A container whose condition reads its own contents is
	// therefore "Logic is cyclical" at install, which CommCare HQ reports as
	// "Cannot make new version". These pin that the authoring proof draws the
	// same edge, and that a report names the containment.
	describe("relevance cascade from a container to its descendants", () => {
		it("rejects a group whose relevant reads its own child", () => {
			// The production shape: a quiz group that hides itself once its own
			// answer is filled in.
			const { tree, doc } = treeFromFields([
				f({
					kind: "group",
					id: "question_1_section",
					label: proseText("Question 1"),
					relevant: "string-length(/data/question_1_section/answer_1) = 0",
					children: [
						f({ kind: "text", id: "answer_1", label: proseText("Answer") }),
					],
				}),
			]);
			const cycles = new TriggerDag().reportCycles(
				tree,
				doc,
				doc.formOrder[doc.moduleOrder[0]][0],
			);
			expect(cycles).toContainEqual({
				path: [
					"/data/question_1_section",
					"/data/question_1_section/answer_1",
					"/data/question_1_section",
				],
				cascade: {
					container: "/data/question_1_section",
					containerKind: "group",
					descendant: "/data/question_1_section/answer_1",
				},
			});
		});

		it("rejects commcare-core's group_cyclic_reference fixture shape", () => {
			// `src/test/resources/xform_tests/group_cyclic_reference.xml`: a
			// field outside the group reads the group's child, and the group
			// reads that field. Neither authored expression references the
			// other directly; the loop closes only through the cascade.
			const { tree, doc } = treeFromFields([
				f({
					kind: "int",
					id: "first",
					label: proseText("First"),
					relevant: "/data/question1/question2 = '2'",
				}),
				f({
					kind: "group",
					id: "question1",
					label: proseText("Q1"),
					relevant: "/data/first = '1'",
					children: [
						f({ kind: "text", id: "question2", label: proseText("Q2") }),
					],
				}),
				f({
					kind: "text",
					id: "extra",
					label: proseText("Extra"),
					relevant: "/data/first = '1'",
				}),
			]);
			const cycles = new TriggerDag().reportCycles(
				tree,
				doc,
				doc.formOrder[doc.moduleOrder[0]][0],
			);
			// Reading `/data/question1/question2` also depends on the prefix
			// `/data/question1`, which closes a two-node twin of the same
			// loop; one authored loop is one report, the one that can explain
			// the containment.
			expect(cycles).toHaveLength(1);
			const withCascade = cycles.find((c) => c.cascade !== undefined);
			expect(withCascade?.cascade).toEqual({
				container: "/data/question1",
				containerKind: "group",
				descendant: "/data/question1/question2",
			});
			expect(withCascade?.path).toContain("/data/first");
		});

		// The device cascades value/relevance writes. Required is a
		// non-cascading Condition; a constraint and a label's
		// `<output>` are evaluated on demand, so a loop that closes only
		// through one of them installs and runs. The proof must not refuse
		// it, and the runtime must keep the calculate edge rather than the
		// constraint edge when it breaks that loop.
		it("does not report a loop that closes only through a constraint", () => {
			const { tree, doc } = treeFromFields([
				f({
					kind: "text",
					id: "flag",
					label: proseText("Flag"),
					validate: ". != /data/g/child",
				}),
				f({
					kind: "group",
					id: "g",
					label: proseText("G"),
					relevant: "/data/flag = 'yes'",
					children: [
						f({ kind: "text", id: "child", label: proseText("Child") }),
					],
				}),
			]);
			expect(
				new TriggerDag().reportCycles(
					tree,
					doc,
					doc.formOrder[doc.moduleOrder[0]][0],
				),
			).toEqual([]);
		});

		it("does not report a loop that closes only through a label reference", () => {
			const childUuid = testUuid("44444444-4444-4444-8444-444444444444");
			const { tree, doc } = treeFromFields([
				f({
					kind: "text",
					id: "flag",
					label: {
						parts: [
							{ kind: "text", text: "Flag for " },
							{ kind: "field-ref", uuid: childUuid },
						],
					},
				}),
				f({
					kind: "group",
					id: "g",
					label: proseText("G"),
					relevant: "/data/flag = 'yes'",
					children: [
						f({
							kind: "text",
							id: "child",
							uuid: childUuid,
							label: proseText("Child"),
						}),
					],
				}),
			]);
			expect(
				new TriggerDag().reportCycles(
					tree,
					doc,
					doc.formOrder[doc.moduleOrder[0]][0],
				),
			).toEqual([]);
		});

		it("keeps the calculate edge and drops the constraint edge at runtime", () => {
			// a calculates from b; b's constraint reads a. The only loop is
			// through the constraint, so a change to b must still re-run a.
			const { tree, doc } = treeFromFields([
				f({ kind: "hidden", id: "a", calculate: "/data/b + 1" }),
				f({
					kind: "int",
					id: "b",
					label: proseText("B"),
					validate: ". < /data/a",
				}),
			]);
			const dag = new TriggerDag();
			dag.build(
				tree,
				formExpressionRuntime(
					doc,
					doc.formOrder[doc.moduleOrder[0]][0],
					undefined,
					{},
				),
			);
			expect(dag.getAffected("/data/b", () => 1)).toContain("/data/a");
			expect(dag.getAffected("/data/a", () => 1)).not.toContain("/data/b");
		});

		it("still re-validates on a constraint edge that closes no loop", () => {
			const { tree, doc } = treeFromFields([
				f({ kind: "int", id: "a", label: proseText("A") }),
				f({
					kind: "int",
					id: "b",
					label: proseText("B"),
					validate: ". < /data/a",
				}),
			]);
			const dag = new TriggerDag();
			dag.build(
				tree,
				formExpressionRuntime(
					doc,
					doc.formOrder[doc.moduleOrder[0]][0],
					undefined,
					{},
				),
			);
			expect(dag.getAffected("/data/a", () => 1)).toContain("/data/b");
		});

		it("cascades through nested containers to a grandchild", () => {
			const { tree, doc } = treeFromFields([
				f({
					kind: "group",
					id: "outer",
					label: proseText("Outer"),
					relevant: "/data/outer/inner/leaf = 'go'",
					children: [
						f({
							kind: "group",
							id: "inner",
							label: proseText("Inner"),
							children: [
								f({ kind: "text", id: "leaf", label: proseText("Leaf") }),
							],
						}),
					],
				}),
			]);
			const cycles = new TriggerDag().reportCycles(
				tree,
				doc,
				doc.formOrder[doc.moduleOrder[0]][0],
			);
			expect(cycles.some((c) => c.cascade?.container === "/data/outer")).toBe(
				true,
			);
		});

		it("applies to a repeat's relevant as well", () => {
			const { tree, doc } = treeFromFields([
				f({
					kind: "repeat",
					id: "visits",
					label: proseText("Visits"),
					repeat_mode: "user_controlled",
					relevant: "/data/visits/note != ''",
					children: [f({ kind: "text", id: "note", label: proseText("Note") })],
				}),
			]);
			const cycles = new TriggerDag().reportCycles(
				tree,
				doc,
				doc.formOrder[doc.moduleOrder[0]][0],
			);
			expect(
				cycles.some(
					(c) =>
						c.cascade?.containerKind === "repeat" &&
						c.cascade.container === "/data/visits",
				),
			).toBe(true);
		});

		it("accepts a group whose relevant reads only fields outside it", () => {
			const { tree, doc } = treeFromFields([
				f({ kind: "int", id: "age", label: proseText("Age") }),
				f({
					kind: "group",
					id: "adult",
					label: proseText("Adult"),
					relevant: "/data/age >= 18",
					children: [
						f({
							kind: "hidden",
							id: "years_over",
							calculate: "/data/age - 18",
						}),
						f({
							kind: "text",
							id: "occupation",
							label: proseText("Occupation"),
							relevant: "/data/adult/years_over > 0",
						}),
					],
				}),
			]);
			expect(
				new TriggerDag().reportCycles(
					tree,
					doc,
					doc.formOrder[doc.moduleOrder[0]][0],
				),
			).toEqual([]);
		});

		it("includes the relevance cascade in the runtime DAG", () => {
			// Effective visibility changes the nodeset selected below a container
			// even when no descendant scalar changes. Runtime therefore re-runs a
			// descendant expression when the valid-by-construction container changes
			// relevance.
			const { tree, doc } = treeFromFields([
				f({ kind: "int", id: "age", label: proseText("Age") }),
				f({
					kind: "group",
					id: "adult",
					label: proseText("Adult"),
					relevant: "/data/age >= 18",
					children: [
						f({ kind: "hidden", id: "marker", calculate: "'visible'" }),
					],
				}),
			]);
			const dag = new TriggerDag();
			dag.build(
				tree,
				formExpressionRuntime(
					doc,
					doc.formOrder[doc.moduleOrder[0]][0],
					undefined,
					{},
				),
			);
			expect(dag.getAffected("/data/adult", () => 1)).toEqual([
				"/data/adult/marker",
			]);
		});
	});

	it("promotes lookup filter edges to runtime while defaults stay authoring-only", () => {
		const fieldA = testUuid("20000000-0000-7000-8000-0000000000a2");
		const fieldB = testUuid("20000000-0000-7000-8000-0000000000b2");
		const fieldC = testUuid("20000000-0000-7000-8000-0000000000c2");
		const { tree, doc } = treeFromFields([
			f({
				uuid: fieldA,
				kind: "text",
				id: "a",
				label: proseText("A"),
				default_value: "/data/b",
			}),
			lookupSelectForDag(fieldB, "b", fieldA),
			f({
				uuid: fieldC,
				kind: "text",
				id: "c",
				label: proseText("C"),
				relevant: "/data/a = 'yes'",
			}),
		]);
		const dag = new TriggerDag();
		const runtimeSnapshot = () => {
			const repeatCount = () => 0;
			return {
				expressionsA: dag
					.getExpressions("/data/a")
					.map((expression) => ({ ...expression })),
				expressionsB: dag
					.getExpressions("/data/b")
					.map((expression) => ({ ...expression })),
				expressionsC: dag
					.getExpressions("/data/c")
					.map((expression) => ({ ...expression })),
				affectedByA: dag.getAffected("/data/a", repeatCount),
				affectedByB: dag.getAffected("/data/b", repeatCount),
				allPaths: dag.getAllPaths(repeatCount),
			};
		};

		dag.build(
			tree,
			formExpressionRuntime(
				doc,
				doc.formOrder[doc.moduleOrder[0]][0],
				undefined,
				{},
			),
		);
		const beforeReport = runtimeSnapshot();
		/* `a`'s default_value reference is authoring-only: no runtime
		 * expression, and a `b` change never re-runs the applied default. */
		expect(beforeReport.expressionsA).toEqual([]);
		expect(beforeReport.affectedByB).toEqual([]);
		/* The lookup select's choices ARE runtime: one `choices`
		 * expression, and its filter's field-term edge makes an `a`
		 * change re-filter `b` (plus `c`'s ordinary relevance). */
		expect(beforeReport.expressionsB).toEqual([{ type: "choices", expr: "" }]);
		expect(beforeReport.affectedByA).toContain("/data/b");
		expect(beforeReport.affectedByA).toContain("/data/c");
		expect(beforeReport.allPaths).not.toEqual([]);
		/* The cycle proof (defaults included) mutates nothing runtime. */
		expect(
			dag.reportCycles(tree, doc, doc.formOrder[doc.moduleOrder[0]][0]),
		).not.toEqual([]);
		expect(runtimeSnapshot()).toEqual(beforeReport);
		dag.rebuild(
			tree,
			formExpressionRuntime(
				doc,
				doc.formOrder[doc.moduleOrder[0]][0],
				undefined,
				{},
			),
		);
		expect(runtimeSnapshot()).toEqual(beforeReport);
	});
});

// The parser owns text syntax and name binding. This boundary starts with a
// stored tree and proves that the shared verdict reaches the exact doc slot.
describe("typed deep validation", () => {
	it("keeps an admitted app free of expression findings", () => {
		const doc = formFixture();
		expect(validateBlueprintDeep(doc)).toEqual([]);
	});
	it("presents a dangling field identity at its actual calculate slot", () => {
		const base = formFixture();
		const missing = testUuid("removed-expression-field");
		const doc = {
			...base,
			fields: {
				...base.fields,
				[ids.hidden]: {
					...base.fields[ids.hidden],
					calculate: {
						kind: "term" as const,
						term: { kind: "field" as const, uuid: missing },
					},
				},
			},
		};
		expect(validateBlueprintDeep(doc)).toContainEqual(
			expect.objectContaining({
				kind: "field-xpath",
				fieldUuid: ids.hidden,
				surface: "calculate",
				error: expect.objectContaining({
					code: "INVALID_REF",
					storedRef: "dangling-identity",
					checkCode: "unknown-form-field",
				}),
			}),
		);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toContainEqual(
			expect.objectContaining({
				code: "INVALID_REF",
				location: expect.objectContaining({
					fieldUuid: ids.hidden,
					field: "calculate",
				}),
				details: expect.objectContaining({
					checkCode: "unknown-form-field",
					storedRef: "dangling-identity",
				}),
			}),
		);
	});
	it("checks direct form-case properties through the shared catalog", () => {
		const base = formFixture();
		const doc = {
			...base,
			fields: {
				...base.fields,
				[ids.hidden]: {
					...base.fields[ids.hidden],
					calculate: {
						kind: "term" as const,
						term: {
							kind: "form-case" as const,
							caseType: "patient",
							property: "missing",
						},
					},
				},
			},
		};
		expect(validateBlueprintDeep(doc)).toContainEqual(
			expect.objectContaining({
				kind: "field-xpath",
				error: expect.objectContaining({ code: "INVALID_CASE_REF" }),
			}),
		);
	});
	it("checks a form-link expression even when its source form has no questions", () => {
		const base = formFixture();
		const doc = {
			...base,
			forms: {
				...base.forms,
				[ids.form]: {
					...base.forms[ids.form],
					formLinks: [
						{
							uuid: ids.link,
							condition: { kind: "here" as const },
							target: {
								type: "form" as const,
								moduleUuid: ids.module,
								formUuid: ids.target,
							},
						},
					],
				},
			},
			fieldOrder: { ...base.fieldOrder, [ids.form]: [] },
		};
		expect(validateBlueprintDeep(doc)).toContainEqual(
			expect.objectContaining({
				kind: "form-link-xpath",
				linkUuid: ids.link,
				slot: "form_link_condition",
				error: expect.objectContaining({
					code: "XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
					checkCode: "arm-unavailable",
				}),
			}),
		);
	});
	it("retains call arity admission for stored trees without reparsing", () => {
		const base = formFixture();
		const doc = {
			...base,
			fields: {
				...base.fields,
				[ids.hidden]: {
					...base.fields[ids.hidden],
					calculate: { kind: "call" as const, fn: "round", args: [] },
				},
			},
		};
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toContainEqual(
			expect.objectContaining({
				code: "TYPE_ERROR",
				details: expect.objectContaining({
					checkCode: "arm-unavailable",
					checkReason: "function-arity",
				}),
			}),
		);
	});
	it("keeps a known question unavailable after its form has closed", () => {
		const base = formFixture();
		const doc = {
			...base,
			forms: {
				...base.forms,
				[ids.form]: {
					...base.forms[ids.form],
					formLinks: [
						{
							uuid: ids.link,
							condition: {
								kind: "term" as const,
								term: { kind: "field" as const, uuid: ids.text },
							},
							target: {
								type: "form" as const,
								moduleUuid: ids.module,
								formUuid: ids.target,
							},
						},
					],
				},
			},
		};
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toContainEqual(
			expect.objectContaining({
				code: "INVALID_REF",
				location: expect.objectContaining({ field: "form_link_condition" }),
				details: expect.objectContaining({
					checkCode: "form-answer-unavailable",
					linkUuid: ids.link,
				}),
			}),
		);
	});
});

describe("live repeat cardinality feedback", () => {
	it.each([
		"../n",
		"current()/../n",
		"number(/data/n)",
		"parent::node()/n",
		"self::node()/../n",
	])("admits sibling count %s in its calculated carrier scope", (count) => {
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({ id: "n", kind: "int", default_value: "2" }),
								f({
									id: "rows",
									kind: "repeat",
									repeat_mode: "count_bound",
									repeat_count: count,
									children: [f({ id: "answer", kind: "text" })],
								}),
							],
						},
					],
				},
			],
		});
		assertAdmitted(doc);
	});
	it.each([
		"count(../rows) + 1",
		"count(current()/../rows) + 1",
		"count(parent::node()/rows) + 1",
		"count(current()/parent::node()/rows) + 1",
		"count(self::node()/../rows) + 1",

		"count(/data/rows[n = 1]) + 1",
	])("rejects feedback through %s", (count) => {
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									id: "rows",
									kind: "repeat",
									repeat_mode: "count_bound",
									repeat_count: count,
									children: [f({ id: "n", kind: "int", default_value: "1" })],
								}),
							],
						},
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(error) =>
					error.code === "CYCLE" &&
					error.message.includes("depends on rows it creates"),
			),
		).toBe(true);
	});
	it("follows relative feedback through a calculated answer", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									id: "target",
									kind: "hidden",
									calculate: "count(../rows) + 1",
								}),
								f({
									id: "rows",
									kind: "repeat",
									repeat_mode: "count_bound",
									repeat_count: "number(../target)",
									children: [f({ id: "answer", kind: "text" })],
								}),
							],
						},
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(error) =>
					error.code === "CYCLE" &&
					error.message.includes("depends on rows it creates"),
			),
		).toBe(true);
	});

	it("admits a count initialized once from the still-empty repeat", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									id: "n",
									kind: "int",
									default_value: "count(#form/rows) + 1",
								}),
								f({
									id: "rows",
									kind: "repeat",
									repeat_mode: "count_bound",
									repeat_count: "#form/n",
									children: [f({ id: "answer", kind: "text" })],
								}),
							],
						},
					],
				},
			],
		});
		assertAdmitted(doc);
	});

	it.each([
		{
			name: "defaults in created rows",
			fields: [
				f({
					id: "rows",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: "sum(#form/rows/n) + 1",
					children: [f({ id: "n", kind: "int", default_value: "1" })],
				}),
			],
		},
		{
			name: "own rows",
			fields: [
				f({
					id: "rows",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: "count(#form/rows) + 1",
					children: [f({ id: "answer", kind: "text" })],
				}),
			],
		},
		{
			name: "own answers",
			fields: [
				f({
					id: "rows",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: "count(#form/rows/answer) + 1",
					children: [f({ id: "answer", kind: "text" })],
				}),
			],
		},
		{
			name: "calculated feedback",
			fields: [
				f({ id: "target", kind: "hidden", calculate: "count(#form/rows) + 1" }),
				f({
					id: "rows",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: "number(#form/target)",
					children: [f({ id: "answer", kind: "text" })],
				}),
			],
		},
		{
			name: "mutual repeats",
			fields: [
				f({
					id: "a",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: "count(#form/b) + 1",
					children: [f({ id: "answer", kind: "text" })],
				}),
				f({
					id: "b",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: "count(#form/a) + 1",
					children: [f({ id: "answer", kind: "text" })],
				}),
			],
		},
	])("rejects $name before Preview or export", ({ fields }) => {
		const doc = buildDoc({
			modules: [
				{ name: "Visits", forms: [{ name: "Visit", type: "survey", fields }] },
			],
		});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some(
				(error) =>
					error.code === "CYCLE" &&
					error.message.includes("depends on rows it creates"),
			),
		).toBe(true);
	});
});
