/**
 * Contract: a name the source supplies is looked up only among the entries a
 * reader's table holds (`lib/commcare/sourceKeys.ts`), so a column whose format or whose
 * property is one of the names every JavaScript object inherits
 * (`constructor`, `toString`, ...) reads exactly as a column of a name no
 * table holds: an unknown format as plain, a property as an ordinary
 * property. The failure it catches: a property named `constructor` refused
 * as outside Nova's property grammar, or a format named `constructor`
 * throwing from inside the reader, both because a plain object answered its
 * prototype's member.
 */
import { describe, expect, it } from "vitest";
import { plainColumn } from "@/lib/domain/modules";
import { type SourceTable, tableOf } from "../../../sourceKeys";
import { patients, uuid } from "./fixtures";
import { closedCodes, readLists } from "./listReading";

/** Each name every object inherits that HQ's property grammar admits (`__defineGetter__` and its
 *  kin are refused there for their underscores, as any such name is). */
const INHERITED = Object.getOwnPropertyNames(Object.prototype).filter(
	(name) => !name.startsWith("__"),
);

const twoColumns = () =>
	patients([
		plainColumn(uuid(1), "case_name", "Name"),
		plainColumn(uuid(2), "notes", "Notes"),
	]);

/** The codes of a reading whose second column took `change` on both screens. */
async function codesWith(change: Record<string, unknown>): Promise<string[]> {
	const reading = await readLists(twoColumns(), {
		edit: (app) => {
			const pair = app.modules[0]?.case_details;
			for (const detail of [pair?.short, pair?.long]) {
				const column = detail?.columns[1];
				if (column !== undefined) Object.assign(column, change);
			}
		},
		firstPassOnly: true,
	});
	return closedCodes(reading).sort();
}

describe("a name every object inherits, in a case list column", () => {
	it.each(INHERITED)(
		"reads the format %s as a format no table holds",
		async (name) => {
			expect(await codesWith({ format: name })).toEqual(
				await codesWith({ format: "a-format-hq-registers-none-of" }),
			);
		},
	);

	it.each(INHERITED)(
		"reads the property %s as an ordinary property",
		async (name) => {
			expect(await codesWith({ field: name })).toEqual(
				await codesWith({ field: "visits" }),
			);
		},
	);
});

describe("a reader's table", () => {
	it("answers only its own entries, and a lookup by index does not typecheck", () => {
		const table: SourceTable<number> = tableOf({ a: 1 });
		expect(table.get("a")).toBe(1);
		expect(table.get("constructor")).toBeUndefined();
		const name: string = "a";
		// @ts-expect-error: a table is read by `get`, never by an index a source's name could fill.
		expect(table[name]).toBeUndefined();
	});
});
