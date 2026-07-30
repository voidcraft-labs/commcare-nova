import { z } from "zod";
import { isPersistableJsonNumber } from "@/lib/domain";
import { type Mutation, mutationSchema } from "./types";

const intrinsicJsonStringify = JSON.stringify;
const intrinsicJsonParse = JSON.parse;

const admittedMutationBatchBrand: unique symbol = Symbol(
	"AdmittedMutationBatch",
);
const admittedMutationStagesBrand: unique symbol = Symbol(
	"AdmittedMutationStages",
);
const hookInertJsonBrand: unique symbol = Symbol("HookInertJson");
const admittedMutationBatches = new WeakSet<object>();

export type MutationWireCanonicalityReason =
	| "non-json-value"
	| "sparse-array"
	| "schema-default"
	| "schema-strip"
	| "schema-coercion"
	| "schema-parse";

const MUTATION_WIRE_CANONICALITY_REASONS: ReadonlySet<string> = new Set([
	"non-json-value",
	"sparse-array",
	"schema-default",
	"schema-strip",
	"schema-coercion",
	"schema-parse",
]);

export function isMutationWireCanonicalityReason(
	value: unknown,
): value is MutationWireCanonicalityReason {
	return (
		typeof value === "string" && MUTATION_WIRE_CANONICALITY_REASONS.has(value)
	);
}

export interface MutationWireCanonicalityDetails {
	readonly mutationIndex: number | null;
	readonly pointer: string;
	readonly reason: MutationWireCanonicalityReason;
}

export class MutationWireCanonicalityError extends Error {
	readonly code = "MUTATION_WIRE_CANONICALITY_INVALID" as const;
	readonly details: MutationWireCanonicalityDetails;

	constructor(details: MutationWireCanonicalityDetails) {
		super(
			"This edit could not be saved because its mutation data was not canonical.",
		);
		this.name = "MutationWireCanonicalityError";
		this.details = details;
	}
}

export type AdmittedMutationBatch = readonly Mutation[] & {
	readonly [admittedMutationBatchBrand]: true;
};

export interface AdmittedMutationStageSlice {
	readonly stage: string;
	readonly start: number;
	readonly end: number;
}

export interface AdmittedMutationStages {
	readonly batch: AdmittedMutationBatch;
	readonly slices: readonly AdmittedMutationStageSlice[];
	readonly [admittedMutationStagesBrand]: true;
}

type JsonPrimitive = null | boolean | string | number;
type HookInertJsonValue =
	| JsonPrimitive
	| HookInertJsonValue[]
	| { [key: string]: HookInertJsonValue };

export type ProtectedMutationEnvelope = HookInertJsonValue & {
	readonly [hookInertJsonBrand]: true;
};

interface PathSegment {
	readonly value: string | number;
}

class JsonTreeAdmissionError extends Error {
	readonly path: readonly PathSegment[];
	readonly reason: MutationWireCanonicalityReason;

	constructor(
		path: readonly PathSegment[],
		reason: MutationWireCanonicalityReason,
	) {
		super(reason);
		this.path = path;
		this.reason = reason;
	}
}

function pointerSegment(value: string | number): string {
	return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointerFor(path: readonly PathSegment[]): string {
	return path.length === 0
		? ""
		: `/${path.map((segment) => pointerSegment(segment.value)).join("/")}`;
}

function detailsFor(
	path: readonly PathSegment[],
	reason: MutationWireCanonicalityReason,
): MutationWireCanonicalityDetails {
	const first = path[0]?.value;
	return {
		mutationIndex:
			typeof first === "number" && Number.isSafeInteger(first) ? first : null,
		pointer: pointerFor(path),
		reason,
	};
}

function failJsonTree(
	path: readonly PathSegment[],
	reason: MutationWireCanonicalityReason,
): never {
	throw new JsonTreeAdmissionError(path, reason);
}

function ownKeys(value: object, path: readonly PathSegment[]): PropertyKey[] {
	try {
		return Reflect.ownKeys(value);
	} catch {
		return failJsonTree(path, "non-json-value");
	}
}

function ownDescriptor(
	value: object,
	key: PropertyKey,
	path: readonly PathSegment[],
): PropertyDescriptor {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(value, key);
	} catch {
		return failJsonTree(path, "non-json-value");
	}
	if (descriptor === undefined) {
		return failJsonTree(path, "non-json-value");
	}
	return descriptor;
}

function prototypeOf(
	value: object,
	path: readonly PathSegment[],
): object | null {
	try {
		return Object.getPrototypeOf(value);
	} catch {
		return failJsonTree(path, "non-json-value");
	}
}

function isArrayValue(
	value: object,
	path: readonly PathSegment[],
): value is unknown[] {
	try {
		return Array.isArray(value);
	} catch {
		return failJsonTree(path, "non-json-value");
	}
}

function defineToJsonProtector(value: object): void {
	if (Object.hasOwn(value, "toJSON")) return;
	Object.defineProperty(value, "toJSON", {
		configurable: false,
		enumerable: false,
		value: undefined,
		writable: false,
	});
}

function isInternalToJsonProtector(
	value: object,
	key: PropertyKey,
	path: readonly PathSegment[],
): boolean {
	if (key !== "toJSON") return false;
	const descriptor = ownDescriptor(value, key, path);
	return (
		"value" in descriptor &&
		descriptor.value === undefined &&
		descriptor.enumerable === false &&
		descriptor.get === undefined &&
		descriptor.set === undefined
	);
}

function isArrayIndexKey(key: string, length: number): boolean {
	if (key === "") return false;
	const number = Number(key);
	return (
		Number.isSafeInteger(number) &&
		number >= 0 &&
		number < length &&
		String(number) === key
	);
}

function detachArray(
	input: unknown[],
	path: readonly PathSegment[],
	active: Set<object>,
	allowInternalProtectors: boolean,
	stageMutationArrays: Set<object> | undefined,
): HookInertJsonValue[] {
	const proto = prototypeOf(input, path);
	if (proto !== Array.prototype && proto !== null) {
		return failJsonTree(path, "non-json-value");
	}
	const lengthDescriptor = ownDescriptor(input, "length", path);
	if (
		!("value" in lengthDescriptor) ||
		typeof lengthDescriptor.value !== "number" ||
		!Number.isSafeInteger(lengthDescriptor.value) ||
		lengthDescriptor.value < 0
	) {
		return failJsonTree(path, "non-json-value");
	}
	const length = lengthDescriptor.value;
	const keys = ownKeys(input, path);
	let protectorCount = 0;
	for (const key of keys) {
		if (typeof key !== "string") {
			return failJsonTree(path, "non-json-value");
		}
		if (
			allowInternalProtectors &&
			isInternalToJsonProtector(input, key, path)
		) {
			protectorCount += 1;
			continue;
		}
		if (key !== "length" && !isArrayIndexKey(key, length)) {
			return failJsonTree(path, "non-json-value");
		}
	}
	if (keys.length !== length + 1 + protectorCount) {
		return failJsonTree(path, "sparse-array");
	}

	const output: HookInertJsonValue[] = new Array(length);
	for (let index = 0; index < length; index += 1) {
		const segment = [...path, { value: index }];
		const descriptor = ownDescriptor(input, String(index), segment);
		if (
			!("value" in descriptor) ||
			descriptor.get !== undefined ||
			descriptor.set !== undefined ||
			descriptor.enumerable !== true
		) {
			return failJsonTree(segment, "non-json-value");
		}
		output[index] = detachJsonValue(
			descriptor.value,
			segment,
			active,
			allowInternalProtectors,
			stageMutationArrays,
		);
	}
	defineToJsonProtector(output);
	return output;
}

function detachObject(
	input: object,
	path: readonly PathSegment[],
	active: Set<object>,
	allowInternalProtectors: boolean,
	stageMutationArrays: Set<object> | undefined,
): { [key: string]: HookInertJsonValue } {
	const proto = prototypeOf(input, path);
	if (proto !== Object.prototype && proto !== null) {
		return failJsonTree(path, "non-json-value");
	}
	const keys = ownKeys(input, path);
	if (keys.some((key) => typeof key === "symbol")) {
		return failJsonTree(path, "non-json-value");
	}
	const stringKeys = (keys as string[]).toSorted((a, b) => a.localeCompare(b));
	const output = Object.create(null) as {
		[key: string]: HookInertJsonValue;
	};
	for (const key of stringKeys) {
		const segment = [...path, { value: key }];
		if (
			allowInternalProtectors &&
			isInternalToJsonProtector(input, key, segment)
		) {
			continue;
		}
		const descriptor = ownDescriptor(input, key, segment);
		if (
			!("value" in descriptor) ||
			descriptor.get !== undefined ||
			descriptor.set !== undefined ||
			descriptor.enumerable !== true
		) {
			return failJsonTree(segment, "non-json-value");
		}
		output[key] = detachJsonValue(
			descriptor.value,
			segment,
			active,
			allowInternalProtectors,
			stageMutationArrays,
		);
	}
	defineToJsonProtector(output);
	return output;
}

function detachJsonValue(
	input: unknown,
	path: readonly PathSegment[],
	active: Set<object>,
	allowInternalProtectors: boolean,
	stageMutationArrays: Set<object> | undefined,
): HookInertJsonValue {
	if (
		input === null ||
		typeof input === "boolean" ||
		typeof input === "string"
	) {
		return input;
	}
	if (typeof input === "number") {
		if (!isPersistableJsonNumber(input)) {
			return failJsonTree(path, "non-json-value");
		}
		return input;
	}
	if (typeof input !== "object") {
		return failJsonTree(path, "non-json-value");
	}
	if (
		stageMutationArrays !== undefined &&
		path.length === 2 &&
		typeof path[0]?.value === "number" &&
		path[1]?.value === "mutations" &&
		isArrayValue(input, path)
	) {
		if (stageMutationArrays.has(input)) {
			return failJsonTree(path, "non-json-value");
		}
		stageMutationArrays.add(input);
	}
	if (active.has(input)) {
		return failJsonTree(path, "non-json-value");
	}
	active.add(input);
	try {
		return isArrayValue(input, path)
			? detachArray(
					input,
					path,
					active,
					allowInternalProtectors,
					stageMutationArrays,
				)
			: detachObject(
					input,
					path,
					active,
					allowInternalProtectors,
					stageMutationArrays,
				);
	} finally {
		active.delete(input);
	}
}

function detachJsonTree(
	input: unknown,
	allowInternalProtectors = false,
	rejectSharedStageMutationArrays = false,
): HookInertJsonValue {
	return detachJsonValue(
		input,
		[],
		new Set(),
		allowInternalProtectors,
		rejectSharedStageMutationArrays ? new Set() : undefined,
	);
}

function freezeJsonTree(value: HookInertJsonValue): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return;
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			freezeJsonTree(value[index] as HookInertJsonValue);
		}
	} else {
		for (const key of Object.keys(value)) {
			freezeJsonTree(value[key] as HookInertJsonValue);
		}
	}
	Object.freeze(value);
}

interface JsonDifference {
	readonly path: readonly PathSegment[];
	readonly reason: "schema-default" | "schema-strip" | "schema-coercion";
}

function firstJsonDifference(
	input: unknown,
	output: unknown,
	path: readonly PathSegment[] = [],
): JsonDifference | undefined {
	if (
		input === null ||
		output === null ||
		typeof input !== "object" ||
		typeof output !== "object"
	) {
		return Object.is(input, output)
			? undefined
			: { path, reason: "schema-coercion" };
	}
	const inputIsArray = Array.isArray(input);
	const outputIsArray = Array.isArray(output);
	if (inputIsArray !== outputIsArray) {
		return { path, reason: "schema-coercion" };
	}
	if (inputIsArray && outputIsArray) {
		if (input.length !== output.length) {
			return { path, reason: "schema-coercion" };
		}
		for (let index = 0; index < input.length; index += 1) {
			const difference = firstJsonDifference(input[index], output[index], [
				...path,
				{ value: index },
			]);
			if (difference !== undefined) return difference;
		}
		return undefined;
	}

	const inputRecord = input as Record<string, unknown>;
	const outputRecord = output as Record<string, unknown>;
	const inputKeys = Object.keys(inputRecord).toSorted((a, b) =>
		a.localeCompare(b),
	);
	const outputKeys = Object.keys(outputRecord).toSorted((a, b) =>
		a.localeCompare(b),
	);
	for (const key of inputKeys) {
		if (!Object.hasOwn(outputRecord, key)) {
			// Report the known parent rather than echoing an arbitrary stripped key.
			return { path, reason: "schema-strip" };
		}
	}
	for (const key of outputKeys) {
		if (!Object.hasOwn(inputRecord, key)) {
			return {
				path: [...path, { value: key }],
				reason: "schema-default",
			};
		}
	}
	for (const key of inputKeys) {
		const difference = firstJsonDifference(
			inputRecord[key],
			outputRecord[key],
			[...path, { value: key }],
		);
		if (difference !== undefined) return difference;
	}
	return undefined;
}

function issuePath(issue: z.core.$ZodIssue): readonly PathSegment[] {
	return issue.path.map((value) => ({
		value: typeof value === "number" ? value : String(value),
	}));
}

function comparePaths(
	left: readonly PathSegment[],
	right: readonly PathSegment[],
): number {
	const sharedLength = Math.min(left.length, right.length);
	for (let index = 0; index < sharedLength; index += 1) {
		const leftValue = left[index]?.value;
		const rightValue = right[index]?.value;
		if (leftValue === rightValue) continue;
		if (typeof leftValue === "number" && typeof rightValue === "number") {
			return leftValue - rightValue;
		}
		if (typeof leftValue === "number") return -1;
		if (typeof rightValue === "number") return 1;
		return String(leftValue).localeCompare(String(rightValue));
	}
	return left.length - right.length;
}

function schemaParseDetails(
	error: z.ZodError,
): MutationWireCanonicalityDetails {
	const issues = error.issues
		.map((issue) => ({ issue, path: issuePath(issue) }))
		.toSorted((a, b) => comparePaths(a.path, b.path));
	const first = issues[0];
	return detailsFor(
		first?.path ?? [],
		first?.issue.code === "unrecognized_keys" ? "schema-strip" : "schema-parse",
	);
}

const mutationBatchSchema = z
	.array(mutationSchema)
	.superRefine((mutations, ctx) => {
		const renameIndex = mutations.findIndex(
			(mutation) => mutation.kind === "renameCaseProperties",
		);
		if (renameIndex === -1 || mutations.length === 1) return;
		ctx.addIssue({
			code: "custom",
			path: [renameIndex],
			message:
				"A case-property rename is the complete app-wide edit and must be the only mutation in its batch.",
		});
	});

function admitMutationBatchInternal(
	value: unknown,
	allowInternalProtectors: boolean,
): AdmittedMutationBatch {
	let detached: HookInertJsonValue;
	try {
		detached = detachJsonTree(value, allowInternalProtectors);
	} catch (error) {
		if (error instanceof JsonTreeAdmissionError) {
			throw new MutationWireCanonicalityError(
				detailsFor(error.path, error.reason),
			);
		}
		throw error;
	}

	let reparsed: unknown;
	try {
		const json = intrinsicJsonStringify(detached);
		reparsed = intrinsicJsonParse(json);
	} catch {
		throw new MutationWireCanonicalityError(detailsFor([], "non-json-value"));
	}

	let protectedReparsed: HookInertJsonValue;
	try {
		protectedReparsed = detachJsonTree(reparsed);
	} catch (error) {
		if (error instanceof JsonTreeAdmissionError) {
			throw new MutationWireCanonicalityError(
				detailsFor(error.path, error.reason),
			);
		}
		throw error;
	}

	const parsed = mutationBatchSchema.safeParse(protectedReparsed);
	if (!parsed.success) {
		throw new MutationWireCanonicalityError(schemaParseDetails(parsed.error));
	}
	const difference = firstJsonDifference(protectedReparsed, parsed.data);
	if (difference !== undefined) {
		throw new MutationWireCanonicalityError(
			detailsFor(difference.path, difference.reason),
		);
	}
	freezeJsonTree(protectedReparsed);
	admittedMutationBatches.add(protectedReparsed as object);
	return protectedReparsed as unknown as AdmittedMutationBatch;
}

export function admitMutationBatch(value: unknown): AdmittedMutationBatch {
	if (
		typeof value === "object" &&
		value !== null &&
		admittedMutationBatches.has(value)
	) {
		return value as AdmittedMutationBatch;
	}
	return admitMutationBatchInternal(value, false);
}

export function isAdmittedMutationBatch(
	value: unknown,
): value is AdmittedMutationBatch {
	return (
		typeof value === "object" &&
		value !== null &&
		admittedMutationBatches.has(value)
	);
}

function admittedStageEntries(value: unknown): Array<{
	readonly stage: string;
	readonly mutations: AdmittedMutationBatch;
}> {
	let root: HookInertJsonValue;
	try {
		root = detachJsonTree(value, false, true);
	} catch (error) {
		if (error instanceof JsonTreeAdmissionError) {
			throw new MutationWireCanonicalityError({
				mutationIndex: null,
				pointer: pointerFor(error.path),
				reason: error.reason,
			});
		}
		throw error;
	}
	if (!Array.isArray(root)) {
		throw new MutationWireCanonicalityError(detailsFor([], "schema-parse"));
	}
	const entries: Array<{
		readonly stage: string;
		readonly mutations: AdmittedMutationBatch;
	}> = [];
	let mutationOffset = 0;
	for (let index = 0; index < root.length; index += 1) {
		const entry = root[index];
		if (
			typeof entry !== "object" ||
			entry === null ||
			Array.isArray(entry) ||
			typeof entry.stage !== "string" ||
			!("mutations" in entry)
		) {
			throw new MutationWireCanonicalityError({
				mutationIndex: null,
				pointer: pointerFor([{ value: index }]),
				reason: "schema-parse",
			});
		}
		const keys = Object.keys(entry).toSorted((a, b) => a.localeCompare(b));
		if (keys.length !== 2 || keys[0] !== "mutations" || keys[1] !== "stage") {
			throw new MutationWireCanonicalityError({
				mutationIndex: null,
				pointer: pointerFor([{ value: index }]),
				reason: "schema-strip",
			});
		}
		let mutations: AdmittedMutationBatch;
		try {
			mutations = admitMutationBatchInternal(entry.mutations, true);
		} catch (error) {
			if (
				error instanceof MutationWireCanonicalityError &&
				error.details.mutationIndex !== null
			) {
				const localIndex = error.details.mutationIndex;
				const globalIndex = mutationOffset + localIndex;
				const localPrefix = `/${localIndex}`;
				const pointer =
					error.details.pointer === localPrefix
						? `/${globalIndex}`
						: error.details.pointer.startsWith(`${localPrefix}/`)
							? `/${globalIndex}${error.details.pointer.slice(localPrefix.length)}`
							: error.details.pointer;
				throw new MutationWireCanonicalityError({
					mutationIndex: globalIndex,
					pointer,
					reason: error.details.reason,
				});
			}
			throw error;
		}
		entries.push({
			stage: entry.stage,
			mutations,
		});
		mutationOffset += mutations.length;
	}
	return entries;
}

export function admitMutationStages(value: unknown): AdmittedMutationStages {
	const entries = admittedStageEntries(value);
	const combined: Mutation[] = [];
	const slices: AdmittedMutationStageSlice[] = [];
	for (const entry of entries) {
		const start = combined.length;
		for (let index = 0; index < entry.mutations.length; index += 1) {
			combined.push(entry.mutations[index] as Mutation);
		}
		const end = combined.length;
		if (end > start) {
			slices.push(Object.freeze({ stage: entry.stage, start, end }));
		}
	}
	const batch = admitMutationBatchInternal(combined, true);
	return Object.freeze({
		batch,
		slices: Object.freeze(slices),
	}) as AdmittedMutationStages;
}

export function encodeAdmittedMutationEnvelope(value: unknown): {
	readonly value: ProtectedMutationEnvelope;
	readonly json: string;
} {
	let detached: HookInertJsonValue;
	try {
		detached = detachJsonTree(value, true);
	} catch (error) {
		if (error instanceof JsonTreeAdmissionError) {
			throw new MutationWireCanonicalityError(
				detailsFor(error.path, error.reason),
			);
		}
		throw error;
	}
	freezeJsonTree(detached);
	return Object.freeze({
		value: detached as ProtectedMutationEnvelope,
		json: intrinsicJsonStringify(detached),
	});
}

export function admittedMutationSlice(
	stages: AdmittedMutationStages,
	slice: AdmittedMutationStageSlice,
): AdmittedMutationBatch {
	const values: Mutation[] = [];
	for (let index = slice.start; index < slice.end; index += 1) {
		values.push(stages.batch[index] as Mutation);
	}
	return admitMutationBatchInternal(values, true);
}
