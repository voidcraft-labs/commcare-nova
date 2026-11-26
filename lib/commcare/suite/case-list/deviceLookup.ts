import type { DeviceLookupExtra } from "@/lib/domain/modules";
import { w } from "../../xpath/wire/builders";
import { sessionContextPath } from "../../xpath/wire/fromExpression";
import type { WireExpr } from "../../xpath/wire/tree";

/** Values the companion receives before the worker chooses a case. */
export function deviceLookupExtraWire(extra: DeviceLookupExtra): WireExpr {
	return "value" in extra
		? w.str(extra.value)
		: sessionContextPath(extra.expression.term.field);
}
