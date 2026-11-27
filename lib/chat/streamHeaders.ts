import { UI_MESSAGE_STREAM_HEADERS } from "ai";

// Compression can hold small SSE events until a later write or stream close.
export const CHAT_STREAM_HEADERS = {
	...UI_MESSAGE_STREAM_HEADERS,
	"cache-control": "no-cache, no-transform",
};
