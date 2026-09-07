import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type AppConnectId,
	connectIdsExcept,
} from "@/lib/doc/hooks/useAppConnectIds";

it("excludes only the edited block while preserving co-located and cross-form IDs", () => {
	const first = testUuid("connect-first");
	const second = testUuid("connect-second");
	const ids: AppConnectId[] = [
		{ formUuid: first, kind: "learn_module", id: "lesson" },
		{ formUuid: first, kind: "assessment", id: "quiz" },
		{ formUuid: second, kind: "learn_module", id: "lesson_two" },
	];
	expect(connectIdsExcept(ids, first, "learn_module")).toEqual(
		new Set(["quiz", "lesson_two"]),
	);
	expect(connectIdsExcept(ids, first, "assessment")).toEqual(
		new Set(["lesson", "lesson_two"]),
	);
	expect(connectIdsExcept(ids, second, "learn_module")).toEqual(
		new Set(["lesson", "quiz"]),
	);
});
