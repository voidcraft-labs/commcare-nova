"""The proof lane's runtime (proof/README.md): one HQ boot forked into workers that run queued blocks.

- ``blocks``: the queue a lane runs (blocks of groups, and the groups whose
  judgments are cached), and what a block's run leaves in the output.
  Standard library only.
- ``serve``: ``python -m proof.lane.serve``, the fork server. One process
  boots HQ, restores HQ's template database, compiles the Core runner and
  warms HQ, then forks pytest workers, claims blocks and hands their groups
  out, and writes each block's manifest.
- ``broker``: which group a worker runs next, which blocks to claim, and when
  a block is finished; the server's decisions, apart from its processes.
- ``worker``: what a forked worker does, and ``plugin.LanePlugin``, the
  pytest plugin that runs the groups the server hands it.
- ``timings``: what each group cost a worker, without what its session
  shares.
- ``gate``: ``python -m proof.lane.gate``, the lane's verdict from every
  shard's output, on the standard library alone.
- ``reader``: the gate's reader of cached judgments from the evidence store.
- ``extraction``: ``python -m proof.lane.extraction``, the surface
  extraction with its key (the image and the extractor code that made it),
  which decides whether a named extraction may stand in for a run's own.
"""
