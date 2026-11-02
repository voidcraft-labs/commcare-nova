/**
 * The one birth rule for a group's `fieldList`: a new group shows its
 * questions on one screen when its label has text and it holds no repeat
 * workers add entries to. The plausible failures are an unlabelled group
 * turned into a one-screen page, and a group born holding a user repeat
 * with the flag the validator then refuses.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { groupBornFieldList } from "../fields";
import { EMPTY_PROSE_TEMPLATE, proseText } from "../prose";

const labelled = proseText("Household");

describe("groupBornFieldList", () => {
	it("gives a labelled group with no user repeat the flag", () => {
		expect(
			groupBornFieldList({ label: labelled, holdsUserRepeat: false }),
		).toBe(true);
	});

	it("leaves a labelled group holding a user repeat without it", () => {
		expect(
			groupBornFieldList({ label: labelled, holdsUserRepeat: true }),
		).toBeUndefined();
	});

	it("leaves a group with no label without it", () => {
		expect(groupBornFieldList({ holdsUserRepeat: false })).toBeUndefined();
		expect(groupBornFieldList({ holdsUserRepeat: true })).toBeUndefined();
	});

	it("reads a label with no parts as no label", () => {
		expect(
			groupBornFieldList({
				label: EMPTY_PROSE_TEMPLATE,
				holdsUserRepeat: false,
			}),
		).toBeUndefined();
		expect(
			groupBornFieldList({ label: proseText(""), holdsUserRepeat: false }),
		).toBeUndefined();
	});

	it("reads a label made only of a reference as text", () => {
		expect(
			groupBornFieldList({
				label: { parts: [{ kind: "field-ref", uuid: testUuid("name") }] },
				holdsUserRepeat: false,
			}),
		).toBe(true);
	});
});
