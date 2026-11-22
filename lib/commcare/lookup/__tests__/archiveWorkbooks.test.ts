import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import type {
	ArchiveRow,
	StreamingLookupTable,
} from "@/lib/lookup/archiveRows";
import { planLargeWorkbooks } from "../archiveWorkbooks";
import { buildLookupFixtures } from "../fixtures";
import { lookupWireNaming } from "../naming";
import { suiteWithStreamedRows } from "../streamSuite";
import { wireRow, wireTable } from "./lookupWireCorpus";

function data(tag: string, value: string): StreamingLookupTable {
	const definition = wireTable(tag, [{ name: "code", type: "text" }]);
	const row = wireRow(definition, "row", { code: value });
	const item: ArchiveRow = { row, external: new Map(), read: () => undefined };
	return {
		definition,
		count: 1,
		reader: {
			check: async () => {},
			async *rows() {
				yield item;
			},
			reopenRow: async (position: number) => {
				if (position !== 1) throw new Error("Unexpected row.");
				return item;
			},
		},
	};
}

it("emits complete text-only workbook sheets and a suite fixture read by independent XML and ZIP parsers", async () => {
	const one = data("areas", "<007>"),
		two = data("schools", "李 & María");
	const plan = await planLargeWorkbooks([two, one]);
	expect(plan.alternatives).toEqual([]);
	expect(plan.files).toHaveLength(1);
	const [file] = plan.files;
	expect(file.totalWorkbookRows).toBe(7);
	const blob = [];
	for await (const piece of file.open()) blob.push(piece);
	const program =
		"import io,sys,json,zipfile,xml.etree.ElementTree as ET\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nassert z.testzip() is None\nns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}\nnames=[s.attrib['name'] for s in ET.fromstring(z.read('xl/workbook.xml')).findall('.//s:sheet',ns)]\nprint(json.dumps([[name,[v.text or '' for v in ET.fromstring(z.read('xl/worksheets/sheet%d.xml'%i)).findall('.//s:row[last()]/s:c/s:is/s:t',ns)]] for i,name in enumerate(names,1)]))";
	const read = spawnSync("python3", ["-c", program], {
		input: Buffer.concat(blob),
	});
	expect(read.status, read.stderr.toString()).toBe(0);
	expect(JSON.parse(read.stdout.toString())).toMatchObject([
		["types", expect.any(Array)],
		["areas", ["", "N", "<007>"]],
		["schools", ["", "N", "李 & María"]],
	]);
	const naming = lookupWireNaming([one.definition, two.definition]);
	const empty = buildLookupFixtures(
		naming,
		new Map([
			[one.definition.id, []],
			[two.definition.id, []],
		]),
	);
	const suite =
		"<suite>" + empty.fixtures.map((f) => f.xml).join("") + "</suite>";
	const chunks = [];
	for await (const part of suiteWithStreamedRows(suite, [two, one]).open())
		chunks.push(part);
	const parse = spawnSync(
		"python3",
		[
			"-c",
			"import sys,json,xml.etree.ElementTree as ET;print(json.dumps([n.text for n in ET.fromstring(sys.stdin.buffer.read()).iter('code')]))",
		],
		{ input: Buffer.concat(chunks) },
	);
	expect(parse.status, parse.stderr.toString()).toBe(0);
	expect(JSON.parse(parse.stdout.toString())).toEqual(["<007>", "李 & María"]);
});

it("retains the exact reason when a destination workbook would change a row", async () => {
	const table = data("areas", " 007 ");
	const plan = await planLargeWorkbooks([table]);
	expect(plan.files).toEqual([]);
	expect(plan.alternatives[0].carrier).toEqual({
		kind: "json",
		reason: expect.stringContaining("trim"),
	});
});

it("emits a segmented cell with the identical native bytes and row receipt as its inline spelling", async () => {
	const text = '李&"\\u0000xlsx:0"🍊'.repeat(80);
	const ordinary = data("districts", text),
		segment = data("districts", "");
	const id = segment.definition.columns[0].id;
	const stored = await segment.reader.reopenRow(1);
	const bytes = Buffer.from(text);
	const external: ArchiveRow = {
		row: stored.row,
		external: new Map([
			[JSON.stringify(["cell", id]), { bytes: bytes.length }],
		]),
		read: ({ slot }) => {
			if (slot.kind !== "cell" || slot.columnId !== id) return undefined;
			return (async function* () {
				for (let i = 0; i < bytes.length; i += 11)
					yield bytes.subarray(i, i + 11);
			})();
		},
	};
	segment.reader = {
		...segment.reader,
		async *rows() {
			yield external;
		},
		reopenRow: async () => external,
	};
	const a = await planLargeWorkbooks([ordinary]),
		b = await planLargeWorkbooks([segment]);
	expect(b.alternatives).toEqual([]);
	expect(b.files[0].expected).toEqual(a.files[0].expected);
	const bytesOf = async (input: AsyncIterable<Uint8Array>) => {
		const chunks = [];
		for await (const chunk of input) chunks.push(chunk);
		return Buffer.concat(chunks);
	};
	expect(await bytesOf(b.files[0].open())).toEqual(
		await bytesOf(a.files[0].open()),
	);
});

it("keeps assigned or indexed tables on their verified destination when the workbook would trim a value", async () => {
	for (const restriction of ["assigned", "indexed"]) {
		const table = data("districts", " 007 ");
		if (restriction === "assigned") table.definition.workerAccess = "assigned";
		else
			table.definition = {
				...table.definition,
				columns: table.definition.columns.map((c) => ({
					...c,
					index: "indexed",
				})),
			};
		const plan = await planLargeWorkbooks([table]);
		expect(plan.files).toEqual([]);
		expect(plan.alternatives[0].carrier.kind).toBe("source-reference");
	}
});
