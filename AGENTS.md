# AGENTS.md

The procedure for invoking `ent` in this repository is written in `.claude/skills/ent/SKILL.md`.
Claude Code picks it up as a skill. Codex picks up the same canonical copy through the
`.agents/skills/ent` symlink, and every other agent gets there from this file.

The procedure is not copied here. Writing the same thing in two places leaves no way to tell
which one is authoritative once one of them goes stale. Read one place only: `.claude/skills/ent/SKILL.md`.

**The rules for working on ent's own code are in `CLAUDE.md`.** They are separate from the procedure
for using ent (SKILL.md), and cover putting the entry point through the mise task and not running
in parallel from the same directory. Read it before starting work on ent itself.

The human-facing introduction is in `README.md` (English; the Japanese is `README.ja.md`, same content),
and the design background is in `docs/design.md` (English; the Japanese is `docs/design.ja.md`, same content).

**What goes into this repository is decided by the owner, whose procedure is written in
`.claude/skills/owner/SKILL.md`.** Claude Code reaches it through `.claude/agents/owner.md`;
Codex picks up the same canonical copy through the `.agents/skills/owner` symlink, the same way
it reaches `ent`. The procedure judges a proposal against the core design decisions in
`docs/design.md` — take it, reject it, or change its shape — and holds nothing about the design
itself. Each judgement is recorded under `docs/decisions/`, one file per decision, rejected
proposals included. The design stays in `docs/design.md` alone.
