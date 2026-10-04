"""Browser transcripts: what one view or Vellum run asked HQ, what HQ answered, and what the browser showed.

A transcript is JSON::

    {"spec": <the run's canonical spec>,
     "first": <sha256 of HQ's first answer>,
     "exchanges": [{"phase", "method", "url", "headers", "body", "response"}],
     "outputs": {...}}

``exchanges`` are every request the page had HQ answer, in the order HQ
answered them: the phase it was asked in (``load``, ``section:<i>``,
``followup:<i>``, ``vellum``), its method, URL and headers, its body (base64,
or null) and the sha256 of HQ's answer (``proof.editors.hq.response_digest``).
``outputs`` are what the browser showed: for a view, per section, its Save
button's state before the save, just before its release and after it, and
the requests, page errors, console errors and dialogs of the run, each with
the phase it happened in; for Vellum, Vellum's record of the form, its save,
its state after the save and its events. Nothing in a transcript is a time or
a path of the machine that made it.

Replaying a transcript (``replay``) has HQ answer every recorded request
again, in its phase (a section's inside the caller's ``on_section(i)``), built
exactly as the page sent it, and compares each answer's digest with the
recorded one. The browser is deterministic given its inputs (the driver and
its step files, the image's Chromium and bundles, the run's spec, which fixes
its clock, its randomness and its cookies) and the answers it gets: so, by
induction over the exchanges, when HQ answers every recorded request as it
did, a live run would have asked exactly these requests and shown exactly
these outputs, and the recorded outputs stand for it. At the first answer
that differs the replay stops, answers nothing further, and reports the
request (``ReplayMismatch``); the caller then restores its state and runs the
browser live.
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Callable, Iterable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import Any

from proof.editors.client import PageRequest

FORMAT = 1


def canonical(value: Any) -> bytes:
    """``value`` as canonical JSON: sorted keys, no insignificant whitespace, UTF-8."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value: Any) -> str:
    """The sha256 of ``value``'s canonical JSON, as hex."""
    return hashlib.sha256(canonical(value)).hexdigest()


class TranscriptInvalid(ValueError):
    """A transcript that is not in the format this module reads."""


@dataclass(frozen=True)
class TranscriptExchange:
    phase: str
    method: str
    url: str
    headers: dict
    # The request body, base64, or None.
    body: str | None
    # The sha256 of HQ's answer (proof.editors.hq.response_digest).
    response: str

    def request(self) -> PageRequest:
        """The request as the page sent it."""
        return PageRequest(
            method=self.method,
            url=self.url,
            headers=dict(self.headers),
            body=base64.b64decode(self.body) if self.body is not None else None,
            phase=self.phase,
        )

    def to_json(self) -> dict:
        return {
            "phase": self.phase,
            "method": self.method,
            "url": self.url,
            "headers": dict(self.headers),
            "body": self.body,
            "response": self.response,
        }


@dataclass(frozen=True)
class Transcript:
    spec: dict
    first: str
    exchanges: tuple[TranscriptExchange, ...]
    outputs: dict = field(default_factory=dict)

    @property
    def spec_digest(self) -> str:
        return digest(self.spec)

    def to_json(self) -> dict:
        return {
            "format": FORMAT,
            "spec": self.spec,
            "first": self.first,
            "exchanges": [exchange.to_json() for exchange in self.exchanges],
            "outputs": self.outputs,
        }

    def canonical(self) -> bytes:
        return canonical(self.to_json())

    def digest(self) -> str:
        return hashlib.sha256(self.canonical()).hexdigest()

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Transcript:
        if not isinstance(value, Mapping) or value.get("format") != FORMAT:
            raise TranscriptInvalid(
                f"A transcript is a JSON object of format {FORMAT}; this one is not ({str(value)[:200]})."
            )
        exchanges = value.get("exchanges")
        if not isinstance(exchanges, list) or not exchanges:
            raise TranscriptInvalid("A transcript holds at least the page's own request; this one holds none.")
        try:
            parsed = tuple(
                TranscriptExchange(
                    phase=entry["phase"],
                    method=entry["method"],
                    url=entry["url"],
                    headers=dict(entry["headers"]),
                    body=entry["body"],
                    response=entry["response"],
                )
                for entry in exchanges
            )
        except (KeyError, TypeError) as error:
            raise TranscriptInvalid(f"A transcript exchange lacks {error}.") from error
        if value.get("first") != parsed[0].response:
            raise TranscriptInvalid("A transcript's first is the digest of its first exchange's answer, and is not.")
        return cls(spec=dict(value["spec"]), first=value["first"], exchanges=parsed, outputs=dict(value["outputs"]))


def from_exchanges(spec: Mapping[str, Any], exchanges: Iterable, outputs: Mapping[str, Any]) -> Transcript:
    """The transcript of a live run: its spec, HQ's exchanges in the order HQ answered them, and its outputs."""
    recorded = tuple(
        TranscriptExchange(
            phase=exchange.phase,
            method=exchange.method,
            url=exchange.url,
            headers=dict(exchange.headers),
            body=base64.b64encode(exchange.body).decode("ascii") if exchange.body is not None else None,
            response=exchange.response_digest,
        )
        for exchange in exchanges
    )
    if not recorded:
        raise TranscriptInvalid("A run with no exchange with HQ has no transcript.")
    return Transcript(spec=dict(spec), first=recorded[0].response, exchanges=recorded, outputs=dict(outputs))


class ReplayMismatch(Exception):
    """HQ answered a recorded request differently: the transcript does not stand for this run."""

    def __init__(self, index: int, recorded: TranscriptExchange, answered: str | None):
        super().__init__(
            f"HQ answered the transcript's request {index} ({recorded.phase}: {recorded.method} {recorded.url})"
            f" with {answered}, and the transcript recorded {recorded.response}."
        )
        self.index = index
        self.recorded = recorded
        self.answered = answered


def section_of(phase: str) -> int | None:
    """The section a phase belongs to (``section:<i>``, ``followup:<i>``), or None."""
    kind, _, index = phase.partition(":")
    return int(index) if kind in ("section", "followup") and index.isdigit() else None


def replay(
    transcript: Transcript,
    answers,
    *,
    on_section: Callable[[int], AbstractContextManager] | None = None,
    skip_first: bool = False,
) -> list:
    """Has ``answers`` answer every recorded request again, in its phase; HQ's exchanges, in order.

    A section's requests are answered inside ``on_section(i)``, entered at
    its first request and left after its last, as a live view enters and
    leaves it; ``answers`` is told which section is open. ``skip_first``
    leaves out the first request, already answered ahead of the replay
    (``HQAnswers.preanswer``), whose answer must be the transcript's first.
    Raises ``ReplayMismatch`` at the first answer whose digest differs,
    having answered nothing after it, and having left the open section's
    context with that error.
    """
    answered = []
    open_section: tuple[int, AbstractContextManager] | None = None

    def leave(error: BaseException | None = None):
        # With an error, the section's context sees it (its fork restores, and
        # whatever the caller does after the section's requests does not run);
        # the error goes on to the caller either way.
        nonlocal open_section
        if open_section is None:
            return
        _, context = open_section
        open_section = None
        answers.close_section()
        if error is None:
            context.__exit__(None, None, None)
        else:
            context.__exit__(type(error), error, error.__traceback__)

    try:
        for index, recorded in enumerate(transcript.exchanges):
            if index == 0 and skip_first:
                if answers.exchanges[-1].response_digest != transcript.first:
                    raise ReplayMismatch(0, recorded, answers.exchanges[-1].response_digest)
                answered.append(answers.exchanges[-1])
                continue
            section = section_of(recorded.phase)
            if open_section is not None and open_section[0] != section:
                leave()
            if section is not None and open_section is None:
                if on_section is None:
                    raise ValueError("A view transcript's sections are replayed inside on_section; none was given.")
                context = on_section(section)
                context.__enter__()
                open_section = (section, context)
                answers.open_section(section)
            answers(recorded.request())
            exchange = answers.exchanges[-1]
            answered.append(exchange)
            if exchange.response_digest != recorded.response:
                raise ReplayMismatch(index, recorded, exchange.response_digest)
        leave()
    except BaseException as error:
        leave(error)
        raise
    return answered
