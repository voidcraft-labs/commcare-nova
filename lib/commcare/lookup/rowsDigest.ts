import { createHash } from "node:crypto";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";
import type { HqFixtureRow } from "../hq/lookupTables";

/**
 * One row as the digest spells it: its field names sorted, each with its
 * value, or, for a multi-valued field, its ordered values each with its
 * properties as sorted pairs. The row's id
 * is left out: HQ keeps a row's id only while it keeps the table and the
 * row's content (`fixtures/upload/run_upload.py::Mutation.process`), so an
 * id says nothing about what the row holds.
 */
function spelledRow(row: HqFixtureRow): unknown {
	const fields = Object.keys(row.fields)
		.sort()
		.map((name) => {
			const value = row.fields[name];
			if (typeof value === "string") return [name, value];
			/* A field that holds one value is spelled as that value whichever
			 * of HQ's two row shapes served it; only a multi-valued field
			 * carries its values' properties. */
			const [only] = value;
			if (
				value.length === 1 &&
				only !== undefined &&
				Object.keys(only.properties).length === 0
			)
				return [name, only.value];
			return [
				name,
				value.map((item) => [
					item.value,
					Object.keys(item.properties)
						.sort()
						.map((property) => [property, item.properties[property]]),
				]),
			];
		});
	return Object.keys(row.itemAttributes ?? {}).length > 0
		? { fields, attributes: row.itemAttributes }
		: fields;
}

export function rowsDigest(rows: readonly HqFixtureRow[]): string {
	return canonicalJsonDigest(rows.map(spelledRow));
}

/** Stream the same JSON spelling for a row whose lexical values reside in
 * separate immutable reads. A single cell, plus the row's shape, is live. */
async function writeResolvedJson(
	value: unknown,
	resolve: (value: string) => Promise<string>,
	write: (text: string) => void,
): Promise<void> {
	if (Array.isArray(value)) {
		write("[");
		for (const [i, item] of value.entries()) {
			if (i) write(",");
			await writeResolvedJson(item, resolve, write);
		}
		write("]");
	} else if (value !== null && typeof value === "object") {
		write("{");
		for (const [i, [key, item]] of Object.entries(value).entries()) {
			if (i) write(",");
			write(JSON.stringify(key) + ":");
			await writeResolvedJson(item, resolve, write);
		}
		write("}");
	} else
		write(
			JSON.stringify(typeof value === "string" ? await resolve(value) : value),
		);
}

/** The verified stream and the ordinary inline observation use the identical
 * canonical array spelling, including the empty array. */
export function streamingLookupRowsDigest() {
	const hash = createHash("sha256").update("[");
	let count = 0;
	return {
		row(row: HqFixtureRow) {
			if (count++) hash.update(",");
			hash.update(canonicalJsonText(spelledRow(row)));
		},
		async resolvedRow(
			row: HqFixtureRow,
			resolve: (value: string) => Promise<string>,
		) {
			if (count++) hash.update(",");
			// Canonicalize only the bounded skeleton. Its properties now have
			// JSON's actual enumeration order, including numeric property names.
			await writeResolvedJson(
				JSON.parse(canonicalJsonText(spelledRow(row))),
				resolve,
				(text) => {
					hash.update(text);
				},
			);
		},
		finish() {
			return { count, digest: hash.update("]").digest("hex") };
		},
	};
}
