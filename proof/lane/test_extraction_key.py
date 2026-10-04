"""A surface extraction stands in for a run's own only when the run's image and extractor code made it.

Contract (``proof.lane.extraction``): an extraction carries its key, the
image's id and the digest of the extractor's code (every file under
``proof/surface`` but its tests and conftest, and the Python of
``proof/hq``), read before it ran; ``key_problem`` accepts a named extraction
whose key is this run's and refuses any other, naming both keys. The
plausible failures: an extraction another image or older extractor code made
standing in for this run's (the surface block's verdict would then hold
nothing about the code under test), a change to the extractor that the
digest misses, and a test or a compiled file changing the key, which would
throw away extractions nothing invalidated.
"""

from __future__ import annotations

import pytest

from proof.lane import extraction


def _tree(root):
    files = {
        "surface/__main__.py": "main\n",
        "surface/families/flags.py": "flags\n",
        "surface/js/surface.mjs": "js\n",
        "surface/test_flags.py": "a test\n",
        "surface/conftest.py": "fixtures\n",
        "surface/__pycache__/model.cpython-313.pyc": "compiled\n",
        "hq/boot.py": "boot\n",
        "hq/test_boot.py": "a test\n",
        "hq/schema.sql": "not python\n",
    }
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)
    return root


def test_the_digest_follows_the_extractors_code_and_nothing_else(tmp_path):
    root = _tree(tmp_path / "proof")
    listed = [path.relative_to(root).as_posix() for path in extraction.extractor_files(root)]
    assert listed == ["hq/boot.py", "surface/__main__.py", "surface/families/flags.py", "surface/js/surface.mjs"]
    digest = extraction.extractor_digest(root)
    for name in ("surface/test_flags.py", "surface/conftest.py", "surface/__pycache__/model.cpython-313.pyc"):
        (root / name).write_text("changed\n")
    (root / "hq/schema.sql").write_text("changed\n")
    assert extraction.extractor_digest(root) == digest
    for name in ("surface/families/flags.py", "surface/js/surface.mjs", "hq/boot.py"):
        (root / name).write_text((root / name).read_text() + "edited\n")
        assert extraction.extractor_digest(root) != digest, name
        digest = extraction.extractor_digest(root)
    (root / "surface/families/added.py").write_text("new\n")
    assert extraction.extractor_digest(root) != digest


@pytest.fixture
def run_key(tmp_path, monkeypatch):
    root = _tree(tmp_path / "proof")
    monkeypatch.setenv(extraction.IMAGE_ENVIRONMENT, "sha256:" + "1" * 64)
    return extraction.key(root)


def test_an_extraction_this_runs_image_and_code_made_stands_in(tmp_path, run_key):
    made = tmp_path / "made"
    made.mkdir()
    extraction.write_key(made, run_key)
    assert extraction.key_problem(made, run_key) is None


def test_an_extraction_another_image_or_other_code_made_is_refused_naming_both_keys(tmp_path, run_key):
    for changed in ({"image": "sha256:" + "2" * 64}, {"extractor": "0" * 64}):
        made = tmp_path / next(iter(changed))
        made.mkdir()
        extraction.write_key(made, {**run_key, **changed})
        problem = extraction.key_problem(made, run_key)
        assert problem is not None and "cannot stand in" in problem
        assert next(iter(changed.values())) in problem and run_key[next(iter(changed))] in problem

    unkeyed = tmp_path / "unkeyed"
    unkeyed.mkdir()
    assert "holds no readable extraction.json" in extraction.key_problem(unkeyed, run_key)

    made = tmp_path / "made"
    made.mkdir()
    extraction.write_key(made, run_key)
    assert "does not know its image" in extraction.key_problem(made, {**run_key, "image": None})
