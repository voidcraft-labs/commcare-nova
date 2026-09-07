// Diagnostic interpolation and optional detail policy. Message prose is free to
// improve; these tests do not claim a compiler actually enforces its invariants.
import { describe, expect, it } from "vitest";
import {
	compilerBugMessage,
	missingPredicateThunkMessage,
	typeCheckerBypassMessage,
	unhandledKindMessage,
} from "../errors";

describe("predicate diagnostics", () => {
	it.each(["future-kind", { kind: "rogue", payload: 42 }, undefined])(
		"identifies the call site, family, received value, and available kinds: %j",
		(received) => {
			const message = unhandledKindMessage({
				where: "readCandidate",
				family: "Candidate",
				received,
				knownKinds: ["alpha", "beta"],
			});
			expect(message).toContain("`readCandidate`");
			expect(message).toContain("Candidate");
			expect(message).toContain(
				received === undefined ? "undefined" : JSON.stringify(received),
			);
			expect(message).toContain("alpha, beta");
		},
	);
	it("keeps the invariant readable with and without optional detail", () => {
		const base = {
			where: "compileRelationPath",
			invariant: "non-self input produced self",
		};
		const plain = compilerBugMessage(base);
		expect(plain).toContain(base.where);
		expect(plain).toContain(base.invariant);
		expect(plain).not.toContain("undefined");
		expect(
			compilerBugMessage({ ...base, detail: "Inspect the relation arm." }),
		).toBe(`${plain}\n\nInspect the relation arm.`);
	});
	it.each([
		{ expected: "declared property" },
		{ received: "ghost" },
		{ expected: "declared property", received: "ghost" },
		{},
	])("shows only the supplied expected and received details: %j", (details) => {
		const message = typeCheckerBypassMessage({
			where: "resolveTerm",
			summary: "Unknown property",
			...details,
		});
		expect(message).toContain("resolveTerm");
		expect(message).toContain("Unknown property");
		expect(message.includes("expected:")).toBe("expected" in details);
		expect(message.includes("got:")).toBe("received" in details);
		if ("expected" in details) expect(message).toContain(details.expected);
		if ("received" in details) expect(message).toContain(details.received);
		expect(message).toContain("checkPredicate");
	});
	it("uses the caller's actionable hint", () => {
		const message = typeCheckerBypassMessage({
			where: "resolveTerm",
			summary: "Unknown property",
			hint: "Declare the property first.",
		});
		expect(message).toContain("Hint: Declare the property first.");
	});
	it.each(["if", "count(via, where)"])(
		"identifies the missing predicate callback for %s",
		(arm) => {
			const message = missingPredicateThunkMessage({
				where: "compileExpression",
				arm,
				slot: `the ${arm} predicate slot`,
			});
			expect(message).toContain("`compileExpression`");
			expect(message).toContain(`\`${arm}\``);
			expect(message).toContain(`the ${arm} predicate slot`);
			expect(message).toContain("ctx.compilePredicate");
		},
	);
});
