"""The surface as a whole: deterministic, pinned, and keyed as the manifest reads it.

Contracts:
- The same pins give the same bytes. The committed surface is one
  extraction (``npm run surface``, in a container of its own), and every pull
  request compares two more with it byte for byte: the lane's (this group's
  ``extraction``, under the lane's ``PYTHONHASHSEED=0``, or the stored one a
  run with the same key made), in the gate (``proof/lane/gate.py``, section
  4), and CI's surface job's (``node proof/run.mjs --surface`` on a runner of
  its own, with Python's hash seed unset, as ``npm run surface`` runs it). A
  nondeterministic fact fails both, so this group extracts once. Here: the
  extraction is written in its one canonical form (the document's own JSON,
  tab-indented, keys sorted, ending in a newline), so equal facts are equal
  bytes.
- The surface records the commits it was read from, and they are the pins
  (``proof/pins.json``) the image holds; an extractor that recorded another
  checkout's commit, or none, would let a stale surface pass.
- Every key is ``<family>:<name>`` as the manifest's schema parses keys, and
  every source names an upstream repository, never a machine path.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from proof.surface.model import ANDROID, CORE, HQ, KEY_PATTERN

PINS = Path(__file__).resolve().parents[1] / "pins.json"


def test_the_extraction_is_written_in_its_one_canonical_form(extraction):
    assert extraction.text.endswith("\n") and "\t" in extraction.text
    assert extraction.text == json.dumps(extraction.document, indent="\t", sort_keys=True, ensure_ascii=False) + "\n"


def test_the_surface_records_the_pins_it_was_read_from(extraction, sources):
    pins = json.loads(PINS.read_text(encoding="utf-8"))
    recorded = extraction.document["pins"]
    assert set(recorded) == {HQ, CORE, ANDROID}
    for name, root in ((HQ, sources.hq), (CORE, sources.core), (ANDROID, sources.android)):
        head = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True)
        assert recorded[name] == head.stdout.strip() == pins[name]["commit"]


def test_every_key_and_source_is_well_formed(items):
    assert len(items) > 1000
    for key, facts in items.items():
        assert KEY_PATTERN.match(key), key
        assert facts["source"] and facts["source"] == sorted(set(facts["source"])), key
        # An authored item names where each fact was settled, Nova's emitter and Formplayer among them
        # (proof/surface/families/authored.py); every other is read from the three checkouts.
        repositories = (
            (HQ, CORE, ANDROID, "commcare-nova", "formplayer") if facts.get("authored") else (HQ, CORE, ANDROID)
        )
        for source in facts["source"]:
            assert source.split("/", 1)[0] in repositories, (key, source)
    # No path of the machine that ran the extraction reaches the surface.
    text = json.dumps(items)
    for machine_path in ("/opt/", "/tmp/", "/work/", "/private/", "/Users/"):
        assert machine_path not in text, machine_path
