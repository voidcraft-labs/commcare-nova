import type { Uuid } from "@/lib/domain";
import type { CaseMappingRow } from "@/lib/domain/caseMappingRows";
import type { RewriteControl } from "../../emissionRewrites";
import type { ModuleExpressionContexts } from "../../expressionContext";
import {
	identityLookupWireNaming,
	type LookupWireNaming,
} from "../../lookup/naming";
import { w } from "../../xpath/wire/builders";
import { toWire, type WireBuildContext } from "../../xpath/wire/fromExpression";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import { INLINE_SEARCH_INPUT_INSTANCE_ID } from "../case-search/noMatches";
import { hqMappingKeyIsExpression, keyAsVariable } from "./keyVariable";

export interface MappingScope {
	expressions: ModuleExpressionContexts;
	lookupNaming?: LookupWireNaming;
	inline: boolean;
}

export function mappingCondition(
	columnUuid: Uuid,
	row: CaseMappingRow,
	subject: WireExpr,
	scope: MappingScope,
	target: WireBuildContext["target"],
	root?: WireBuildContext["root"],
	rewrites?: RewriteControl,
): WireExpr {
	if (row.when) {
		if (!row.uuid)
			throw new Error("A condition must identify its mapping row.");
		return toWire(row.when, {
			target,
			root,
			rewrites,
			types: scope.expressions({
				slot: "case_list_mapping_condition",
				member: { columnUuid, rowUuid: row.uuid },
			}),
			bindings: {
				lookup: {
					naming: scope.lookupNaming ?? identityLookupWireNaming(),
					instanceScope: "suite",
				},
				...(scope.inline && {
					searchInputInstanceId: INLINE_SEARCH_INPUT_INSTANCE_ID,
				}),
			},
		});
	}
	if (row.value === undefined)
		throw new Error("A mapping row needs a condition or saved value.");
	return row.match === "exact"
		? w.eq(subject, w.str(row.value))
		: w.call("selected", [subject, w.str(row.value)]);
}

/** HQ's editor interprets punctuation in a key as XPath. A literal needing
 * protection is compared with its own column's value. A typed condition
 * names the properties it reads, even when another property supplies the column. */
function nativeMappingKey(
	columnUuid: Uuid,
	row: CaseMappingRow,
	scope: MappingScope,
	rewrites?: RewriteControl,
): string | WireExpr {
	if (row.when)
		return w.paren(
			mappingCondition(
				columnUuid,
				row,
				w.context([w.self()]),
				scope,
				"hq-json",
				undefined,
				rewrites,
			),
		);
	if (
		row.match === "exact" &&
		row.value !== undefined &&
		!hqMappingKeyIsExpression(row.value)
	)
		return row.value;
	return mappingCondition(
		columnUuid,
		row,
		w.context([w.self()]),
		scope,
		"hq-json",
	);
}

export function mappingKeyText(
	key: ReturnType<typeof nativeMappingKey>,
): string {
	return typeof key === "string"
		? key
		: serializeWire(key, { target: "hq-json", interpolation: "enum-key" }).text;
}

/** The editor requires distinct key text, and HQ uses a shortened digest
 * for the locale variable of an XPath key. Grouping a condition preserves its
 * value while giving each row an independent native variable and text unit. */
export function nativeMappingKeys(
	columnUuid: Uuid,
	rows: readonly CaseMappingRow[],
	scope: MappingScope,
	rewrites?: (uuid: Uuid) => RewriteControl | undefined,
): (string | WireExpr)[] {
	const used = new Set<string>();
	return rows.map((row) => {
		let key = nativeMappingKey(
			columnUuid,
			row,
			scope,
			row.uuid && rewrites?.(row.uuid),
		);
		let name = keyAsVariable(mappingKeyText(key));
		while (used.has(name)) {
			key = w.paren(
				typeof key === "string" ? w.eq(w.context([w.self()]), w.str(key)) : key,
			);
			name = keyAsVariable(mappingKeyText(key));
		}
		used.add(name);
		return key;
	});
}
