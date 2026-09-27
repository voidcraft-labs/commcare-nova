import type * as Actions from "@/app/(app)/build/work-actions";

async function request(method: string, input: unknown) {
	const response = await fetch(`/native/work/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	return response.json();
}
export const readChatWork: typeof Actions.readChatWork = (input) =>
	request("read", input);
export const discardChatWork: typeof Actions.discardChatWork = (input) =>
	request("discard", input);
