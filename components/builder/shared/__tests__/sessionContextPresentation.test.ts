import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	SESSION_CONTEXT_FIELDS,
	sessionContext,
	sessionUser,
	sessionUserProperty,
	term,
} from "@/lib/domain/expression";
import {
	SESSION_CONTEXT_CHOICES,
	sessionContextPresentation,
	sessionUserPresentation,
} from "../sessionContextPresentation";

describe("saved app information", () => {
	it.each([
		["drift", "Device clock offset"],
		["window_width", "Window width"],
		["applanguage", "App language"],
	] as const)(
		"keeps %s visible without offering an editor or substituting user ID",
		(field, label) => {
			const reference = sessionContext(field);
			const saved = term(reference);
			const before = structuredClone(saved);
			const presentation = sessionContextPresentation(reference.field);
			expect(presentation).toEqual({ kind: "preserved", field, label });
			expect(presentation.label).not.toBe("Current user's ID");
			expect(saved).toEqual(before);
		},
	);

	it("retains every stored session field while offering the four supported choices", () => {
		expect(
			SESSION_CONTEXT_FIELDS.map(
				(field) => sessionContextPresentation(field).field,
			),
		).toEqual(SESSION_CONTEXT_FIELDS);
		expect(SESSION_CONTEXT_CHOICES.map(({ field }) => field)).toEqual([
			"userid",
			"username",
			"deviceid",
			"appversion",
		]);
	});
});

describe("saved worker information", () => {
	const district = {
		uuid: testUuid("worker-district"),
		slug: "district",
		label: "District",
	};

	it("keeps a built-in worker-record read distinct from editable session data", () => {
		const session = sessionUser("commcare_first_name");
		const worker = { ...session, source: "worker-record" as const };
		expect(sessionUserPresentation(session, [])).toEqual({
			kind: "editable",
			reference: session,
			label: "First name",
		});
		expect(sessionUserPresentation(worker, [])).toEqual({
			kind: "preserved",
			reference: worker,
			label: "First name from the worker record",
		});
	});

	it("resolves a custom worker-record label by identity after its name changes", () => {
		const session = sessionUserProperty(district.uuid);
		const worker = { ...session, source: "worker-record" as const };
		const renamed = { ...district, slug: "region", label: "Service region" };
		expect(sessionUserPresentation(session, [renamed]).kind).toBe("editable");
		expect(sessionUserPresentation(worker, [renamed])).toEqual({
			kind: "preserved",
			reference: worker,
			label: "Service region from the worker record",
		});
	});

	it("keeps an unavailable custom worker record read-only without selecting another property", () => {
		const worker = {
			...sessionUserProperty(testUuid("missing-worker-property")),
			source: "worker-record" as const,
		};
		expect(sessionUserPresentation(worker, [district])).toEqual({
			kind: "preserved",
			reference: worker,
			label: "Unavailable worker information from the worker record",
		});
	});
});
