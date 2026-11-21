/**
 * A refused column, or a refused custom tile cell, is refused whole: what is left of it once its
 * refusal stands belongs to the refused thing, so it is claimed under that refusal and one cause
 * is one finding. A key the refusal's entry names is claimed under that entry at the key; any
 * other key the column holds is covered by the refusal's finding.
 */
import type { Finding, HqPlace } from "@/lib/publish/hqFindings";
import { inventoryIndex } from "../../surface/inventory";
import type { ReadContext } from "../context";
import { type JsonCursor, JsonCursorImpl, sameJson } from "../jsonCursor";

/** The keys that say what a column is, in the order a refusal of one decides the column's. */
const DECISIVE_KEYS = [
	"model",
	"format",
	"field",
	"useXpathExpression",
	"enum",
	"date_format",
	"late_flag",
	"time_ago_interval",
	"endpoint_action_id",
];

/** The last finding of `code` raised at `place`, naming `name` where one is given. */
function findingOf(
	ctx: ReadContext,
	code: string,
	place: HqPlace,
	name?: string,
): Finding | undefined {
	const findings = ctx.accounting.findings();
	for (let index = findings.length - 1; index >= 0; index -= 1) {
		const finding = findings[index] as Finding;
		if (
			finding.code === code &&
			sameJson(finding.place, place) &&
			(name === undefined || finding.detail.name === name)
		)
			return finding;
	}
	return undefined;
}

/**
 * Claims each key of `cursor` that holds a value other than its default and that nothing claims
 * yet, under the finding `by`: at the key under the finding's entry where that entry names the key,
 * and covered by the finding otherwise. `within` narrows the keys to those the refused thing owns.
 */
export function claimRestUnder(
	ctx: ReadContext,
	cursor: JsonCursor,
	by: Finding,
	within: (key: string) => boolean = () => true,
): void {
	if (!(cursor instanceof JsonCursorImpl)) return;
	const entry =
		by.subject === null ? undefined : inventoryIndex().entry(by.code);
	for (const key of Object.keys(cursor.value)) {
		if (!within(key) || !cursor.used(key)) continue;
		const site = { json: cursor, key };
		if (ctx.accounting.holder(site) !== undefined) continue;
		const surfaceKey = `schema:${cursor.cls}.${key}`;
		if (entry?.surfaceKeys.includes(surfaceKey) === true)
			ctx.accounting.claimEntry(
				site,
				entry.id,
				surfaceKey,
				by.place,
				by.detail,
			);
		else ctx.accounting.cover(site, by);
	}
}

/**
 * Claims what is left of `cursor` under the last finding of `code` (a manifest entry's id, or a
 * circumstance, then naming `name`) raised at `place` (`claimRestUnder`); nothing where no such
 * finding stands.
 */
export function claimRestUnderFinding(
	ctx: ReadContext,
	cursor: JsonCursor,
	finding: {
		readonly code: string;
		readonly place: HqPlace;
		readonly name?: string;
	},
	within?: (key: string) => boolean,
): void {
	const by = findingOf(ctx, finding.code, finding.place, finding.name);
	if (by !== undefined) claimRestUnder(ctx, cursor, by, within);
}

/**
 * Claims what is left of a refused column under its refusal: the refusal a claim on one of the
 * column's own keys declared, the keys that say what the column is first (`DECISIVE_KEYS`), then
 * the rest in the column's order. Nothing is claimed where no key of the column carries a refusal.
 */
export function claimRestOfRefusedColumn(
	ctx: ReadContext,
	column: JsonCursor,
	within: (key: string) => boolean,
): void {
	if (!(column instanceof JsonCursorImpl)) return;
	const keys = Object.keys(column.value);
	const first = DECISIVE_KEYS.filter((key) => keys.includes(key));
	for (const key of [...first, ...keys.filter((one) => !first.includes(one))]) {
		const holder = ctx.accounting.holder({ json: column, key });
		if (holder === undefined || holder === "held" || holder.use !== "refuse")
			continue;
		const by = findingOf(ctx, holder.entry, column.place);
		if (by === undefined) continue;
		claimRestUnder(ctx, column, by, within);
		return;
	}
}
