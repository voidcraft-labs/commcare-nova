import { serializeXml, serializeXmlValue } from "../serializeXml";
import { type StreamMember, streamZip, textMember } from "../streamZip";
import { addWorkbookHeaders, columnName } from "./textWorkbook";

export interface StreamSheet {
	name: string;
	width: number;
	height: number;
	rows: () => AsyncIterable<readonly string[] | AsyncIterable<string>>;
}

export function streamTextWorkbook(sheets: readonly StreamSheet[]) {
	const members: StreamMember[] = [];
	addWorkbookHeaders(sheets, (path, element) =>
		members.push(textMember(path, serializeXml(element))),
	);
	for (const [i, sheet] of sheets.entries()) {
		members.push({
			path: "xl/worksheets/sheet" + (i + 1) + ".xml",
			async *open() {
				yield Buffer.from(
					'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:' +
						columnName(sheet.width - 1) +
						sheet.height +
						'"/><sheetData>',
				);
				let index = 0;
				for await (const row of sheet.rows()) {
					index++;
					yield Buffer.from('<row r="' + index + '">');
					let col = 0;
					for await (const value of row) {
						yield Buffer.from(
							'<c r="' +
								columnName(col++) +
								index +
								'" t="inlineStr"><is><t xml:space="preserve">' +
								serializeXmlValue(value, false) +
								"</t></is></c>",
						);
					}
					yield Buffer.from("</row>");
				}
				if (index !== sheet.height)
					throw new Error("The table changed while preparing its workbook.");
				yield Buffer.from("</sheetData></worksheet>");
			},
		});
	}
	return streamZip(members);
}
