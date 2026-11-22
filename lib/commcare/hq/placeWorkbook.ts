import {xmlTextIssue} from "../xmlText";
import { streamTextWorkbook } from "../lookup/streamWorkbook";
import { type StreamMember, streamZip, textMember } from "../streamZip";
import type { HqLocation, HqLocationType } from "./locations";
import { writableSiteCode } from "./placeTransfer";

const typeHeaders = [
	"code",
	"name",
	"parent_code",
	"Delete(Y/N)",
	"Shares Cases Y/N",
	"View Child Cases (Y/N)",
];
const placeHeaders = [
	"location_id",
	"site_code",
	"name",
	"parent_site_code",
	"external_id",
	"latitude",
	"longitude",
	"Delete(Y/N)",
];
const reserved = new Set([
	"name",
	"type",
	"owner_id",
	"external_id",
	"hq_user_id",
	"commtrack-supply-point",
]);
// Python str.strip() includes the four ASCII information separators alongside
// Unicode White_Space. Its set differs from JavaScript's trim at both ends.
function nativeSpace(character:string):boolean {
	const code=character.charCodeAt(0);
	return /\p{White_Space}/u.test(character) || (code >= 0x1c && code <= 0x1f);
}
const textCell = (text: string) =>
	text.length <= 32767 && !nativeSpace(text.charAt(0)) && !nativeSpace(text.slice(-1)) && xmlTextIssue(text) === undefined;
const sheetTitle = (code: string) =>
	code.length > 0 &&
	code.length <= 31 &&
	!/[\\/?*:[\]]/u.test(code) &&
	!code.startsWith("'") &&
	!code.endsWith("'") &&
	code.toLowerCase() !== "types" &&
	textCell(code);

export interface PlaceIdUpdate {
	place: HqLocation;
	externalId: string | null;
	parentCode: string | null;
}
export class PlaceWorkbookMismatch extends Error {}

/** The native importer requires the complete types sheet, strips all text
 * cells, lowercases site and parent codes, and stringifies supplied metadata.
 * With no data column it discards uncategorized keys. Each workbook therefore
 * groups rows by their exact set of safe metadata columns and preserves the
 * current identity, coordinates, hierarchy and target-only information. */
export function placeIdWorkbookMembers(
	domain: string,
	types: readonly HqLocationType[],
	updates: readonly PlaceIdUpdate[],
): StreamMember[] {
	if (
		types.some(
			(level) =>
				!textCell(level.code) ||
				!textCell(level.name) ||
				(level.parentCode !== null && !textCell(level.parentCode)),
		)
	)
		throw new PlaceWorkbookMismatch(
			"The organization workbook would change a level name or code on this project space. Check its level setup in CommCare HQ.",
		);
	const typeRows = [
		typeHeaders,
		...types.map((level) => [
			level.code,
			level.name,
			level.parentCode ?? "",
			"",
			level.sharesCases ? "yes" : "no",
			level.viewDescendants ? "yes" : "no",
		]),
	];
	const groups = new Map<
		string,
		{ level: string; columns: string[]; rows: string[][] }
	>();
	const members: StreamMember[] = [];
	const finish = (group: {
		level: string;
		columns: string[];
		rows: string[][];
	}) => {
		const rows = group.rows;
		group.rows = [];
		if (!rows.length) return;
		const index = members.length + 1;
		members.push({
			path: `place-ids-${index}.xlsx`,
			async *open() {
				const sheets = [
					{ name: "types", records: typeRows },
					{
						name: group.level,
						records: [
							[...placeHeaders, ...group.columns.map((key) => "data: " + key)],
							...rows,
						],
					},
				];
				yield* streamTextWorkbook(
					sheets.map((sheet) => ({
						name: sheet.name,
						width: sheet.records[0].length,
						height: sheet.records.length,
						async *rows() {
							yield* sheet.records;
						},
					})),
				);
			},
		});
	};
	for (const { place, externalId, parentCode } of updates) {
		const mismatch = (reason: string): never => {
			throw new PlaceWorkbookMismatch(
				`The workbook for “${place.name || place.siteCode}” (${place.siteCode}) would change ${reason}. Set up the exact values on this destination, then publish again.`,
			);
		};
		if (externalId === null || !textCell(externalId))
			mismatch("its external ID");
		if (
			!place.observation ||
			place.observation.nameIsNull ||
			!textCell(place.name) ||
			!textCell(place.siteCode) ||
			!writableSiteCode(place.siteCode) ||
			(parentCode !== null &&
				(!textCell(parentCode) || !writableSiteCode(parentCode)))
		)
			mismatch("its name, site code or parent");
		if (!sheetTitle(place.locationTypeCode))
			mismatch("the spelling of its level");
		const columns = Object.keys(place.values).sort();
		const values = columns.map((key) => {
			const value = place.values[key];
			if (
				typeof value !== "string" ||
				!textCell(value) ||
				!/^[\p{L}\p{N}_-]+$/u.test(key) ||
				reserved.has(key) ||
				key.startsWith("xml") ||
				key.startsWith("commcare") ||
				key.length > 32760
			)
				return mismatch(`the place information saved under “${key}”`);
			return value;
		});
		if (columns.length + placeHeaders.length > 16384)
			mismatch("the number of place information fields");
		const name = JSON.stringify([place.locationTypeCode, ...columns]);
		const group = groups.get(name) ?? {
			level: place.locationTypeCode,
			columns,
			rows: [],
		};
		group.rows.push([
			place.locationId,
			place.siteCode,
			place.name,
			parentCode ?? "",
			externalId as string,
			place.latitude ?? "",
			place.longitude ?? "",
			"",
			...values,
		]);
		groups.set(name, group);
		if (group.rows.length === 100) finish(group);
	}
	for (const group of groups.values()) finish(group);
	if (!members.length)
		throw new PlaceWorkbookMismatch(
			"The destination already has these place IDs. Publish again to continue.",
		);
	return [
		...members,
		textMember(
			"Instructions.txt",
			`These ${members.length} organization workbooks update IDs for ${updates.length} places on ${domain}.\nOpen Organization in that project space and import each workbook. CommCare HQ will show the affected places before you confirm. Then publish from Nova again to verify the saved IDs.\n`,
		),
	];
}
export function placeIdArchive(
	domain: string,
	types: readonly HqLocationType[],
	updates: readonly PlaceIdUpdate[],
) {
	return streamZip(placeIdWorkbookMembers(domain, types, updates));
}
