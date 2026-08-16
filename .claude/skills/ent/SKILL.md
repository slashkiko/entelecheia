---
name: ent
description: Procedure for converging a Goal with the ent CLI. Covers reading the structure with agent-context, first-time setup with init, checking prerequisites with doctor, one round of start / run / get / list, looking ahead with --dry-run, ending a Goal that is no longer pursued with abandon, sending progress to stdout or a file instead of posting it to the PR with --report, narrowing output with --limit, reading exit codes, and where WAITING_HUMAN and ESCALATE wait for human approval or intervention.
---

# Running ent

`ent` is a controller that converges the current state onto a declared end state. What follows is the
procedure written for agents to invoke. The human-facing introduction is in README.md; it is not duplicated here.

## The first thing to invoke

```
ent agent-context
```

Emits subcommands, arguments, flag types, environment variables and exit codes as JSON.
There is no need to read the prose of `--help`. Where the procedure below has gone stale, that output is authoritative.

## Choosing an Actor

The default is Claude Code. To put every phase on Codex, add `ENT_ACTOR=codex` to the same command.
Provider, model and effort can also be chosen per `DECIDE`, `IMPLEMENT`, `REVIEW` and `INVESTIGATE`.
`ENT_<PHASE>_ACTOR` / `ENT_<PHASE>_MODEL` / `ENT_<PHASE>_EFFORT` are the phase-specific settings; when
absent they fall back to `ENT_ACTOR` / `ENT_MODEL` / `ENT_EFFORT`.
Valid effort values are `low / medium / high / xhigh / max` for Claude Code and
`none / minimal / low / medium / high / xhigh` for Codex. A value that does not match the provider is an argument error.

```sh
ENT_ACTOR=codex ent doctor
ENT_ACTOR=codex ent run <slug>

ENT_DECIDE_ACTOR=codex \
ENT_IMPLEMENT_ACTOR=claude-code \
ENT_REVIEW_MODEL=<model> \
ent run <slug>
```

These are the defaults. DECIDE may override them for a single tick by returning an `ACT` with an
`agent` block (`{"actor":"claude-code|codex","model":"...","effort":"..."}`); naming a model or an
effort requires naming the actor too, and the actor must be one these variables already selected.
What is omitted runs on that provider's own default rather than the phase's variables. The provider
that ran is recorded on the Run.
DECIDE cannot pick its own provider that way — the decide phase stays on the environment variables.

The chosen values are not pinned into the DB across ticks. Pass the same environment variables every time, cron included.
If even one phase involves Codex, confirm the login first with `codex login status`.
When an Actor stops at a usage limit, the failure classification and tokens are saved to the Run, and the
guard replaces the original ACT with `WAIT(usage_limit)`. The Goal transitions to
`WAITING_EXTERNAL(usage_limit)` and is not run again until `resume_after`.

## Repositories that do not have `.goals/` yet

Where `.goals/` is absent, `ent doctor` fails `goals` and `state_ignored` at the same time.
Nothing is broken; it has simply not been started. There is one command to invoke once before the first round.

```
ent init                    # place .goals/, the .gitignore line and the Goal template
```

`ent init` is idempotent: a second run does not overwrite existing `.goals/*.yaml` and does not add the same
line to `.gitignore` twice. Outside a git repository it creates nothing and refuses with exit code 1.

**It writes outside the repository as well.** It places at `~/.claude/skills/ent` a symlink pointing at ent's own
`.claude/skills/ent`, so that an agent working in the target repository can read this procedure as a
skill. Nothing is copied, so the canonical copy stays in the single place inside ent itself. No
`.claude/` appears on the target repository's side. **It rewrites `$HOME`, so it is not something to invoke without asking the human.**

If it already points here, it is left untouched (that is where idempotence holds). If anything other than
a link to this ent is already there — a link pointing elsewhere, a broken link, a real directory — it
creates nothing at all, `.goals/` included, and refuses with exit code 1. It is not ent's place to decide
which one is authoritative, so ask the human whether to move the existing one aside. Only when ent's own
`.claude/skills/ent` cannot be found does it write to stderr instead of refusing and finish without the link.

With `--json`, this one entry appears in `entries` too. The first run is `created` and every run after that
is `kept`, and while `path` is relative for things inside the repository, this one alone is an absolute path.

The template is filled in only as far as being schema-valid. The remaining `desired_state` and
`acceptance_criteria` are what declares what is to be achieved. **These two are the human's to write; an
agent must not fill them in and proceed to `ent start`.**

## One round

```
ent doctor                  # check read-only whether the prerequisites for running are in place
ent start <slug>            # register .goals/<slug>.yaml and make it ACTIVE
ent run <slug>              # run exactly one tick and exit
ent get <slug>              # read the declaration and the runtime state together
ent list                    # list the registered Goals
```

`ent start` records the HEAD of the directory it was invoked in as the gate's baseline. The Actor's
worktree is cut from that commit, and the commit the gate diffs the worktree against is the same one.
**Commit the Goal's declaration and spec before `ent start`.** Then what the human wrote lands on the
baseline side, and the worktree diff lists only what the Actor wrote.

While it is running, never amend or rebase that baseline commit. If the fork point disappears the diff
cannot be taken and it stops at `ESCALATE(guard_unavailable)`. Avoid rewriting `.goals/*.yaml`
mid-tick as well. It is picked up as a before/after difference on the main repository side, and since
`.goals/**` is a protected path that cannot be removed from any Goal, it becomes `protected_path_touched`.

When HEAD could not be read, and for Goals started before this record existed, `default_branch` is the
baseline. In that case what the human wrote is listed as the Actor's edits too. For what to do once it
has stopped, read "Where it stops for human approval" below.

There is one more subcommand, used only when stepping away from a Goal that is no longer pursued.

```
ent abandon <slug> --reason "why it is no longer pursued"
```

`--reason` is required, and whitespace alone does not pass. It sets status to `ABANDONED` and records the
reason, so the next tick stops picking that Goal up. The reason appears in `state.abandonReason` of `ent get`.

**There is no matching `ent complete`.** Completion is judged from VERIFIED Facts alone
(design.md §3.1), so
there is no way to write "completed" while criteria are still red. `abandon` is what to use when the desired
state was met outside the loop (a human merged the PR by hand, for example).
It records "no longer pursued", not "finished".

If the state cannot be dropped, it stops with exit code 1 and writes nothing.

- Already terminal (`COMPLETED` / `FAILED` / `ABANDONED`). Terminal states are never painted over
- `state.leaseOwner` is set. Never drop it from the side while another process is running it
- `ent start` was never run. There is no state to step down to

Only a forgotten `--reason` gives 2. Retyping argv makes it pass, so it falls the other way from 1.

`ent doctor` writes nothing at all. It does not even create the state directory.

A missing prerequisite does not make `ent run` fail at the entrance. Local observation, verification
commands and Actor execution all proceed without a GitHub token, and killing it at the entrance would
stop work that could still move. In exchange, running without being able to read a single token leaves
`type: fact` criteria such as `github.ci.failed_job_count` unobserved and unfilled forever. It keeps
running, so it goes unnoticed. doctor reports what is missing on the spot.

`doctor` and `run` read the GitHub token in the same order (`GITHUB_TOKEN` → `GH_TOKEN` →
`gh auth token`). From an interactive shell, being logged in to gh is enough; no environment variable
needs to be passed. **From cron it is different**: PATH and gh's configuration are not necessarily
inherited, so set `GITHUB_TOKEN` explicitly, or invoke `ent doctor` in the same environment and check.
doctor's `github_token` fails only when none of the three could be read.
An **empty string** in the environment variable reads as "decided not to pass one", and gh is not called
either. Unset and empty differ in meaning only here.

Exit codes alone mean something different from the other subcommands. 0 is "no failed check at all" and
1 is "one or more failed". It is not a runtime error. unknown is not counted.
The login state of the chosen provider appears as `claude_login` or `codex_login`, with unknown.
When providers are mixed across phases, both appear.
The detail is in `checks[].detail` of the JSON on stdout, not on stderr.

`ent run` **always finishes in one tick**. It is not resident, and there is no flag to wait for completion.
Converging means invoking `ent run` repeatedly (running it from cron is the intended shape).
Waiting is not sleeping inside `ent run`; it comes back as a `WAIT` decision.
The exception is dependency waiting from `goal.depends_on`, which creates neither a `WAIT` nor a state
transition and appears in `skipped`.
Do not write your own polling. Waiting for the next round is the caller's job.

To look at the contents before running:

```
ent run <slug> --dry-run    # run only OBSERVE / VERIFY / ASSESS / DECIDE
```

The Actor is not launched and nothing is written to the PR. snapshot / verifications / decision /
status are not written either. What the next tick would observe, which criteria are failing and
what it intends to do next are all readable.

It is not free. VERIFY really runs the criteria's commands, and DECIDE calls the LLM.
The tokens consumed leave a record in `llm_calls`. It is not something safe to invoke any number of times.

Output is `ran: false` / `dryRun: true`. Where it would have moved had it written goes into
`wouldTransitionTo`. `skipped` is `null` as a rule, but for a Goal that never went through `ent start`
it holds `the Goal is not registered` (which is the situation right after `ent init`).
Tell dry-run apart by `dryRun`, not by `skipped`.

## Running without posting progress to the PR

By default the criteria pass status is stacked as PR comments. To run without posting:

```
ent run <slug> --report stdout          # lands in report.body of the output JSON
ent run <slug> --report ./progress.md   # appends to the file
```

What moves is the destination of the progress, and it gains one section there (next paragraph).
Neither observation nor decision changes, and push and PR creation are not stopped either. The PR itself
is published as before. What stops being posted is the criteria pass status.

It is emitted without `GITHUB_TOKEN`, and even when there is no PR yet. Writing progress happens before
securing a PR, and is decoupled from whether one can be secured.

Specifying `stdout` does not send raw Markdown down the pipe. stdout stays JSON-only and the body goes
into `report.body`. To show it to a human, pull it out with `jq -r .report.body`.

**The `--report` body carries a `## Review role message` section at the end.** It reproduces verbatim the
body the review role returned last, and it is never included in PR comments. **The `--report` body and the
PR comment body are therefore not the same.** The section appears only on ticks where `--report` was
passed, and for a Goal where `ReviewPort.latest()` returns null (the review role was never launched, or
no Run has completed) the section is absent entirely. When the raw log could not be read, the reason goes
into the section; for a Run whose body was not retained, the id of the Run that was read goes in. The tick does not fail.

**How the section stacks differs by destination.** `stdout` emits once per invocation so nothing piles up,
but a file is appended to, so the bodies line up once per run. And since the section reads the most recent
completed review-role Run, the content stays the same every tick until the next review finishes
(the stretch where `WAIT(review_pending)` continues). For long runs, use `stdout` or split the
destination files.

What goes into `report` in the output:

| Destination | What it holds |
| --- | --- |
| `stdout` | `destination` / `written` / `error` / `body` |
| file | `destination` / `path` / `written` / `error` (the body is on the file's side) |

`written: false` happens two ways. It could not be written (`error` holds the reason and one line also
goes to stderr), or the tick did not run at all (`error` is null and the reason is in `skipped` of the
same output). Neither changes the exit code. A failed notification does not repaint the tick's
success or failure.

Only `run` accepts `--report`; passing it to another subcommand gives exit code 2.
Combining it with `--dry-run` is refused with 2 as well. That path does not go through publish so there is
nowhere to write, and the criteria results are on the `observed.verifications` side.

## Narrowing the output

`run` / `get` / `list` emit JSON by default. `init`, `start` and `abandon` emit JSON only when `--json`
is passed.
`doctor` and `agent-context` are always JSON and accept neither `--json` nor `--limit`.
Passing them gives exit code 2.

```
ent list --limit 10
ent get <slug> --limit 5    # the number of runs. The oldest are dropped first
```

`--limit` defaults to 50. Only when something was truncated does the way to narrow it appear on **stderr**.
stdout of `run` / `get` / `list` (and of `init` / `start` / `abandon` with `--json`) is JSON only, so it
can be piped straight into `jq`.

## Where it stops for human approval

`WAITING_HUMAN` is not a failure. Until a human acts, no number of runs changes the state.
Detection of the approval happens on the next tick, though, so continuing to run is itself correct.

- PR review approval
- `/ent approve <criterion-id>` in a PR comment (criteria with `verification.type: human`)

An agent must never perform either of these on a human's behalf. They are the signal that a human
approved, so emitting them in their place erases the meaning of the approval. Read which criterion is
waiting from `verifications` of `ent get <slug>`.

**Both routes count only people with write access to the repository.**
Review approval excludes the PR's author (GitHub itself does not allow approving your own PR), while the
comment phrase counts the author too. In a repository run by one person, that is the only
approval route (design.md §10-4).

`ESCALATE` is an action, not a Goal state. An `ESCALATE` from `protected_path_touched` is the state of
being stopped with a change left on a path that must not be touched, and the Goal state for it is
`WAITING_HUMAN`. It is not waiting for approval but waiting for a human to clear it. The next tick will
not resolve it either. `guard_unavailable` has the same shape, but means **the gate itself could not be
run** rather than "nothing was touched". A vanished baseline commit is what that covers. Only the
`budget_exhausted` `ESCALATE` gives `BLOCKED`.

What goes into `status` is the Goal state (`ACTIVE` / `WAITING_HUMAN` / `WAITING_EXTERNAL` /
`BLOCKED` / `COMPLETED` and so on); `ESCALATE` and `WAIT` appear on the `action` side.

## When the controller did not push or open the PR

When the Goal's declaration has `policies.publish`, the controller does not perform a step written as
`manual`. `publishHold` appears in that tick's output (it is absent for Goals with no such declaration).

| Key | What it holds |
| --- | --- |
| `step` | The step that was stopped. Either `push_branch` or `open_pull_request` |
| `reason` | `declared_manual`. That the declaration stopped it |
| `pushed` | Whether `branch` is on the remote |
| `branch` | The branch that becomes the PR's head |
| `base` | The PR's base |

Branch on these keys. `skipped` and `decision.rationale` are one line of prose for humans, so branching on
their wording breaks silently the moment the wording is edited.

In the same tick, `action` is `ESCALATE(push_branch_declared_manual)` or
`ESCALATE(open_pull_request_declared_manual)`, and `status` is `WAITING_HUMAN`.

`--dry-run` does not reflect this stop. It does not go through publish, so `publishHold` is absent and
`wouldTransitionTo` comes back as the decision from before the stop. For a Goal stopped by a declaration,
the dry-run forecast and the real tick's result disagree.

**If `step: open_pull_request` (`pushed: true`), open the PR on its behalf.**
The branch is already on the remote, and the only thing stopping it is that the controller was declared
not to create it. That declaration is a way to keep the controller from creating it, not a way to keep
the invoker from creating it.

```
gh pr create --head <publishHold.branch> --base <publishHold.base> \
  --title <the Goal's name> --body <the body>
```

**Read the declarations the takeover needs from `.goals/<slug>.yaml`. They are not in `ent get`.**
All `ent get` emits from the declaration is `goal` (`id` / `name` / `desired_state` / `depends_on`);
neither `repository` nor `acceptance_criteria` yields a single key. What `verifications` holds is only the
criterion ids and results, so neither the description nor `verification.type` is on that side. What
`publishHold` holds is what the declaration cannot determine (`branch` and `pushed`).

| What the takeover needs | Where to read it |
| --- | --- |
| head and base | `publishHold.branch` / `publishHold.base` |
| Whether to pass `--draft` | `repository.pull_request.draft` in `.goals/<slug>.yaml` |
| The PR title | `goal.name` in `.goals/<slug>.yaml` (the `goal` of `ent get` works too) |
| Desired State in the body | the same `goal.desired_state` |
| The criteria list in the body | `acceptance_criteria` in `.goals/<slug>.yaml` (id / `verification.type` / description) |

With `repository.pull_request.draft: true`, pass `--draft`. It is the value the controller passes when it
opens the PR, so forgetting it means **only the PR opened on its behalf notifies the reviewers**.
That notification is exactly what `open_pull_request: manual` is trying to stop.

Make the body the same shape the controller opens with (`pullRequestBody`, `src/publish/index.ts`).

````markdown
Changes for the entelecheia Goal `<goal.id>`.

## Desired State

<goal.desired_state>

## Acceptance Criteria

- `<id>` (<verification.type>) <description>

The controller stacks progress as comments. Approve with the following phrase.

```
/ent approve <criterion-id>
```
````

For criteria with `verification.type: human`, reviewers cannot find the way to approve unless that fixed
phrase is in the body. **Do not replace `<criterion-id>` in the body with the real id.** What counts as
approval is on the PR comment side, and only when the whole line matches `/ent approve <the real id>`.
Keep the body as a template that shows how to write it.

The next tick finds that PR and moves on. The declaration can stay as it is.
**Only when the human has said they want to see the contents before it is opened**, leave it unopened and
hand `publishHold` over as it is.

**Do not take over `step: push_branch` (`pushed: false`).** The branch is not on the remote, so the PR
cannot be opened. Even a hand push cannot be observed by the controller, so it stops in the same place
every tick until the declaration is set back to `auto`. Hand it to the human.

**It will not become `BLOCKED`.** Even once the budget runs out,
`ESCALATE(push_branch_declared_manual)` overwrites `ESCALATE(budget_exhausted)`, so the state stays
`WAITING_HUMAN`. While it is stopped, `max_reconciles` and `max_actor_runs` advance, but `max_wall_clock`
alone stops (every `ESCALATE` other than budget exhaustion is subtracted from elapsed time as waiting).
"It will go `BLOCKED` eventually and catch your eye" does not happen, so it stays stopped until it is
handed to a human.

A tick stopped by a gate such as `ESCALATE(protected_path_touched)` carries no `publishHold`.
Those are stops where neither the push nor the PR may be taken over.

## Exit codes

| code | Meaning |
| --- | --- |
| 0 | Success. The tick ran to the end (`ran: false` is 0 too). For `doctor`, no failed check at all |
| 1 | Runtime error, or a state that cannot be run. Detail on stderr. For `doctor`, one or more failed, with detail in the JSON on stdout |
| 2 | Invalid arguments. The valid values are listed on stderr |

Do not mistake 1 for 2. 2 means "retyping it will work", and the valid values are listed on stderr.
A state where argv is valid but cannot be run — running `ent start` against a terminal Goal, for
example — is 1. Making that 2 leaves the caller retrying with different argv forever.

`ran: false` is not a failure. `skipped` holds the reason (asleep / another worker is handling it / terminal).
`--dry-run` is not a failure at `ran: false` either, and `skipped` is `null` as a rule.
Only when applied to an unregistered Goal does it hold a reason, so tell dry-run apart by
`dryRun: true`, not by `skipped`.
