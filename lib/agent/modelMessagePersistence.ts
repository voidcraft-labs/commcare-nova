/** Lossless JSON persistence for AI SDK model messages and step evidence. */

import type { ModelMessage } from "ai";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

const ENCODING = "nova-model-value-v1" as const;

type EncodedModelValue =
	| { readonly kind: "null" }
	| { readonly kind: "undefined" }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "url"; readonly value: string }
	| { readonly kind: "bytes"; readonly value: string }
	| { readonly kind: "array"; readonly items: readonly EncodedModelValue[] }
	| {
			readonly kind: "object";
			readonly entries: readonly (readonly [string, EncodedModelValue])[];
	  };

export interface PersistedModelValue {
	readonly encoding: typeof ENCODING;
	readonly value: EncodedModelValue;
}

export class ModelValuePersistenceError extends Error {
	readonly name = "ModelValuePersistenceError";
}

function encodeValue(value: unknown): EncodedModelValue {
	if (value === null) return { kind: "null" };
	if (value === undefined) return { kind: "undefined" };
	if (typeof value === "boolean") return { kind: "boolean", value };
	if (typeof value === "string") return { kind: "string", value };
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new ModelValuePersistenceError(
				"Model context cannot persist a non-finite number.",
			);
		}
		return { kind: "number", value };
	}
	if (value instanceof URL) return { kind: "url", value: value.toString() };
	if (value instanceof Uint8Array) {
		return { kind: "bytes", value: Buffer.from(value).toString("base64") };
	}
	if (value instanceof ArrayBuffer) {
		return {
			kind: "bytes",
			value: Buffer.from(new Uint8Array(value)).toString("base64"),
		};
	}
	if (Array.isArray(value)) {
		return { kind: "array", items: value.map(encodeValue) };
	}
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ModelValuePersistenceError(
				`Model context cannot persist a ${value.constructor?.name ?? "non-plain object"}.`,
			);
		}
		return {
			kind: "object",
			entries: Object.entries(value).map(([key, nested]) => [
				key,
				encodeValue(nested),
			]),
		};
	}
	throw new ModelValuePersistenceError(
		`Model context cannot persist a ${typeof value} value.`,
	);
}

function encodedValue(value: unknown, context: string): EncodedModelValue {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ModelValuePersistenceError(`${context} is not an encoded value.`);
	}
	const record = value as Record<string, unknown>;
	switch (record.kind) {
		case "null":
		case "undefined":
			return { kind: record.kind };
		case "boolean":
			if (typeof record.value === "boolean") {
				return { kind: "boolean", value: record.value };
			}
			break;
		case "number":
			if (typeof record.value === "number" && Number.isFinite(record.value)) {
				return { kind: "number", value: record.value };
			}
			break;
		case "string":
		case "url":
		case "bytes":
			if (typeof record.value === "string") {
				return { kind: record.kind, value: record.value };
			}
			break;
		case "array":
			if (Array.isArray(record.items)) {
				return {
					kind: "array",
					items: record.items.map((item, index) =>
						encodedValue(item, `${context}.items[${index}]`),
					),
				};
			}
			break;
		case "object":
			if (Array.isArray(record.entries)) {
				return {
					kind: "object",
					entries: record.entries.map((entry, index) => {
						if (
							!Array.isArray(entry) ||
							entry.length !== 2 ||
							typeof entry[0] !== "string"
						) {
							throw new ModelValuePersistenceError(
								`${context}.entries[${index}] is invalid.`,
							);
						}
						return [
							entry[0],
							encodedValue(entry[1], `${context}.entries[${index}][1]`),
						] as const;
					}),
				};
			}
			break;
	}
	throw new ModelValuePersistenceError(`${context} has an invalid encoding.`);
}

function decodeValue(value: EncodedModelValue): unknown {
	switch (value.kind) {
		case "null":
			return null;
		case "undefined":
			return undefined;
		case "boolean":
		case "number":
		case "string":
			return value.value;
		case "url":
			return new URL(value.value);
		case "bytes":
			return new Uint8Array(Buffer.from(value.value, "base64"));
		case "array":
			return value.items.map(decodeValue);
		case "object":
			return Object.fromEntries(
				value.entries.map(([key, nested]) => [key, decodeValue(nested)]),
			);
	}
}

/** The tagged root keeps arbitrary customer/tool JSON collision-free: an
 * object that happens to contain `kind: "url"` is itself encoded as an object,
 * never mistaken for Nova's URL representation. */
export function persistModelValue(value: unknown): PersistedModelValue {
	return { encoding: ENCODING, value: encodeValue(value) };
}

export function rehydrateModelValue(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ModelValuePersistenceError(
			"Persisted model value is not an object.",
		);
	}
	const record = value as Record<string, unknown>;
	if (record.encoding !== ENCODING) {
		throw new ModelValuePersistenceError(
			"Persisted model value has an unsupported encoding.",
		);
	}
	return decodeValue(encodedValue(record.value, "Persisted model value"));
}

export function durableModelValueDigest(value: unknown): string {
	return canonicalJsonDigest(persistModelValue(value));
}

export function persistModelMessage(
	message: ModelMessage,
): PersistedModelValue {
	return persistModelValue(message);
}

export function rehydrateModelMessage(value: unknown): ModelMessage {
	const message = rehydrateModelValue(value);
	if (
		message === null ||
		typeof message !== "object" ||
		Array.isArray(message)
	) {
		throw new ModelValuePersistenceError(
			"Persisted model message is not an object.",
		);
	}
	const role = (message as { role?: unknown }).role;
	if (!["system", "user", "assistant", "tool"].includes(String(role))) {
		throw new ModelValuePersistenceError(
			"Persisted model message has an invalid role.",
		);
	}
	return message as ModelMessage;
}
