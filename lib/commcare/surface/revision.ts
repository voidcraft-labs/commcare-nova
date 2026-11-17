// lib/commcare/surface/revision.ts
//
// Whether a surface key is one the manifest declares: a key of CommCare's own
// schema, and so no content of an app. A name that is not declared may be an
// author's question id, a JSON key an app wrote, a file path or a table's
// tag, so whatever titles a log line asks here before it prints a name.

import gateEntries from "./entries/gates.json";
import { inventoryIndex } from "./inventory";
import { gateEntriesFileSchema } from "./schema";

let GATE_KEYS: ReadonlySet<string> | undefined;

/** True where some manifest entry's `surfaceKeys` holds the key: a key of CommCare's own schema,
 *  and no content of an app. Computed once per process over `lib/commcare/surface/entries/*.json`. */
export function isDeclaredSurfaceKey(key: string): boolean {
	if (inventoryIndex().naming(key).length > 0) return true;
	GATE_KEYS ??= new Set(
		gateEntriesFileSchema
			.parse(gateEntries)
			.flatMap((gate) => gate.surfaceKeys),
	);
	return GATE_KEYS.has(key);
}
