# entelecheia

> Declare the end state; the controller converges to it.

**A human declares the project's finished state (the Desired State), and the controller converges
on it.** The controller observes the current state and keeps ticking until the gap is closed. At the
step where it decides *how* to close the gap, it launches Claude Code or Codex. The CLI is named
`ent`.

*Entelecheia* (ἐντελέχεια) is Aristotle's term for the state in which potentiality has become
actuality. It names exactly the state this tool tries to realize for a Goal.

*English | [日本語](README.ja.md)*

This README covers the design essentials, where the project stands, and how to use it. The full
design, the reasoning behind each decision, and the phase plan live in
[`docs/design.md`](docs/design.md). Read that first when you start working in this repository.

## Design essentials

**The MVP is complete.** All nine completion conditions in design.md §9 have been confirmed. But §9
only asks "does the controller run all the way through"; "can the Agent rewrite the control loop"
is not part of it. So after completion we ran one review pass and closed the gaps in the
self-hosting safeguards and in the tests.

The core of the design is that **the LLM decides neither completion nor the stopping conditions for
runaway behavior**. All that is delegated to the LLM is how to close the gap. What follows covers,
in order: one tick and its vocabulary, the design principles and their implementation status, the
boundary between guard and LLM, the protected-path gate, the switch that keeps push and PR creation
in human hands, the credentials never handed to the Agent, and where Goal state is kept.

### One tick and its vocabulary

The controller cycles through OBSERVE / ASSESS / DECIDE / ACT / VERIFY. It opens the PR itself and
accumulates progress in comments. It then detects human approval and proceeds to COMPLETED.

**Actor** is the abstraction for the execution subject the controller launches. There are two Actor
implementations: Claude Code and Codex CLI. When referring to a running instance of one, we write
**Agent**.

### Design principles and implementation status

The table below pairs each design principle with its implementation status. The "Status" column
reflects the current state, including the post-MVP review.

| Principle | Content | Status |
|---|---|---|
| Completion is judged only on VERIFIED | Facts carry a confidence level; LLM inference (INFERRED) may feed the Plan but is never used to judge completion | Done |
| Never silently drop what could not be confirmed | Distinguish "there is nothing there" from "we could not confirm it"; the latter stays in `unobserved` / `unverified` with a reason | Done |
| Reject Goals that cannot be reduced to verification | A Goal whose Acceptance Criteria cannot be reduced to a means of verification (command / Fact reference / human approval) is never made ACTIVE | Done |
| Waiting is a state, not a process | Every reconcile returns in finite time on every tick. Nothing stays resident and sleeps | Done |
| Separate declaration from convergence | Humans write the Desired State and Acceptance Criteria. The Actor implementation is chosen per phase at launch; the Actor role within a Goal and the implementation steps are decided by the controller | Partial (decomposition across Goals goes only as far as declaring order via `goal.depends_on`; the decision to split is the human's — design.md §10-12) |
| Write-ahead | Write the intent to the DB before the side effect. Killed at any instant, the next tick can recover | Done |
| Isolation by location alone is not enough | Beyond separating files with a worktree: never pipe the Agent's output into the controller's shell, and never execute what the Agent wrote with the controller's privileges | Partial (the "not into the shell" half is handled in design.md §7; the "not with the controller's privileges" half is open in §10-9) |

### The boundary between guard and LLM

Completion and the stopping conditions for runaway behavior are not left to the LLM. The LLM may
choose only among four actions: `ACT` / `VERIFY` / `WAIT` / `REPLAN`. `COMPLETE` and `ESCALATE` are
decided by pure logic (the guard). That boundary lives in `src/decide/`.

### The protected-path gate

As a self-hosting safeguard, if the Agent edits a path listed in `policies.protected_paths`, the
controller detects it outside of ACT and stops. Separately from the Agent's own deny rules, the
controller holds its own gate. Detection is based not on the Agent's self-report but on changes git
observed, so writes made through Bash are visible too. Writes that escape the worktree are seen via
git on the main repository side, not just inside the worktree. Only changes inside the repository
are visible, though; the scope and the remaining holes are written up in design.md §10-6.

What is protected is the control loop itself (`src/controller/**`) and the Goal declarations
(`.goals/**`), plus **the gate itself (including the files that decide the Agent's deny list) and
the verification machinery**. The criteria for choosing them are in design.md §7.

### Keeping push and PR creation in human hands

`policies.require_human_approval` stops the Agent's operations; it has no effect on the controller's
own push and PR creation. Those are stopped by `policies.publish`.

```yaml
policies:
  publish:
    push_branch: auto
    # Write it this way in a repository shared by a team. Opening a PR notifies
    # reviewers, and undoing it does not take the notification back.
    open_pull_request: manual
```

Write nothing and push and PR creation proceed automatically, as before. A step set to `manual` is
not performed by the controller, and that tick stops at `WAITING_HUMAN`. Which step was stopped, and
what a human must do to move on, appears in `decision` from `ent get <slug>`.

The stop also appears structurally in `ent run` output: `publishHold` is present only on ticks
stopped by a declaration. **Only when PR creation (`open_pull_request`) is what was stopped** can the
agent driving the tick read `publishHold` and open the PR on the controller's behalf. A stopped push
cannot be taken over, because the branch is not on the remote. The breakdown of the keys and the
takeover procedure are in `.claude/skills/ent/SKILL.md`. Goals with no such declaration never emit
this key, so no `jq` you are running today changes at all.

The two steps are released differently. When `open_pull_request` is stopped, a human opening the PR
is enough — the next tick finds it and moves on (the declaration can stay as it is). `push_branch`
does not work that way. The very path you declined to use (`BranchPort.push`) is the only route that
knows the remote, so even if a human pushes by hand the controller cannot observe it. It keeps
stopping every tick until the declaration is set back to `auto`. **Nor will it eventually run out of
budget, fall to `BLOCKED`, and thereby catch your eye.** The stop reason overwrites
`budget_exhausted`, so the state stays `WAITING_HUMAN`.

**Neither step necessarily surfaces the stop in the PR.** It appears as a PR comment only when a
Goal that already had a PR was switched to `manual` partway through. A Goal declared `manual` from
the start never gets a PR, so there is no way to notice other than reading `ent get` and `ent list`.
If you plan to operate with declaration-based stops, set up a routine for reading those first. The
reason this is named separately from `require_human_approval` is in design.md §7.

### Credentials never handed to the Agent

The credentials the controller holds (`GITHUB_TOKEN` / `GH_TOKEN`, and the token read from
`gh auth token`) are never handed to the Agent. Claude Code is not given OpenAI/Codex credentials
and Codex is not given Anthropic/Claude Code credentials; only the chosen provider's own
authentication is left in place.

Dropping environment variables is not enough to cut it off. **`gh` inside the Agent and inside the
verification commands is de-authenticated as well** (`GH_CONFIG_DIR` is pointed at a directory that
does not exist). `HOME` has to be passed through, so merely dropping variables would leave the
host's login intact. Shell paths are narrowed too: git is invoked with an argv array, and the only
things routed through a shell are `setup` and `verification.run` from the Goal YAML.

`type: human` approvals count only those from people with write access to the repository. Review
approvals exclude the PR's author, but **the comment boilerplate counts the author too**. In a
one-person repository that is the only approval route, so approval rests on the Agent being unable
to reach it (design.md §10-4).

### Where Goal state is kept

Goal state (ACTIVE, COMPLETED, and so on) lives in `.goals/.state/goals.db`. `.goals/*.yaml` holds
only the declaration and never runtime state. Note that the action `COMPLETE` and the Goal state
`COMPLETED` are different things: the latter results from the former being chosen.

## Where this stands, and the roadmap

**Phase 3 complete. MVP complete.** From Phase 0 through Phase 3 there are eleven Goals in total.
Below, in order: "Inside Phase 3", "Until you actually run it, the plumbing cannot be assumed
connected", "The controller does the committing", "Everything green does not mean nothing is
broken", "The more central the design, the less it reduces to a verification command", and
"Scope per phase".

The Goal YAML schema is in `src/domain/goal.ts`; the registry of observation keys is in
`src/domain/fact-keys.ts`.

### Inside Phase 3

Phase 3 is self-hosting, split into five Goals. The first made one tick's record readable; the
second added PR creation, notification, and approval detection; the third added waiting and runaway
control; the fourth added the self-hosting safeguards. **The fifth was implemented by the
controller.**

All the human did was write the Goal YAML and Acceptance Criteria, run `ent start`, and then repeat
`ent run`. The controller ran the Actor in a worktree, opened a PR, accumulated progress in
comments, and stopped waiting for approval (the transition to `COMPLETED` itself was confirmed in a
separate Goal — design.md §9).

### Until you actually run it, the plumbing cannot be assumed connected

Every piece of broken wiring found during and right after Phase 3 passed its tests. There were four.

1. A missing quote in `git branch --format` had been failing worktree creation ever since Phase 2
2. VERIFY was running commands in the controller's own repository instead of the worktree
3. While a PR existed, pushing had stopped (and a test froze that as the specification, staying green)
4. **The Actor finished writing the implementation and never committed it**

The fourth breaks differently. Push, VERIFY, and DECIDE all behaved exactly as contracted; nobody
misbehaved. Push only sends committed changes, but VERIFY looks at the worktree's working tree. So
every criterion passed while nothing reached the remote, and the controller stopped waiting for
approval. What the human is waiting for is a PR carrying the implementation, so that wait never
ends. **Nothing anywhere required the premise that "the Actor commits".**

### The controller does the committing

**The premise that "the Actor commits" is no longer assumed.** On a tick where **all** the
machine-side criteria (the `command` type) pass, the controller commits what the Actor wrote. Asking
the Actor to commit never produced confirmable compliance, and in practice the same Actor
configuration produced both ticks that committed and ticks that did not (design.md §10-11). On a
tick stopped by the protected-path gate, nothing is committed — so that violating changes never
enter the history.

**On a tick that committed, the uncommitted-work gate is not consulted.** `local.dirty` is an
observation from before the commit, so reading it would mean stopping yourself over the mess you
just cleaned up. What remains in scope is the tick where nothing was committed (only gitignored
files are dirty, or the commit itself failed). If uncommitted changes remain on a `COMPLETE` /
`WAIT` / `VERIFY` tick that does not resolve the leftovers, `ESCALATE(uncommitted_changes)` calls a
human. The only thing read is the `local.dirty` **that this tick's observation produced by looking
at the worktree**. Ticks where observation failed, or where the worktree does not exist yet, do not
stop.

Even after roles multiplied (design.md §4.2), what it is compared against is pinned to **the
implement role's branch**. That is where verification commands run and where `local.*` is observed,
and the review role reads the same working tree. The reason for stopping and the next move are
surfaced both in `ent get` and in the PR comments.

### Everything green does not mean nothing is broken

The post-MVP review found the same shape of hole still open. Tests that inject Ports never touched a
single line of `src/adapters/local.ts` (real git and shell) or of `main()` in `src/cli.ts`, and
those two had no tests at all. **Five mutations kept the whole suite green** (letting the LLM choose
`COMPLETE`; emptying the Agent's deny list; removing `sort` from digest normalization; turning an
approval-Port failure into "verified as failed"; moving lease release out of `finally`).

There are now integration tests that run against real git and real SQLite, and each of those five is
pinned by one test. The integration tests found a bug the moment they were written (trimming the
output of `git status --porcelain` dropped one character from the path — an error introduced by the
same change that added the integration tests, absent from the code before it).

**The path through ACT, however, is not covered by the current automated tests.** The `main()`
integration test exercises the path where the guard chooses `COMPLETE`, calling neither the Actor nor
GitHub. Every piece of broken wiring listed above was on the side that actually hits something
external (git / GitHub / Actor), so that side is still only confirmable by actually running
`ent run`.

### The more central the design, the less it reduces to a verification command

Neither Phase 1 nor the first Goal of Phase 2 reached COMPLETED merely by passing the four of six
Acceptance Criteria that are verified by command. What remained in Phase 1 was the CI result
(`type: fact`) and a check that the Port abstraction had not fused to a single implementation
(`type: human`). What remained in the first Goal of Phase 2 was the CI result and a check that the
guard/LLM boundary was sound (`type: human`).

### Scope per phase

The table below shows the controller's scope cumulatively. Each row is the cumulative scope **at the
point that phase completed**. What is counted is the stages the controller runs, not the presence of
code. Who initiates a run is not counted in the "controller's scope" column.

Human judgment stops entering the inside of a tick from the completion of Phase 2 onward. Initiation
itself is cron's job; no resident process is created (design.md §3.6).

| Phase | Controller's scope (cumulative) | Human's part |
|---|---|---|
| 0 | none | all of OBSERVE / ASSESS / DECIDE / ACT / VERIFY |
| 1 | OBSERVE / VERIFY | ASSESS / DECIDE / ACT, and initiating every stage |
| 2 | OBSERVE / ASSESS / DECIDE / ACT / VERIFY | writing Goals, approving |
| 3 | the same scope as Phase 2, run against this repository itself (self-hosting) | writing Goals, approving |

Once Phase 3 completed, initiating a tick no longer requires human judgment either. What is left to
the human is two things: writing Goals, and writing `/ent approve <criterion-id>` on the PR (or
clicking Approve in a GitHub review).

## Installing

**There are two kinds of reader**: people who only *use* ent, and people who work on ent itself.
They need different things, so the entry points are separate.

### Setup for using ent

**Running ent requires neither mise nor pnpm nor tsc.** There is not a single reference to mise in
`src/`, and none in what `ent doctor` inspects. What remains is three things: Node 24 or later,
[gh](https://cli.github.com/), and a logged-in Actor (Claude Code / Codex).

If you have one checkout with a built `dist/cli.js`, you can link `ent` onto your PATH from it.

```sh
cd /path/to/entelecheia
pnpm link --global    # links package.json's bin (dist/cli.js) into the global bin
```

`dist/cli.js` has a shebang, so the symlink can be invoked directly. It works with `"private": true`
left as is (that is a separate matter from publishing to npm). To remove it, run
`pnpm uninstall --global entelecheia`.

**What you link to is the `dist/cli.js` inside the checkout, not a copy.** Rebuild ent itself and
what `ent` points at is replaced too. Conversely, linking from a checkout that has no `dist/` yet
leaves the symlink pointing at nothing, so run "Setup for working on ent" below once in that
checkout.

Which Node starts is chosen by the shebang's `/usr/bin/env node`. Invoked from a shell where mise or
nvm is in effect, the target repository's Node gets used, and anything below 24 dies on the
`node:sqlite` import. Which Node you are on is reported by `node` in `ent doctor`. You may also skip
the symlink and call `dist/cli.js` directly with an absolute Node path pinned (there is an example
under "Running ent").

### Setup for working on ent

To work on ent itself, have [mise](https://mise.jdx.dev/) and [gh](https://cli.github.com/)
installed. The Node and pnpm versions are pinned in `mise.toml`, so you do not need to install them
separately.

```sh
mise trust        # once, right after cloning. Without it the next line stops with a trust error
mise install --locked
pnpm install --frozen-lockfile
mise run build    # produces dist/cli.js — this artifact is what you hand to users
```

**The first line, `mise trust`, is part of the procedure, not a defect in your environment.** mise
will not read a `mise.toml` it does not trust, so skipping it makes `mise install --locked` stop with
`Config files ... are not trusted.`

## Verification

```sh
mise run verify   # runs typecheck / lint / build / test together
mise run check    # supply-chain and workflow checks (from the baseline)
```

`build` is part of `verify` because "the types pass" and "`dist/cli.js` gets produced" are two
different things. `tsconfig.json` is `noEmit` and includes `tests/**`. What actually produces the
`bin` artifact is `tsconfig.build.json`.

**Right after starting a Goal, `typecheck` and `test` fail.** That is an expected state arising from
writing the Acceptance Criteria first, not a defect in your environment. Down to the number of
failures, the Goal's `desired_state` declares it as the measured state at the moment work began.
main's CI (`.github/workflows/verify.yml`) stays red for that period too.

When only specification tests are failing, `lint`, `build`, and `check` still pass (`build` does not
look at `tests/**`). Which Goal is in progress is read from `ent list`. **It is not written in this
README**: writing it would add one more place to update every time a Goal is started, and forgetting
to update it would leave the README claiming things fail.

## Running ent

**Every invocation of `ent` runs exactly one tick and exits.** The first half below covers running a
single Goal in this repository. After the command list come "Common options", "Choosing provider,
model, and effort", "Using Codex", "The commit the gate measures against", and "How to launch it, and
the exception when working on ent itself". The second half covers operations, in six sections: "Using
it on a repository outside this repo", "Excluding permanently failing workflows from the count", "Not
posting progress to the PR", "Opening PRs as drafts", "Splitting a coarse task across several Goals",
and "Running several Goals at once".

```sh
mise run build                     # produce dist/cli.js
ENT_NODE="$(mise which node)"       # pin an absolute path to Node 24+ first
alias ent="$ENT_NODE $(pwd)/dist/cli.js"

ent init                           # make the current repository runnable (idempotent)
ent start <slug>                   # register a Goal and make it ACTIVE
ent run <slug>                     # run one tick and exit
ent run <slug> --pr <n>            # name the PR to observe (ones the controller opened are automatic)
ent run <slug> --issue <n>         # name the Issue to observe
ent run <slug> --dry-run           # write nothing; just look at what the next tick would contain
ent run <slug> --report stdout     # send progress to your hands instead of posting it to the PR
ent get <slug>                     # show the declaration and the runtime state together
ent abandon <slug> --reason "…"    # declare it no longer pursued and terminate it (reason required)
ent list                           # list registered Goals
ent doctor                         # read-only check that the prerequisites for running are in place
ent agent-context                  # emit the CLI's structure as machine-readable JSON
```

### Common options

`--json` makes the output JSON (`run` / `get` / `list` are JSON by default; `start`, `abandon`, and
`init` produce JSON only with `--json`). `doctor` and `agent-context` are always JSON and do not
accept `--json`. `--limit <n>` narrows the number of entries for `get` / `list`. There is a cap by
default too, and the way to narrow further is printed to stderr only when entries were cut. The
procedure aimed at agents is in `.claude/skills/ent/SKILL.md`.

### Choosing provider, model, and effort

Provider, model, and effort can be chosen separately for `DECIDE`, `IMPLEMENT`, `REVIEW`, and
`INVESTIGATE`. `ENT_<PHASE>_ACTOR` / `ENT_<PHASE>_MODEL` / `ENT_<PHASE>_EFFORT` are the
phase-specific settings; without them it falls back to the shared `ENT_ACTOR` / `ENT_MODEL` /
`ENT_EFFORT`. When no provider is specified it is `claude-code`, preserving existing behavior.

Valid effort values differ per provider. Claude Code accepts `low / medium / high / xhigh / max`;
Codex accepts `none / minimal / low / medium / high / xhigh`.

```sh
ENT_ACTOR=codex ent doctor
ENT_ACTOR=codex ent run <slug>

# Codex for DECIDE only, Claude Code for implementation, a different model for review
ENT_DECIDE_ACTOR=codex \
ENT_IMPLEMENT_ACTOR=claude-code \
ENT_REVIEW_MODEL=<model> \
ent run <slug>
```

### Using Codex

If even one phase involves Codex, confirm the login first with `codex login status`. When the
selection mixes Claude Code and Codex, `ent doctor` reports the login prerequisites for both.

The Codex Adapter uses the official non-interactive mode, `codex exec --json`. The implement role is
pinned to `workspace-write` and the review and investigate roles to `read-only`, and the user's
`config.toml` and execpolicy rules are not loaded. The non-interactive Codex CLI has no per-command
allow/deny settings equivalent to the Claude Agent SDK's. Forbidden operations are therefore stopped
by layering the sandbox, the prompt, credential removal, and the end-of-tick git gate. Because this
is not identical permission control, Codex is never selected automatically — it is an explicit
opt-in.

Failure handling is separated too. Even if Codex's JSONL contains a final message, a run followed by
`turn.failed` or `error` is treated as a failure. stderr is kept in the Run's raw log alongside
stdout. If the Actor stops at a usage limit, the failure classification and the token counts are
saved to the Run and the guard replaces that ACT with `WAIT(usage_limit)`. As a result the Goal
transitions to `WAITING_EXTERNAL(usage_limit)`.

Codex also has an official TypeScript SDK, but it is not used here. The current SDK is a wrapper that
launches the Codex CLI with JSONL, and it cannot pass `--ephemeral`, `--ignore-user-config`, and
`--ignore-rules` — which this Adapter relies on for its isolation contract — through its public
options. For now, therefore, `codex exec` is launched directly.

### The commit the gate measures against

`ent start` records the HEAD of the directory you invoked it in as **the gate's baseline**. The
Actor's worktree is cut from that commit, and the gate diffs the worktree against that same commit
(detecting writes that escaped the worktree is a separate route: the before/after difference around
ACT on the main repository side). **Commit the Goal's declaration and specification before running
`ent start`.** Then what the human wrote is on the baseline side, and only what the Actor wrote lines
up in the worktree diff.

It is recorded only when `ent start` is run on a Goal with no Runs at all. Re-running it on a Goal in
flight does not move the baseline: the worktree stays cut from the original baseline, so moving only
the baseline would misalign "what it was cut from" and "what it is compared against".

Do not amend or rebase the baseline commit while the Goal is running. If the branch point
disappears, the diff cannot be taken and it stops with `ESCALATE(guard_unavailable)`. The PR's target
stays `default_branch`. When HEAD could not be read, and for Goals started before this recording
existed, `default_branch` remains the baseline as before (in which case what the human wrote lines up
as the Actor's edits too).

### How to launch it, and the exception when working on ent itself

`ent` is registered as `bin` in `package.json`, but it is not published to npm. To get it on your
PATH, `pnpm link --global` is enough (see "Installing"). From here on, examples use an alias with an
absolute path to Node 24+ or call `dist/cli.js` with that same Node. Because you decide which Node
starts, there is no mix-up even in a shell where mise or nvm is in effect (only those Goals that
work on ent itself go through the task below).

Nothing stays resident. Every `run` tick finishes in finite time, and waiting is left as Goal state.
The one exception is waiting on `goal.depends_on`, which takes no lease and so leaves no state — it
appears only in `skipped` in `ent run` output (design.md §10-12). To keep it going, invoke `run` from
cron.

**When running a Goal that works on ent itself, use `mise run ent -- run <slug>`.** Until `tsc` runs,
the implementation at HEAD is not in `dist/cli.js`, so invoking it directly keeps an old controller
running. The reason and the exceptions are in `CLAUDE.md`.

### Using it on a repository outside this repo

**Where ent lives and which repository it drives can be different places.** `ent` treats "the
directory you are currently in" as the target repository (`repoRoot = process.cwd()`). So build ent
once somewhere and invoke it at the root of the target repository. The target repository needs
neither ent installed nor any dependency added.

```sh
cd /path/to/entelecheia && mise run build
ENT_NODE="$(mise which node)"       # pin an absolute path to Node 24+ at this point
alias ent="$ENT_NODE /path/to/entelecheia/dist/cli.js"

cd /path/to/your-repo
ent init            # place .goals/, the .gitignore line, and a Goal template
ent doctor          # read-only check of whether it can run in this location
```

`ent init` is idempotent: it does not overwrite existing `.goals/*.yaml` and does not add the same
line twice to `.gitignore`. If this is not a git repository it creates nothing and refuses with exit
code 1. The template is filled in only as far as schema validity requires; `desired_state` and
`acceptance_criteria` are written by a human. For how to write CI criteria, see the `[!IMPORTANT]`
under
"[Excluding permanently failing workflows from the count](#excluding-permanently-failing-workflows-from-the-count)".

**Pin which Node starts.** `node:sqlite` requires Node 24 or later. Left to `/usr/bin/env node`, the
target repository's mise or nvm may take effect and select an older Node. `node_version` in
`ent doctor` tells you on the spot.

On the target repository side, confirm that `.goals/.state/` is gitignored (`state_ignored` in
`ent doctor`). The state DB, the worktrees, and the Agent's raw logs go there, so committing them
mixes them into your history.

Three constraints remain.

- The lease lives in `.goals/.state/goals.db`, which is gitignored, so **mutual exclusion does not
  work across machines** (two machines running the same Goal will both open a PR)
- `PROTECTED_PATH_FLOOR` contains paths specific to entelecheia, so if the target repository has
  paths by the same names (`src/controller/**`, for instance), the Agent touching them becomes a
  violation **by mistake**
- **Conversely, the floor's protected paths do not reach ent's own code.** ent itself sits outside
  the target repository, so a line like `src/controller/**` does not point at ent's sources. Where
  the previous item is about false positives from same-named paths on the target side, this one is
  about the floor being unusable for protecting ent itself. **What the gate protects is the inside of
  the target repository, not ent's own code** (only under self-hosting do the two coincide). What
  carries meaning in a target repository is three entries: `.goals/**`, `.git/**`, and
  `.goals/.state/**`. The latter two do not show up in `git status`, but `.git/hooks/**` and
  `core.hooksPath` are watched by a separate route that compares fingerprints before and after ACT
  (`outOfSightState`), and `.goals/.state/goals.db` — together with the raw log of a completed
  review-role Run (`.goals/.state/runs/<id>/log.jsonl`) — by a logical digest built from the rows
  belonging to that Goal (`Store.guardDigest`), and from there they connect to the gate. The raw log
  is watched because its body becomes the `review.verdict` Fact: protect the row but not what the row
  points at, and the verdict can be forged. What stays invisible is gitignored paths other than these
  two, and anything outside repoRoot (holes (a) and (b) in design.md §10-6)

### Excluding permanently failing workflows from the count

`github.ci.failed_job_count` counts failing jobs across **all workflow runs** tied to the head sha.
Writing `{ type: fact, key: github.ci.failed_job_count, equals: 0 }` makes "not one job is failing at
this commit" a criterion.

**Exclusion only affects `github.ci.failed_job_count`.** Of the 31 Goals currently in `.goals/`, the
29 that look at CI **all** write their criterion as
`{ type: fact, key: github.ci.conclusion, equals: success }`, and that one stays the conclusion of a
single latest run (see "Only the count is affected" below). So adding `exclude_workflows` to a
declaration **moves not one existing Goal's verdict**. To make exclusion take effect you must move
that Goal's criterion from `github.ci.conclusion` to `github.ci.failed_job_count`. Whether to move it
is a per-Goal decision (`conclusion` looks at only one run's conclusion, so the false convergence of
issue #58 remains on that side).

Because it spans runs, **workflows your repository deliberately leaves red or pending as a matter of
policy are included too.** The "do not make it mergeable until a specific person's review passes"
kind of workflow is one such: if it fails it joins the count, and if it never reaches `completed`
while awaiting approval the count itself never settles. Either way `equals: 0` is never satisfied. To
exclude them, write it in the declaration.

```yaml
repository:
  provider: github
  owner: your-org
  name: your-repo
  default_branch: main
  ci:
    # Write the name: from .github/workflows/*.yml (the PR checks list also shows
    # job names and third-party check runs, so do not take it from there)
    exclude_workflows:
      - Require owner approval
```

Without `exclude_workflows`, `failed_job_count` counts every workflow run.

**Exclusion is per workflow run** and cannot be written per job name. The count settles only when
"not a single run is unsettled", so a gate that never reaches `completed` while awaiting approval
must be excluded as a run or the count never settles. Excluding by job name does not move the run's
status.

**Only the count is affected.** `github.ci.conclusion` stays the conclusion of a single latest run,
and writing an exclusion does not change how that one is selected. This is so that adding one line to
a declaration cannot shift the meaning of an existing `conclusion == success`.

> [!IMPORTANT]
> **Write the CI criterion of new Goals with `github.ci.failed_job_count`.**
> `github.ci.conclusion == success` looks at only one latest run, so it passes even when other runs
> are failing (issue #58). Exclusion, too, works only on the `failed_job_count` side.
>
> ```yaml
> - id: ac-5
>   description: Not one job is failing in the CI of the PR carrying the change
>   verification: { type: fact, key: github.ci.failed_job_count, equals: 0 }
> ```
>
> Existing Goals are still written with `conclusion` because it came first, not because it is the
> correct meaning. They are left as they are so that the verdicts of running Goals are not changed
> after the fact.

**Note that excluded runs also drop out of `github.ci.failed_jobs`.** The names and log URLs of
failing jobs are collected from the runs that survive exclusion, so an excluded run's failing jobs
disappear from that Fact as well as from the count. **The material passed to the next ACT is short by
exactly the excluded part.** Keeping them would mean passing to ACT the very failures you declared
"excluded from the count, i.e. need not be fixed", which would erase the meaning of exclusion — so it
falls on the removal side. What happened in an excluded run is read from the states in
`github.ci.excluded_workflows`, described next.

**Only GitHub Actions workflow runs can be excluded.** This count only ever counted jobs in Actions
runs, so third-party check runs and branch-protection required reviews were never in it. Writing such
gates here does nothing.

The result of exclusion is not hidden. What was excluded and how many appear both in the
`github.ci.excluded_workflows` Fact and in `failed_job_count`'s detail, and they also show up in the
criteria verdicts (the detail column of the progress comment). "All green" and "green after
exclusion" are kept from looking the same.

```sh
ent get <slug> | jq '.snapshot.facts[] | select(.key == "github.ci.excluded_workflows")'
```

How each excluded run looked (`waiting` / `failure` / `success` …) is attached as well. On the detail
side it takes the form `除外: Require owner approval (1 run / waiting)`. **With the count alone you
cannot tell "excluded a gate that was still pending" from "excluded a run containing a real
failure".** Since they disappear from the failing-jobs side too, whether what disappeared was red can
only be read here. Finished runs report their conclusion, unfinished ones their status (that is the
strongest information readable about that run).

Names that matched nothing are not rejected; they surface in the observation as `runs: 0`. Whether a
name exists cannot be decided at the time the declaration is read. Parsing does not look at the
repository, and even from `ent doctor` the target repository is not necessarily the checkout at hand.
More fundamentally, "does not match" covers both a typo and "a workflow that did not run this time"
(path filters or branch filters can keep it from running), and the observation side cannot tell them
apart. It falls on the side of emitting the number and letting a human read it.

**Past 100 runs, no count is emitted.** `GET /actions/runs` reads only one page at `per_page: 100`.
When the response's `total_count` exceeds the number of entries returned — that is, when it was not
read in full — `failed_job_count` is not made a Fact. Otherwise, something failing in an unread run
would not join the count and `failed_job_count=0` would appear indistinguishable from "all green". If
we cannot count them all, we emit no count: the same rule as "emit nothing while runs are still in
flight". The same treatment applies when `total_count` is absent from the response altogether (there
is no basis for deciding it was read in full).

In that case the criterion **is never satisfied**. The judgment is that never satisfied beats falsely
green, but it does add one non-converging path. When it is stuck with no count emitted, suspect the
number of runs first. **Exclusion runs after the page is fetched**, so runs destined for exclusion
consume the 100-entry budget too. An `on: pull_request_review` gate adds a run per review, so the
repositories that most want exclusion are the ones that hit the limit first.

Pagination is not implemented. Fetching page two and beyond would eat the same GitHub API rate-limit
budget that pinact (run by `mise run check`) uses, once per run. Losing the ability to reason about
round trips per tick was judged worse than not emitting a count.

### Not posting progress to the PR

By default, the pass status of the criteria is accumulated in PR comments. With `--report`, that pass
status is delivered to your hands instead of the PR.

```sh
ent run <slug> --report stdout                        # lands in report.body of the output JSON
ent run <slug> --report stdout | jq -r .report.body   # read it as a table
ent run <slug> --report ./progress.md                 # append to a file
```

What moves is the destination of the progress, and **one extra section — the review body — comes with
it** (see below). Neither observation nor judgment changes, and it does not stop pushing what the
Actor wrote or opening the PR. **The PR itself is published exactly as before.** What stops being
posted is the criteria pass status; use it when you do not want trial runs to lengthen a PR that is
under review.

Progress is emitted even without `GITHUB_TOKEN` and even before a PR exists. Writing the progress is
placed ahead of securing the PR, so it is decoupled from whether the PR can be secured.

Specifying `stdout` does not stream raw Markdown. `run`'s standard output is JSON only, and the body
goes in `report.body`. Only `run` accepts it, and it cannot be combined with `--dry-run`. What goes
into the JSON, and what happens when it could not be written, are in `.claude/skills/ent/SKILL.md`.

**This output also carries the review body the review role returned last, as a
`## レビュー役の本文` section.** On its way to becoming Facts, the review role's reply is folded into
just two things — `review.verdict` and `review.reviewed_sha` — so the reasons and reservations behind
an `approved` are left unreadable by anyone, sitting in
`.goals/.state/runs/<id>/log.jsonl`. The section is placed at the **end** of `report.body`. The
criteria table stays in the same position regardless of destination, so you reach the pass status
without scrolling past a long review body. The review body is not summarized: line breaks, tables,
and code blocks are emitted as they are.

The section appears only on ticks with `--report`. It is not posted to PR comments, so `report.body`
and the PR comment are no longer the same content. For a Goal whose review role has never been
launched, the section itself does not appear. When the raw log could not be read, the reason appears
in the section; for a Run with no review body left (an execution cut short), the id of the Run that
was read appears. **On no path is anything silently dropped, and no path fails the tick.**

> [!NOTE]
> **The two destinations accumulate differently.** `--report stdout` emits once per invocation and
> does not pile up, but `--report <path>` **appends** to the file. What the section reads is the most
> recent completed review-role Run, so the content stays the same every tick until the next review
> finishes — keep running while waiting for review and the same body lines up once per run. For long
> runs, use `stdout` or split the destination file.

### Opening PRs as drafts

If the target repository has a "publish as a draft first" practice, write it in
`repository.pull_request.draft`.

```yaml
repository:
  provider: github
  owner: your-org
  name: your-repo
  default_branch: main
  pull_request:
    draft: true
```

**Write nothing and it opens ready, as before.** The default is unchanged, so not one existing
`.goals/*.yaml` behaves differently.

It only takes effect when the PR is created. An already-open PR is never turned back into a draft.
publish does not rewrite the title or body of a PR after creation (rewriting them every tick would
keep reviewers from following the diff), and this is aligned with that.

Opening as a draft lets you finish adjusting to title conventions and PR templates before reviewers
are notified. **There is not yet a way to decide that title and body themselves by declaration.** The
title stays `goal.name`, and the body is produced from ent's fixed template.

> [!WARNING]
> If the target repository's workflows exclude draft PRs
> (`if: github.event.pull_request.draft == false`, for instance), **CI never runs even once.**
> Without a run, not one `github.ci.*` Fact is produced, so the `type: fact` criteria that read them
> stay unresolved and the Goal circles in place until it hits `max_unchanged_reconciles`. Before
> declaring draft, look at how the target repository's workflows treat drafts.

### Splitting a coarse task across several Goals

Once you split one coarse task into N Goals, write the order in `goal.depends_on` (design.md §10-12).

```yaml
goal:
  id: wire-it-up
  name: wire it up
  desired_state: |
    …
  depends_on:
    - build-the-thing
```

Until every dependency is COMPLETED, `ent run` exits without running that tick. **It does not take a
lease either**, because a Goal that is merely waiting holding a slot would keep the Goals that can
make progress from running within one cron cycle. The decision is made at the tick's entrance rather
than at `ent start`, so you may declare an order whose dependencies have not been started yet.
Register all the pieces and line up `ent run` from the top, and only the ones that can advance will
(how to line them up, and why they cannot currently be lined up concurrently, is in the next
section).

The reason it did not advance appears in `skipped` in `ent run` output. If a dependency has fallen to
`FAILED` or `ABANDONED`, it also states that waiting will not resolve it and what the next move is
(redo the dependency, or rewrite `depends_on`). Dependencies not yet registered count as "waiting
will advance it": it may simply be that `ent start` was forgotten, so absence is not read as
terminal. **This wait is not left in Goal state, so it appears only in `skipped`** (a remaining hole
in design.md §10-12). Depending on itself is rejected by the schema, but **a cycle spanning two or
more is invisible from any single YAML file**, so everyone stops, waiting.

Dependency judgments also read the per-machine state DB. On another machine a dependency's
`COMPLETED` is not visible, so it counts as unregistered, i.e. waiting (the same constraint as the
lease above).

**The decision to split is the human's.** The controller merely follows the order as written; it
never splits a coarse task into N by itself (design.md §10-12).

### Running several Goals at once

By design, `ent run` may be invoked from several processes at once. No facility for running them
together (`ent run --all`, or a resident watch) is provided. How many to line up is the caller's
decision; `ent` is responsible for "not breaking when invoked concurrently". **This is design intent,
however — concurrency from the same directory has not been confirmed with two real processes** (see
the warning below).

> [!WARNING]
> **Concurrency from the same directory has not actually been confirmed by starting two.**
> This section used to say "the protected-path gate stops it with
> `ESCALATE(protected_path_touched)`, so run them one at a time". The state DB is WAL, so another
> process writing or closing its connection triggers a checkpoint that changes the contents of
> `goals.db`, and the gate — which compared it by sha256 — fired as collateral damage. **That cause
> has been closed.** The gate now views the state DB not as a file but as a logical digest of "the
> rows belonging to that Goal", so writes for another Goal do not move it (issue #62, design.md
> §10-6). What has been confirmed is **two ticks driven concurrently against the same `goals.db`
> inside Vitest**; two `ent run` processes have not been started. The contention where the first
> `git worktree add` takes `.git/index.lock`, and SQLite busy contention, both remain.
> `.goals/.state/` is created under `process.cwd()`, so splitting worktrees splits the DB with them.
> But the lease splits too, so **do not run the same Goal in separate worktrees** ("passing the same
> slug to two processes is safe", below, stops applying, and both will open a PR).

```sh
# Example of the side that lines up workers: one process per slug, wait for all to finish
# (same directory, so do not use this as is while the unconfirmed item above remains)
for slug in goal-a goal-b goal-c; do
  ent run "$slug" &
done
wait
```

When running from cron, likewise move into the target repo and use absolute paths for Node 24+ and
for ent itself. Because a previous tick can run past the next start time, **always take a
repository-level external lock, even for a single Goal.** Below is an example using macOS/BSD `lockf`
that exits without starting when the lock is held. Replace `/absolute/path/to/node-24` with the path
to Node 24+ obtained by running `mise which node` in an interactive shell. On Linux, use the
scheduler's no-overlap setting or an equivalent lock.

```cron
*/10 * * * * cd /path/to/your-repo && /usr/bin/lockf -n /tmp/ent-your-repo.lock /absolute/path/to/node-24 /path/to/entelecheia/dist/cli.js run goal-a
```

When running several Goals from the same directory, staggering start times does not guarantee
serialization either. While the unconfirmed item above remains, use the same repository-level lock,
or start them one at a time from an external scheduler that can forbid overlapping runs. Do not line
up lock-free cron lines directly.

For Goals that work on ent itself, the target repo and ent are the same, so go through the task.
Replace with the absolute path obtained from `command -v mise` so as not to depend on cron's PATH,
and take the same external lock.

```cron
*/10 * * * * cd /path/to/entelecheia && /usr/bin/lockf -n /tmp/ent-entelecheia.lock /absolute/path/to/mise run ent -- run goal-a
```

The next two paragraphs (the lease, and how many to line up) are premises for starting two in the
same directory. Concurrency in one directory has not been confirmed with real processes yet, so read
them together with the warning above. The token discussion after that applies equally when running
just one.

Passing the same slug to two processes is handled safely. Ownership of a Goal is decided by a
time-limited lease, so only the side that acquired it first advances; the other skips with "another
worker holds the lease" and exits 0. The Actor never runs twice and state never mixes. A side that
loses the lease mid-tick also steps down without writing a single snapshot, verification, Decision,
or state transition (only the Run row it already wrote remains — design.md §3.6).

How many to line up is decided by machine resources. Each tick runs the Actor (Claude Code or Codex)
and the Goal's verification commands (`mise run verify` in this repository) on top of a worktree, so
budget one to two CPU cores per line. As a rule of thumb, staying under half the core count keeps
verification commands from tipping into timeouts.

Observing GitHub requires a token. Pass `GITHUB_TOKEN` (or `GH_TOKEN`) and it is used; with neither
environment variable it falls back to `gh auth token`. gh is a setup prerequisite, so invoking from an
interactive shell needs nothing passed. When running from cron, PATH and gh's configuration are not
necessarily inherited, so either set `GITHUB_TOKEN` explicitly or run `ent doctor` in the same
environment to confirm. **An empty string is read as "we decided not to pass one", and gh is not
called either.** This is the one place where unset and empty differ in meaning: it keeps an
interactively logged-in gh's token from being used silently when you do not want GitHub observed.
**If no route yields a token**, the observation remains in `unobserved` as `port_failed`, and ASSESS
does not read it as "there is no PR". A token that was read is not written back into `process.env`,
so how it is dropped from the Agent's and the verification commands' environments is unchanged. The
Actor and the LLM use the saved login of the CLI you chose, as is. When using API keys, the
verification commands are still not given `ANTHROPIC_*` / `CLAUDE_CODE_*` / `OPENAI_API_KEY` /
`CODEX_API_KEY`.

## Directories

```
.goals/<slug>.yaml        Edited by humans. Under Git. Declaration only. slug must match goal.id
.goals/.state/goals.db    Runtime state written by the controller. Gitignored
.goals/.state/worktrees/  Worktrees the Actor edits. Physically separate from the controller itself.
                          The name is derived from (goal.id, role). The implement and review roles
                          share the same <slug>: the implement role writes, the review role reads.
                          Only the investigate role is split out as
                          <slug>-investigate (design.md §4.2)
.goals/.state/runs/<run-id>/  The Agent's raw logs. The DB holds only the path
src/domain/fact.ts        The Fact type (separating VERIFIED / INFERRED) and Unresolved
src/domain/fact-keys.ts   Registry of observation keys. fact verification in Goal YAML refers here
src/domain/goal.ts        The Zod schema for Goal YAML
src/domain/goal-parse.ts  Goal YAML validation and the slug/goal.id match. Reads no files
src/domain/gap.ts         The Gap and Assessment types ASSESS produces
src/domain/action.ts      The Action and Decision types DECIDE chooses
src/domain/run.ts         The Actor's execution-record type and ActorRole (implement and review
                          share a worktree; only investigate is separate — design.md §4.2)
src/domain/goal-state.ts  The Goal lifecycle, and the transition from Action to next state
src/domain/port-error.ts  Kinds of Port failure (usage_limit / unavailable)
src/domain/verification.ts Per-criterion verification results. The index that §9's completion check reads
src/domain/digest.ts      Digest of observed values. Material for loop detection
src/domain/protected-paths.ts Protected-path inspection. Stops edits to the control loop itself
src/domain/guard-rules.ts The decision rules the guard (pure logic) reads. Gate baseline and
                          stopping conditions
src/domain/withheld-env.ts The removal list of credentials dropped from the Agent's and the
                          verification commands' environments
src/domain/error-message.ts Extracts one human-readable line from an exception
src/domain/llm-call.ts    A record of one LlmPort call. Tokens that do not create a Run
src/observe/              Observe, and the definitions of the Ports it depends on
src/verify/               Verify, and the definitions of the Ports it depends on
src/assess/               Assess. Matches Acceptance Criteria against Facts to produce Gaps
src/decide/               Decide and the LlmPort definition. The guard/LLM boundary is here
src/act/                  Act. Runs the Actor on a worktree. Write-ahead is here
src/reconcile/            Bundles OBSERVE → VERIFY → ASSESS → DECIDE into one tick
src/publish/              Securing the PR and the progress comment. CodeWriterPort and BranchPort
src/store/port.ts         The Port for runtime state. Owned by the consumer; holds no implementation
src/store/sqlite.ts       Its SQLite implementation (node:sqlite). Only the composition root plugs it in
src/controller/           Outside one tick. lease → recovery → reconcile → ACT → persist → transition
src/adapters/local.ts     Ports writable with node:child_process (command execution, git, worktree)
src/adapters/goal-file.ts Reads .goals/<slug>.yaml from the filesystem
src/adapters/github.ts    CodeProviderPort. @octokit/rest + ETag
src/adapters/claude.ts    ActorPort and LlmPort. Claude Agent SDK.
                          Per-role allowed/denied tools and prompts are here too. Only the
                          implement role holds editing tools (design.md §4.2)
src/adapters/codex.ts     ActorPort and LlmPort. Converts Codex CLI's non-interactive JSONL
src/adapters/agent-prompt.ts Per-role prompts and output contract for Codex
src/wiring/index.ts       The composition root. The single place deciding which Adapter goes into
                          which Port. The gate's inputs (Adapter injection and verifyRoot) are
                          decided here too
src/usecase/init.ts       ent init. Places .goals/, the gitignore line, and a Goal template
src/usecase/doctor.ts     ent doctor. Inspects the prerequisites for running, writing nothing
src/usecase/inspect.ts    The payload ent get / ent list emit. Read-only
src/cli/parse.ts          Argument interpretation. Executes nothing
src/cli/present.ts        Output formatting. stdout is JSON only; diagnostics go to stderr
src/cli/agent-context.ts  The CLI structure ent agent-context emits
src/cli.ts                Entry point of the ent command. Per-subcommand steps and the exit-code contract
.claude/skills/ent/SKILL.md  What agents read as procedure. Invocation order, and where it stops for
                          human approval
.agents/skills/ent          Codex's lookup path. A symlink pointing at the canonical file above
AGENTS.md                 An entry point that merely points at the SKILL.md above. Procedures are
                          never written twice
tests/                    The substance of the Acceptance Criteria, and integration tests that hit
                          real git / real SQLite
```

`.goals/.state/` is created the first time `ent start` is invoked.

## Security baseline

This repository was created from
[`slashkiko/repository-baseline`](https://github.com/slashkiko/repository-baseline). The following
controls come from the baseline; if you remove one, leave the reason behind.

- mise pins the supply chain of the security tools, and new releases are used only after a 7-day wait
- Pinact requires GitHub Actions to be pinned to full commit SHAs
- actionlint and zizmor inspect workflow syntax and security properties
- Betterleaks scans the entire Git history
- `.github/workflows/weekly-audit.yml` detects OSPS Baseline version changes weekly

Always confirm the dry run before applying repository-setting initialization.

```sh
mise run repository-initialize                    # dry run. Only shows the settings it would apply
mise run repository-initialize --configure-github # actually rewrites the settings on GitHub
```

For details see [`docs/security-baseline.md`](docs/security-baseline.md) and
[`SECURITY.md`](SECURITY.md).

## License

MIT. See [`LICENSE`](LICENSE).

The Actor `ent` launches is Claude Code or Codex, and **neither is covered by this license.** Each
runs under its own vendor's terms, and you need a valid login for the one you select. In particular
`@anthropic-ai/claude-agent-sdk`, which this repository depends on, is not open source: it ships
under Anthropic's Commercial Terms of Service rather than an OSI license.
