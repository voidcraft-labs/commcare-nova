"""The Java helper's batch: each command's document is the one the command prints alone.

Contract (``proof.surface.java.read_families``, the helper's ``batch``): the
commands of a batch read the trees ``Code.load`` parsed once in its JVM, so
none may change one. A change to a parsed tree (a property set; a node added
to, removed from or replaced in a list; a node moved to another parent) is
refused before JavaParser applies it, and fails the batch naming the command
and the file; a command's own copy (``Node.clone()``, which
``Runtimes.printed`` changes) stays free to change. The plausible failure: a
command that changes a tree it read, so every command after it in the batch
reads the changed tree, and the surface (``npm run surface`` reads through the
batch too) records what no command alone would.

The helper is compiled from a temporary copy with the changes planted into
its ``session`` command, and runs that command alone in a batch over the
pinned Core, whose ``org/commcare/session`` it reads.
"""

from __future__ import annotations

import subprocess

from proof.surface import java

ANCHOR = "result = Runtimes.sessionInstance(code);"
# Far more than the helper takes to read Core's session package and fail; a helper that never ends fails the test.
DEADLINE_SECONDS = 120
# Each change is tried in turn and its refusal written to standard error; then one change is left to fail the batch.
PLANTED = """com.github.javaparser.ast.CompilationUnit tree = code.units.get(0).tree;
                com.github.javaparser.ast.body.TypeDeclaration<?> type = tree.getType(0);
                for (Runnable change : List.<Runnable>of(
                        () -> type.clone().setName("Planted"),
                        () -> type.setName("Planted"),
                        () -> tree.getImports().add(
                            new com.github.javaparser.ast.ImportDeclaration("planted", false, false)),
                        () -> type.getMembers().get(0).remove(),
                        () -> type.getMembers().set(0, type.getMembers().get(0).clone()),
                        () -> type.getMembers().get(0).setParentNode(tree))) {
                    try {
                        change.run();
                        System.err.println("planted: allowed");
                    } catch (IllegalStateException refused) {
                        System.err.println("planted: " + refused.getMessage());
                    }
                }
                type.setName("Planted");
                result = null;"""
REFUSED = "The surface helper changed the tree it parsed from "
FILE = "src/main/java/org/commcare/session/CommCareSession.java"


def test_a_command_that_changes_a_tree_it_parsed_fails_the_batch_and_names_itself(plant, sources, tmp_path):
    root = plant(java.SOURCE_DIR, ["nova"], {"nova/proof/surface/Main.java": (ANCHOR, PLANTED)})
    classes = tmp_path / "classes"
    classes.mkdir()
    java.compile_helper(sources, root, classes)
    finished = subprocess.run(
        java.helper_command(sources, classes, "batch", None, None, ["session"]),
        capture_output=True,
        timeout=DEADLINE_SECONDS,
        check=False,
    )
    errors = finished.stderr.decode("utf-8", "replace")
    assert finished.returncode == 1 and finished.stdout == b"", errors[-4000:]

    tried = [line.removeprefix("planted: ") for line in errors.splitlines() if line.startswith("planted: ")]
    # The copy changes; each change to the parsed tree is refused, naming the file and what changed.
    assert tried[0] == "allowed", errors[-4000:]
    refusals = tried[1:]
    assert len(refusals) == 5, errors[-4000:]
    assert all(refusal.startswith(REFUSED + str(sources.core / FILE)) for refusal in refusals), refusals
    changes = [refusal.split(": it ", 1)[1].split(".", 1)[0] for refusal in refusals]
    assert changes[0] == "set its name"
    assert changes[1].startswith("added ImportDeclaration at ")
    assert changes[2].startswith("removed ") and changes[3].startswith("replaced ")
    assert changes[4] == "moved it to another parent"
    # The one left unhandled fails the batch, which names the command.
    assert f"The batch's session command failed: {REFUSED}{sources.core / FILE}" in errors
