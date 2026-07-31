/**
 * Immutable final-schema decoder for persisted Blueprints at the
 * canonical-identity cutover.
 *
 * This module imports only timestamp-owned exact-carrier types and the
 * committed generated validator. It deliberately does not import live domain
 * schemas, doc hydration, reducers, or the runtime persistence boundary.
 */

import { createHash } from "node:crypto";
import {
	type FrozenJsonMaterialization,
	type FrozenVerifiedJson,
	materializeFrozenJson,
} from "./frozenJsonCarriers";
import {
	type FrozenLookupValidationContext,
	validateFrozenPersistableBlueprintCandidate,
} from "./frozenPersistableBlueprintValidator.generated.mjs";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CONTEXT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}:[0-9a-f]{64}$/;
const INTEGER_TEXT_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const POSTGRES_PLAIN_DECIMAL_PATTERN =
	/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const CAPTURE_APP_KEYS = [
	"id",
	"appName",
	"connectType",
	"caseTypes",
	"logo",
	"mutationSeq",
] as const;
const CAPTURE_ENTITY_KEYS = [
	"appId",
	"uuid",
	"kind",
	"parentUuid",
	"ordinal",
	"data",
] as const;
const ENTITY_KINDS = [
	"module",
	"form",
	"field",
	"user_property",
	"user_type",
	"persona",
] as const;
const FLAT_ENTITY_KINDS = new Set<FrozenStoredEntityKind>([
	"user_property",
	"user_type",
	"persona",
]);
const STRINGIFY_INTRINSIC = JSON.stringify.bind(JSON);

export type FrozenStoredEntityKind = (typeof ENTITY_KINDS)[number];

export interface FrozenPersistableBlueprintContext {
	/**
	 * Content-free carrier identifier: a stable family plus a SHA-256 digest.
	 * Raw app ids, UUIDs, names, labels, values, or prose are forbidden.
	 */
	readonly id: string;
}

export interface FrozenStoredAppCapture {
	readonly id: string;
	readonly appName: string;
	readonly connectType: string | null;
	readonly caseTypes: FrozenVerifiedJson;
	readonly logo: string | null;
	readonly mutationSeq: string | number;
}

export interface FrozenStoredEntityCapture {
	readonly appId: string;
	readonly uuid: string;
	readonly kind: FrozenStoredEntityKind;
	readonly parentUuid: string | null;
	readonly ordinal: number;
	readonly data: FrozenVerifiedJson;
}

export type FrozenPersistableEntity = Readonly<
	Record<string, unknown> & { readonly uuid: string }
>;

/**
 * Frozen structural type sufficient for migration persistence. The generated
 * validator owns the complete per-arm shape; this hand-written type does not
 * try to become a second domain model.
 */
export interface FrozenPersistableBlueprint
	extends Readonly<Record<string, unknown>> {
	readonly appId: string;
	readonly appName: string;
	readonly connectType: "learn" | "deliver" | null;
	readonly caseTypes: readonly unknown[] | null;
	readonly modules: Readonly<Record<string, FrozenPersistableEntity>>;
	readonly forms: Readonly<Record<string, FrozenPersistableEntity>>;
	readonly fields: Readonly<Record<string, FrozenPersistableEntity>>;
	readonly moduleOrder: readonly string[];
	readonly formOrder: Readonly<Record<string, readonly string[]>>;
	readonly fieldOrder: Readonly<Record<string, readonly string[]>>;
}

export interface FrozenStoredBlueprintExact {
	readonly app: FrozenStoredAppCapture;
	readonly entities: readonly FrozenStoredEntityCapture[];
}

export interface FrozenDecodedBlueprint<
	TExact = FrozenVerifiedJson | FrozenStoredBlueprintExact,
> {
	readonly exact: TExact;
	readonly runtime: FrozenPersistableBlueprint;
	/**
	 * Direct verified carriers retain PostgreSQL's exact canonical jsonb text.
	 * A row-assembled document uses this module's deterministic key-sorted JSON
	 * solely as content-address evidence; it is never the fold-baseline digest.
	 */
	readonly canonicalText: string;
	readonly digest: string;
}

export type FrozenPersistableBlueprintFailureFacet =
	| "app"
	| "case_types"
	| "modules"
	| "forms"
	| "fields"
	| "user_properties"
	| "user_types"
	| "personas"
	| "unknown";

export class FrozenPersistableBlueprintDecodeError extends Error {
	readonly name = "FrozenPersistableBlueprintDecodeError";

	constructor(
		readonly contextId: string,
		readonly stage:
			| "context"
			| "capture"
			| "schema"
			| "canonicality"
			| "gate"
			| "internal",
		readonly facet: FrozenPersistableBlueprintFailureFacet = "unknown",
		readonly evidenceDigest: string = sha256Text(
			`${contextId}:${stage}:${facet}`,
		),
	) {
		super(
			`Frozen persisted Blueprint ${contextId} failed ${stage} validation (${facet}:${evidenceDigest}).`,
		);
	}
}

function sha256Text(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Source(value: string | null): string {
	return createHash("sha256")
		.update(value === null ? Buffer.from([0]) : Buffer.from(value))
		.digest("hex");
}

function contentFreeStoredAppContext(
	appId: string,
): FrozenPersistableBlueprintContext {
	return { id: `stored_app:${sha256Text(appId)}` };
}

function assertContext(
	context: FrozenPersistableBlueprintContext,
): FrozenPersistableBlueprintContext {
	if (
		context === null ||
		typeof context !== "object" ||
		!CONTEXT_ID_PATTERN.test(context.id)
	) {
		throw new FrozenPersistableBlueprintDecodeError(
			"context:invalid",
			"context",
		);
	}
	return context;
}

function fail(
	context: FrozenPersistableBlueprintContext,
	stage: FrozenPersistableBlueprintDecodeError["stage"],
	facet?: FrozenPersistableBlueprintFailureFacet,
	evidenceDigest?: string,
): never {
	throw new FrozenPersistableBlueprintDecodeError(
		context.id,
		stage,
		facet,
		evidenceDigest,
	);
}

function assertExactDataObjectKeys(
	value: object,
	expected: readonly string[],
	context: FrozenPersistableBlueprintContext,
): void {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		fail(context, "capture");
	}
	if (Object.getOwnPropertySymbols(value).length !== 0) {
		fail(context, "capture");
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const actual = Object.keys(descriptors).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		fail(context, "capture");
	}
	for (const descriptor of Object.values(descriptors)) {
		if (
			descriptor.get !== undefined ||
			descriptor.set !== undefined ||
			descriptor.enumerable !== true
		) {
			fail(context, "capture");
		}
	}
}

function exactJsonValue(
	exact: FrozenVerifiedJson,
	context: FrozenPersistableBlueprintContext,
	allowSqlNull = false,
): unknown {
	if (
		exact === null ||
		typeof exact !== "object" ||
		!DIGEST_PATTERN.test(exact.sourceDigest) ||
		sha256Source(exact.sourceText) !== exact.sourceDigest ||
		(exact.sourceText === null && !allowSqlNull)
	) {
		fail(context, "capture");
	}
	const materialized = materializeFrozenBlueprintJson(exact, context);
	if (materialized.kind === "sql-null") {
		if (!allowSqlNull) fail(context, "capture");
		return null;
	}
	return materialized.value;
}

function normalizedDecimal(value: string): string {
	const match = value.match(
		/^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/,
	);
	if (match === null) throw new Error("invalid decimal");
	const negative = match[1] === "-";
	const integer = match[2] ?? "0";
	const fraction = match[3] ?? "";
	let coefficient = BigInt(`${negative ? "-" : ""}${integer}${fraction}`);
	let exponent = Number(match[4] ?? "0") - fraction.length;
	if (coefficient === BigInt(0)) return "0e0";
	while (coefficient % BigInt(10) === BigInt(0)) {
		coefficient /= BigInt(10);
		exponent += 1;
	}
	return `${coefficient}e${exponent}`;
}

function materializeFrozenBlueprintNumber(raw: string): number {
	if (!POSTGRES_PLAIN_DECIMAL_PATTERN.test(raw) || raw === "-0") {
		throw new Error("noncanonical frozen Blueprint number");
	}
	const value = Number(raw);
	if (!raw.includes(".") && !Number.isSafeInteger(value)) {
		throw new Error("noncanonical frozen Blueprint number");
	}
	if (
		!Number.isFinite(value) ||
		Object.is(value, -0) ||
		(value === 0 && normalizedDecimal(raw) !== "0e0")
	) {
		throw new Error("noncanonical frozen Blueprint number");
	}
	const projected = JSON.stringify(value);
	if (
		typeof projected !== "string" ||
		normalizedDecimal(raw) !== normalizedDecimal(projected)
	) {
		throw new Error("noncanonical frozen Blueprint number");
	}
	return value;
}

/**
 * Timestamp-owned exact numeric boundary shared by the final-schema decoder
 * and the first-run legacy transform. It intentionally performs no Blueprint
 * shape validation.
 */
export function materializeFrozenBlueprintJson<T>(
	exact: FrozenVerifiedJson,
	contextInput: FrozenPersistableBlueprintContext,
): FrozenJsonMaterialization<T> {
	const context = assertContext(contextInput);
	if (
		exact === null ||
		typeof exact !== "object" ||
		!DIGEST_PATTERN.test(exact.sourceDigest) ||
		sha256Source(exact.sourceText) !== exact.sourceDigest
	) {
		fail(context, "capture");
	}
	let numericFailure = false;
	try {
		return materializeFrozenJson<T>(exact, ({ raw }) => {
			try {
				return materializeFrozenBlueprintNumber(raw);
			} catch {
				numericFailure = true;
				throw new Error("frozen Blueprint number rejected");
			}
		});
	} catch {
		fail(context, numericFailure ? "canonicality" : "capture");
	}
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	return Object.freeze(value);
}

function encodedString(value: string): string {
	const encoded = STRINGIFY_INTRINSIC(value);
	if (typeof encoded !== "string") {
		throw new Error("String JSON encoding failed.");
	}
	return encoded;
}

/**
 * Deterministic JSON for composite content-address evidence. It never invokes
 * a container's `toJSON`; only primitive strings reach the captured intrinsic.
 */
function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "string":
			return encodedString(value);
		case "number":
			if (!Number.isFinite(value) || Object.is(value, -0)) {
				throw new Error("Noncanonical JSON number.");
			}
			return String(value);
		case "object": {
			if (seen.has(value)) throw new Error("Cyclic JSON value.");
			seen.add(value);
			if (Array.isArray(value)) {
				const result = `[${value
					.map((entry) => canonicalJson(entry, seen))
					.join(",")}]`;
				seen.delete(value);
				return result;
			}
			const result = `{${Object.keys(value)
				.sort()
				.map(
					(key) =>
						`${encodedString(key)}:${canonicalJson(
							(value as Readonly<Record<string, unknown>>)[key],
							seen,
						)}`,
				)
				.join(",")}}`;
			seen.delete(value);
			return result;
		}
		default:
			throw new Error("Non-JSON value.");
	}
}

function validatedRuntime(
	value: unknown,
	context: FrozenPersistableBlueprintContext,
	lookupContext: FrozenLookupValidationContext,
): FrozenPersistableBlueprint {
	const result = validateFrozenPersistableBlueprintCandidate(
		value,
		lookupContext,
	);
	if (!result.ok) {
		fail(
			context,
			result.stage === "schema" ||
				result.stage === "canonicality" ||
				result.stage === "gate"
				? result.stage
				: "internal",
			result.facet,
			DIGEST_PATTERN.test(result.evidenceDigest)
				? result.evidenceDigest
				: undefined,
		);
	}
	return deepFreeze(result.value) as FrozenPersistableBlueprint;
}

export function decodeFrozenPersistableBlueprint(
	exact: FrozenVerifiedJson,
	contextInput: FrozenPersistableBlueprintContext,
	lookupContext: FrozenLookupValidationContext,
): FrozenDecodedBlueprint<FrozenVerifiedJson> {
	const context = assertContext(contextInput);
	try {
		const value = exactJsonValue(exact, context);
		const runtime = validatedRuntime(value, context, lookupContext);
		return Object.freeze({
			exact,
			runtime,
			canonicalText: exact.sourceText as string,
			digest: exact.sourceDigest,
		});
	} catch (error) {
		if (error instanceof FrozenPersistableBlueprintDecodeError) throw error;
		fail(context, "internal");
	}
}

function newRecord<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
}

function captureDataObject(
	capture: FrozenStoredEntityCapture,
	context: FrozenPersistableBlueprintContext,
): Readonly<Record<string, unknown>> {
	const value = exactJsonValue(capture.data, context);
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(context, "capture");
	}
	return value as Readonly<Record<string, unknown>>;
}

function validateMutationSequence(
	value: string | number,
	context: FrozenPersistableBlueprintContext,
): void {
	if (typeof value === "string") {
		if (!INTEGER_TEXT_PATTERN.test(value)) fail(context, "capture");
		return;
	}
	if (!Number.isSafeInteger(value) || value < 0) fail(context, "capture");
}

function groupKey(capture: FrozenStoredEntityCapture): string {
	switch (capture.kind) {
		case "module":
			return "module";
		case "form":
		case "field":
			return `${capture.kind}:${capture.parentUuid ?? ""}`;
		case "user_property":
		case "user_type":
		case "persona":
			return capture.kind;
	}
}

function validateContiguousOrdinals(
	captures: readonly FrozenStoredEntityCapture[],
	context: FrozenPersistableBlueprintContext,
): void {
	const groups = new Map<string, FrozenStoredEntityCapture[]>();
	for (const capture of captures) {
		const key = groupKey(capture);
		const members = groups.get(key) ?? [];
		members.push(capture);
		groups.set(key, members);
	}
	for (const members of groups.values()) {
		members.sort((left, right) => left.ordinal - right.ordinal);
		for (let index = 0; index < members.length; index += 1) {
			if (members[index]?.ordinal !== index) fail(context, "capture");
		}
	}
}

export function decodeFrozenStoredApp(
	appCapture: FrozenStoredAppCapture,
	entityCaptures: readonly FrozenStoredEntityCapture[],
	lookupContext: FrozenLookupValidationContext,
): FrozenDecodedBlueprint<FrozenStoredBlueprintExact> {
	const rawId =
		appCapture !== null &&
		typeof appCapture === "object" &&
		typeof appCapture.id === "string"
			? appCapture.id
			: "";
	const context = assertContext(contentFreeStoredAppContext(rawId));
	try {
		assertExactDataObjectKeys(appCapture, CAPTURE_APP_KEYS, context);
		if (
			appCapture.id.length === 0 ||
			typeof appCapture.appName !== "string" ||
			(appCapture.connectType !== null &&
				appCapture.connectType !== "learn" &&
				appCapture.connectType !== "deliver") ||
			(appCapture.logo !== null && !UUID_PATTERN.test(appCapture.logo))
		) {
			fail(context, "capture");
		}
		validateMutationSequence(appCapture.mutationSeq, context);
		const caseTypes = exactJsonValue(appCapture.caseTypes, context, true);

		if (!Array.isArray(entityCaptures)) fail(context, "capture");
		const captures = [...entityCaptures];
		const byUuid = new Map<string, FrozenStoredEntityCapture>();
		const dataByUuid = new Map<string, Readonly<Record<string, unknown>>>();
		for (const capture of captures) {
			if (capture === null || typeof capture !== "object") {
				fail(context, "capture");
			}
			assertExactDataObjectKeys(capture, CAPTURE_ENTITY_KEYS, context);
			if (
				capture.appId !== appCapture.id ||
				!UUID_PATTERN.test(capture.uuid) ||
				!ENTITY_KINDS.includes(capture.kind) ||
				(capture.parentUuid !== null &&
					!UUID_PATTERN.test(capture.parentUuid)) ||
				!Number.isSafeInteger(capture.ordinal) ||
				capture.ordinal < 0 ||
				byUuid.has(capture.uuid)
			) {
				fail(context, "capture");
			}
			const data = captureDataObject(capture, context);
			if (data.uuid !== capture.uuid) fail(context, "capture");
			byUuid.set(capture.uuid, capture);
			dataByUuid.set(capture.uuid, data);
		}

		for (const capture of captures) {
			const parent =
				capture.parentUuid === null
					? undefined
					: byUuid.get(capture.parentUuid);
			if (capture.kind === "module" || FLAT_ENTITY_KINDS.has(capture.kind)) {
				if (capture.parentUuid !== null) fail(context, "capture");
			} else if (capture.kind === "form") {
				if (parent?.kind !== "module") fail(context, "capture");
			} else {
				const parentData =
					parent === undefined ? undefined : dataByUuid.get(parent.uuid);
				const parentIsContainer =
					parent?.kind === "field" &&
					(parentData?.kind === "group" || parentData?.kind === "repeat");
				if (parent?.kind !== "form" && !parentIsContainer) {
					fail(context, "capture");
				}
			}
		}
		validateContiguousOrdinals(captures, context);

		const modules = newRecord<FrozenPersistableEntity>();
		const forms = newRecord<FrozenPersistableEntity>();
		const fields = newRecord<FrozenPersistableEntity>();
		const flatRecords = {
			user_property: newRecord<FrozenPersistableEntity>(),
			user_type: newRecord<FrozenPersistableEntity>(),
			persona: newRecord<FrozenPersistableEntity>(),
		};
		const moduleRows = captures
			.filter((capture) => capture.kind === "module")
			.sort((left, right) => left.ordinal - right.ordinal);
		for (const capture of captures) {
			const data = dataByUuid.get(capture.uuid) as FrozenPersistableEntity;
			switch (capture.kind) {
				case "module":
					modules[capture.uuid] = data;
					break;
				case "form":
					forms[capture.uuid] = data;
					break;
				case "field":
					fields[capture.uuid] = data;
					break;
				case "user_property":
					flatRecords.user_property[capture.uuid] = data;
					break;
				case "user_type":
					flatRecords.user_type[capture.uuid] = data;
					break;
				case "persona":
					flatRecords.persona[capture.uuid] = data;
					break;
			}
		}

		const formOrder = newRecord<readonly string[]>();
		for (const module of moduleRows) {
			formOrder[module.uuid] = captures
				.filter(
					(capture) =>
						capture.kind === "form" && capture.parentUuid === module.uuid,
				)
				.sort((left, right) => left.ordinal - right.ordinal)
				.map((capture) => capture.uuid);
		}
		const fieldOrder = newRecord<readonly string[]>();
		for (const capture of captures) {
			const data = dataByUuid.get(capture.uuid);
			if (
				capture.kind !== "form" &&
				!(
					capture.kind === "field" &&
					(data?.kind === "group" || data?.kind === "repeat")
				)
			) {
				continue;
			}
			fieldOrder[capture.uuid] = captures
				.filter(
					(child) =>
						child.kind === "field" && child.parentUuid === capture.uuid,
				)
				.sort((left, right) => left.ordinal - right.ordinal)
				.map((child) => child.uuid);
		}

		const flatProjection: Record<string, unknown> = {};
		const flatSlots = [
			["user_property", "userProperties", "userPropertyOrder"],
			["user_type", "userTypes", "userTypeOrder"],
			["persona", "personas", "personaOrder"],
		] as const;
		for (const [kind, recordSlot, orderSlot] of flatSlots) {
			const rows = captures
				.filter((capture) => capture.kind === kind)
				.sort((left, right) => left.ordinal - right.ordinal);
			if (rows.length === 0) continue;
			switch (kind) {
				case "user_property":
					flatProjection[recordSlot] = flatRecords.user_property;
					break;
				case "user_type":
					flatProjection[recordSlot] = flatRecords.user_type;
					break;
				case "persona":
					flatProjection[recordSlot] = flatRecords.persona;
					break;
			}
			flatProjection[orderSlot] = rows.map((row) => row.uuid);
		}

		const assembled = {
			appId: appCapture.id,
			appName: appCapture.appName,
			connectType: appCapture.connectType,
			caseTypes,
			modules,
			forms,
			fields,
			moduleOrder: moduleRows.map((row) => row.uuid),
			formOrder,
			fieldOrder,
			...(appCapture.logo === null ? {} : { logo: appCapture.logo }),
			...flatProjection,
		};
		const runtime = validatedRuntime(assembled, context, lookupContext);
		const canonicalText = canonicalJson(runtime);
		const exact = deepFreeze({
			app: appCapture,
			entities: Object.freeze(captures),
		});
		return Object.freeze({
			exact,
			runtime,
			canonicalText,
			digest: sha256Text(canonicalText),
		});
	} catch (error) {
		if (error instanceof FrozenPersistableBlueprintDecodeError) throw error;
		fail(context, "internal");
	}
}
