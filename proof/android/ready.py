"""Whether this machine can load the Android reader, independently of its behavioral verdicts.

A real JVM installs a retained, self-contained survey. Failure here means a
shard cannot load the reader. The selfchecks and predicates run separately:
their assertions remain failures without preventing the other proofs.
"""

from pathlib import Path

from proof.android.client import AndroidReader


def main():
    archive = Path(__file__).resolve().parents[1] / "controls" / "targeted-survey-menu" / "local.ccz"
    with AndroidReader() as reader:
        answer = reader.request("profile", archive=str(archive))
    if answer.get("install") != "Installed":
        raise RuntimeError(f"The Android reader could not install its readiness survey: {answer}")


if __name__ == "__main__":
    main()
