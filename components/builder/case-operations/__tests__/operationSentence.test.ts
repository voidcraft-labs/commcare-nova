import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import type { CaseOperation } from "@/lib/domain";
import { idOf, literal, term } from "@/lib/domain/predicate";
import {
	type OperationSentenceContext,
	operationSentence,
	operationSentenceText,
} from "../operationSentence";

const CREATE = asUuid("11111111-1111-4111-8111-111111111111");
const REPEAT = asUuid("22222222-2222-4222-8222-222222222222");
const FIELD = asUuid("33333333-3333-4333-8333-333333333333");

const names: Record<string, string> = {
	[CREATE]: "Create client",
	[REPEAT]: "Beds",
	[FIELD]: "Referral ID",
};

const context: OperationSentenceContext = {
	operationName: (uuid) => names[uuid],
	repeatLabel: (uuid) => names[uuid],
	fieldLabel: (uuid) => names[uuid],
};

/** Nothing outside the operation resolves — every fallback fires. */
const blind: OperationSentenceContext = {
	operationName: () => undefined,
	repeatLabel: () => undefined,
	fieldLabel: () => undefined,
};

function op(patch: Partial<CaseOperation> = {}): CaseOperation {
	return {
		uuid: asUuid("44444444-4444-4444-8444-444444444444"),
		id: "do_thing",
		order: "a",
		action: "create",
		caseType: "referral",
		target: { kind: "new" },
		name: term(literal("Referral")),
		...patch,
	};
}

describe("operationSentence", () => {
	it("reads a create as an outcome", () => {
		expect(operationSentence(op(), context).lead).toBe(
			"Create a new referral case",
		);
	});

	it("names the key field of a keyed create", () => {
		expect(
			operationSentence(op({ target: { kind: "new", idFrom: FIELD } }), context)
				.lead,
		).toBe("Create a new referral case, keyed by “Referral ID”");
	});

	it("reads the session target as the case the form opened", () => {
		expect(
			operationSentence(
				op({ action: "update", target: { kind: "session" }, name: undefined }),
				context,
			).lead,
		).toBe("Update the case this form opened");
	});

	it("names the producing operation for an earlier-create target", () => {
		expect(
			operationSentence(
				op({
					action: "update",
					target: { kind: "op", opUuid: CREATE },
					name: undefined,
				}),
				context,
			).lead,
		).toBe("Update the referral case from “Create client”");
	});

	it("humanizes stored case-type identifiers in every author-facing clause", () => {
		const sentence = operationSentence(
			op({
				action: "update",
				caseType: "archived_referral",
				target: { kind: "op", opUuid: CREATE },
				name: undefined,
				retype: "closed_referral",
			}),
			context,
		);
		expect(sentence.lead).toBe(
			"Update the archived referral case from “Create client”",
		);
		expect(sentence.details).toContain("changes its type to closed referral");
		expect(operationSentenceText(sentence)).not.toContain("archived_referral");
		expect(operationSentenceText(sentence)).not.toContain("closed_referral");
	});

	it("says a calculation found the case for a runtime target", () => {
		expect(
			operationSentence(
				op({
					action: "close",
					target: { kind: "expression", expr: idOf(CREATE) },
					name: undefined,
				}),
				context,
			).lead,
		).toBe("Close a referral case found by a calculation");
	});

	it("names the repeat a multiplicity rides on", () => {
		expect(
			operationSentence(op({ forEach: { repeat: REPEAT } }), context).details,
		).toContain("once for each “Beds” entry");
	});

	it("counts writes and links in singular and plural", () => {
		const one = operationSentence(
			op({
				writes: [{ property: "a", value: term(literal("x")) }],
				links: [
					{
						identifier: "parent",
						targetType: "client",
						target: { kind: "op", opUuid: CREATE },
						relationship: "child",
					},
				],
			}),
			context,
		);
		expect(one.details).toContain("saves 1 property");
		expect(one.details).toContain("links it to another case");

		const many = operationSentence(
			op({
				writes: [
					{ property: "a", value: term(literal("x")) },
					{ property: "b", value: term(literal("y")) },
				],
			}),
			context,
		);
		expect(many.details).toContain("saves 2 properties");
	});

	it("distinguishes removing a link from adding one", () => {
		// An empty index target is CommCare's unlink, so the sentence must
		// not read it as another link.
		const sentence = operationSentence(
			op({
				action: "update",
				target: { kind: "session" },
				name: undefined,
				links: [
					{
						identifier: "parent",
						targetType: "client",
						target: null,
						relationship: "child",
					},
				],
			}),
			context,
		);
		expect(sentence.details).toContain("removes a link");
		expect(sentence.details.join(" ")).not.toContain("links it to");
	});

	it("names rename, retype, and owner as outcomes", () => {
		const sentence = operationSentence(
			op({
				action: "update",
				target: { kind: "session" },
				name: undefined,
				rename: term(literal("New")),
				retype: "visit",
				owner: term(literal("-")),
			}),
			context,
		);
		expect(sentence.details).toEqual([
			"gives it a new name",
			"changes its type to visit",
			"sets who owns it",
		]);
	});

	it("degrades to honest phrasing when a reference cannot be resolved", () => {
		// A peer's rename or removal lands mid-render; the row must still
		// read as a sentence rather than exposing a uuid.
		const sentence = operationSentence(
			op({
				action: "update",
				target: { kind: "op", opUuid: CREATE },
				name: undefined,
				forEach: { repeat: REPEAT },
			}),
			blind,
		);
		expect(sentence.lead).toBe(
			"Update the referral case made earlier in this form",
		);
		expect(sentence.details).toContain(
			"once for each entry in a repeating section",
		);
		expect(operationSentenceText(sentence)).not.toContain(CREATE);
		expect(operationSentenceText(sentence)).not.toContain(REPEAT);
	});

	it("joins the row into one accessible sentence", () => {
		expect(
			operationSentenceText(
				operationSentence(op({ forEach: { repeat: REPEAT } }), context),
			),
		).toBe("Create a new referral case — once for each “Beds” entry");
		expect(operationSentenceText(operationSentence(op(), context))).toBe(
			"Create a new referral case",
		);
	});

	it("never renders CommCare's or the wire's vocabulary", () => {
		const shapes = [
			op(),
			op({ action: "update", target: { kind: "session" }, name: undefined }),
			op({ action: "close", target: { kind: "session" }, name: undefined }),
		];
		for (const shape of shapes) {
			const text = operationSentenceText(
				operationSentence(shape, context),
			).toLowerCase();
			for (const banned of [
				"save to case",
				"case block",
				"advanced case action",
				"aca",
				"xpath",
				"index",
			]) {
				expect(text).not.toContain(banned);
			}
		}
	});
});
