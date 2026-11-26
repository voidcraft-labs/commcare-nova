import type { Uuid } from "@/lib/domain/uuid";
import { caseTextWireKey } from "../../suite/case-list/calculationText";
import { keyAsVariable } from "../../suite/case-list/keyVariable";
import { chargeWork } from "../../workMeter";
import { visitSyntax } from "../../xpath/formSyntax";
import { sharedFormSyntax } from "../syntaxRead";

/** Evaluate HQ's actual ordered replacement before assigning identities. Its
 * substring replacement also changes quoted literals and property names. The
 * parser then identifies genuine variables for the one scope that owns them. */
export function nativeCalculationText(
	field: string,
	keys: readonly string[],
	variableName: (key: string, index: number) => string,
): string {
	let effective = field;
	const names = new Map<string, string>();
	for (const [index, key] of keys.entries()) {
		const native = keyAsVariable(key);
		chargeWork("compare", effective.length);
		effective = effective.replaceAll(native.slice(1), () => native);
		names.set(native, variableName(key, index));
	}
	const parsed = sharedFormSyntax(effective);
	if (!parsed.ok || !parsed.node) return effective;
	const canonical = new Set(names.values());
	const changes: { from: number; to: number; name: string }[] = [];
	visitSyntax(parsed.node, (node) => {
		if (node.kind === "variable") {
			const name =
				names.get(node.name) ??
				(canonical.has(node.name) ? `unbound_${node.name}` : undefined);
			if (name !== undefined)
				changes.push({ from: node.from, to: node.to, name });
		}
	});
	let result = "",
		position = 0;
	for (const { from, to, name } of changes) {
		result += `${effective.slice(position, from)}$${name}`;
		position = to;
	}
	return result + effective.slice(position);
}

/** The parser binds each translated variable to its piece in this column. */
export function bindCalculationText(
	field: string,
	keys: readonly string[],
	pieces: readonly { uuid: Uuid }[],
): string {
	return nativeCalculationText(field, keys, (_key, index) =>
		caseTextWireKey(pieces[index].uuid),
	);
}
