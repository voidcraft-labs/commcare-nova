import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { executeWithOutputPipes } from "../../run.mjs";

// Saturate an actual nonblocking log descriptor before either child can write.
// The ordinary inherited write fails immediately. The hosted runner can begin
// writing while the pipe is still full and must forward every byte before exit.
const saturatedLog = `
import os, select, subprocess, sys

node, module = sys.argv[1:]
read_end, write_end = os.pipe()
os.set_blocking(write_end, False)
filled = 0
while True:
    try:
        filled += os.write(write_end, b' ' * 4096)
    except BlockingIOError:
        break

writer = "import os; os.write(2, b'writing\\\\n'); os.write(1, b'x' * 1048576); os._exit(7)"
direct = subprocess.run([sys.executable, '-c', writer], stdout=write_end, stderr=subprocess.PIPE, timeout=3)
assert direct.returncode == 1 and b'BlockingIOError' in direct.stderr, direct.stderr

wrapper = '''
const [module, python, writer] = process.argv.slice(1);
const { executeWithOutputPipes } = await import(module);
process.exit(await executeWithOutputPipes(python, ["-c", writer]));
'''
with subprocess.Popen([node, '--input-type=module', '-e', wrapper, module, sys.executable, writer],
                      stdout=write_end, stderr=subprocess.PIPE) as wrapped:
    os.close(write_end)
    try:
        assert select.select([wrapped.stderr], [], [], 3)[0], 'child did not start writing'
        assert wrapped.stderr.readline() == b'writing\\n'
        with os.fdopen(read_end, 'rb') as output:
            assert output.read(filled + 1048576) == b' ' * filled + b'x' * 1048576
        assert wrapped.wait(timeout=3) == 7
    finally:
        if wrapped.poll() is None:
            wrapped.kill()
`;

it("keeps hosted shard output and the child's exit when the runner pipe fills", async () => {
	await promisify(execFile)(
		"python3",
		[
			"-c",
			saturatedLog,
			process.execPath,
			resolve(import.meta.dirname, "../../run.mjs"),
		],
		{ timeout: 10_000 },
	);
});

it("reaps the child and cancels a blocked forwarder when the other sink breaks", async () => {
	const writing = Promise.withResolvers<number>();
	let release: (() => void) | undefined;
	const stdout = new Writable({
		write(chunk, _encoding, done) {
			release = done;
			writing.resolve(Number(chunk.toString()));
		},
	});
	const stderr = new PassThrough();
	const running = executeWithOutputPipes(
		process.execPath,
		[
			"-e",
			"process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);",
		],
		{ stdout, stderr },
	);
	const pid = await writing.promise;
	const failure = new Error("runner log sink broke");
	stderr.destroy(failure);
	try {
		await expect(running).rejects.toBe(failure);
		expect(() => process.kill(pid, 0)).toThrow("ESRCH");
		expect(stdout.listenerCount("error")).toBe(0);
		expect(stderr.listenerCount("error")).toBe(0);
	} finally {
		release?.();
		stdout.end();
		await finished(stdout, { cleanup: true });
	}
});
