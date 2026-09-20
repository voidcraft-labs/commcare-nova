/** An authored value or address that the caller can correct. */
export class AuthoringInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthoringInputError";
	}
}

/** Nova could not turn stored app content into its authored reading form. The
 * caller's request was fine and the app is unchanged; nothing the caller sends
 * can correct it, so it is never an `AuthoringInputError`. */
export class ReadProjectionError extends Error {
	constructor(
		readonly toolName: string,
		cause: unknown,
	) {
		super(
			"Nova couldn't put this part of the app into a readable form. Your request was fine and the app is unchanged. The problem is on our side and we've recorded it, so asking again with different values won't help. Other parts of the app can still be read.",
			{ cause },
		);
		this.name = "ReadProjectionError";
	}
}
