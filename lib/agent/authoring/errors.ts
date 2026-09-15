/** An authored value or address that the caller can correct. */
export class AuthoringInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthoringInputError";
	}
}
