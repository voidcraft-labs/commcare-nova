/**
 * These bytes are the pre-step input to the one-off lift, not documents rebuilt
 * by the head's factories. Their digests and coverage checks remain after the
 * old expression model leaves; the cutover consumes these raw carriers.
 *
 * A failure the old gate cannot admit is a fault over an admitted carrier, or
 * surrounding-state metadata. PR13 applies those explicitly in its guard tests;
 * an invalid raw fixture must never stand in for a pre-step stored document.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	PersistedBlueprintRootText,
	PersistedEntityRowText,
} from "@/lib/db/persistedJson";

interface Fixture {
	readonly id: string;
	readonly kind: "corpus" | "synthetic";
	readonly digest: string;
	readonly source: {
		readonly document?: string;
		readonly description?: string;
	};
	readonly steps: readonly string[];
	readonly classes: readonly string[];
	readonly blockers: readonly string[];
	readonly rules: readonly string[];
	readonly reasons: readonly string[];
	readonly context?: Record<string, unknown>;
	readonly faults?: readonly {
		readonly stage: string;
		readonly operation: string;
		readonly entity?: string;
		readonly uuid?: string;
		readonly path?: readonly (string | number)[];
		readonly value?: unknown;
		readonly blocker: string;
		readonly oldGateRefusal?: string;
	}[];
}
interface Carriers {
	readonly root: PersistedBlueprintRootText;
	readonly rows: readonly PersistedEntityRowText[];
}
const PRE_STEP = join(import.meta.dirname, "fixtures", "pre-step");
const manifest = JSON.parse(
	readFileSync(join(PRE_STEP, "manifest.json"), "utf8"),
) as { format: string; sourceCommit: string; fixtures: readonly Fixture[] };
const fixtures = manifest.fixtures;
const captured = new Map(
	fixtures.map((fixture) => {
		const bytes = readFileSync(join(PRE_STEP, fixture.id, "carriers.json"));
		return [
			fixture.id,
			{ fixture, bytes, carriers: JSON.parse(bytes.toString()) as Carriers },
		] as const;
	}),
);
function capture(id: string) {
	const result = captured.get(id);
	if (!result) throw new Error(`Missing frozen fixture ${id}`);
	return result;
}
/** Inspect individual raw carriers, without recreating an old document reader. */
function row(
	id: string,
	entityId: string,
	kind = "field",
): Record<string, unknown> {
	const result = capture(id)
		.carriers.rows.filter((entry) => entry.kind === kind)
		.map((entry) => JSON.parse(entry.data_text) as Record<string, unknown>)
		.find((entry) => entry.id === entityId);
	if (!result) throw new Error(`Missing ${kind} ${id}/${entityId}`);
	return result;
}
function text(value: string) {
	return { parts: [{ kind: "text", text: value }] };
}
function coverage(key: "steps" | "classes" | "blockers" | "rules" | "reasons") {
	return [...new Set(fixtures.flatMap((fixture) => fixture[key]))].sort();
}

describe("frozen pre-step carriers", () => {
	it("keeps the exact captured bytes and a closed, named inventory", () => {
		expect(manifest.format).toBe("hq-round-trip-expressions-pre-step-1");
		expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
		expect(captured.size).toBe(fixtures.length);
		expect(fixtures.length).toBeGreaterThan(0);
		expect(
			readdirSync(PRE_STEP, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort(),
		).toEqual(fixtures.map((fixture) => fixture.id).sort());
		for (const { fixture, bytes, carriers } of captured.values()) {
			expect(createHash("sha256").update(bytes).digest("hex"), fixture.id).toBe(
				fixture.digest,
			);
			expect(carriers.root.app_settings_text, fixture.id).not.toBeNull();
			expect(carriers.rows.length, fixture.id).toBeGreaterThan(0);
			expect(
				fixture.kind === "corpus"
					? fixture.source.document
					: fixture.source.description,
				fixture.id,
			).toBeTruthy();
		}
	});

	it("names every step, blocker, blocking rule and notice reason in part 09", () => {
		expect(coverage("steps")).toEqual(
			[
				"catalog-rules",
				"form-link-datum-names",
				"record-expressions",
				"form-logic-lift",
				"declare-read-properties",
				"repeat-read-first-row",
				"lift-round-trip",
			].sort(),
		);
		expect(coverage("blockers")).toEqual(
			[
				"expression-parse-refused",
				"empty-required-expression",
				"form-link-datum-unresolved",
				"declared-property-type-conflict",
				"declared-property-has-stored-values",
				"old-reference-dangling",
				"target-parse",
				"target-gate",
				"target-export-readiness",
				"case-schema-unplanned",
				"round-trip",
				"holder",
				"digest",
				"unexplained",
			].sort(),
		);
		expect(coverage("rules")).toEqual(
			[
				"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				"CYCLE",
				"record-verdict-moved-by-inference",
				"SELECT_PRELOAD_WRITE_NOT_AN_OPTION",
				"case-query-untyped",
				"selected-cases-as-one-value",
				"prose-repeat-read-as-one-value",
				"day-only-on-device",
			].sort(),
		);
		expect(coverage("reasons")).toEqual(
			[
				"case-property-rules-removed",
				"expressions-follow-choices",
				"expressions-respelled",
				"case-property-declared",
				"repeat-read-takes-first-row",
				"search-today-is-workers-day",
				"search-date-time-equality-matches",
				"date-time-comparison-compares-moments",
				"case-property-type-now-known",
				"unsaved-assistant-work-discarded",
				"deep-links-need-republish",
				"expressions-sent-at-next-publish",
			].sort(),
		);
		expect(coverage("classes")).toEqual(
			[
				"datetime-ordering",
				"relative-across-repeat",
				"current-repeat-row",
				"query-bound-repeat",
				"manual-datum",
				"record-integer-division",
				"record-decimal-division",
				"catalog-required",
				"catalog-validation",
				"catalog-validation-message",
				"select-literal-default",
				"select-comparison",
				"record-choice-eq",
				"record-choice-neq",
				"record-choice-in",
				"record-choice-switch",
				"multi-select-choice",
				"unmatched-choice-literal",
				"canonical-respelling",
				"relative-inside-repeat",
				"empty-optional",
				"structural-many-value",
				"typed-case-query",
				"unique-untyped-case-query",
				"standard-untyped-case-query",
				"known-case-id-query",
				"session-selected-case",
				"declare-text",
				"declare-decimal",
				"declare-date",
				"declare-datetime",
				"ambiguous-untyped-query",
				"unknown-untyped-query",
				"hidden-writer-inference",
				"effective-search-today",
				"effective-search-datetime-equality",
				"empty-datum-guard",
				"empty-repeat-count-guard",
				"empty-ids-query-guard",
				"unresolved-datum-guard",
			].sort(),
		);
	});

	it("retains catalog rules, manual datum strings and record division before their lifts", () => {
		const catalog = JSON.parse(
			capture("catalog-rules").carriers.root.case_types_text ?? "null",
		);
		expect(catalog).toContainEqual(
			expect.objectContaining({
				name: "patient",
				properties: expect.arrayContaining([
					expect.objectContaining({
						name: "age",
						required: text("true()"),
						validation: text(". >= 0"),
						validation_msg: text("Age must be zero or greater."),
					}),
				]),
			}),
		);
		expect(row("form-link-manual", "register_frog", "form").formLinks).toEqual([
			expect.objectContaining({
				datums: [{ name: "case_id", xpath: text("'explicit-frog'") }],
			}),
		]);
		expect(row("arithmetic", "calculate", "form").caseOperations).toEqual([
			expect.objectContaining({
				writes: expect.arrayContaining([
					expect.objectContaining({
						property: "quotient",
						value: expect.objectContaining({ kind: "arith", op: "div" }),
					}),
					expect.objectContaining({
						property: "mixed",
						value: expect.objectContaining({ kind: "arith", op: "div" }),
					}),
				]),
			}),
		]);
	});

	it("retains relative, current-row, choice, empty and many-value form logic", () => {
		expect(
			row("container-query-conditional-relative", "item_id").calculate,
		).toEqual(text("current()/../@id"));
		expect(
			row("container-query-conditional-relative", "confirm").relevant,
		).toEqual(text("../show = 'yes'"));
		expect(row("form-logic", "same_row").calculate).toEqual(text("../answer"));
		expect(row("form-logic", "canonical").calculate).toEqual(text("((1+  2))"));
		expect(row("form-logic", "optional_empty").relevant).toEqual({ parts: [] });
		expect(row("form-logic", "summary").calculate).toEqual({
			parts: [
				{ kind: "text", text: "concat('Answers: ', " },
				{ kind: "field-ref", uuid: row("form-logic", "answer").uuid },
				{ kind: "text", text: ")" },
			],
		});
		expect(row("choices", "choice").default_value).toEqual(text("'yes'"));
		expect(row("choices", "choices").default_value).toEqual(text("'a b'"));
		expect(row("choices", "visit", "form").caseOperations).toEqual([
			expect.objectContaining({
				condition: {
					kind: "and",
					clauses: expect.arrayContaining([
						expect.objectContaining({ kind: "eq" }),
						expect.objectContaining({ kind: "neq" }),
						expect.objectContaining({ kind: "in" }),
					]),
				},
				writes: [
					expect.objectContaining({
						value: expect.objectContaining({
							kind: "switch",
							cases: [
								expect.objectContaining({
									when: { kind: "literal", value: "yes" },
								}),
							],
						}),
					}),
				],
			}),
		]);
	});

	it("retains all case-query bindings, declaration types and selected-case reads", () => {
		const cases = "instance('casedb')/casedb/case";
		const selected = "instance('commcaresession')/session/data/case_id";
		for (const [name, expression] of [
			["typed", `${cases}[@case_type='patient']/known`],
			["unique", `${cases}/known`],
			["standard", `${cases}/@case_id`],
			["by_id", `${cases}[@case_id=${selected}]/known`],
			["selected", selected],
		])
			expect(row("case-query-bindings", name).calculate).toEqual(
				text(expression),
			);
		for (const [name, suffix] of [
			["new_text", ""],
			["new_number", " + 1"],
			["new_date", " < today()"],
			["new_moment", " < now()"],
		]) {
			expect(row("declare-read-properties", name).calculate).toEqual(
				text(`${cases}[@case_type='patient']/${name}${suffix}`),
			);
		}
		expect(row("hidden-inference", "score")).toMatchObject({
			calculate: text("1 + 2"),
			caseWrite: { caseType: "patient", property: "score" },
		});
		expect(row("targeted-datetime-ordering", "order").calculate).toMatchObject({
			parts: expect.arrayContaining([{ kind: "text", text: " < " }]),
		});
	});

	it("states guard faults and surrounding-state failures separately from admitted bytes", () => {
		for (const fixture of fixtures) {
			for (const fault of fixture.faults ?? []) {
				expect(fixture.blockers, fixture.id).toContain(fault.blocker);
				if (fault.entity || fault.uuid)
					expect(
						capture(fixture.id).carriers.rows.some(
							(entry) => entry.uuid === (fault.entity ?? fault.uuid),
						),
					).toBe(true);
				if (fault.operation === "replace-slot") {
					expect(fault.path?.length, fixture.id).toBeGreaterThan(0);
					expect(Object.hasOwn(fault, "value"), fixture.id).toBe(true);
				}
			}
		}
		expect(
			capture("required-slot-guards").fixture.faults?.map(
				(fault) => fault.path,
			),
		).toEqual([
			["formLinks", 0, "datums", 0, "xpath"],
			["repeat_count"],
			["data_source", "ids_query"],
			["formLinks", 0, "datums", 0, "name"],
		]);
		expect(capture("orphan-read-property").fixture.context).toEqual({
			cases: [
				{
					caseType: "patient",
					properties: { new_text: "retained orphan value" },
				},
			],
		});
		expect(capture("selected-cases-scalar").fixture.faults).toEqual([
			expect.objectContaining({
				oldGateRefusal: "XPATH_INSTANCE_UNAVAILABLE",
				value: text(
					"concat('Selected: ', instance('selected_cases')/results/value)",
				),
			}),
		]);
		expect(row("context-and-guards", "visit", "form").entryPoint).toMatchObject(
			{ id: "visit" },
		);
		expect(capture("context-and-guards").fixture.context).toMatchObject({
			privateWork: ["authoring-workspace", "design-change-set"],
			deployment: { liveApp: true, entryPoints: true },
			holder: { kind: "live-run" },
			expectedDigest: "mismatch",
			census: "unexplained",
		});
	});
});
