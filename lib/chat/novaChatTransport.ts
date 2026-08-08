/**
 * Nova's chat transport: `WorkflowChatTransport` with the cold-resume replay
 * windowed by the CLIENT'S hydrated state (`lib/chat/hydratedStepFilter`).
 *
 * The subclass overrides exactly one path — the public `reconnectToStream`,
 * which only the cold resume calls (`useChat`'s `resumeStream` on a page that
 * hydrated the barrier-persisted transcript). Its full-log replay pipes
 * through the hydrated-step skip filter, which reads the live Chat state at
 * the replay's `start` chunk — the moment the stream declares which message
 * it grows — so the window is always the client's own truth about that exact
 * message.
 *
 * The transport's INTERNAL recovery — a POST whose response broke before the
 * `finish` chunk — deliberately does not pass through here: that client built
 * its message from the wire (nothing hydrated), so it needs every chunk it
 * hasn't counted, which is exactly the base class's cursor behavior
 * (`startIndex` = chunks received, from 0 when it got none). Setting
 * `initialStartIndex` on the constructor instead would rewind that path too
 * and permanently skip the receipts (`data-app-materialized`) and completed steps a
 * mid-send client never received.
 */

import type {
	ReconnectToStreamOptions,
	WorkflowChatTransportOptions,
} from "@ai-sdk/workflow";
import { WorkflowChatTransport } from "@ai-sdk/workflow";
import type { ChatRequestOptions, UIMessage, UIMessageChunk } from "ai";
import { createHydratedStepSkipFilter } from "./hydratedStepFilter";

export class NovaChatTransport<
	UI_MESSAGE extends UIMessage,
> extends WorkflowChatTransport<UI_MESSAGE> {
	private readonly hydratedMessages: () => readonly unknown[];

	constructor(
		options: WorkflowChatTransportOptions<UI_MESSAGE>,
		/** The Chat's CURRENT messages — read per replay, never captured:
		 *  the filter must window on what the client holds at that moment. */
		hydratedMessages: () => readonly unknown[],
	) {
		super(options);
		this.hydratedMessages = hydratedMessages;
	}

	override async reconnectToStream(
		options: ReconnectToStreamOptions & ChatRequestOptions,
	): Promise<ReadableStream<UIMessageChunk> | null> {
		const stream = await super.reconnectToStream(options);
		if (!stream) return stream;
		return stream.pipeThrough(
			createHydratedStepSkipFilter(this.hydratedMessages),
		);
	}
}
