import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	continuesPreviewCommand,
	continuesPreviewTask,
} from "../../taskContinuation";

it("limits continuation to its exact form and ordered selector modules", () => {
	const moduleUuid = testUuid("module"),
		formUuid = testUuid("form"),
		parent = testUuid("parent");
	const task = {
		moduleUuid,
		formUuid,
		selectingModuleUuids: [parent, moduleUuid],
		caseDatabase: { rows: [], indices: [] },
	};
	for (const selector of task.selectingModuleUuids)
		expect(
			continuesPreviewTask(task, { kind: "cases", moduleUuid: selector }),
		).toBe(true);
	expect(
		continuesPreviewTask(task, { kind: "form", moduleUuid, formUuid }),
	).toBe(true);
	expect(
		continuesPreviewTask(task, {
			kind: "form",
			moduleUuid,
			formUuid: testUuid("other"),
		}),
	).toBe(false);
	expect(continuesPreviewTask(task, { kind: "module", moduleUuid })).toBe(
		false,
	);
	const withReturn = { ...task, returnModuleUuid: moduleUuid };
	expect(continuesPreviewTask(withReturn, { kind: "module", moduleUuid })).toBe(
		true,
	);
	expect(
		continuesPreviewCommand(withReturn, { kind: "module", moduleUuid }),
	).toBe(false);
	expect(continuesPreviewTask(task, { kind: "home" })).toBe(false);
	expect(
		continuesPreviewTask(
			{ ...task, formUuid: undefined, selectingModuleUuids: [] },
			{ kind: "module", moduleUuid },
		),
	).toBe(true);
});
