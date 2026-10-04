"""A rebound function reads its replacement in every module that binds it, whenever the module was imported.

Contract: inside ``rebound(original, replacement)`` every module-level
binding of ``original`` reads ``replacement``, and at exit every binding of
``replacement`` reads ``original`` again, including the bindings of modules
imported inside the block. ``rebound`` keeps the bindings it found for the
process and reads only the modules imported since, so the plausible failure
is a binding the kept list lacks: a module imported after the first block
(between blocks, or inside one) that the next block leaves reading the real
function, or one imported inside a block left reading a replacement whose
seam has closed, including inside a block nested in another (a check's
seams opened inside another check's, as configuration sensitivity opens a
flipped flag seam inside the plain one), where the inner block reads such a
module first.

The modules are real files imported by Python's import system, each binding
the function with ``from <source> import answer`` as HQ's modules do, so a
module imported inside a block binds whatever its source holds then.
"""

from __future__ import annotations

import importlib
import subprocess
import sys
import types
import uuid

import pytest

from proof.hq.seams import rebound

SOURCE = """
def answer():
    return "original"
"""


@pytest.fixture
def modules(tmp_path):
    """Import modules written into ``tmp_path``: ``modules(name, text)``; each is removed when the test ends."""
    prefix = f"proof_rebound_{uuid.uuid4().hex[:8]}"
    imported = []
    sys.path.insert(0, str(tmp_path))

    def load(name, text):
        full = f"{prefix}_{name}"
        (tmp_path / f"{full}.py").write_text(text.replace("{source}", f"{prefix}_source"))
        imported.append(full)
        return importlib.import_module(full)

    try:
        yield load
    finally:
        sys.path.remove(str(tmp_path))
        for name in imported:
            sys.modules.pop(name, None)


def _replacement():
    return "replacement"


def test_every_binding_reads_the_replacement_however_late_its_module_was_imported(modules):
    source = modules("source", SOURCE)
    original = source.answer
    before = modules("before", "from {source} import answer\n")

    with rebound(original, _replacement):
        assert (source.answer(), before.answer()) == ("replacement", "replacement")
        inside = modules("inside", "from {source} import answer\n")
        assert inside.answer is _replacement  # imported while the source held the replacement
    assert source.answer is before.answer is inside.answer is original

    between = modules("between", "from {source} import answer as aliased\n")
    with rebound(original, _replacement):
        bound = (source.answer, before.answer, inside.answer, between.aliased)
        assert all(binding is _replacement for binding in bound), bound
    assert source.answer is before.answer is inside.answer is between.aliased is original


def test_a_binding_someone_else_holds_is_left_to_them(modules):
    """Only bindings that read the original are patched, and only the replacement is restored."""
    source = modules("source", SOURCE)
    original = source.answer
    held = modules("held", "from {source} import answer\n")

    def theirs():
        return "theirs"

    with rebound(original, _replacement):
        pass  # the bindings are now known
    held.answer = theirs
    with rebound(original, _replacement):
        assert source.answer is _replacement and held.answer is theirs
    assert source.answer is original and held.answer is theirs


def test_a_nested_block_over_the_outer_replacement_leaves_every_binding_as_the_outer_block_found_it(modules):
    """A seam opened inside another reads the function from its source, so it rebinds the outer replacement."""
    source = modules("source", SOURCE)
    original = source.answer
    before = modules("before", "from {source} import answer\n")

    def outer():
        return "outer"

    def inner():
        return "inner"

    with rebound(original, outer):
        between = modules("between", "from {source} import answer\n")
        with rebound(source.answer, inner):
            assert (source.answer, before.answer, between.answer) == (inner, inner, inner)
            inside = modules("inside", "from {source} import answer\n")
            assert inside.answer is inner
        assert all(binding is outer for binding in (source.answer, before.answer, between.answer, inside.answer))
    assert source.answer is before.answer is between.answer is inside.answer is original


def test_a_nested_block_over_the_same_original_leaves_no_replacement_behind(modules):
    """The outer block's exit reads again the modules the inner block read while they held the outer replacement."""
    source = modules("source", SOURCE)
    original = source.answer

    def outer():
        return "outer"

    with rebound(original, outer):
        pass  # the source's binding is known
    with rebound(original, outer):
        between = modules("between", "from {source} import answer\n")
        with rebound(original, _replacement):
            inside = modules("inside", "from {source} import answer\n")
            assert (between.answer, inside.answer) == (outer, outer)
    assert source.answer is between.answer is inside.answer is original
    with rebound(original, _replacement):
        assert all(binding is _replacement for binding in (source.answer, between.answer, inside.answer))
    assert source.answer is between.answer is inside.answer is original


# The scan of sys.modules -------------------------------------------------------------------------
#
# Contract: ``_Modules.sync`` adds every module put into ``sys.modules``
# since its last call, reading only those (so a seam opened when nothing was
# imported reads nothing), and finds what a read of the whole dict finds. The
# plausible failures: a module added while another was removed (the dict's
# length unchanged), a module put back after its removal, a module put in
# place of another under a name the dict already held, and a dict merged in
# whole after a clear (as ``mock.patch.dict(sys.modules)`` restores it), each
# leaving a binding unread.


def _whole_read():
    return {id(module) for module in list(sys.modules.values()) if isinstance(module, types.ModuleType)}


def test_the_scan_reads_only_the_modules_added_since_it_last_ran(modules):
    from proof.hq.seams import _MODULES

    _MODULES.sync()
    read = _MODULES.read
    _MODULES.sync()
    assert _MODULES.read == read  # nothing imported: nothing read

    added = [modules(f"added{index}", "VALUE = 1\n") for index in range(3)]
    _MODULES.sync()
    # Each import puts its module in once (Python's import system may move it
    # to the end of the dict, which puts it in again).
    assert 3 <= _MODULES.read - read <= 6
    assert all(module in _MODULES.seen for module in added)
    assert _whole_read() <= {id(module) for module in _MODULES.seen}


def test_the_scan_finds_every_module_whatever_was_removed_put_back_or_swapped(modules):
    from proof.hq.seams import _MODULES

    first = modules("first", "VALUE = 1\n")
    _MODULES.sync()
    # A removal and an addition, leaving the dict's length as it was.
    sys.modules.pop(first.__name__)
    swapped = modules("swapped", "VALUE = 2\n")
    _MODULES.sync()
    assert swapped in _MODULES.seen
    # A name removed and put back holds a new module, at the end.
    sys.modules.pop(swapped.__name__)
    put_back = types.ModuleType(swapped.__name__)
    sys.modules[swapped.__name__] = put_back
    _MODULES.sync()
    assert put_back in _MODULES.seen
    # A module put in place of another under a name the dict holds, which
    # leaves the name where it was.
    in_place = types.ModuleType(swapped.__name__)
    sys.modules[swapped.__name__] = in_place
    try:
        read = _MODULES.read
        _MODULES.sync()
        assert in_place in _MODULES.seen and _MODULES.read - read == 1
    finally:
        sys.modules[swapped.__name__] = swapped
    _MODULES.sync()
    assert _whole_read() <= {id(module) for module in _MODULES.seen}


def test_the_scan_finds_a_dict_merged_in_whole_after_a_clear():
    """``sys.modules`` emptied and refilled from a copy, as ``mock.patch.dict`` restores it, in a fresh
    single-threaded process (no other thread may import while the dict is empty)."""
    script = """
import sys, types
from proof.hq import seams
seams._MODULES.sync()
saved = dict(sys.modules)
merged = types.ModuleType("proof_rebound_merged")
saved["proof_rebound_merged"] = merged
sys.modules.clear()
sys.modules.update(saved)
read = seams._MODULES.read
seams._MODULES.sync()
seams._MODULES._verify(sys.modules)
print(merged in seams._MODULES.seen, seams._MODULES.read - read >= len(saved))
"""
    completed = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=120)
    assert completed.returncode == 0, completed.stderr[-4000:]
    assert completed.stdout.split() == ["True", "True"]


def test_the_verify_mode_refuses_a_module_the_watcher_did_not_see_and_accepts_imports(modules, monkeypatch):
    """Verify mode reads the whole dict on every call; a module put in while the watcher was not watching
    (taken off behind the scan's back here) is refused, and imports the watcher saw are accepted."""
    from proof.hq import seams

    monkeypatch.setattr(seams, "VERIFY_MEMOS", True)
    modules("verified", "VALUE = 1\n")
    seams._MODULES.sync()  # accepted: an import
    _, watch, unwatch, _ = seams._dict_watcher_api()
    unwatch(seams._MODULES._watcher, sys.modules)
    try:
        unseen = modules("unseen", "VALUE = 2\n")
    finally:
        watch(seams._MODULES._watcher, sys.modules)
    with pytest.raises(seams.SeamRefused, match=unseen.__name__):
        seams._MODULES.sync()
