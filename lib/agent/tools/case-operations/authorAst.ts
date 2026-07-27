/**
 * SA-facing Predicate / ValueExpression schemas and their identity bridge.
 *
 * The canonical AST stores immutable UUID leaves. Authors never speak those
 * identities: a form answer is addressed by its path and an earlier create by
 * its operation id. These schemas preserve every carrier-blind AST arm while
 * swapping only those two leaves. Resolution happens before the shared commit
 * gate, and projection performs the exact inverse for read tools.
 */

import { z } from "zod";
import type { Uuid } from "@/lib/domain";
import {
	carrierBlindPredicateSchema,
	carrierBlindTermSchema,
	carrierBlindValueExpressionSchema,
	literalSchema,
	type Predicate,
	type ValueExpression,
} from "@/lib/domain/predicate";

type ObjectSchema = z.ZodObject<z.ZodRawShape>;

function options(schema: z.ZodType): readonly ObjectSchema[] {
	return (schema as unknown as { readonly options: readonly ObjectSchema[] })
		.options;
}

function hasDiscriminator(schema: ObjectSchema, kind: string): boolean {
	const discriminator = schema.shape.kind as unknown as {
		readonly value?: unknown;
		readonly options?: readonly unknown[];
	};
	return (
		discriminator.value === kind ||
		discriminator.options?.includes(kind) === true
	);
}

function arm(schema: z.ZodType, kind: string): ObjectSchema {
	const found = options(schema).find((candidate) =>
		hasDiscriminator(candidate, kind),
	);
	if (found === undefined) {
		throw new Error(`AST schema arm "${kind}" not found`);
	}
	return found;
}

const authorFieldTermSchema = z
	.object({
		kind: z.literal("field"),
		path: z
			.string()
			.min(1)
			.describe(
				"Field path inside the form, such as status or household/members/name",
			),
	})
	.strict();

/**
 * Worker information addressed the way an author names it — its slug,
 * the same token `#user/<slug>` spells — rather than the immutable UUID
 * the document stores.
 *
 * This arm is not optional. The canonical term union has seven arms; a
 * missing one is not "unauthorable", it is a leaf that survives the
 * projector untouched (which leaks a storage UUID this boundary
 * promises never to return) and then fails the union parse on the way
 * back in, so a read cannot round-trip through an update.
 */
const authorSessionUserPropertySchema = z
	.object({
		kind: z.literal("session-user-property"),
		slug: z
			.string()
			.min(1)
			.describe(
				"Saved key of a worker-information property, as listed by get_users",
			),
	})
	.strict();

const authorTermSchema = z.discriminatedUnion("kind", [
	arm(carrierBlindTermSchema, "prop"),
	arm(carrierBlindTermSchema, "input"),
	arm(carrierBlindTermSchema, "session-user"),
	authorSessionUserPropertySchema,
	arm(carrierBlindTermSchema, "session-context"),
	authorFieldTermSchema,
	arm(carrierBlindTermSchema, "literal"),
]);

const authorIdOfSchema = z
	.object({
		kind: z.literal("id-of"),
		operationId: z
			.string()
			.min(1)
			.describe("Id of an earlier create operation in this form"),
	})
	.strict();

export const authorValueExpressionSchema: z.ZodType<unknown> =
	z.discriminatedUnion("kind", [
		arm(carrierBlindValueExpressionSchema, "term").safeExtend({
			term: authorTermSchema,
		}),
		arm(carrierBlindValueExpressionSchema, "today"),
		arm(carrierBlindValueExpressionSchema, "now"),
		authorIdOfSchema,
		arm(carrierBlindValueExpressionSchema, "acting-user"),
		arm(carrierBlindValueExpressionSchema, "unowned"),
		arm(carrierBlindValueExpressionSchema, "date-add").safeExtend({
			date: z.lazy(() => authorValueExpressionSchema),
			quantity: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindValueExpressionSchema, "date-coerce").safeExtend({
			value: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindValueExpressionSchema, "datetime-coerce").safeExtend({
			value: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindValueExpressionSchema, "double").safeExtend({
			value: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindValueExpressionSchema, "arith").safeExtend({
			left: z.lazy(() => authorValueExpressionSchema),
			right: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindValueExpressionSchema, "concat").safeExtend({
			parts: z.array(z.lazy(() => authorValueExpressionSchema)).min(1),
		}),
		arm(carrierBlindValueExpressionSchema, "coalesce").safeExtend({
			values: z.array(z.lazy(() => authorValueExpressionSchema)).min(1),
		}),
		arm(carrierBlindValueExpressionSchema, "if").safeExtend({
			cond: z.lazy(() => authorPredicateSchema),
			// biome-ignore lint/suspicious/noThenProperty: AST data slot, not a promise method.
			then: z.lazy(() => authorValueExpressionSchema),
			else: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindValueExpressionSchema, "switch").safeExtend({
			on: z.lazy(() => authorValueExpressionSchema),
			cases: z
				.array(
					z
						.object({
							when: literalSchema,
							// biome-ignore lint/suspicious/noThenProperty: AST data slot, not a promise method.
							then: z.lazy(() => authorValueExpressionSchema),
						})
						.strict(),
				)
				.min(1),
			fallback: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindValueExpressionSchema, "count").safeExtend({
			where: z.lazy(() => authorPredicateSchema).optional(),
		}),
		arm(carrierBlindValueExpressionSchema, "unwrap-list").safeExtend({
			value: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindValueExpressionSchema, "format-date").safeExtend({
			date: z.lazy(() => authorValueExpressionSchema),
		}),
	]);

export const authorPredicateSchema: z.ZodType<unknown> = z.discriminatedUnion(
	"kind",
	[
		arm(carrierBlindPredicateSchema, "eq").safeExtend({
			left: z.lazy(() => authorValueExpressionSchema),
			right: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindPredicateSchema, "in").safeExtend({
			left: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindPredicateSchema, "within-distance").safeExtend({
			center: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindPredicateSchema, "match").safeExtend({
			value: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindPredicateSchema, "multi-select-contains"),
		arm(carrierBlindPredicateSchema, "match-all"),
		arm(carrierBlindPredicateSchema, "match-none"),
		arm(carrierBlindPredicateSchema, "is-null").safeExtend({
			left: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindPredicateSchema, "is-blank").safeExtend({
			left: z.lazy(() => authorValueExpressionSchema),
		}),
		arm(carrierBlindPredicateSchema, "between").safeExtend({
			left: z.lazy(() => authorValueExpressionSchema),
			lower: z.lazy(() => authorValueExpressionSchema).optional(),
			upper: z.lazy(() => authorValueExpressionSchema).optional(),
		}),
		arm(carrierBlindPredicateSchema, "and").safeExtend({
			clauses: z.array(z.lazy(() => authorPredicateSchema)).min(1),
		}),
		arm(carrierBlindPredicateSchema, "or").safeExtend({
			clauses: z.array(z.lazy(() => authorPredicateSchema)).min(1),
		}),
		arm(carrierBlindPredicateSchema, "not").safeExtend({
			clause: z.lazy(() => authorPredicateSchema),
		}),
		arm(carrierBlindPredicateSchema, "when-input-present").safeExtend({
			clause: z.lazy(() => authorPredicateSchema),
		}),
		arm(carrierBlindPredicateSchema, "exists").safeExtend({
			where: z.lazy(() => authorPredicateSchema).optional(),
		}),
		arm(carrierBlindPredicateSchema, "missing").safeExtend({
			where: z.lazy(() => authorPredicateSchema).optional(),
		}),
	],
);

export interface AuthorIdentityResolver {
	readonly fieldUuid: (path: string) => Uuid;
	readonly operationUuid: (id: string) => Uuid;
	readonly userPropertyUuid: (slug: string) => Uuid;
}

export interface AuthorIdentityProjector {
	readonly fieldPath: (uuid: Uuid) => string | undefined;
	readonly operationId: (uuid: Uuid) => string | undefined;
	readonly userPropertySlug: (uuid: Uuid) => string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewriteAuthorIdentities(
	value: unknown,
	resolver: AuthorIdentityResolver,
): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => rewriteAuthorIdentities(item, resolver));
	}
	if (!isRecord(value)) return value;
	if (value.kind === "field" && typeof value.path === "string") {
		return { kind: "field", uuid: resolver.fieldUuid(value.path) };
	}
	if (value.kind === "id-of" && typeof value.operationId === "string") {
		return {
			kind: "id-of",
			opUuid: resolver.operationUuid(value.operationId),
		};
	}
	if (
		value.kind === "session-user-property" &&
		typeof value.slug === "string"
	) {
		return {
			kind: "session-user-property",
			userPropertyUuid: resolver.userPropertyUuid(value.slug),
		};
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [
			key,
			rewriteAuthorIdentities(child, resolver),
		]),
	);
}

function projectCanonicalIdentities(
	value: unknown,
	projector: AuthorIdentityProjector,
): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => projectCanonicalIdentities(item, projector));
	}
	if (!isRecord(value)) return value;
	if (value.kind === "field" && typeof value.uuid === "string") {
		return {
			kind: "field",
			path: projector.fieldPath(value.uuid as Uuid) ?? "[missing field]",
		};
	}
	if (value.kind === "id-of" && typeof value.opUuid === "string") {
		return {
			kind: "id-of",
			operationId:
				projector.operationId(value.opUuid as Uuid) ?? "[missing operation]",
		};
	}
	if (
		value.kind === "session-user-property" &&
		typeof value.userPropertyUuid === "string"
	) {
		return {
			kind: "session-user-property",
			slug:
				projector.userPropertySlug(value.userPropertyUuid as Uuid) ??
				"[missing worker information]",
		};
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [
			key,
			projectCanonicalIdentities(child, projector),
		]),
	);
}

export function resolveAuthorValueExpression(
	value: unknown,
	resolver: AuthorIdentityResolver,
): ValueExpression {
	return carrierBlindValueExpressionSchema.parse(
		rewriteAuthorIdentities(value, resolver),
	) as ValueExpression;
}

export function resolveAuthorPredicate(
	value: unknown,
	resolver: AuthorIdentityResolver,
): Predicate {
	return carrierBlindPredicateSchema.parse(
		rewriteAuthorIdentities(value, resolver),
	) as Predicate;
}

export function projectValueExpression(
	value: ValueExpression,
	projector: AuthorIdentityProjector,
): unknown {
	return projectCanonicalIdentities(value, projector);
}

export function projectPredicate(
	value: Predicate,
	projector: AuthorIdentityProjector,
): unknown {
	return projectCanonicalIdentities(value, projector);
}
