/**
 * Helpers for records whose keys are authored identities.
 *
 * JavaScript's object prototype names are valid Nova identities (`constructor`,
 * `toString`, and `__proto__` all satisfy several of our wire schemas). A plain
 * bracket read therefore is not a membership test, and assigning `__proto__`
 * with bracket syntax can mutate an object's prototype instead of recording
 * data. Keep those two hazards behind this small boundary.
 */

import { z } from "zod";

/** True only when `key` is an own data property of `record`. */
export function hasOwnRecordKey(
	record: object | undefined,
	key: PropertyKey,
): boolean {
	return record !== undefined && Object.hasOwn(record, key);
}

/** Read an authored record member without falling through to its prototype. */
export function ownRecordValue<T>(
	record: Readonly<Record<string, T>> | undefined,
	key: string,
): T | undefined {
	return hasOwnRecordKey(record, key) ? record?.[key] : undefined;
}

/**
 * Build a plain JSON-compatible record while preserving every key as an own
 * data property, including `__proto__`.
 */
export function recordFromEntries<T>(
	entries: Iterable<readonly [string, T]>,
): Record<string, T> {
	return Object.fromEntries(entries);
}

/**
 * Zod's native record parser intentionally drops `__proto__`. That is a sound
 * default for ordinary JavaScript dictionaries, but Nova permits any non-empty
 * stable identity, including prototype-looking strings. Parse only enumerable
 * OWN entries, validate both halves, and rebuild through Object.fromEntries so
 * every accepted key remains ordinary data without invoking a prototype setter.
 */
export function ownRecordSchema<
	TKeySchema extends z.ZodType<string>,
	TValueSchema extends z.ZodType,
>(keySchema: TKeySchema, valueSchema: TValueSchema) {
	return z.unknown().transform((input, ctx) => {
		if (input === null || typeof input !== "object" || Array.isArray(input)) {
			ctx.addIssue({
				code: "custom",
				message: "Expected a record object.",
			});
			return z.NEVER;
		}

		const entries: Array<[string, z.output<TValueSchema>]> = [];
		for (const [key, value] of Object.entries(input)) {
			const parsedKey = keySchema.safeParse(key);
			if (!parsedKey.success) {
				for (const issue of parsedKey.error.issues) {
					ctx.addIssue({ ...issue, path: [key, ...issue.path] });
				}
				continue;
			}
			const parsedValue = valueSchema.safeParse(value);
			if (!parsedValue.success) {
				for (const issue of parsedValue.error.issues) {
					ctx.addIssue({ ...issue, path: [key, ...issue.path] });
				}
				continue;
			}
			entries.push([parsedKey.data, parsedValue.data]);
		}
		return recordFromEntries(entries);
	});
}

/** Return the current record with one own member set or replaced. */
export function recordWithValue<T>(
	record: Readonly<Record<string, T>> | undefined,
	key: string,
	value: T,
): Record<string, T> {
	return recordFromEntries([
		...Object.entries(record ?? {}).filter(([candidate]) => candidate !== key),
		[key, value] as const,
	]);
}

/** Return the current record without one own member. */
export function recordWithoutKey<T>(
	record: Readonly<Record<string, T>> | undefined,
	key: string,
): Record<string, T> {
	return recordFromEntries(
		Object.entries(record ?? {}).filter(([candidate]) => candidate !== key),
	);
}

/** Layer own data entries left-to-right without invoking prototype setters. */
export function mergeOwnRecords<T>(
	...records: ReadonlyArray<Readonly<Record<string, T>> | undefined>
): Record<string, T> {
	return recordFromEntries(
		records.flatMap((record) => Object.entries(record ?? {})),
	);
}
