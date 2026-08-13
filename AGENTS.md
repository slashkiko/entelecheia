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
