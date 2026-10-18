import { w } from "@/lib/commcare/xpath/wire/builders";
import type { WireTermBindings } from "@/lib/commcare/xpath/wire/fromExpression";
import { ownRecordValue, USERCASE_CASE_TYPE } from "@/lib/domain";
import type { CaseDatabaseSnapshot } from "./xpathInstances";

/** A restored worker record always wins. A scenario or an entry without that
 * record retains Preview's existing identity projection; no row is invented. */
export function previewWorkerPropertyBinding(
	userId: string | undefined,
	usercase: Readonly<Record<string, string>> | undefined,
	cases: CaseDatabaseSnapshot | null | undefined,
): NonNullable<WireTermBindings["workerProperty"]> {
	return (property) => {
		if (
			userId === undefined ||
			cases?.rows.some(
				(row) =>
					row.case_type === USERCASE_CASE_TYPE &&
					ownRecordValue(row.properties, "hq_user_id") === userId,
			)
		)
			return undefined;
		return w.str(
			usercase === undefined ? "" : (ownRecordValue(usercase, property) ?? ""),
		);
	};
}
