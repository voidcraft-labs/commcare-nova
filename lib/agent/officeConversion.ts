// Runs only inside the isolated Office parser process (or focused parser tests).
import AdmZip from "adm-zip";
import mammoth from "mammoth";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import * as XLSX from "xlsx";
import { createFigureCollector, figureMarker } from "./documentFigures";
import { OFFICE_LIMITS } from "./officeLimits";

export function assertOfficeArchiveBudget(
	entrySizes: number[],
	label: string,
): void {
	if (entrySizes.length > OFFICE_LIMITS.entries)
		throw new Error(
			`This ${label} has too many internal parts to read safely. You can try a simpler version.`,
		);
	let total = 0;
	for (const size of entrySizes) {
		if (!Number.isSafeInteger(size) || size < 0)
			throw new Error(
				`This ${label} declares an invalid internal size. You can try exporting it again.`,
			);
		total += size;
		if (total > OFFICE_LIMITS.decodedBytes)
			throw new Error(
				`This ${label}'s contents expand to over ${OFFICE_LIMITS.decodedBytes / 1024 / 1024} MB. You can split it into smaller files.`,
			);
	}
}

/** Decode, CRC-check and repackage exactly the admitted bytes. The next parser
 * never sees the original ZIP headers, duplicate names or alternate directory.
 * AdmZip caps deflate output to header.size; stored entries are checked against
 * their actual bytes too. All of this runs under the process resource limits. */
function canonicalOfficeArchive(buffer: Buffer, kind: "docx" | "xlsx"): Buffer {
	const archive = new AdmZip(buffer);
	const entries = archive.getEntries();
	assertOfficeArchiveBudget(
		entries.map((e) => e.header.size),
		kind,
	);
	const canonical = new AdmZip();
	const names = new Set<string>();
	let decoded = 0;
	for (const entry of entries) {
		if (
			names.has(entry.entryName) ||
			entry.entryName.includes("\\") ||
			entry.entryName.includes("\0") ||
			entry.entryName
				.replace(/\/$/, "")
				.split("/")
				.some((part) => part === "" || part === "." || part === "..")
		)
			throw new Error(
				"The file has conflicting internal parts. You can try exporting it again.",
			);
		names.add(entry.entryName);
		const bytes = entry.getData();
		decoded += bytes.length;
		if (
			bytes.length !== entry.header.size ||
			decoded > OFFICE_LIMITS.decodedBytes
		)
			throw new Error(
				"The file's decoded contents exceed its size budget. You can try a smaller file.",
			);
		canonical.addFile(entry.entryName, bytes);
	}
	return canonical.toBuffer();
}

export async function docxToMarkdownWithFigures(buffer: Buffer) {
	buffer = canonicalOfficeArchive(buffer, "docx");
	const collector = createFigureCollector();
	const result = await mammoth.convertToHtml(
		{ buffer },
		{
			externalFileAccess: false,
			convertImage: mammoth.images.imgElement((image) =>
				collector.collect(image),
			),
		},
	);
	if (result.messages.some((message) => message.type === "error")) {
		throw new Error(
			"Some document content could not be converted. You can try exporting it as a PDF.",
		);
	}
	const seen = new Set<number>();
	const markdown = String(
		await unified()
			.use(rehypeParse, { fragment: true })
			.use(rehypeRemark, {
				handlers: {
					img(_state, node) {
						const index = Number(node.properties.src);
						const figure = collector.figures[index - 1];
						if (!figure || seen.has(index))
							throw new Error("Document figure references could not be read.");
						seen.add(index);
						return { type: "html", value: figureMarker(index, figure.altText) };
					},
				},
			})
			.use(remarkGfm)
			.use(remarkStringify)
			.process(result.value),
	);
	if (seen.size !== collector.figures.length)
		throw new Error("Some document figures could not be located in the text.");
	return {
		markdown,
		figures: collector.figures,
		warnings: result.messages.map((message) => message.message),
	};
}

/**
 * Render a 2D string array as a GitHub-flavored markdown table. The first row
 * is the header; a separator row follows. An empty input yields an empty
 * string (a sheet with no rows contributes nothing).
 */
export function rowsToMarkdownTable(rows: string[][]): string {
	if (rows.length === 0) return "";
	const header = rows[0];
	const separator = header.map(() => "---");
	const body = rows.slice(1);
	const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
	return [line(header), line(separator), ...body.map(line)].join("\n");
}

// Hard caps so a sparse or malicious workbook can't blow up extraction. A
// few-KB `.xlsx` can declare `!ref = A1:XFD1048576` (~17 billion cells); walking
// that declared range — `sheet_to_json` builds the grid, a naive formula scan
// iterates it — would pin CPU / OOM the shared extraction worker, and the upload
// file-byte cap does NOT bound a SPARSE range. These do: the value table is read
// over a clamped window, the formula scan walks only POPULATED cells (bounded by
// the byte-capped file content), and the sheet count is capped. The model reads
// the requirements SHAPE (schema + sample values), not every record, so clamping
// the table window loses nothing it needs.
const MAX_XLSX_SHEETS = 32;
const MAX_XLSX_TABLE_ROWS = 2_000;
const MAX_XLSX_TABLE_COLS = 128;
const MAX_XLSX_FORMULAE_PER_SHEET = 2_000;

/** The worksheet range to read, clamped to the table window: the A1 range string
 *  plus whether the clamp actually trimmed it (drives a truncation note), or
 *  `null` when the sheet declares no `!ref`. Bounds the grid `sheet_to_json`
 *  builds so a huge declared `!ref` can't balloon memory. */
function clampedSheetRange(
	ws: XLSX.WorkSheet,
): { ref: string; truncated: boolean } | null {
	const ref = ws["!ref"];
	if (!ref) return null;
	const range = XLSX.utils.decode_range(ref);
	const maxR = range.s.r + MAX_XLSX_TABLE_ROWS - 1;
	const maxC = range.s.c + MAX_XLSX_TABLE_COLS - 1;
	const truncated = range.e.r > maxR || range.e.c > maxC;
	range.e.r = Math.min(range.e.r, maxR);
	range.e.c = Math.min(range.e.c, maxC);
	return { ref: XLSX.utils.encode_range(range), truncated };
}

/**
 * Pull the formula cells from a worksheet, in reading order (row-major). Returns
 * one `{ addr, formula }` per cell carrying a formula (`cell.f`, which SheetJS
 * stores without the leading `=`); value-only cells are skipped. `sheet_to_json`
 * reports only the COMPUTED value, so without this pass the calculation logic —
 * totals, scores, unit conversions, derived dates — is dropped on the floor, and
 * that logic is exactly what the SA should rebuild as CommCare calculated fields.
 *
 * Iterates the cells actually PRESENT (the worksheet's own address keys), NOT the
 * declared `!ref` range — a sparse sheet can declare a billion-cell range while
 * holding a handful of cells, and walking the range is the DoS. Populated-cell
 * count is bounded by the byte-capped file content, and the formula list is
 * capped besides.
 */
function collectSheetFormulae(ws: XLSX.WorkSheet): {
	formulae: { addr: string; formula: string }[];
	omittedCount: number;
} {
	const formulae: { addr: string; formula: string }[] = [];
	let omittedCount = 0;
	for (const addr of Object.keys(ws)) {
		if (addr.startsWith("!")) continue; // skip `!ref` / `!cols` / … metadata
		const cell = ws[addr] as XLSX.CellObject | undefined;
		if (cell?.f) {
			if (formulae.length < MAX_XLSX_FORMULAE_PER_SHEET)
				formulae.push({ addr, formula: cell.f });
			else omittedCount++;
		}
	}
	// Object key order isn't guaranteed row-major; sort to reading order so the
	// Calculations list lines up with the value table above it.
	formulae.sort((a, b) => {
		const pa = XLSX.utils.decode_cell(a.addr);
		const pb = XLSX.utils.decode_cell(b.addr);
		return pa.r - pb.r || pa.c - pb.c;
	});
	return { formulae, omittedCount };
}

/**
 * xlsx buffer → one markdown section per sheet: the sheet name as a heading, the
 * cell VALUES as a table, and — when the sheet has any — a `#### Calculations`
 * block listing each formula cell (`<addr> = <formula>`). `sheet_to_json` with
 * `header: 1` returns each row as an array of cell values; `raw: false` formats
 * cells as display strings and `defval: ""` fills gaps so ragged rows still
 * align into a table. The values table carries only computed results, so the
 * Calculations block is what preserves the derivation logic for the SA; the
 * table directly above it grounds each formula's A1 cell references.
 * `cellFormula: true` (SheetJS's read default, set explicitly) is what keeps the
 * formulas on `cell.f` for `collectSheetFormulae` to read.
 */
export function xlsxToMarkdown(buffer: Buffer): string {
	buffer = canonicalOfficeArchive(buffer, "xlsx");
	const workbook = XLSX.read(buffer, { type: "buffer", cellFormula: true });
	// Cap the sheet count first — each sheet does bounded-but-real work.
	const sections = workbook.SheetNames.slice(0, MAX_XLSX_SHEETS)
		.map((name) => {
			const ws = workbook.Sheets[name];
			// Read over the clamped window — `sheet_to_json` builds a grid across
			// the DECLARED range, so a huge `!ref` would balloon memory without this.
			const clamp = clampedSheetRange(ws);
			const rows = XLSX.utils.sheet_to_json<string[]>(ws, {
				header: 1,
				blankrows: false,
				defval: "",
				raw: false,
				...(clamp ? { range: clamp.ref } : {}),
			});
			// Cells come through typed as the worksheet's stored values; coerce each
			// to a string so the markdown renderer receives a uniform 2D string grid.
			const grid = rows.map((row) => row.map((cell) => String(cell)));
			const truncationNote = clamp?.truncated
				? `\n\n_(table truncated to the first ${MAX_XLSX_TABLE_ROWS} rows × ${MAX_XLSX_TABLE_COLS} columns)_`
				: "";
			// Append the formula list only when the sheet has one, so value-only
			// sheets stay clean. The h4 nests under the sheet's h3 heading.
			const { formulae, omittedCount } = collectSheetFormulae(ws);
			const calculations = formulae.length
				? `\n\n#### Calculations\n\n${formulae
						.map(({ addr, formula }) => `- ${addr} = ${formula}`)
						.join("\n")}`
				: "";
			const formulaNote =
				omittedCount > 0
					? `\n\n_(${omittedCount} additional ${omittedCount === 1 ? "formula was" : "formulas were"} not read because this sheet reached the extraction limit)_`
					: "";
			return `### ${name}\n\n${rowsToMarkdownTable(grid)}${truncationNote}${calculations}${formulaNote}`;
		})
		.join("\n\n");
	const omittedSheets = workbook.SheetNames.length - MAX_XLSX_SHEETS;
	return omittedSheets > 0
		? `${sections}\n\n_(${omittedSheets} additional ${omittedSheets === 1 ? "sheet was" : "sheets were"} not read because this workbook reached the extraction limit)_`
		: sections;
}
