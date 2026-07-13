import type { ToolUIPart } from "ai";
import { describe, expect, it } from "vitest";
import type { ToolCallSummary } from "@/lib/agent/tools/shared/toolCallSummary";
import { toolAction, toolDetail, toolLocation } from "../toolSummary";

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
			"Setting the case-list filter",
		);
		expect(toolAction(pendingPart("updateApp"))).toBe("Updating app settings");
	});

	it("reads as done once the call succeeds", () => {
		expect(toolAction(donePart("createModule", { subject: "Clients" }))).toBe(
			'Created module "Clients"',
		);
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

	it("names the Connect flip directly when only connect changed", () => {
		expect(toolAction(donePart("updateApp", { connect: "learn" }))).toBe(
			"Set CommCare Connect to Learn",
		);
		expect(toolAction(donePart("updateApp", { connect: "off" }))).toBe(
			"Turned off CommCare Connect",
		);
		// A connect-only change has no name to point at.
		expect(
			toolLocation(donePart("updateApp", { connect: "learn" })),
		).toBeNull();
	});

	it("surfaces the Connect flip on the detail line when both slots changed", () => {
		const part = donePart("updateApp", {
			subject: "Outreach",
			nameChange: "named",
			connect: "deliver",
		});
		expect(toolAction(part)).toBe("Named the app");
		expect(toolLocation(part)).toBe("Outreach");
		expect(toolDetail(part)).toBe("Set CommCare Connect to Deliver");
	});

	it("falls back to the generic phrase for a row recorded before the facts existed", () => {
		// Threads persisted before the tool reported nameChange/connect carry
		// only `subject` — the name still moves to the → line, never truncating
		// the headline.
		const part = donePart("updateApp", { subject: "Client Registration" });
		expect(toolAction(part)).toBe("Updated app settings");
		expect(toolLocation(part)).toBe("Client Registration");
	});
});

describe("generateSchema transcript row", () => {
	it("folds the case-type count into the headline with the type names on the → line", () => {
		const part = donePart("generateSchema", {
			subject: "patient, visit, referral",
			count: 3,
		});
		expect(toolAction(part)).toBe("Recorded 3 case types on the data model");
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
