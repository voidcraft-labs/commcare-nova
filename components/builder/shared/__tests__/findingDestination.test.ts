/**
 * Contract: `findingOpenAction` opens the place a finding names, the same way
 * for the case-list workspace's selection review and the platform section's
 * refusal block. A finding the selection review opened before the helper was
 * extracted keeps its destination (a chosen-case finding among them), and
 * the two platform arms send a Search or case-list feature to the screen
 * where it is changed. `mediaLocationOpenAction` opens a refused media
 * reference's carrier.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { StructuredCommitFinding } from "@/lib/doc/hooks/useBlueprintMutations";
import type { MediaRefLocation } from "@/lib/domain/mediaRefs";
import type { NavigateActions } from "@/lib/routing/navigation";
import {
	findingOpenAction,
	findingTargetName,
	mediaLocationOpenAction,
} from "../findingDestination";

const MODULE = testUuid("destination-module");
const FORM = testUuid("destination-form");
const FIELD = testUuid("destination-field");
const OPERATION = testUuid("destination-operation");
const LINK = testUuid("destination-link");
const OPTION = testUuid("destination-option");

/** A NavigateActions that records each call by name and arguments. */
function recordingNavigate() {
	const calls: unknown[][] = [];
	const navigate = new Proxy(
		{},
		{
			get:
				(_target, name) =>
				(...args: unknown[]) => {
					calls.push([name, ...args]);
				},
		},
	) as NavigateActions;
	return { calls, navigate };
}

function opened(finding: StructuredCommitFinding): unknown[][] {
	const { calls, navigate } = recordingNavigate();
	const open = findingOpenAction(finding, navigate);
	open?.();
	return calls;
}

function finding(
	code: string,
	location: StructuredCommitFinding["location"],
	details?: Record<string, string>,
): StructuredCommitFinding {
	return {
		code,
		scope: location.formUuid !== undefined ? "form" : "module",
		location,
		...(details !== undefined && { details }),
	};
}

const IN_FORM = { moduleUuid: MODULE, formUuid: FORM };

describe("a finding opens the place it names", () => {
	it("opens a case operation's finding at that operation", () => {
		expect(
			opened(
				finding("CASE_OPERATION_X", IN_FORM, { operationUuid: OPERATION }),
			),
		).toEqual([["openFormOperations", MODULE, FORM, OPERATION]]);
	});

	it("opens a form link's finding at that link", () => {
		expect(
			opened(finding("FORM_LINK_TARGET_MISSING", IN_FORM, { linkUuid: LINK })),
		).toEqual([["openFormLinks", MODULE, FORM, LINK]]);
		expect(
			opened(finding("XPATH_X", IN_FORM, { surface: "form_link_datum_xpath" })),
		).toEqual([["openFormLinks", MODULE, FORM, undefined]]);
	});

	it("opens a display condition's finding at the form's condition", () => {
		expect(
			opened(
				finding("XPATH_X", IN_FORM, { surface: "form_display_condition" }),
			),
		).toEqual([["openFormCondition", MODULE, FORM]]);
	});

	it("opens a field's finding at the form with the field selected", () => {
		expect(
			opened(
				finding(
					"PLATFORM_FEATURE_UNAVAILABLE",
					{ ...IN_FORM, fieldUuid: FIELD, fieldId: "visit_at" },
					{ feature: "datetime-question", platform: "web-apps" },
				),
			),
		).toEqual([["openForm", MODULE, FORM, FIELD]]);
	});

	it("keeps a chosen-case finding's destination, the form", () => {
		expect(
			opened(
				finding("SESSION_DATUM_NOT_SUPPLIED", IN_FORM, {
					carrier: "chosen-case",
				}),
			),
		).toEqual([["openForm", MODULE, FORM, undefined]]);
	});

	it("opens a Search feature's finding in the module's Search settings", () => {
		for (const feature of [
			"search-first",
			"search-field-single-date",
			"search-field-multiple-choice",
		])
			expect(
				opened(
					finding(
						"PLATFORM_FEATURE_UNAVAILABLE",
						{ moduleUuid: MODULE },
						{ feature, platform: "android" },
					),
				),
			).toEqual([["openSearchConfig", MODULE]]);
	});

	it("opens a case-list feature's finding in the module's case list", () => {
		for (const [feature, platform] of [
			["several-cases", "android"],
			["case-list-here", "web-apps"],
		])
			expect(
				opened(
					finding(
						"PLATFORM_FEATURE_UNAVAILABLE",
						{ moduleUuid: MODULE },
						{ feature, platform },
					),
				),
			).toEqual([["openCaseList", MODULE]]);
	});

	it("opens any other module finding at the module", () => {
		expect(
			opened(finding("MODULE_X", { moduleUuid: MODULE }, { surface: "x" })),
		).toEqual([["openModule", MODULE]]);
	});

	it("opens nothing for a finding located at the app", () => {
		const { navigate } = recordingNavigate();
		expect(
			findingOpenAction(
				{
					code: "PLATFORM_FEATURE_UNAVAILABLE",
					scope: "app",
					location: {},
					details: { feature: "connect-app", platform: "web-apps" },
				},
				navigate,
			),
		).toBeUndefined();
	});

	it("names the field, else the form, else the module", () => {
		expect(
			findingTargetName({
				fieldId: "visit_at",
				formName: "Visit",
				moduleName: "Visits",
			}),
		).toBe("visit_at");
		expect(findingTargetName({ formName: "Visit", moduleName: "Visits" })).toBe(
			"Visit",
		);
		expect(findingTargetName({ moduleName: "Visits" })).toBe("Visits");
		expect(findingTargetName({})).toBe("this item");
	});
});

describe("a refused media reference opens its carrier", () => {
	function openedAt(location: MediaRefLocation): unknown[][] {
		const { calls, navigate } = recordingNavigate();
		mediaLocationOpenAction(location, navigate)?.();
		return calls;
	}
	const form = {
		moduleUuid: MODULE,
		moduleName: "Visits",
		formUuid: FORM,
		formName: "Visit",
	};

	it("opens a field's or an option's media at the field", () => {
		expect(
			openedAt({
				kind: "option_media",
				...form,
				fieldUuid: FIELD,
				fieldId: "consent",
				optionUuid: OPTION,
				optionValue: "yes",
			}),
		).toEqual([["openForm", MODULE, FORM, FIELD]]);
	});

	it("opens a form's icon at the form, a module's at the module, and a case list's at the case list", () => {
		expect(openedAt({ kind: "form_icon", ...form })).toEqual([
			["openForm", MODULE, FORM],
		]);
		expect(
			openedAt({
				kind: "module_audio_label",
				moduleUuid: MODULE,
				moduleName: "Visits",
			}),
		).toEqual([["openModule", MODULE]]);
		expect(
			openedAt({
				kind: "case_list_icon",
				moduleUuid: MODULE,
				moduleName: "Visits",
			}),
		).toEqual([["openCaseList", MODULE]]);
	});

	it("opens nothing for the app logo, which sits beside the block", () => {
		const { navigate } = recordingNavigate();
		expect(
			mediaLocationOpenAction({ kind: "app_logo" }, navigate),
		).toBeUndefined();
	});
});
