import type { SavedSearchAddressDefault } from "@/lib/domain/modules";
import { w } from "../../xpath/wire/builders";

export function savedAddressDefaultWire(value: SavedSearchAddressDefault) {
	return typeof value === "string"
		? w.str(value)
		: w.call(
				"concat",
				value.map((part) => w.str(part)),
			);
}
