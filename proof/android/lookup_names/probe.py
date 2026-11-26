"""Read the pinned Core XPath lexer's complete UTF-16 name grammar in JDK 17 or one Android image.

Run from the worktree, naming a clean commcare-core checkout at proof/pins.json's commit.
With --avd, supply ANDROID_SDK_ROOT, JDK 17 JAVA_HOME and a local copy of Core's Guava
31.1-jre jar (--guava). The default locations are the macOS SDK, JDK 17 and the Gradle cache.
The guest boots read-only on a dedicated port. Finishing the probe closes only its own emulator.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
GUAVA_SHA256 = "a42edc9cab792e39fe39bb94f3fca655ed157ff87a8af78e1d6ba5b07c4a00ab"
GUAVA_CACHE_KEY = "60458f877d055d0c9114d9e1a2efb737b4bc282c"


def run(*args, **kwargs):
    return subprocess.run(
        [str(arg) for arg in args],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        timeout=120,
        **kwargs,
    ).stdout.strip()


def image_ranges(args, directory, classes, jdk, guava):
    sdk = Path(
        os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME") or Path.home() / "Library/Android/sdk"
    )
    platform = max(
        sdk.glob("platforms/android-[0-9]*"),
        key=lambda path: int(path.name.split("-")[1]),
    )
    tools = max(
        (p for p in sdk.glob("build-tools/*") if all(s.isdigit() for s in p.name.split("."))),
        key=lambda p: tuple(map(int, p.name.split("."))),
    )
    jar = directory / "probe.jar"
    run(jdk / "bin/jar", "cf", jar, "-C", classes, ".")
    env = dict(
        os.environ,
        JAVA_HOME=str(jdk),
        JAVA_TOOL_OPTIONS="-Xmx256m -XX:ActiveProcessorCount=1",
    )
    run(
        tools / "d8",
        "--min-api",
        "23",
        "--lib",
        platform / "android.jar",
        "--classpath",
        guava,
        "--output",
        directory,
        jar,
        env=env,
    )
    serial = f"emulator-{args.port}"
    adb = sdk / "platform-tools/adb"
    if serial in run(adb, "devices").split():
        raise RuntimeError(f"{serial} already belongs to another operation")
    with (directory / "emulator.log").open("w+") as log:
        emulator = subprocess.Popen(
            [
                str(sdk / "emulator/emulator"),
                "-avd",
                args.avd,
                "-port",
                str(args.port),
                "-read-only",
                "-no-window",
                "-no-audio",
                "-no-boot-anim",
                "-no-snapshot",
                "-cores",
                "1",
                "-memory",
                "1536",
            ],
            stdout=log,
            stderr=log,
        )
        try:
            deadline = time.monotonic() + 210
            while time.monotonic() < deadline:
                if emulator.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(log.read())
                try:
                    if (
                        run(
                            adb,
                            "-s",
                            serial,
                            "shell",
                            "getprop",
                            "sys.boot_completed",
                            stderr=subprocess.DEVNULL,
                        )
                        == "1"
                    ):
                        break
                except subprocess.CalledProcessError:
                    pass
                time.sleep(2)
            else:
                raise RuntimeError(f"{args.avd} did not finish booting within 210 seconds")

            def shell(*cmd):
                return run(adb, "-s", serial, "shell", *cmd)

            remote = "/data/local/tmp/nova-lookup-names.dex"
            run(adb, "-s", serial, "push", directory / "classes.dex", remote)
            shell("chmod", "0444", remote)
            return {
                "fingerprint": shell("getprop", "ro.build.fingerprint"),
                "api": int(shell("getprop", "ro.build.version.sdk")),
                "ranges": json.loads(
                    shell(
                        f"CLASSPATH={remote}",
                        "app_process",
                        "/system/bin",
                        "LookupNameProbe",
                    )
                ),
            }
        finally:
            if emulator.poll() is None:
                emulator.terminate()
                try:
                    emulator.wait(15)
                except subprocess.TimeoutExpired:
                    emulator.kill()
                    emulator.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("core", type=Path)
    parser.add_argument("--avd")
    parser.add_argument("--port", type=int, default=5588)
    parser.add_argument("--guava", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pin = json.loads((ROOT / "proof/pins.json").read_text())["commcare-core"]["commit"]
    if run("git", "-C", args.core, "rev-parse", "HEAD") != pin or run("git", "-C", args.core, "status", "--porcelain"):
        raise ValueError(f"Name a clean checkout of CommCare Core {pin}")
    home = os.environ.get("JAVA_HOME")
    if not home and shutil.which("/usr/libexec/java_home"):
        home = run("/usr/libexec/java_home", "-v", "17")
    jdk = Path(home or Path(shutil.which("javac")).resolve().parents[1])
    version = run(jdk / "bin/java", "--version")
    if version.splitlines()[0].split()[1].split(".")[0] != "17":
        raise ValueError(f"Use JDK 17 for the compiler and JVM probe. Found {version}")
    guava = (
        args.guava
        or Path.home()
        / ".gradle/caches/modules-2/files-2.1/com.google.guava/guava/31.1-jre"
        / GUAVA_CACHE_KEY
        / "guava-31.1-jre.jar"
    )
    if hashlib.sha256(guava.read_bytes()).hexdigest() != GUAVA_SHA256:
        raise ValueError("Use Core's Guava 31.1-jre compiler dependency.")
    with tempfile.TemporaryDirectory(prefix="lookup-names-") as temporary:
        directory = Path(temporary)
        classes = directory / "classes"
        classes.mkdir()
        run(
            jdk / "bin/javac",
            "--release",
            "8",
            "-J-Xmx160m",
            "-J-XX:ActiveProcessorCount=1",
            "-nowarn",
            "-sourcepath",
            args.core / "src/main/java",
            "-cp",
            guava,
            "-d",
            classes,
            HERE / "LookupNameProbe.java",
        )
        result = (
            image_ranges(args, directory, classes, jdk, guava)
            if args.avd
            else {
                "version": version,
                "ranges": json.loads(
                    run(
                        jdk / "bin/java",
                        "-Xmx64m",
                        "-XX:ActiveProcessorCount=1",
                        "-cp",
                        f"{classes}{os.pathsep}{guava}",
                        "LookupNameProbe",
                    )
                ),
            }
        )
    ranges = result["ranges"]
    digest = hashlib.sha256(json.dumps(ranges, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    args.output.write_text(json.dumps(dict(core=pin, rangeSha256=digest, **result), indent=2) + "\n")
    expected = json.loads(
        (ROOT / "lib/domain" / ("androidNameRanges.json" if args.avd else "portableNameRanges.json")).read_text()
    )
    def units(pairs):
        return {n for start, end in zip(pairs[::2], pairs[1::2]) for n in range(start, end + 1)}

    for kind, boundaries in expected.items():
        wanted, observed = units(boundaries), units(ranges[kind])
        if result.get("api") in (23, None):
            agrees = wanted == observed
        else:
            agrees = wanted <= observed
        if not agrees:
            raise ValueError(f"The native lexer disagrees with Nova for {kind}. Full ranges are in {args.output}")
    recorded = json.loads((HERE / "runtimes.json").read_text())
    for runtime in recorded["runtimes"]:
        if runtime["runtime"] == result.get("fingerprint", version) and runtime["rangeSha256"] != digest:
            raise ValueError(f"This runtime now reads a different grammar. Full ranges are in {args.output}")


if __name__ == "__main__":
    main()
