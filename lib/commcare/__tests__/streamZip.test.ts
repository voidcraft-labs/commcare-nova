import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { expect, it } from "vitest";
import { streamZip, textMember } from "../streamZip";

it("round-trips a literal UTF-8 member across a surrogate boundary through an independent ZIP reader", async () => {
	const value = "a".repeat(16383) + "🍊\r\n".repeat(2000);
	const chunks = [];
	for await (const chunk of streamZip([textMember("places/área.xml", value)]))
		chunks.push(chunk);
	const digest = createHash("sha256").update(value).digest("hex");
	const check = spawnSync(
		"python3",
		[
			"-c",
			"import hashlib,io,sys,zipfile\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nassert z.testzip() is None\nprint(hashlib.sha256(z.read('places/área.xml')).hexdigest())",
		],
		{ input: Buffer.concat(chunks) },
	);
	expect(check.status).toBe(0);
	expect(check.stdout.toString().trim()).toBe(digest);
});

it("closes an unfinished source on cancellation before opening the following member", async () => {
	let read = 0,
		closed = false,
		opened = false;
	const random = randomBytes(64 * 1024);
	const iterator = streamZip([
		{
			path: "large",
			async *open() {
				try {
					while (read < 10000) {
						read++;
						yield random;
					}
				} finally {
					closed = true;
				}
			},
		},
		{
			path: "never",
			async *open() {
				opened = true;
				yield random;
			},
		},
	]);
	try {
		for (;;) {
			const chunk = await iterator.next();
			expect(chunk.done).toBe(false);
			if (read > 0 && chunk.value && chunk.value.length > 256) break;
		}
	} finally {
		await iterator.return(undefined);
	}
	expect(closed).toBe(true);
	expect(read).toBeLessThan(100);
	expect(opened).toBe(false);
});

it("refuses a truncated member without releasing a completed archive", async () => {
	const collect = async () => {
		for await (const _ of streamZip([
			{
				path: "one",
				size: 2,
				async *open() {
					yield Buffer.from("x");
				},
			},
		])) {
		}
	};
	await expect(collect()).rejects.toThrow("unexpected number of bytes");
});

it("keeps a small streaming member readable after a four-gigabyte archive prefix", async () => {
	// Feed the real writer the offset at the close of a previous member.
	// This reproduces its actual local/central bytes without compressing
	// or reserving four gigabytes per test run.
	const prefix = 2 ** 32 + 17;
	const zip = new ZipFile() as ZipFile & { outputStreamCursor: number };
	zip.outputStreamCursor = prefix;
	for (const name of ["first", "following"])
		zip.addReadStream(Readable.from([Buffer.from(name)]), name, {
			forceDosTimestamp: true,
		});
	zip.end();
	const chunks: Buffer[] = [];
	for await (const bytes of zip.outputStream as Readable) chunks.push(bytes);
	const check = spawnSync(
		"python3",
		[
			"-c",
			`
import io,sys,struct,zlib,tempfile,zipfile
prefix=2**32+17
raw=sys.stdin.buffer.read()
# ZipFile resolves each true 64-bit central offset through a sparse prefix.
with tempfile.TemporaryFile() as dest:
    dest.seek(prefix);dest.write(raw);dest.seek(0)
    with zipfile.ZipFile(dest) as archive:
        for name in ["first","following"]:
            assert archive.getinfo(name).header_offset>=prefix and archive.read(name)==name.encode()
# As Android ZipInputStream does, read each member sequentially and
# interpret its descriptor widths from its actual file and compressed sizes.
pos=0
for name in ["first","following"]:
    assert raw[pos:pos+4]==bytes([80,75,3,4])
    namesize,extrasize=struct.unpack_from("<HH",raw,pos+26)
    assert raw[pos+30:pos+30+namesize]==name.encode()
    data=raw[pos+30+namesize+extrasize:]
    inflate=zlib.decompressobj(-15); member=inflate.decompress(data)
    assert member==name.encode()
    length=len(data)-len(inflate.unused_data)
    assert struct.unpack_from("<IIII",inflate.unused_data)==(0x08074b50,zlib.crc32(member),length,len(member))
    pos=len(raw)-len(inflate.unused_data)+16
assert raw[pos:pos+4]==bytes([80,75,1,2])
`,
		],
		{ input: Buffer.concat(chunks) },
	);
	expect(check.status, check.stderr.toString()).toBe(0);
});
