import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import { testUuid } from "@/__tests__/helpers/uuid";

import type { UserProperty } from "@/lib/domain";
import {
	actingUser,
	checkExpression,
	compatibleTypesFor,
	dateLiteral,
	formField,
	idOf,
	literal,
	sessionUserProperty,
	term,
	unowned,
} from "@/lib/domain/expression";
import {
	reseedValueForConstraint,
	resolveExpressionType,
} from "../cards/reseed";
import { editorExpressionContext } from "../editorContext";
import { isAuthorableExpressionKind } from "../expressionEditorSchemas";

const FIELD = testUuid("11111111-1111-4111-8111-111111111111");
const CREATE = testUuid("22222222-2222-4222-8222-222222222222");
const WORKER = testUuid("33333333-3333-4333-8333-333333333333");

/** The catalogs every fixture below starts from; each carrier's slot supplies
 * its own axes. */
const BARE_CATALOGS = {
	caseTypes: [],
	currentCaseType: "patient",
	knownInputs: [],
};
const BARE = expressionEditorFixture("case-filter", BARE_CATALOGS).context;

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

	it("uses the real case-filter profile to refuse submission-local values", () => {
		const ctx = editorExpressionContext(BARE);
		expect(checkExpression(actingUser(), ctx).errors.length === 0).toBe(false);
		expect(checkExpression(unowned(), ctx).errors.length === 0).toBe(false);
		expect(checkExpression(idOf(CREATE), ctx).errors.length === 0).toBe(false);
	});

	it("refuses a form answer, because no answers are in scope", () => {
		const ctx = editorExpressionContext(BARE);
		expect(ctx.form).toBeUndefined();
		expect(ctx.profile.ownerValues).toBe(false);
		expect(ctx.profile.operationIds.size).toBe(0);
		expect(
			checkExpression(term(formField(FIELD)), ctx).errors.length === 0,
		).toBe(false);
	});
});

describe("with an operation scope", () => {
	it("opens `id-of` after a create and owner values only in an owner slot", () => {
		expect(
			isAuthorableExpressionKind("id-of", { operationScope: { creates: [] } }),
		).toBe(false);
		const scope = {
			operationScope: { creates: [{ uuid: CREATE, label: "create_referral" }] },
		};
		expect(isAuthorableExpressionKind("id-of", scope)).toBe(true);
		expect(isAuthorableExpressionKind("acting-user", scope)).toBe(false);
		expect(isAuthorableExpressionKind("unowned", scope)).toBe(false);
		expect(
			isAuthorableExpressionKind("acting-user", {
				...scope,
				ownerValues: true,
			}),
		).toBe(true);
		expect(
			isAuthorableExpressionKind("unowned", {
				...scope,
				ownerValues: true,
			}),
		).toBe(true);
	});

	it("admits answers and earlier creates from the real owner slot", () => {
		const ctx = expressionEditorFixture("operation-owner", {
			...BARE_CATALOGS,
			formFields: [
				{
					uuid: FIELD,
					label: "Client name",
					id: "client_name",
					dataType: "text",
				},
			],
			operationScope: { creates: [{ uuid: CREATE, label: "create_referral" }] },
		}).context.expressionContext;
		expect(
			checkExpression(term(formField(FIELD)), ctx).errors.length === 0,
		).toBe(true);
		expect(checkExpression(actingUser(), ctx).errors.length === 0).toBe(true);
		expect(checkExpression(idOf(CREATE), ctx).errors.length === 0).toBe(true);
		// An answer the surface did not declare stays refused: the decl list
		// IS the admission list, already narrowed by repeat scope.
		expect(
			checkExpression(term(formField(testUuid("not-in-scope"))), ctx).errors
				.length === 0,
		).toBe(false);
	});
});

describe("the cascade reseed resolves against the vocabulary on screen", () => {
	const FULL = expressionEditorFixture("operation-owner", {
		...BARE_CATALOGS,
		userProperties: [WORKER_PROPERTY],
		formFields: [DATE_ANSWER],
		operationScope: { creates: [{ uuid: CREATE, label: "create_referral" }] },
	}).context;

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
		// literal of the subject's own type: the committed comparison is
		// `date == date`, never the `date == text` an unresolved subject left.
		expect(
			reseedValueForConstraint(term(literal("2024-01-01")), accepts),
		).toEqual(term(dateLiteral("")));
	});

	it("resolves a form answer to nothing when the surface declares none", () => {
		// The fail-closed half: no answers in scope means the reference is not
		// merely unresolved, it is inadmissible, which is why a surface must
		// declare them rather than the resolver inventing a permissive default.
		expect(resolveExpressionType(term(formField(FIELD)), BARE)).toBeUndefined();
		expect(
			checkExpression(term(formField(FIELD)), editorExpressionContext(BARE))
				.errors.length === 0,
		).toBe(false);
	});
});
