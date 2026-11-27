import type { SavedSearchAddressDefault } from "@/lib/domain/modules";
import { w } from "../../xpath/wire/builders";
import { sessionContextPath } from "../../xpath/wire/fromExpression";

export function savedAddressDefaultWire(value: SavedSearchAddressDefault) {
	if (typeof value === "string") return w.str(value);
	return w.call(
		"concat",
		Array.isArray(value)
			? value.map((part) => w.str(part))
			: [w.str(value.prefix), sessionContextPath(value.worker)],
	);
}
