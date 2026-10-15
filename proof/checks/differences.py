"""What every check reports: a complete set of differences, never only the first.

A ``Difference`` names the check that saw it, the corpus document (or
control) it was seen on, the artifact compared, where in that artifact, what
kind of difference it is, and the two values. ``path`` is structural: it
names what the difference is, never which document it is on. Every
position, and every key, identity or name that is the app's data rather than
CommCare's vocabulary (a question, group or repeat id, a case property, a
case type, an index identifier, an operation or container name, a minted id
or uuid suffix, a language code), is ``*``, so one symptom has one path
wherever it occurs; ``at`` is the same path with the concrete positions,
keys, identities and names. The vocabulary is decided from the formats' own
readers (``compare.names`` for an XForm's data, a submission and Core's case
database; ``compare.app_json`` for the app JSON; ``compare.app_strings`` for
app strings), so a name a reader finds an element by (``case``, ``create``,
``update``, ``meta``, ``@case_id``) stays as it is, and so does the name of a
node Nova generates, its fixed name or its family without its minted part
(``compare.names.nova_name``). A run of the app's own elements is one
``*``, a query-bound repeat's row inside it part of it (how deeply the app
nests its data is the document's).

Paths are JSON Pointer over JSON; over XML, ``/tag[@attr=*]`` where an
attribute is the element's identity (``/tag[@attr=value]`` in ``at``),
``/tag[*]`` otherwise (``/tag[n]``, from 1, in ``at``), and ``/@attr``,
``/text()``, ``/tail()``, ``/namespace()`` and ``/order()`` for what an
element holds; over app strings, the HQ key family (``/forms.m*f*``, the
key itself in ``at``). Collections are compared the way their readers key
them, never by position where position is not what the reader reads: a
bind by its node set, a ``setvalue`` by its event and target, a case in
Core's case database by its ``@case_id``, HQ's case blocks by case id
and each case's by where the form holds each, their order as HQ applies
them one difference (``proof.checks.proof3``), a generated id by the first
place both sides hold it (``compare.trace``).

A ``refused`` difference (a comparison that could not run) names its cause
in its path (``/not-well-formed``, ``/unbuildable/validate_app/...``,
``/status/<HTTP status>``...), and a check reports no refusal whose cause
the bar already reports. So does a runtime's refusal of what it was given
(HQ's of a submission, ``/runs/*/refusal/<class>/...``; Core's,
``/runs/*/trace/*/processing/<class>/...``) and an exception Core raised
running a step (``/runs/*/trace/*/error/<class>/<where it was constructed>``),
and what the refusing side holds none of because it refused or raised is
compared under that path.

A register entry (``proof.checks.registers``) matches differences by check,
artifact, exact path, the kind where it names one, and, where it pins them,
values.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass

CHECKS = frozenset({"bar", "intent", "manifest", "sensitivity", "proof1", "proof2", "proof3", "proof4", "proof5"})
KINDS = frozenset({"changed", "added", "removed", "error", "refused"})

# What a served state's readers made of it (``proof.observe.served``) is reported under an artifact whose first
# step names the reader, and every check that reports one names it from these: Formplayer's walks and the
# requests HQ's views refused it (``formplayer@...``), the Web Apps client's screens (``webapps@...``), a phone's
# and a tablet's reading of the state (``android@...``, ``android-tablet@...``, ``proof.checks.android``), what
# CommCare Connect made of the state's submissions (``connect@...``, ``proof.checks.connect``), and a release HQ
# served that is not the build the other checks read, or that HQ refused to release (``release@...``). Only the
# served observation records any of them, so a run without the readers (``proof.lane.readers``) shows none, and
# the gate leaves the register's entries naming one to the nightly (``proof.checks.registers.served_entry``).
FORMPLAYER = "formplayer"
WEBAPPS = "webapps"
ANDROID = "android"
ANDROID_TABLET = "android-tablet"
CONNECT = "connect"
RELEASE = "release"
SERVED_ARTIFACTS = frozenset({FORMPLAYER, WEBAPPS, ANDROID, ANDROID_TABLET, CONNECT, RELEASE})
# The reader each served artifact is the record of (``proof.lane.readers.READERS``): a release is the one HQ serves
# Formplayer, and a tablet is a device.
READER_OF = {
    FORMPLAYER: "formplayer",
    RELEASE: "formplayer",
    WEBAPPS: "webapps",
    ANDROID: "android",
    ANDROID_TABLET: "android",
    CONNECT: "connect",
}


def served_artifact(artifact: str) -> bool:
    """Whether an artifact (a difference's, or a register entry's pattern) is a served reader's: its first step,
    up to the first ``@``, is one of ``SERVED_ARTIFACTS``."""
    return artifact.partition("@")[0] in SERVED_ARTIFACTS


def artifact_reader(artifact: str) -> str | None:
    """The reader whose record a served artifact is (``READER_OF``), or None for any other artifact."""
    return READER_OF.get(artifact.partition("@")[0])


@dataclass(frozen=True)
class Difference:
    check: str
    document: str
    artifact: str
    path: str
    at: str
    kind: str
    before: object
    after: object

    def __post_init__(self):
        if self.check not in CHECKS:
            raise ValueError(f"A difference names the check {self.check!r}; the checks are {sorted(CHECKS)}.")
        if self.kind not in KINDS:
            raise ValueError(f"A difference has the kind {self.kind!r}; the kinds are {sorted(KINDS)}.")
        for name in ("before", "after"):
            try:
                json.dumps(getattr(self, name))
            except (TypeError, ValueError) as error:
                raise ValueError(
                    f"A difference's {name} must be JSON (it is written to the lane's evidence); "
                    f"{self.artifact} {self.at} holds {getattr(self, name)!r}: {error}"
                ) from error

    def as_json(self):
        return asdict(self)

    def describe(self):
        """One line a person reads in a failing check."""
        shown = {"changed": "changed", "added": "added", "removed": "removed", "error": "failed", "refused": "refused"}
        return (
            f"{self.check} {self.artifact} {self.at}: {shown[self.kind]}"
            f" (before {_short(self.before)}, after {_short(self.after)})"
        )


def _short(value, limit=160):
    text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def pointer_token(key) -> str:
    """One JSON Pointer reference token (RFC 6901): ``~`` as ``~0``, ``/`` as ``~1``."""
    return str(key).replace("~", "~0").replace("/", "~1")


def sorted_differences(differences):
    """Differences in a stable order: by artifact, then concrete path, then kind."""
    return sorted(differences, key=lambda d: (d.document, d.check, d.artifact, d.at, d.kind))


def summary(differences, limit=60):
    """The differences as the lines a failing check prints, grouped by structural path."""
    ordered = sorted_differences(differences)
    classes = {}
    for difference in ordered:
        classes.setdefault((difference.check, difference.artifact, difference.path), []).append(difference)
    lines = [f"{len(ordered)} differences in {len(classes)} classes (check, artifact, structural path):"]
    for (check, artifact, path), members in classes.items():
        lines.append(f"  {check} {artifact} {path}: {len(members)}, e.g. {members[0].describe()}")
        if len(lines) > limit:
            lines.append(f"  … and {len(classes) - limit} more classes")
            break
    return "\n".join(lines)
