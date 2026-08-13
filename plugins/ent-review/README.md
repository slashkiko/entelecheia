# ent-review plugin

Where the skill that only the review-role Actor reads is placed. `src/adapters/claude.ts` points
here with `plugins: [{ type: "local", path: ... }]`.

It is the wrapper that lets a skill be handed over while `settingSources: []` stays in place. The
host's `~/.claude` and the repository's `.claude` are left unread, and only what is placed here is
visible to the Agent.

## The skill inside does not depend on ent

`skills/semantic-review/` is a general-purpose skill used the same way outside ent as well, and is a
copy of the original at `~/.claude/skills/semantic-review/`. **Do not write ent's vocabulary — Goal,
criteria, verdict — in here.** The ent-side rewrites — reading the worktree's HEAD rather than a PR,
the Goal YAML being the primary source of intent, appending the two lines `reviewed_sha:` and
`verdict:` at the end — are all held by `REVIEW_PROMPT` in `src/adapters/claude.ts`.

Keeping it that way means splitting the skill out into another repository takes only a `cp`.

## Updating it

After editing `~/.claude/skills/semantic-review/`, copy it back over here.

**The copy here has been translated into English; the original it is copied from is still in Japanese.**
Copying straight from upstream — or replacing this with a symlink to the original — reverts the
translation. Translate again after copying, or take across only the parts that changed.

To avoid managing two copies locally, `skills/semantic-review` can be made a symlink to the original and
is still recognised as a plugin (the distributed artifact contains the real files).
