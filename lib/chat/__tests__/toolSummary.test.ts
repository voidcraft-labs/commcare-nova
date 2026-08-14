import type { ToolUIPart } from "ai";
import { describe, expect, it } from "vitest";
import type { ToolCallSummary } from "@/lib/agent/tools/shared/toolCallSummary";
import {
	isEditToolPart,
	toolAction,
	toolDetail,
	toolLocation,
} from "../toolSummary";

/** A completed tool part carrying a mutating-success output. */
const donePart = (tool: string, summary: ToolCallSummary): ToolUIPart =>
	({
		type: `tool-${tool}`,
		toolCallId: "call_1",
		state: "output-available",
		input: {},
		output: { message: "prose for the model", summary },
	}) as ToolUIPart;

/** An in-flight tool part — input received, no output yet. */
const pendingPart = (tool: string): ToolUIPart =>
	({
		type: `tool-${tool}`,
		toolCallId: "call_1",
		state: "input-available",
		input: {},
	}) as ToolUIPart;

describe("action tense follows the call's status", () => {
	it("reads as in-progress while the call is in flight", () => {
		expect(toolAction(pendingPart("addFields"))).toBe("Adding fields");
		expect(toolAction(pendingPart("createModule"))).toBe("Creating module");
		expect(toolAction(pendingPart("setCaseListFilter"))).toBe(
			"Updating available cases",
		);
		expect(toolAction(pendingPart("updateApp"))).toBe("Updating app settings");
		expect(toolAction(pendingPart("configureConnect"))).toBe(
			"Configuring CommCare Connect",
		);
		expect(toolAction(pendingPart("getCaseOperations"))).toBe(
			"Inspecting case operations",
		);
	});

	it("reads as done once the call succeeds", () => {
		expect(toolAction(donePart("createModule", { subject: "Clients" }))).toBe(
			'Created module "Clients"',
		);
		expect(
			toolAction(donePart("getCaseOperations", { location: "Edit" })),
		).toBe("Inspected case operations");
		expect(
			toolAction(donePart("configureCaseList", { location: "Patients" })),
		).toBe("Configured the case list");
	});

	it("keeps the in-progress form for a failure — the change never landed", () => {
		const errored = {
			type: "tool-addFields",
			toolCallId: "call_1",
			state: "output-error",
			input: {},
			errorText: "AI_ToolExecutionError: boom",
		} as ToolUIPart;
		expect(toolAction(errored)).toBe("Adding fields");

		const refused = {
			type: "tool-removeField",
			toolCallId: "call_1",
			state: "output-available",
			input: {},
			output: { error: "No field with that id exists." },
		} as ToolUIPart;
		expect(toolAction(refused)).toBe("Removing field");
	});

	it("falls back to the raw tool name in either tense for an unmapped tool", () => {
		expect(toolAction(pendingPart("someFutureTool"))).toBe("someFutureTool");
	});
});

describe("updateApp transcript row", () => {
	it("reads 'Named the app' with the title on the → line for a first name", () => {
		const part = donePart("updateApp", {
			subject: "Client Registration",
			nameChange: "named",
		});
		expect(toolAction(part)).toBe("Named the app");
		expect(toolLocation(part)).toBe("Client Registration");
		expect(toolDetail(part)).toBeNull();
	});

	it("reads 'Renamed the app' for a replacement name", () => {
		const part = donePart("updateApp", {
			subject: "Village Health",
			nameChange: "renamed",
		});
		expect(toolAction(part)).toBe("Renamed the app");
		expect(toolLocation(part)).toBe("Village Health");
	});

	it("falls back to the generic phrase for a row recorded before the facts existed", () => {
		const part = donePart("updateApp", { subject: "Client Registration" });
		expect(toolAction(part)).toBe("Updated app settings");
		expect(toolLocation(part)).toBe("Client Registration");
	});
});

describe("configureConnect transcript row", () => {
	it("names each exact target state directly", () => {
		expect(toolAction(donePart("configureConnect", { connect: "learn" }))).toBe(
			"Set CommCare Connect to Learn",
		);
		expect(
			toolAction(donePart("configureConnect", { connect: "deliver" })),
		).toBe("Set CommCare Connect to Deliver");
		expect(toolAction(donePart("configureConnect", { connect: "off" }))).toBe(
			"Turned off CommCare Connect",
		);
		expect(
			toolLocation(donePart("configureConnect", { connect: "learn" })),
		).toBeNull();
	});

	it("uses the in-progress phrase when a refused target writes nothing", () => {
		const refused = {
			type: "tool-configureConnect",
			toolCallId: "call_1",
			state: "output-available",
			input: {},
			output: { error: "A non-null mode requires participants." },
		} as ToolUIPart;
		expect(toolAction(refused)).toBe("Configuring CommCare Connect");
		expect(toolDetail(refused)).toBe("A non-null mode requires participants.");
	});
});

describe("generateSchema transcript row", () => {
	it("keeps the static headline with the type names on the → line", () => {
		// Not countable: the → line lists the recorded type names, so a
		// count in the headline would restate them — and the longer phrase
		// truncates in the chip.
		const part = donePart("generateSchema", {
			subject: "patient, visit, referral",
			count: 3,
		});
		expect(toolAction(part)).toBe("Recorded the data model");
		expect(toolLocation(part)).toBe("patient, visit, referral");
		expect(toolDetail(part)).toBeNull();
	});

	it("surfaces a refused schema commit as its error text", () => {
		const refused = {
			type: "tool-generateSchema",
			toolCallId: "call_1",
			state: "output-available",
			input: {},
			output: { error: "Nothing was recorded — …" },
		} as ToolUIPart;
		expect(toolAction(refused)).toBe("Recording the data model");
		expect(toolDetail(refused)).toBe("Nothing was recorded — …");
	});

	it("keeps planning-era parts out of the change summary — they wrote nothing", () => {
		// A thread persisted while generateSchema was a pure planning step:
		// its output is `{ planned: true, … }` and no mutation ever landed,
		// so rendering it as a completed doc change would assert an edit
		// history that never happened.
		const planningEra = {
			type: "tool-generateSchema",
			toolCallId: "call_1",
			state: "output-available",
			input: { appName: "Clinic", caseTypes: [] },
			output: { planned: true, appName: "Clinic", caseTypes: [] },
		} as ToolUIPart;
		expect(isEditToolPart(planningEra)).toBe(false);
		// Today's committing tool groups like any other edit tool — both a
		// completed commit and an in-flight call (no output yet).
		expect(
			isEditToolPart(donePart("generateSchema", { subject: "patient" })),
		).toBe(true);
		expect(isEditToolPart(pendingPart("generateSchema"))).toBe(true);
	});
});

describe("scoped-edit rows are unchanged", () => {
	it("keeps the subject inline and the container on the → line", () => {
		const part = donePart("updateForm", {
			subject: "Register Client",
			location: "Clients",
		});
		expect(toolAction(part)).toBe('Updated form "Register Client"');
		expect(toolLocation(part)).toBe("Clients");
	});
});

describe("case-property rename transcript row", () => {
	it("renders the exact simultaneous relation size without exposing payload internals", () => {
		expect(toolAction(pendingPart("renameCaseProperties"))).toBe(
			"Renaming case properties",
		);
		expect(toolAction(donePart("renameCaseProperties", { count: 2 }))).toBe(
			"Renamed 2 case properties",
		);
	});
});

describe("users and personas transcript rows", () => {
	it("renders batch counts and singular entity edits in author language", () => {
		expect(toolAction(donePart("addUserProperties", { count: 2 }))).toBe(
			"Added 2 worker-information properties",
		);
		expect(
			toolAction(donePart("updateUserType", { subject: "Supervisor" })),
		).toBe('Updated role "Supervisor"');
		expect(toolAction(donePart("removePersona", { subject: "Asha" }))).toBe(
			'Removed persona "Asha"',
		);
	});
});
