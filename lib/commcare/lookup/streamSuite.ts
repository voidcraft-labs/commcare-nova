import type { StreamingLookupTable } from "@/lib/lookup/archiveRows";
import { lookupWireNaming } from "./naming";
import { streamWorkerFixtureRow } from "./streamFixture";

/** The compiler validates each structural fixture, including its sole list
 * element. Only its certified empty body marker is replaced with worker rows. */
export function suiteWithStreamedRows(
	suite: string,
	tables: readonly StreamingLookupTable[],
) {
	return {
		path: "suite.xml",
		async *open() {
			let cursor = 0;
			const parts = tables
				.map((table) => {
					const naming = lookupWireNaming([table.definition]).tableFor(
						table.definition.id,
					);
					const prefix = '<fixture id="' + naming.fixtureId + '">';
					const marker = prefix + "<" + naming.listElementName + "/></fixture>";
					const start = suite.indexOf(marker);
					if (start < 0 || suite.indexOf(marker, start + 1) !== -1)
						throw new Error(
							"A streamed fixture needs one compiled suite marker.",
						);
					return { start, end: start + marker.length, table, naming, prefix };
				})
				.sort((a, b) => a.start - b.start);
			for (const { start, end, table, naming, prefix } of parts) {
				yield Buffer.from(
					suite.slice(cursor, start) +
						prefix +
						"<" +
						naming.listElementName +
						">",
				);
				for await (const { row, read } of table.reader.rows())
					yield* streamWorkerFixtureRow(naming, row, read);
				yield Buffer.from("</" + naming.listElementName + "></fixture>");
				cursor = end;
			}
			yield Buffer.from(suite.slice(cursor));
		},
	};
}
