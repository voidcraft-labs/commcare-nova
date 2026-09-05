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
		ordinaryChildRelationships: new Map(),
		usercaseWriteProperties: new Set(),
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
	it("uses the committed action even when the client proposes different destinations", () => {
		const mutation: SubmissionMutation = {
			...protocol,
			kind: "registration",
			primary: { caseType: "other", caseName: "Client", properties: {} },
			children: [],
		};
		const built: BuiltSubmissionOperations = {
			...committedSurvey(),
			ordinaryFormType: "registration",
			ordinaryAction: {
				kind: "registration",
				primary: { caseType: "patient", caseName: "Accepted", properties: {} },
				children: [],
			},
		};

		const envelope = submissionEnvelopeArgs(mutation, "app-1", built);
		expect(envelope.ordinary).toBe(built.ordinaryAction);
		expect(envelope.submissionReceipt).toBe(built.submissionReceipt);
	});

	it("retains only worker answers the committed form can write, including a cleared answer", () => {
		const built = committedSurvey();
		const envelope = submissionEnvelopeArgs(
			{
				...protocol,
				kind: "survey",
				usercase: { district: "", role: "admin" },
			},
			"app-1",
			{ ...built, usercaseWriteProperties: new Set(["district"]) },
		);
		expect(envelope.usercase).toEqual({ properties: { district: "" } });
	});

	it("refuses a client form kind that differs from the committed form", () => {
		expect(() =>
			submissionEnvelopeArgs(
				{
					...protocol,
					kind: "close",
					caseIds: ["case-1"],
					patch: { properties: {} },
					children: [],
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
