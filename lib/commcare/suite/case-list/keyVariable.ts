/**
 * HQ's name for the suite variable of one enum key
 * (`models/case_list.py::MappingItem.key_as_variable`).
 *
 * A key holding a non-word character, or one HQ treats as an expression
 * (any of `{}()[]=<>."'/`), is named `h` and the first eight hex digits of
 * the MD5 of its UTF-8 bytes; any other key is named `k` and the key. The
 * suite's locale ids end in this name, so the local archive names each
 * variable exactly as HQ's build of the same app does.
 *
 * The digest is computed here, in plain TypeScript, because the case-list
 * emitters also run in the browser (`lib/preview/caseTileRendering.ts`),
 * where `node:crypto` is not available.
 */

const EXPRESSION_CHARACTERS = "{}()[]=<>.\"'/";

/** `re.search(r'\W', key)` in Python 3: any character that is not a Unicode word character. */
const NON_WORD = /[^\p{L}\p{N}_]/u;

export function keyAsVariable(key: string): string {
	const treatAsExpression = [...EXPRESSION_CHARACTERS].some((char) =>
		key.includes(char),
	);
	return NON_WORD.test(key) || treatAsExpression
		? `h${md5Hex(key).slice(0, 8)}`
		: `k${key}`;
}

// ── MD5 (RFC 1321) ──────────────────────────────────────────────────

const SHIFTS = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
	9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
	16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
	21,
];

const CONSTANTS = Array.from(
	{ length: 64 },
	(_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0,
);

function rotateLeft(value: number, shift: number): number {
	return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

/** The MD5 digest of `text`'s UTF-8 bytes, as lower-case hex. */
export function md5Hex(text: string): string {
	const message = new TextEncoder().encode(text);
	const bitLength = message.length * 8;
	const paddedLength = (((message.length + 8) >> 6) + 1) * 64;
	const bytes = new Uint8Array(paddedLength);
	bytes.set(message);
	bytes[message.length] = 0x80;
	const view = new DataView(bytes.buffer);
	view.setUint32(paddedLength - 8, bitLength >>> 0, true);
	view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	for (let offset = 0; offset < paddedLength; offset += 64) {
		const words = Array.from({ length: 16 }, (_, index) =>
			view.getUint32(offset + index * 4, true),
		);
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let index = 0; index < 64; index++) {
			let f: number;
			let g: number;
			if (index < 16) {
				f = (b & c) | (~b & d);
				g = index;
			} else if (index < 32) {
				f = (d & b) | (~d & c);
				g = (5 * index + 1) % 16;
			} else if (index < 48) {
				f = b ^ c ^ d;
				g = (3 * index + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * index) % 16;
			}
			const sum = (a + (f >>> 0) + CONSTANTS[index] + words[g]) >>> 0;
			a = d;
			d = c;
			c = b;
			b = (b + rotateLeft(sum, SHIFTS[index])) >>> 0;
		}
		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}
	return [a0, b0, c0, d0]
		.map((word) => {
			const out = new DataView(new ArrayBuffer(4));
			out.setUint32(0, word, true);
			return Array.from({ length: 4 }, (_, index) =>
				out.getUint8(index).toString(16).padStart(2, "0"),
			).join("");
		})
		.join("");
}
