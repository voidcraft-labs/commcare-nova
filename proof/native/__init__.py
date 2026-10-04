"""Nova's native proofs: Nova's exports read by HQ's own code and run by CommCare Core (proof/README.md).

Each family is one producer's corpus. The producer (``producers/``) emits it
through Nova's real expander and compilers into ``$PROOF_OUT/native/<family>``;
an HQ step (``steps/``) regenerates what HQ builds from it through HQ's own
classes, on the shared boot and seams of ``proof.hq``; the ``test_*`` modules
assert what HQ produced; and Core's own test build runs the JUnit classes in
``core/`` over both paths' artifacts (``core_suite``), one pytest test per
class. ``session.NativeSession`` runs each producer and step once per session,
in the order the chains need.
"""
