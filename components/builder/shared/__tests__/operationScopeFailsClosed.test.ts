// components/builder/shared/__tests__/operationScopeFailsClosed.test.ts
//
// Absent means not authorable — the whole safety argument for opening
// three round-trip-only value kinds and one term source inside case
// operations.
//
// `formFields` and `operationScope` are optional on the edit context, so
// every surface that does not opt in must behave EXACTLY as it did
// before: the form-answer source and the submission-local kinds stay
// unauthorable, and the type context those surfaces build refuses the
// values outright. That has to be true of the defaults themselves, not
// true because every current caller happens to omit them — a new surface
// forgetting to opt in should fail closed rather than quietly widen what
// an author can write into a slot the commit gate will reject.

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	actingUser,
	checkValueExpression,
	formField,
	idOf,
	term,
	unowned,
} from "@/lib/domain/predicate";
import { buildEditorTypeContext } from "../editorContext";
import { isAuthorableExpressionKind } from "../expressionEditorSchemas";

const FIELD = asUuid("11111111-1111-4111-8111-111111111111");
const CREATE = asUuid("22222222-2222-4222-8222-222222222222");

const BARE = {
	caseTypes: [],
	currentCaseType: "patient",
	knownInputs: [],
} as const;

describe("without an operation scope", () => {
	it("keeps the submission-local kinds unauthorable", () => {
		for (const kind of ["acting-user", "unowned", "id-of"] as const) {
			expect(isAuthorableExpressionKind(kind)).toBe(false);
			expect(isAuthorableExpressionKind(kind, {})).toBe(false);
			expect(
				isAuthorableExpressionKind(kind, { operationScope: undefined }),
			).toBe(false);
		}
	});

	it("builds a type context that refuses them, so nothing slips past", () => {
		const ctx = buildEditorTypeContext(BARE);
		expect(checkValueExpression(actingUser(), ctx).ok).toBe(false);
		expect(checkValueExpression(unowned(), ctx).ok).toBe(false);
		expect(checkValueExpression(idOf(CREATE), ctx).ok).toBe(false);
	});

	it("refuses a form answer, because no answers are in scope", () => {
		const ctx = buildEditorTypeContext(BARE);
		expect(ctx.formFields?.size).toBe(0);
		expect(ctx.caseOperationValues).toBeUndefined();
		expect(ctx.operationIds).toBeUndefined();
		expect(checkValueExpression(term(formField(FIELD)), ctx).ok).toBe(false);
	});
});

describe("with an operation scope", () => {
	it("opens the two owner sentinels, and `id-of` only once a create exists", () => {
		expect(
			isAuthorableExpressionKind("id-of", { operationScope: { creates: [] } }),
		).toBe(false);
		const scope = {
			operationScope: { creates: [{ uuid: CREATE, label: "create_referral" }] },
		};
		for (const kind of ["acting-user", "unowned", "id-of"] as const) {
			expect(isAuthorableExpressionKind(kind, scope)).toBe(true);
		}
	});

	it("admits exactly the answers and creates the surface declared", () => {
		const ctx = buildEditorTypeContext({
			...BARE,
			formFields: [
				{
					uuid: FIELD,
					label: "Client name",
					id: "client_name",
					dataType: "text",
				},
			],
			operationScope: { creates: [{ uuid: CREATE, label: "create_referral" }] },
		});
		expect(checkValueExpression(term(formField(FIELD)), ctx).ok).toBe(true);
		expect(checkValueExpression(actingUser(), ctx).ok).toBe(true);
		expect(checkValueExpression(idOf(CREATE), ctx).ok).toBe(true);
		// An answer the surface did not declare stays refused: the decl list
		// IS the admission list, already narrowed by repeat scope.
		expect(
			checkValueExpression(term(formField(asUuid("not-in-scope"))), ctx).ok,
		).toBe(false);
	});
});
