/**
 * Tests for the event log type + schema. Covers Zod round-trip for every
 * event variant and payload shape — the Firestore read converter relies on
 * `eventSchema.parse()` to validate persisted data.
 */
import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import {
	type ConversationEvent,
	type Event,
	eventSchema,
	type MutationEvent,
} from "../types";

describe("eventSchema", () => {
	it("parses a mutation event round-trip", () => {
		const event: MutationEvent = {
			kind: "mutation",
			runId: "run-1",
			ts: 1_700_000_000_000,
			seq: 0,
			actor: "agent",
			stage: "scaffold",
			mutation: { kind: "setAppName", name: "App" },
		};
		const parsed = eventSchema.parse(event);
		expect(parsed).toEqual(event);
	});

	it("parses a mutation event without optional stage", () => {
		const event: MutationEvent = {
			kind: "mutation",
			runId: "run-1",
			ts: 1,
			seq: 1,
			actor: "user",
			mutation: {
				kind: "addField",
				parentUuid: asUuid("form-1"),
				field: {
					kind: "text",
					uuid: asUuid("fld-1"),
					id: "name",
					label: "Name",
				},
			},
		};
		const parsed = eventSchema.parse(event);
		expect(parsed).toEqual(event);
	});

	it("parses every conversation payload variant", () => {
		const samples: ConversationEvent[] = [
			{
				kind: "conversation",
				runId: "r",
				ts: 0,
				seq: 0,
				payload: { type: "user-message", text: "hi" },
			},
			{
				kind: "conversation",
				runId: "r",
				ts: 1,
				seq: 1,
				payload: { type: "assistant-text", text: "hi back" },
			},
			{
				kind: "conversation",
				runId: "r",
				ts: 2,
				seq: 2,
				payload: {
					type: "assistant-reasoning",
					text: "thinking …",
				},
			},
			{
				kind: "conversation",
				runId: "r",
				ts: 3,
				seq: 3,
				payload: {
					type: "tool-call",
					toolCallId: "tc-1",
					toolName: "addModule",
					input: { name: "m1" },
				},
			},
			{
				kind: "conversation",
				runId: "r",
				ts: 4,
				seq: 4,
				payload: {
					type: "tool-result",
					toolCallId: "tc-1",
					toolName: "addModule",
					output: "Success",
				},
			},
			{
				kind: "conversation",
				runId: "r",
				ts: 5,
				seq: 5,
				payload: {
					type: "error",
					error: {
						type: "api_auth",
						message: "Unauthorized",
						fatal: false,
					},
				},
			},
		];
		for (const ev of samples) {
			expect(eventSchema.parse(ev)).toEqual(ev);
		}
	});

	it("rejects unknown event kinds", () => {
		const bad: Partial<Event> = {
			// @ts-expect-error — intentional invalid kind
			kind: "spooky",
			runId: "r",
			ts: 0,
			seq: 0,
		};
		expect(() => eventSchema.parse(bad)).toThrow();
	});

	it("rejects unknown conversation payload types", () => {
		const bad = {
			kind: "conversation" as const,
			runId: "r",
			ts: 0,
			seq: 0,
			payload: { type: "gossip", text: "…" },
		};
		expect(() => eventSchema.parse(bad)).toThrow();
	});
});
