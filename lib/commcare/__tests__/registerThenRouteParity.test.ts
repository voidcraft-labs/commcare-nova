/**
 * Register-then-route, held identical on all three surfaces at once.
 *
 * A registration form links to a follow-up on the case it just created.
 * The whole pattern rests on ONE identity — the session variable
 * `case_id_new_<type>_0`, which the entry mints, the guard reads, and the
 * pushed frame carries into the target's `case_id` — and that identity has
 * to mean the same thing on the local `.ccz`, after an HQ import, and in
 * the running preview.
 *
 * They are asserted TOGETHER rather than in three files because the
 * failure mode is divergence, not breakage. Three separate tests can each
 * keep passing while the surfaces drift apart: the suite carries the new
 * case forward, HQ regenerates a frame that carries a different one, and
 * the preview routes on the pre-submission row. Nothing is red, and a
 * worker is dropped on a case list to re-pick the client he just
 * registered.
 *
 * The three claims, one per surface:
 *
 *   - **`.ccz`** — the emitted `<create>` names the target's `case_id`
 *     datum reading `.../case_id_new_patient_0`, under an `if` anchored on
 *     that same variable.
 *   - **HQ JSON** — the payload carries the verbatim guard, the `form`
 *     workflow (without which `form_workflow_frames` ignores every link),
 *     and the two facts HQ's own matcher joins on: the source form creates
 *     a `patient`, and the target module's case type is `patient`.
 *     `_find_best_match` pairs a target datum with a source datum of the
 *     same case type and a different id, which is exactly this pair.
 *   - **preview** — the guard evaluates against the case AS WRITTEN by
 *     this submission, so a projection carrying the new case's value takes
 *     the link and one that does not falls through.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { asUuid } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";
import { endOfFormLinkTarget } from "@/lib/preview/engine/displayConditionEvaluation";
import type { PreviewSearchSessionValues } from "@/lib/preview/engine/identity";

const MODULE = "mod-patients";
const REGISTER = "frm-register";
const FOLLOW_UP = "frm-follow-up";

/** The one authored condition every surface below lowers. */
const CONDITION = eq(prop("patient", "intake_stage"), literal("new"));

/** The session variable the whole pattern turns on. */
const NEW_CASE_ID =
	"instance('commcaresession')/session/data/case_id_new_patient_0";

const PREVIEW_SESSION: PreviewSearchSessionValues = {
	context: { deviceid: "nova-preview", appversion: "preview" },
	user: {},
};

function registerThenRouteDoc() {
	return buildDoc({
		appName: "Clinic",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "intake_stage", label: "Intake stage", data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: REGISTER,
						name: "Register",
						type: "registration",
						formLinks: [
							{
								condition: CONDITION,
								target: {
									type: "form",
									moduleUuid: asUuid(MODULE),
									formUuid: asUuid(FOLLOW_UP),
								},
							},
						],
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "intake_stage",
								label: "Intake stage",
								case_property_on: "patient",
							}),
						],
					},
					{
						uuid: FOLLOW_UP,
						name: "Follow up",
						type: "followup",
						fields: [f({ kind: "text", id: "notes", label: "Notes" })],
					},
				],
			},
		],
	});
}

describe("register then route — one identity on three surfaces", () => {
	it("carries the case the form just created into the follow-up", () => {
		const doc = registerThenRouteDoc();
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => e.code),
		).toEqual([]);

		// ── The guard, as both wire surfaces spell it ────────────────
		const hq = expandDoc(doc);
		const link = hq.modules[0].forms[0].form_links[0];
		expect(link.target).toEqual({
			type: "form",
			moduleIndex: 0,
			formIndex: 1,
		});
		// Anchored on the case the form creates, not on the loaded case a
		// follow-up would read: `endOfFormCaseAnchor` picks
		// `case_id_new_<type>_0` for a registration form.
		expect(link.condition).toContain(NEW_CASE_ID);

		// ── Surface 1: the local `.ccz` ──────────────────────────────
		const suite = new AdmZip(compileCcz(hq, "Clinic", doc)).readAsText(
			"suite.xml",
		);
		const stack = registerEntryStack(suite);
		// The frame reaches the follow-up AND carries the new case into its
		// `case_id`. Without the datum the frame stops at the case list and
		// the worker re-picks the client he just registered.
		expect(stack).toContain('<command value="&apos;m0&apos;"/>');
		expect(stack).toContain('<command value="&apos;m0-f1&apos;"/>');
		expect(stack).toContain(
			`<datum id="case_id" value="${xmlAttr(NEW_CASE_ID)}"/>`,
		);
		// And the same variable gates the frame.
		expect(stack).toContain(`if="${xmlAttr(link.condition ?? "")}"`);

		// ── Surface 2: the HQ payload ────────────────────────────────
		// HQ derives the frame itself, so parity here is the INPUT its
		// matcher joins on rather than the frame: same workflow, same
		// verbatim guard, and a source datum whose case type equals the
		// target module's.
		expect(hq.modules[0].forms[0].post_form_workflow).toBe("form");
		expect(hq.modules[0].case_type).toBe("patient");
		expect(hq.modules[0].forms[0].actions.open_case.condition.type).toBe(
			"always",
		);
		// A terminal unconditional link would suppress this; this link is
		// conditional, so the fallback stays reachable and is named.
		expect(hq.modules[0].forms[0].post_form_workflow_fallback).toBe("default");

		// ── Surface 3: the running preview ───────────────────────────
		const form = doc.forms[asUuid(REGISTER)];
		const taken = endOfFormLinkTarget({
			form,
			session: PREVIEW_SESSION,
			currentCaseType: "patient",
			// The case AS WRITTEN by this submission — the device nulls its
			// casedb initializer before running stack ops precisely so the
			// guard sees these values.
			caseProjection: new Map([["intake_stage", "new"]]),
			lookup: { kind: "idle" },
		});
		expect(taken).toEqual({
			kind: "link",
			target: {
				type: "form",
				moduleUuid: asUuid(MODULE),
				formUuid: asUuid(FOLLOW_UP),
			},
		});

		// The same guard over the value the form did NOT write falls through
		// to the form's own post-submit destination.
		expect(
			endOfFormLinkTarget({
				form,
				session: PREVIEW_SESSION,
				currentCaseType: "patient",
				caseProjection: new Map([["intake_stage", "returning"]]),
				lookup: { kind: "idle" },
			}),
		).toEqual({ kind: "fallback" });
	});
});

/** The `<stack>` body of the registration form's entry (`m0-f0`). */
function registerEntryStack(suite: string): string {
	const entries = suite.split("<entry>");
	const entry = entries.find((candidate) =>
		candidate.includes('<command id="m0-f0"'),
	);
	if (entry === undefined) throw new Error("no m0-f0 entry in suite.xml");
	const start = entry.indexOf("<stack>");
	const end = entry.indexOf("</stack>");
	if (start < 0 || end < 0) throw new Error("m0-f0 entry has no <stack>");
	return entry.slice(start, end);
}

/** The serializer's escaping of an XPath string inside a double-quoted attribute. */
function xmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
