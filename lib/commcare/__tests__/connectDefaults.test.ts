/**
 * Connect wire-emit defaults — the "doc tracks what was set, the wire
 * layer fills the rest" contract for the configurable-but-rarely-
 * customized Connect XPath slots.
 *
 * The load-bearing assertion is BYTE identity: a doc whose assessment
 * carries no `user_score` must emit the exact same XForm bytes as one
 * that explicitly set the canonical default — proving the default is a
 * pure emit-time substitution, not a different wire shape. `buildXForm`
 * is called directly with a pinned xmlns because `expandDoc` mints a
 * fresh formdesigner xmlns per call, which would make whole-document
 * byte comparison meaningless.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	DEFAULT_ASSESSMENT_USER_SCORE,
	effectiveAssessmentUserScore,
} from "@/lib/commcare/connectDefaults";
import type { ResolvedConnectConfig } from "@/lib/commcare/connectSlugs";
import { buildXForm } from "@/lib/commcare/xform";

const XMLNS = "http://openrosa.org/formdesigner/connect-defaults-test";

/** One learn-app survey form carrying `connect`, emitted with a pinned
 *  xmlns so two emissions are byte-comparable. */
function emitAssessmentForm(connect: ResolvedConnectConfig): string {
	const doc = buildDoc({
		appName: "Quiz App",
		connectType: "learn",
		modules: [
			{
				name: "Training",
				forms: [
					{
						name: "Quiz",
						type: "survey",
						connect,
						fields: [f({ kind: "text", id: "feedback", label: "Feedback" })],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	return buildXForm(doc, formUuid, { xmlns: XMLNS, connect });
}

describe("assessment user_score wire default", () => {
	it("an unset user_score emits byte-identically to the explicit canonical default", () => {
		const explicit = emitAssessmentForm({
			assessment: {
				id: "intro_quiz",
				user_score: DEFAULT_ASSESSMENT_USER_SCORE,
			},
		});
		const unset = emitAssessmentForm({ assessment: { id: "intro_quiz" } });

		expect(unset).toBe(explicit);
		// And the shared bytes carry the default on the user_score bind.
		expect(unset).toContain(`calculate="${DEFAULT_ASSESSMENT_USER_SCORE}"`);
	});

	it("an explicit custom expression wins over the default", () => {
		const custom = emitAssessmentForm({
			assessment: { id: "intro_quiz", user_score: "#form/feedback" },
		});
		expect(custom).not.toContain(
			`calculate="${DEFAULT_ASSESSMENT_USER_SCORE}"`,
		);
		expect(custom).toContain("/data/feedback");
	});

	it("resolves absent and empty to the default, explicit values verbatim", () => {
		expect(effectiveAssessmentUserScore({ user_score: "#form/score" })).toBe(
			"#form/score",
		);
		expect(effectiveAssessmentUserScore({})).toBe(
			DEFAULT_ASSESSMENT_USER_SCORE,
		);
		// An explicit empty string still falls through — `<bind calculate=""/>`
		// is a CCHQ build rejection, and the validator's CONNECT_EMPTY_XPATH
		// flags the doc state itself.
		expect(effectiveAssessmentUserScore({ user_score: "" })).toBe(
			DEFAULT_ASSESSMENT_USER_SCORE,
		);
	});
});
