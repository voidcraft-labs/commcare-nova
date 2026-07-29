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
import type { UserProperty } from "@/lib/domain";
import {
	actingUser,
	checkValueExpression,
	compatibleTypesFor,
	dateLiteral,
	formField,
	idOf,
	literal,
	sessionUserProperty,
	term,
	unowned,
} from "@/lib/domain/predicate";
import {
	reseedValueForConstraint,
	resolveExpressionType,
} from "../cards/reseed";
import { buildEditorTypeContext } from "../editorContext";
import { isAuthorableExpressionKind } from "../expressionEditorSchemas";

const FIELD = asUuid("11111111-1111-4111-8111-111111111111");
const CREATE = asUuid("22222222-2222-4222-8222-222222222222");
const WORKER = asUuid("33333333-3333-4333-8333-333333333333");

const BARE = {
	caseTypes: [],
	currentCaseType: "patient",
	knownInputs: [],
} as const;

const DATE_ANSWER = {
	uuid: FIELD,
	label: "Seen on",
	id: "seen_on",
	dataType: "date" as const,
};

const WORKER_PROPERTY: UserProperty = {
	uuid: WORKER,
	slug: "district",
	label: "District",
};

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

// The cascade reseed resolves types inside an event handler, where a hook
// cannot run — so it builds its own context. If that context is narrower
// than the one the pickers offer, the resolution silently returns
// `undefined`, every dependent slot's accept-set widens to everything, the
// reseed is skipped, and a type-incorrect pair commits into a slot the gate
// then refuses. These pin the resolution against the SAME vocabulary,
// because the axes have opposite polarity: an absent worker catalog is
// permissive while absent form answers are fatal, so only the fatal one
// shows up as a wrong-looking `undefined`.
describe("the cascade reseed resolves against the vocabulary on screen", () => {
	const FULL = {
		...BARE,
		userProperties: [WORKER_PROPERTY],
		formFields: [DATE_ANSWER],
		operationScope: { creates: [{ uuid: CREATE, label: "create_referral" }] },
	};

	it("resolves every axis the pickers offer", () => {
		expect(resolveExpressionType(term(formField(FIELD)), FULL)).toBe("date");
		expect(resolveExpressionType(idOf(CREATE), FULL)).toBe("text");
		expect(resolveExpressionType(actingUser(), FULL)).toBe("text");
		expect(resolveExpressionType(term(sessionUserProperty(WORKER)), FULL)).toBe(
			"text",
		);
	});

	it("reseeds a text literal when the subject becomes a date answer", () => {
		// The exact sequence `ComparisonCard.setLeft` runs: resolve the NEW
		// subject, narrow the object's accept-set from it, reseed a value the
		// narrowed set no longer holds.
		const subjectType = resolveExpressionType(term(formField(FIELD)), FULL);
		const accepts = compatibleTypesFor(subjectType);
		expect(accepts.has("text")).toBe(false);
		// A text value has no date reading, so the reseed drops to an empty
		// literal of the subject's own type — the committed comparison is
		// `date == date`, never the `date == text` an unresolved subject left.
		expect(
			reseedValueForConstraint(term(literal("2024-01-01")), accepts),
		).toEqual(term(dateLiteral("")));
	});

	it("resolves a form answer to nothing when the surface declares none", () => {
		// The fail-closed half: no answers in scope means the reference is not
		// merely unresolved, it is inadmissible — which is why a surface must
		// declare them rather than the resolver inventing a permissive default.
		expect(resolveExpressionType(term(formField(FIELD)), BARE)).toBeUndefined();
		expect(
			checkValueExpression(term(formField(FIELD)), buildEditorTypeContext(BARE))
				.ok,
		).toBe(false);
	});
});
