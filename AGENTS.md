# AGENTS.md -- registry lane working instructions

Cross-lane coordination goes through the private relay bus at
`E:\xiom-lang\xiom-relays` (clone of `xiom-lang/xiom-relays`; protocol in its
`README.md` / `PROTOCOL.md`, CLI is `tools/relay.py`, stdlib-only Python).

- At session start and before finishing any task: pull xiom-relays and
  process items addressed to this lane
  (`python tools/relay.py view --lane registry`).
- Never edit another lane's item; open a new item instead.

Everything cross-lane (findings, wishlists, release checks) goes through the
bus; do not wait for hand-relayed messages.

Robustness: if `git pull --ff-only` reports `Cannot fast-forward to multiple
branches`, use `git fetch origin` then `git merge --ff-only origin/main`.
