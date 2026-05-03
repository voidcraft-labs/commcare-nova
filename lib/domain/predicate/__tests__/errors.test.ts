// lib/domain/predicate/__tests__/errors.test.ts
//
// Pin the structure of the three error-message helpers so any future
// edit to `errors.ts` surfaces here as a diff. The helpers feed every
// compiler-stack throw, so their structure is the foundation's
// contract for what a thrown `.message` looks like — both for the
// developer reading a stack trace and for the harness tests that
// match on substrings.

import { describe, expect, it } from "vitest";
import {
	compilerBugMessage,
	typeCheckerBypassMessage,
	unhandledKindMessage,
} from "../errors";

// Pin the actual structure of one message of each shape rather than
// asserting on per-section substrings. The expected text doubles as
// the canonical example a future contributor reads to copy the
// voice for a new call site.

describe("unhandledKindMessage", () => {
	it("formats the canonical multi-section ICE shape", () => {
		const message = unhandledKindMessage({
			where: "compilePredicate",
			family: "Predicate",
			received: "future-kind",
			knownKinds: ["match-all", "match-none", "and", "or"],
		});

		expect(message).toBe(
			[
				'Internal bug — `compilePredicate` received an unhandled Predicate kind: "future-kind".',
				"",
				"I know how to handle these Predicate kinds:",
				"",
				"    match-all, match-none, and, or",
				"",
				"Reaching this throw means a new Predicate variant was added without",
				"updating `compilePredicate`, or TypeScript's exhaustive `never` check was",
				"bypassed (typically through `as any`, an AST built at runtime, or a",
				"partial discriminated-union widening). Add the missing case to the",
				"switch in `compilePredicate` to fix it.",
			].join("\n"),
		);
	});

	it("renders a non-string received value through JSON.stringify", () => {
		const message = unhandledKindMessage({
			where: "compileExpression",
			family: "ValueExpression",
			received: { kind: "rogue", payload: 42 },
			knownKinds: ["term", "today"],
		});
		expect(message).toContain('{"kind":"rogue","payload":42}');
	});
});

describe("compilerBugMessage", () => {
	it("formats the header-only shape when no detail is supplied", () => {
		const message = compilerBugMessage({
			where: "compilePredicate.compileBetween",
			invariant:
				"`between` predicate has neither lower nor upper bound, but the schema's `.refine()` should have rejected it upstream",
		});

		expect(message).toBe(
			"Internal bug — `compilePredicate.compileBetween`: `between` predicate has neither lower nor upper bound, but the schema's `.refine()` should have rejected it upstream.",
		);
	});

	it("appends the detail block on its own paragraph when supplied", () => {
		const message = compilerBugMessage({
			where: "compileRelationPath",
			invariant: "non-self input produced a `self` compiled result",
			detail:
				"This means the relation-path compiler dispatched the wrong arm; check the switch's cases against the input's `kind`.",
		});

		expect(message).toBe(
			[
				"Internal bug — `compileRelationPath`: non-self input produced a `self` compiled result.",
				"",
				"This means the relation-path compiler dispatched the wrong arm; check the switch's cases against the input's `kind`.",
			].join("\n"),
		);
	});
});

describe("typeCheckerBypassMessage", () => {
	it("formats the full shape with expected/got and a custom hint", () => {
		const message = typeCheckerBypassMessage({
			where: "compileTerm",
			summary:
				"property 'ghost-property' is not declared on case type 'patient'",
			expected:
				'a property declared in `case_type_schemas[appId, "patient"].properties`',
			received: "'ghost-property'",
			hint: "register the property on the case type, or correct the AST to read a declared property.",
		});

		expect(message).toBe(
			[
				"`compileTerm` — property 'ghost-property' is not declared on case type 'patient' (type-checker bypass).",
				"",
				'    expected: a property declared in `case_type_schemas[appId, "patient"].properties`',
				"    got:      'ghost-property'",
				"",
				"The type checker (`checkPredicate` / `checkExpression` in",
				"`lib/domain/predicate/typeChecker.ts`) is the gate every compiler",
				"trusts. Reaching this throw means the AST was compiled without",
				"being checked, or was constructed/mutated at runtime after the",
				"check pass.",
				"",
				"Hint: register the property on the case type, or correct the AST to read a declared property.",
			].join("\n"),
		);
	});

	it("supplies a default hint when no site-specific hint is provided", () => {
		const message = typeCheckerBypassMessage({
			where: "compileTerm",
			summary: "unknown case type 'mystery'",
		});
		expect(message).toContain("Hint: route the AST through `checkPredicate`");
	});

	it("omits the expected/got block when neither is supplied", () => {
		const message = typeCheckerBypassMessage({
			where: "compileExpression",
			summary: "`count(self)` is rejected by the type checker",
		});
		expect(message).not.toContain("expected:");
		expect(message).not.toContain("got:");
		// The narrative paragraph still renders so the reader gets the
		// "what to do" context regardless of whether expected/got applies.
		expect(message).toContain("The type checker (");
	});
});
