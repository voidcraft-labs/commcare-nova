import { isTag } from "domhandler";
import { textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { expect, it } from "vitest";
import { lookupAppFixture } from "@/lib/commcare/__tests__/lookupAppFixtures";
import { w } from "../../xpath/wire/builders";
import { serializeWire } from "../../xpath/wire/serialize";
import { buildLookupFixtures } from "../fixtures";
import { lookupWireNaming } from "../naming";
import { lookupReadNodes, lookupReadText, resolveLookupRead } from "../read";
import { bindLookupRead, lookupReadPath } from "../readPath";
import { streamWorkerFixtureRow } from "../streamFixture";
import { wireRow, wireTable } from "./lookupWireCorpus";

function required<T>(value: T | undefined): T {
	if (value === undefined)
		throw new Error("The proof's addressed lookup member is missing.");
	return value;
}
it("binds the same owned selector for a nested path, reads the qualified values in order and refuses ambiguous worker choice labels", () => {
	const { table, rows } = lookupAppFixture(false, true);
	const column = table.columns[1],
		lang = required(column.properties)[0];
	const names = {
		column: (name: string) =>
			table.columns.find((c) => c.wireName === name)?.id,
		attribute: (name: string) =>
			table.attributes?.find((a) => a.wireName === name)?.id,
		property: (_id: unknown, name: string) =>
			column.properties?.find((p) => p.wireName === name)?.id,
	};
	const source = lookupReadPath("label[@lang = 'fr'][1]/@lang");
	expect(source).toBeDefined();
	const read = required(bindLookupRead(required(source), names));
	expect(read).toEqual({
		columnId: column.id,
		where: { propertyId: lang.id, equals: "fr" },
		occurrence: 1,
		propertyId: lang.id,
	});
	expect(
		lookupReadText(rows[0], read, required(resolveLookupRead(table, read))),
	).toBe("fr");
	const firstThenFrench=required(bindLookupRead(required(lookupReadPath("label[1][@lang = 'fr']")),names));
	expect(firstThenFrench).toEqual({ columnId:column.id,where:{propertyId:lang.id,equals:"fr"},occurrence:1,positionBeforeFilter:true });
	expect([...lookupReadNodes(rows[0],firstThenFrench,required(resolveLookupRead(table,firstThenFrench)))]).toEqual([]);
	expect(
		[
			...lookupReadNodes(
				rows[0],
				column.id,
				required(resolveLookupRead(table, column.id)),
			),
		].map((atom) => atom.text),
	).toEqual(["Original Northland", "Choix Northland"]);
	expect(() =>
		lookupReadText(
			rows[0],
			column.id,
			required(resolveLookupRead(table, column.id)),
		),
	).toThrow(/several values/);
});

it("streams external UTF-8 on split codepoints with the XML semantics a worker actually receives", async () => {
	const { table, rows, naming } = lookupAppFixture(false, true);
	const row = rows[0],
		fixture = naming.tables[0];
	const text = "\uFEFFé😀\t\n\r<&";
	const chunks = streamWorkerFixtureRow(fixture, row, (atom) => {
		if (
			atom.slot.kind !== "attribute" &&
			!(atom.slot.kind === "occurrence" && atom.slot.index === 1)
		)
			return undefined;
		return (async function* () {
			const bytes = Buffer.from(text);
			for (const byte of bytes) yield Uint8Array.of(byte);
		})();
	});
	const xml = Buffer.concat(await Array.fromAsync(chunks)).toString();
	const [record] = parseDocument(xml, { xmlMode: true }).children.filter(isTag);
	expect(record.attribs.row_code).toBe(text);
	expect(
		record.children
			.filter(isTag)
			.filter((field) => field.name === "label")
			.map(textContent),
	).toEqual(["Original Northland", text]);
	const [attr] = required(table.attributes);
	const inline = {
		...row,
		attributes: { [attr.id]: text },
		occurrences: {
			[table.columns[1].id]: required(
				row.occurrences?.[table.columns[1].id],
			).map((item, i) => ({ ...item, text: i === 1 ? text : item.text })),
		},
	};
	expect(
		buildLookupFixtures(naming, new Map([[table.id, [inline]]])).fixtures[0]
			.xml,
	).toContain(xml);
});

it("keeps absent, zero and one-empty values distinct and prevents assigned rows entering an offline archive", () => {
	const table = wireTable("visits", [{ name: "reason", type: "text" }]);
	const col = table.columns[0];
	col.repeated = true;
	const row = wireRow(table, "first", {}),
		zero = { ...row, occurrences: { [col.id]: [] } },
		one = { ...row, occurrences: { [col.id]: [{ text: "", properties: {} }] } };
	const fixture = buildLookupFixtures(
		lookupWireNaming([table]),
		new Map([[table.id, [row, zero, one]]]),
	).fixtures[0];
	expect(fixture.xml).toContain(
		"<visits><reason/></visits><visits/><visits><reason/></visits>",
	);
	expect(
		buildLookupFixtures(
			lookupWireNaming([{ ...table, workerAccess: "assigned" }]),
			new Map([[table.id, [row]]]),
		).fixtures,
	).toEqual([]);
});

it("reads the literal qualification that HQ preserves for quote marks, interpolation and a trailing backslash", () => {
	const value = `She said "'hello'" #case/id\\`;
	const literal = serializeWire(w.str(value), { target: "hq-json", interpolation: "case" }).text;
	expect(lookupReadPath(`label[@lang = ${literal}][1]`)).toEqual({
		column: "label",
		occurrence: 1,
		where: { property: "lang", equals: value },
	});
	expect(
		lookupReadPath("label[@lang=concat('en', position())]"),
	).toBeUndefined();
});

it("refuses an unsupported device character in a streamed external detail", async () => {
	const { rows, naming } = lookupAppFixture(false, true);
	const fragments = streamWorkerFixtureRow(naming.tables[0], rows[0], (atom) =>
		atom.slot.kind === "property"
			? (async function* () {
					yield Buffer.from("value\u0001");
				})()
			: undefined,
	);
	await expect(Array.fromAsync(fragments)).rejects.toThrow(/U\+0001/);
});
