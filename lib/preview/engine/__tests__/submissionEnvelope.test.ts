import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { CaptureSubmissionRejectedError } from "@/lib/case-store/errors";
import {
	type BuiltSubmissionOperations,
	submissionEnvelopeArgs,
} from "../caseDataBindingHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";

const protocol = {
	formUuid: testUuid("10000000-0000-4000-8000-000000000001"),
	entryKey: "10000000-0000-4000-8000-000000000002",
	attachmentRefs: [],
} as const;

function committedSurvey(): BuiltSubmissionOperations {
	return {
		ordinaryAction: { kind: "none" },
		ordinaryFormType: "survey",
		submissionReceipt: {
			entryKey: protocol.entryKey,
			formUuid: protocol.formUuid,
			expectedAppMutationSeq: 7,
			blueprintDigest: "0".repeat(64),
			requestDigest: "accepted-request",
		},
	};
}

describe("submission envelope authority", () => {
	it("uses the committed selection and program, never the client's", () => {
		const mutation: SubmissionMutation = {
			...protocol,
			kind: "followup",
			caseIds: ["case-1"],
		};
		const built: BuiltSubmissionOperations = {
			...committedSurvey(),
			ordinaryFormType: "followup",
			ordinaryAction: {
				kind: "followup",
				caseIds: ["case-1"],
				caseType: "patient",
				selection: { kind: "single", maximum: 1 },
			},
		};

		const envelope = submissionEnvelopeArgs(mutation, "app-1", built);
		expect(envelope.ordinary).toBe(built.ordinaryAction);
		expect(envelope.submissionReceipt).toBe(built.submissionReceipt);
		// The worker's record is an operation of the program, never a slot the
		// client fills.
		expect(Object.keys(envelope).sort()).toEqual([
			"appId",
			"ordinary",
			"submissionReceipt",
		]);
	});

	it("refuses a client form kind that differs from the committed form", () => {
		expect(() =>
			submissionEnvelopeArgs(
				{
					...protocol,
					kind: "close",
					caseIds: ["case-1"],
				},
				"app-1",
				committedSurvey(),
			),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("cannot produce an envelope without a durable receipt, even for a survey", () => {
		const { submissionReceipt: _receipt, ...unclaimed } = committedSurvey();
		expect(() =>
			submissionEnvelopeArgs(
				{ ...protocol, kind: "survey" },
				"app-1",
				unclaimed,
			),
		).toThrow();
	});
});
