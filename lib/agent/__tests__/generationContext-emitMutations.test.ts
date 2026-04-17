// lib/agent/__tests__/generationContext-emitMutations.test.ts
//
// Unit tests for the `emitMutations` helper. The helper is the single
// sanctioned write surface for server-side mutation emission — if it
// changes shape, every SA tool handler changes with it.

import type { UIMessageStreamWriter } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth";
import type { Mutation } from "@/lib/doc/types";
import { asUuid } from "@/lib/domain";
import type { EventLogger } from "@/lib/services/eventLogger";
import { GenerationContext } from "../generationContext";

// Minimal construction helper — the context needs only writer + logger +
// session for the emit path, so every other collaborator is a bare stub.
function buildCtx() {
	const writer = {
		write: vi.fn(),
	} as unknown as UIMessageStreamWriter;
	const logger = {
		logEmission: vi.fn(),
		runId: "run-1",
	} as unknown as EventLogger;
	const session = {
		user: { id: "user-1" },
	} as unknown as Session;
	return {
		ctx: new GenerationContext({
			apiKey: "sk-test",
			writer,
			logger,
			session,
		}),
		writer,
		logger,
	};
}

// Representative text-field add mutation. The specific mutation shape is
// unimportant to the helper — these tests only assert that the batch
// round-trips verbatim through `writer.write` + `logger.logEmission`.
const TEXT_FIELD_MUTATION: Mutation = {
	kind: "addField",
	parentUuid: asUuid("form-uuid"),
	field: {
		kind: "text",
		uuid: asUuid("field-uuid"),
		id: "patient_name",
		label: "Patient name",
	},
};

describe("GenerationContext.emitMutations", () => {
	let ctx: GenerationContext;
	let writer: { write: ReturnType<typeof vi.fn> };
	let logger: { logEmission: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		const built = buildCtx();
		ctx = built.ctx;
		writer = built.writer as unknown as typeof writer;
		logger = built.logger as unknown as typeof logger;
	});

	it("writes a data-mutations event to the stream with the supplied mutations", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION]);
		expect(writer.write).toHaveBeenCalledWith({
			type: "data-mutations",
			data: { mutations: [TEXT_FIELD_MUTATION] },
			transient: true,
		});
	});

	it("includes the optional stage tag when provided", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION], "form:0-0");
		expect(writer.write).toHaveBeenCalledWith({
			type: "data-mutations",
			data: { mutations: [TEXT_FIELD_MUTATION], stage: "form:0-0" },
			transient: true,
		});
	});

	it("omits the stage key entirely when no stage is provided (not 'stage: undefined')", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION]);
		const call = writer.write.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect("stage" in call.data).toBe(false);
	});

	it("logs the emission via the event logger", () => {
		ctx.emitMutations([TEXT_FIELD_MUTATION]);
		expect(logger.logEmission).toHaveBeenCalledWith("data-mutations", {
			mutations: [TEXT_FIELD_MUTATION],
		});
	});

	it("does not write or log anything for an empty mutation array", () => {
		ctx.emitMutations([]);
		expect(writer.write).not.toHaveBeenCalled();
		expect(logger.logEmission).not.toHaveBeenCalled();
	});
});
