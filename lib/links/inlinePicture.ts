/** An image `data:` address of a kind Web Apps' renderer draws: the picture
 *  is inside the label, so drawing it requests nothing. */
export function isInlinePicture(src: string): boolean {
	try {
		const address = new URL(src);
		if (address.protocol !== "data:") return false;
		const kind = address.pathname.toLowerCase();
		return ["image/gif;", "image/png;", "image/jpeg;", "image/webp;"].some(
			(prefix) => kind.startsWith(prefix),
		);
	} catch {
		return false;
	}
}
