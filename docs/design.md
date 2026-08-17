# entelecheia Design Document

The single design source for this repository. It is written so that reading this first is enough when
you newly join (or when you open a new session).

*English | [日本語](design.ja.md)*

> [!NOTE]
> **Issue and PR numbers in the body text point at the repository this code was migrated from.** The
> history was rewritten on the way here, so this repository holds zero issues and zero PRs. Numbers
> written as `issue #58` or `PR #34` therefore do not resolve here, and once issues start being filed
> they are numbered from 1 — the same number will end up belonging to something unrelated. Read them
> as labels for the record left behind, not as links.

Last updated: 2026-08-12. This update brings in the following 11 items.

- **Decided the granularity of task decomposition.** The policy is to stand up one Goal per
  decomposed item, and the ordering declaration `goal.depends_on` is in. Also decided who writes the
  declaration when a machine does the decomposition. Implementation is on hold
- **Aligned the descriptions that disagreed with the implementation, and changed the implementation
  in two places.** `/ent approve` counts as approval even when the PR author writes it; in exchange,
  `gh` inside the Agent is left unauthenticated (§10-4). Added the composition root to the floor of
  the protected paths (§7)
- **Handed the semantic-review skill to the review role only.** It must name the declaration by
  goalId and the commit it read by `reviewed_sha:` (§4.2, §4.3)
- **Moved the subject of commit from the Actor to the controller** (§10-11). The output of a failing
  verification command is now kept in evidence (§4.5)
- **Added the Codex CLI Adapter and per-phase provider / model / effort selection.** The Actor's
  usage limit propagates from the Run to guard's waiting decision (§3.5, §4.2)
- **Added a way to stop publish by declaration.** Declare `push_branch` / `open_pull_request` under
  `policies.publish` as `auto` / `manual`. The fact that it was stopped comes out structurally in
  `publishHold` in the output of `ent run` (§7)
- **The review role's body now goes to the destination of `--report`** (§4.3). The path that turns
  only the single word `verdict` into a Fact stays as it is; the body that used to be folded away is
  appended after the main text as a `## Review role message` section. It does not go into PR comments
- **Moved observation of the state DB from a byte string to a per-Goal logical digest** (§10-6). The
  invariant columns of Run that were dropped from the projection are reconciled by `ownRunDrift`.
  The `status` of the `depends_on` Goals is in the projection too. The false positive that was
  blocking parallel runs in the same directory is gone, but confirmation with two real processes is
  not done (§5)
- **Made it possible to write "not a single failing job" in criteria** (§4.3).
  `github.ci.failed_job_count` counts across every workflow run tied to the head sha. Permanently
  failing workflows are excluded from the count via `repository.ci.exclude_workflows`, and what was
  excluded comes out in `github.ci.excluded_workflows` (the README's "Excluding permanently failing
  workflows from the count")
- **Now observes the number of unresolved review threads** (§4.3). Only
  `github.pr.unresolved_threads` is taken from GraphQL. If it cannot be counted through, no Fact is
  made, and a carried-over count is dropped conditionally by `expireStaleFacts`
- **Stopped settling into `WAIT` on the tick that receives `changes_requested`** (§4.3). If the
  review role's conclusion is still against the commit it read, waiting changes nothing, so `WAIT`
  is removed from DECIDE's options. The side that removes the option decides from this tick's
  observation (`observedFacts`) alone

---

## 1. What this builds

A controller that, once you declare a project's completed state (Desired State), observes the
current state and launches Claude Code or Codex until the Gap is closed.

It brings the same structure by which a Kubernetes controller converges on `replicas: 3` into
software development tasks. What the human writes is only "how things should end up"; task
decomposition inside a Goal, the choice of Actor role, and the implementation steps are decided by
the controller. The decomposition holds only inside a single Goal — decomposition across Goals,
splitting one coarse task into N Goals — is still done by humans (the ordering declaration
`goal.depends_on` is in, as far as that goes. §10-12). The Actor implementation, model, and effort
used per phase are chosen by the human through environment variables at invocation, and fall back to
the default Claude Code when unspecified (§3.5 / §4.2).

```
        Desired State (declared by a human)
                 │
                 ▼
  ┌──────► OBSERVE ──► ASSESS ──► DECIDE ──┐
  │                                         │
  │        ┌────────────────────────────────┤
  │        ▼          ▼        ▼       ▼    ▼
  │       ACT      VERIFY    WAIT  ESCALATE COMPLETE
  │        │          │        │
  └────────┴──────────┴────────┘
```

The figure shows only DECIDE's main branches. REPLAN is one of the branch targets too, and
`PLAN → ACT → VERIFY` is not made into a fixed Workflow. Updating the Plan is no more than one of
the actions DECIDE can choose.

---

## 2. Why this is being built

Decomposing the concept into five layers and surveying what already exists showed the top two layers
blank.

| Layer | Content | State of what exists |
|---|---|---|
| L1 | A Goal Controller that converges a per-project Desired State | **Blank** |
| L2 | An Adapter that normalizes each service into the logical resources Project / Task / PR | **Blank** |
| L3 | Running multiple coding agents in parallel and managing worktrees and PRs | Many competitors |
| L4 | Persistent Goals and event-driven resumption | The parts are all there |
| L5 | Self-improvement from execution history | Research stage |

- **L1**: kagent and HumanLayer Agent Control Plane call themselves "declarative", but what they
  declare is the agent definition, not the product's finished state. lidangzzz/goal-driven loops
  until criteria are met, but it is self-contained in a single repository and has no adapter layer.
- **L2**: MCP is plumbing, not abstraction. What Composio and Corsair solve is centralizing
  authentication and connection. Merge.dev's ticketing unified data model is the only close one, but
  it presumes SaaS and code is out of scope.
- **L3**: Emdash (20+ providers, Linear/GitHub/Jira ingestion, worktree parallelism),
  mission-control, Conductor, amux. **This part is not built in-house.**
- **L4**: Temporal / Restate / Cloudflare Agents / Google ADK / LangChain Open SWE /
  Amp Event-Driven Orbs. **Referenced as parts.**
- **L5**: EvoRoute and others. **Decide only the format of the history and defer.**

So implementation cost is concentrated on L1 and L2, and L3 is delegated to the Actor Adapter of
Claude Code or Codex.

### On the name

Entelecheia (ἐντελέχεια) is Aristotle's term for "the state in which potentiality has arrived at
actuality". It is the word for the very state one is trying to realize against a Goal.

`setpoint` (the target value in control engineering; semantically ideal), `cairn`, `attractor`, and
`servo` were already taken on npm.
`telos` was free on npm, but Telos Network (a blockchain) occupies the search space.
`entelechy` (the English form) is a common noun found in the dictionary, hard to stand up as a proper
noun, and it carries a lot of search noise.
The Greek form `entelecheia` is effectively unoccupied on both npm and GitHub.

It also fits the precedent that Kubernetes itself is a transliteration of κυβερνήτης rather than the
anglicized helmsman. The difficulty of reading it is solved with a shortened command (`ent`), the
same as `kubectl`.

---

## 3. Core design decisions

The points that needed a decision, and their conclusions. **Break these and the whole design
breaks.**

### 3.1 Give Facts a confidence level, and judge completion on VERIFIED only

Unlike Kubernetes, the current state of a software project is not structured. The biggest problem is
how to obtain `oauth.implemented: false` in a form that can be trusted. "Read the code and judge" is
the LLM's subjectivity, not observation.

So the Observed State is not made a flat boolean; each Fact carries its source and confidence level.

- **VERIFIED** — primary information verifiable from outside only. Exit codes of verification
  commands, CI conclusions, GitHub API responses, git output. evidence is mandatory.
- **INFERRED** — LLM inference and code reading. It may be used as material for the Plan, but it is
  not used for the judgment that makes a Goal COMPLETED.

This is expressed as a discriminated union and enforced at the type level (`src/domain/fact.ts`).
The aim is to separate "the Agent merely thinks so" from "it was actually confirmed" by type.

Not making a Fact for a target that could not be observed is for the same reason.
"The PR does not exist" and "the PR could not be fetched" are different things, so the latter is not
made into a Fact.

But **what is dropped is the Fact, not the record**. If both of these fold into "the absence of a
Fact", ASSESS reads a GitHub outage as "there is no PR". Running Phase 0 once showed that a wrong
DECIDE comes out of that. So `ObserveResult` / `VerifyResult` hold `unobserved` / `unverified`
outside `facts`, and stack the targets that reached no conclusion together with the reason
(`Unresolved` in `src/domain/fact.ts`).

- `port_failed` — the Port threw. The external side may be down
- `pending` — procedurally no conclusion yet. Waiting for human approval, absence of a referenced
  Fact, and so on

When the Port returns `null`, nothing is stacked here. That is because "it was observed not to
exist"; what gets stacked is only "it could not be confirmed". VERIFY has the same structure:
"the criteria failed" (the Fact `criteria.<id>.passed: false`) and "the criteria could not be
verified" (`unverified`) are not mixed.

`pending` is the result of one observation or verification, not the state of the Goal.
`WAITING_HUMAN` / `WAITING_EXTERNAL` in §4.4 are the transition targets DECIDE picks after reading
`unverified`. Both are the same "waiting", but the layers differ, so the words are kept apart.

### 3.2 A Goal that cannot be reduced to Acceptance Criteria is not made ACTIVE

`replicas: 3` has a finite state space, so convergence can be judged. "You can log in with OAuth" is
infinite. Conversion into a means of verification is mandatory at the Goal's entrance, and criteria
that cannot be converted are not registered.

In the MVP the Goal YAML is hand-written by a human, so reviewing the YAML is itself the approval
gate. A separate UI for approval is not needed. This premise holds only while a human is writing;
once the path that lets a machine do the decomposition (§10-12) is in, the gate does not apply to
what the machine wrote.

### 3.3 Build only one Adapter implementation, and cut just the boundary up front

The problem that a Notion page and a GitHub Issue cannot be fully normalized into the same Task is
territory Merge.dev has struggled with for years. Abstracting every provider from the start
collapses.

Build something that works in one environment, then extract the abstraction. But cut the Provider
interface from the start, and review only whether it has fused to the single implementation.

**Deciding which Adapter goes into which Port happens in exactly one place.** That one place is
`src/wiring/index.ts` (the composition root), and `tests/architecture.test.ts` mechanically pins
down "this is the only place allowed to import `src/adapters/**` and `src/store/sqlite.ts`". If this
grows to more than one, you can create a state where a Port you thought you had swapped out in tests
comes in directly from another path in production.

That one place used to be `src/cli.ts`. What the rule demands is "one place that chooses the
implementation", not "that one place is the CLI", yet Ports kept being added while it stayed pinned
to `cli.ts`, so argument parsing, use cases, and output formatting all gathered in the same file,
and it reached 1,779 lines. Now that the composition root has been moved out, the CLI no longer
needs to know about Adapters. Today argument parsing is in `src/cli/parse.ts`, output formatting in
`src/cli/present.ts`, the CLI structure that `agent-context` emits in `src/cli/agent-context.ts`,
and the body of each subcommand in `src/usecase/**`. What remains in `src/cli.ts` is only the
per-subcommand steps and the exit-code contract.

### 3.4 webhooks are not needed in the MVP

A Kubernetes controller does not run on watch alone either; it always has a periodic resync.
reconcile is an idempotent function that "looks at the current state and fills the difference", and
whether the trigger is a webhook or a timer is not essential.

- **GitHub**: poll REST/GraphQL at 30-60 second intervals. With conditional requests (ETag) the rate
  limit is barely consumed
- **Slack** (future): with Socket Mode it is an outbound WebSocket connection, so no inbound
  endpoint is needed

There is no situation where detecting review approval about a minute late is a problem.
By design, only the `EventSource` interface is cut, and it is swapped for a webhook later.

### 3.5 Provider and model are chosen per phase

The controller's decision LLM is called only on the DECIDE path where a Gap remains; the implement,
review, and investigate calls are separated out as Actor roles. Both go through a Port and an
Adapter, so choosing a provider per phase never leaks a provider-specific branch into the controller
proper. DECIDE's output is always validated with Zod and is not accepted if it does not pass (up to
2 retries).

ASSESS is a pure function that reads only Facts and calls no LLM. In DECIDE too, judging completion
and the stopping condition belong to **guard** (pure logic that decides without calling an LLM;
`src/decide/`). Waiting straddles both. The `WAIT` for the case where there is no Gap but unresolved
remains is decided by guard, and the `WAIT` for the case where a Gap remains (waiting for review and
so on) can be chosen by the LLM too. But **how long to sleep is always decided by guard** (§10-3).
What is entrusted to the LLM is only how to close the Gap.

The default is the Claude Agent SDK, using Claude Code's saved credentials. The Codex CLI Adapter
was added on 2026-08-11. In addition to the common `ENT_ACTOR` / `ENT_MODEL` / `ENT_EFFORT`, it
accepts same-named overrides per `DECIDE`, `IMPLEMENT`, `REVIEW`, and `INVESTIGATE`. For example
`ENT_DECIDE_ACTOR=codex` and `ENT_REVIEW_MODEL=<model>` can be specified at the same time. The
provider, model, and effort for the same phase are chosen as one set, and the ACT Run keeps the
provider actually used. The effort vocabulary is validated per provider. Claude Code takes
`low / medium / high / xhigh / max` and Codex takes `none / minimal / low / medium / high / xhigh`;
a value belonging to only one is never passed silently to the other.

What the environment variables set is the default; **the per-tick override belongs to DECIDE**. An
`ACT` may carry an `agent` block (`actor` required, `model` and `effort` optional), and that Run
alone uses the set named there. Who does the work is part of how the Gap gets closed, so unlike the
stop conditions it may be entrusted to the LLM. The vocabulary is still validated before launch: an
output naming an effort the provider does not have is not adopted — letting the Adapter throw after
launch would spend the same budget as one failed ACT. **DECIDE cannot pick its own provider this
way.** By the time it returns `agent` it has already finished running, and there is no path back to
relaunching itself.

**Only a provider the environment variables already selected can be named.** Codex is an explicit
opt-in because its permission control is not the same (see below), and that declaration means
nothing if a single LLM output can route around it. The set handed to DECIDE is the same one
`ent doctor` checks login prerequisites against, so no provider doctor never looked at can run. A
call that is handed none does not offer `agent` at all and adopts none that comes back — **an
omission is not read as "no restriction."**

An `agent` that omits `model` and `effort` runs on the named provider's own defaults. It does not
inherit them from that phase's environment variables; inheriting would hand an
`ENT_IMPLEMENT_EFFORT` written for Claude to a Codex run, which is exactly the "never passed
silently to the other" this section forbids.

Codex also has an official TypeScript SDK (`@openai/codex-sdk`), which in substance is a wrapper
that launches the Codex CLI and exchanges JSONL events. But the current SDK's public options cannot
pass `--ephemeral`, `--ignore-user-config`, or `--ignore-rules`, which are used for the isolation
contract. Dropping those three and switching to the SDK would mix host-specific sessions, settings,
and rules into the execution contract, so the Codex Adapter launches `codex exec` directly. The
switch will be re-evaluated once the SDK exposes the launch constraints it needs.

### 3.6 Waiting is a state, not a process (interruptibility)

A controller that goes resident and cannot be killed because of a usage limit or waiting for review
is out of the question.

- reconcile **always returns in finite time** on every tick. It does not sleep and go resident
- Waiting is written to the DB as `WAITING_*` and the process exits. **The exception is waiting on a
  dependency** (§10-12): since no lease is taken, nothing can be written on the spot, so it does not
  remain in the state and shows up only in `skipped` of `ent run`. The `resume_after` wait (§10-5)
  is included here, because the `WAITING_EXTERNAL` from the moment it entered waiting is in the DB
- The next tick comes on cron's next round. In a setup that invokes `ent run <slug>` from cron there
  is no resident process to begin with (`ent watch` is unimplemented. §6)

Enforce **write-ahead** — writing the intent before the side effect — throughout, and make it a
crash-only design that can be recovered on the next tick even if killed at an arbitrary moment.

```
1. Assemble the observation and verification (not written yet)
2. commit Run(status: starting)              ← even if killed here,
3. Launch the selected Actor                   the next tick recovers it as an orphan
4. commit Run(status: completed|failed)
5. Write snapshot / verifications / Decision
```

**The only thing written before ACT is Run(starting).** That is the heart of write-ahead: unless the
fact that an Actor was launched remains, the orphan cannot be recovered. If killed partway through
ACT, this row is all that remains, and the next tick starts from recovering it.

The observation is not written first because of the lease. ACT takes minutes, and the lease can be
taken away during that time. If it were written first, by the time the loss is noticed the rows of a
Goal that another worker is running have already been dirtied. Assembly happens right after
observing, `observedAt` stays at the time of observation, and **only the writing is moved after
ACT**. Right before writing, the lease is checked once more, and if it is lost, the process backs
off without writing a single one of snapshot / verifications / Decision / status. The Run(starting)
row is already written, so it remains. That is the point of write-ahead.

The reason Decision is placed last is different: the gates after ACT (protected path, uncommitted
changes) can replace it. Only one row is written per tick.

On SIGTERM, propagate to the running Actor and kill it, finalize the Run as `interrupted`, release
the lease, and exit. A state where Ctrl+C does not work is never created.

---
## 4. Architecture

### 4.1 Logical resources and Adapters

In this document, **Provider** means an interface and **Adapter** means one implementation of it.
The relationship is the GitHub Adapter for `CodeProvider`.

**The "provider" in §3.5 is a different axis.** There it means the Actor and LLM vendor
(`claude-code` / `codex`), which by this section's classification sits on the Adapter side. The word
overlaps, so tell them apart by which section you are reading.

**Port** sits at a different granularity from these: it refers to the function-level interface each
stage of reconcile depends on. Like the `CodeProviderPort` that `observe()` receives, it lists only
the methods that stage actually calls, not the whole Provider. It is also the unit swapped out in
tests.

**The place where runtime state lives (`Store`) is treated the same way.** The interface is
`src/store/port.ts`, the current implementation is SQLite (`src/store/sqlite.ts`), and the only
place that picks the implementation is the single composition root in §3.3. The interface
declaration itself used to live in the SQLite implementation file, and `src/controller/index.ts`
imported it by name from there. It was the only path where the inside referenced the outside, and
because `src/store/` is not under `src/adapters/`, it also escaped the test net that says "only the
composition root may import an Adapter." Now the same test narrows imports of `src/store/sqlite.ts`
down to the composition root alone as well (§3.3). The Goal's runtime state itself (`GoalState` /
`GoalListItem`) and one tick's worth of observation (`Snapshot`) are Goal vocabulary rather than a
storage concern, so `src/domain/` owns them.

| Provider | Logical resource | MVP implementation |
|---|---|---|
| ProjectStateProvider | `Project` / `Task` | Not implemented (interface only) |
| CodeProvider | `Repository` / `Branch` / `PullRequest` | GitHub |
| ReviewProvider | `Review` / `Approval` | GitHub |
| CommunicationProvider | `Message` / `Notification` | GitHub PR comments + CLI stdout |
| CIProvider | `CIRun` | GitHub Actions |

Each Provider separates read (for OBSERVE) from write (for ACT).

### 4.2 Actor

```ts
type ActorRole = 'implement' | 'review' | 'investigate'

interface Actor {
  id: string
  kind: 'claude-code' | 'codex' | 'human'
  roles: ActorRole[]
  run(task: Task, ctx: RunContext): Promise<RunResult>
}
```

The two implementations `claude-code` and `codex` both carry all three roles. Codex is fixed to
`implement=workspace-write` and `review/investigate=read-only`. Because `codex exec` does not take
the same per-command allow/deny that the Claude Agent SDK does, the Codex Adapter is explicit
opt-in, layering a sandbox, credential stripping, and an after-the-fact git gate.

The concrete `ActorRole` lives in `actorRoleSchema` in `src/domain/run.ts`. `ActorPort` returns the
actual provider through `kindFor(role)`, and the value the per-role router picked is recorded in the
write-ahead Run. role passes through the following five places.

- **role determines the Agent's allowed and denied tools** (`ACTOR_TOOLS` in
  `src/adapters/claude.ts`). Only `implement` holds the editing tools (Edit / Write / NotebookEdit);
  `review` and `investigate` hold only the reading tools and Bash. **Separate by permission, not by
  instruction.** intent is something the LLM generates, and while you can confirm that it "wrote"
  something, you cannot confirm that it "followed" it (§3.2). The editing tools are not merely left
  off the allow list but also put on the deny list. Leaving them off the allow list alone can let
  them slip through when the config load order or a default changes. Denials coming from
  `policies.require_human_approval` are dropped as-is regardless of role (being the review role does
  not make merge or force push permissible). The prompts are split per role as well. If only the
  permissions are split and the wording stays the same, the review role keeps attempting edits,
  keeps getting denied, and burns its turns there
- **role determines which skills the Claude Code Agent is shown** (`SKILLS_FOR` in
  `src/adapters/claude.ts`). `semantic-review` is handed only to the Claude Code review role. Handing
  it to the implement role would open room to "write so as to satisfy the review points," and the
  structure §3.1 avoids with criteria would recur on the review side. **`settingSources: []` is not
  relaxed.** The decision not to let it read the host's `~/.claude` or the repository's `.claude`
  stands, and only the plugin the controller named (`plugins/ent-review/`) is visible to the Agent.
  That one entry is what appears in the skill list. Its content is a general-purpose skill used
  outside ent as well, and **it knows nothing about Goal, criteria, or verdict.** Looking at the
  working tree's HEAD rather than the PR diff, the primary source of intent being
  `.goals/<goal.id>.yaml`, and appending the two lines `reviewed_sha:` and `verdict:` after the body
  — all of that is written on the `REVIEW_PROMPT` side. The skill holds the review points; the
  controller holds the contract. **The PR title and body are handed over as the subject of review,
  not as the primary source of intent** (§4.3). That is why `ActorInvocation` carries `goalId` — the
  declaration is already committed into the working tree, so **handing over only which file to read
  is enough for the intent to arrive** (`intent` carries only constraints; `desired_state` is not
  carried) The Codex review role is not handed this Claude plugin; a Codex-specific per-role prompt
  and the `reviewed_sha:` / `verdict:` output contract connect it to the same observation boundary
- **the worktree name is determined by (goal.id, role)** (`worktreeNameFor`). **`review` looks at the
  same working tree as `implement`, and only `investigate` is split off.** All three were split at
  first, but splitting them means **the subject of review never catches up with the implementation.**
  The review role's working tree is cut from base, so not one of the implement role's commits lands
  in it, and `review.reviewed_sha` stays at base and never moves. `local.head_sha` is observed from
  the implement role's working tree (§10-9), so from the moment the Actor commits once, the two never
  match again. The matching rule "use the conclusion only when the commit that was read matches the
  implementation's HEAD" (§4.3's `review.reviewed_sha`) always falls to a mismatch.
  On top of that, on the first tick `verifyRoot` falls back to repoRoot, so if the review role runs
  first with not one line of implementation present, **an approved that reviewed a human's branch
  passes on a matching sha**. The original reason for splitting — the review role's checkout or clean
  wiping out the implement side's diff — **is about running them at the same time**, and since one
  tick starts exactly one Actor (§5), it does not happen. The remaining path, "the review role issues
  destructive git," is closed off per role with the deny list (`git checkout` / `restore` / `clean` /
  `reset` / `stash` are dropped from the roles that do not hold the editing tools). **`implement`
  stays at `goal.id` as-is.** The existing worktree and the PR's branch are at
  `entelecheia/<goal.id>`, and changing the rule would move a running Goal onto a different branch,
  making the diff accumulated so far disappear from the PR
- **Do not put a default on the second argument.** `verifyRoot` (§10-9) and the uncommitted-changes
  gate (§10-11) determine the provenance of an observation by matching the observed `local.branch`
  against `worktreeBranchFor(worktreeNameFor(...))`. The protected-path gate (§10-6) also decides
  which tree to inspect from the same function (that one looks at both the tree of the role that ran
  and the implement role's tree; since `review` shares the implement role's tree, the two collapse
  into one). As long as there are two candidate branches, unless the caller writes out "which working
  tree are we talking about" every time, reading dirt in the `investigate` working tree as leftover
  writes from the implementation would go unnoticed by both the types and the tests. Applying the
  implement role to inputs that do not record a role (existing Decisions and existing Runs) is made
  the reading side's job (`DEFAULT_ACTOR_ROLE`)
- **Record in the Run which role it ran as** (§4.5). Write it on the write-ahead `starting` side. Move
  it to the finalizing side and the role of a Run killed midway stays empty (§3.6)

**The verification commands and the observation source for `local.*` are fixed to the `implement`
working tree** (§10-9). Verifying criteria in the `investigate` working tree means reading the
results of a working tree containing none of the implementation as the implementation's verification
results. What lands on the PR is the implement role's branch too.

### 4.3 What OBSERVE fetches

```
PR        number, state, mergeable, head_sha, review_decision, requested_reviewers,
          title, body, unresolved_threads
Review    state (APPROVED / CHANGES_REQUESTED / COMMENTED), author, submitted_at
CI        the status and conclusion of workflow_run; on failure, the failing job names and log
          URLs, the number of failing jobs (failed_job_count) and the workflows excluded from
          that count (excluded_workflows)
Issue     number, state, labels, linked_pr
local     current_branch, HEAD sha, whether the worktree has uncommitted changes
```

The point is fetching all the way down to the CI failure details. "CI failed" alone gives no
material to hand to the next ACT. With the failing job names and the logs, you can hand them
straight to Claude Code and have it fix them.

**The PR's `title` and `body` are fetched not for judging completion but to hand to the review
role.** The review-role Actor is handed no credentials (§7's `NEUTRALIZED_ENV`, §10-4), so `gh` is
unauthenticated, and review points like "are the declaration's constraints reflected in the PR body"
had no way of being confirmed on that side, ending in `not obtained` every time. What was missing is
not credentials but an interface for handing over information the controller already reads. `act`
pulls the title and body (`github.pr.title` / `github.pr.body`) out of this tick's observation
(`pullRequestTextFrom`) and puts them into the review role's prompt (`renderPullRequestText`). The
division of labor — **the controller reads, the controller writes, and all the Actor is handed is
that observation result** — is unchanged.

What is handed over is **only the Facts this tick's observation produced**. Handing over a set mixed
with carry-overs would deliver the previous title and body even on a tick where GitHub could not be
read, and the observation failure would be filled in with the stale value and become invisible.
Nothing being handed over and the body being empty are also distinguished in the wording of the
prompt. The former is written as `not obtained`, the latter as `(the body is empty)`. Being empty is
an observed result, not something that could not be confirmed (§3.1). If the body contains a
`verdict:` or `reviewed_sha:` line, quoting it in the review role would produce two conclusion lines
and drop the observation to pending (see the `ReviewPort` paragraph below in this section), so the
handing side marks them and neutralizes them.

The concrete observation keys are enumerated in `src/domain/fact-keys.ts`. The table above uses the
names on the logical-resource side, while Fact keys are dot-separated snake_case such as
`github.pr.review_decision`. In Phase 0 there was no correspondence table anywhere against the Port's
camelCase field names, and an implementer could not guess them without reading the tests. Goal YAML's
`verification: { type: fact }` references this registry, so Zod rejects a key that does not exist.

The table above and the registry are not one-to-one at present. There is no key corresponding to the
Review row (`author` / `submitted_at`), and the review state is consolidated into
`github.pr.review_decision`. The list of reviews is used only to derive `review_decision`; there is no
Port that emits an individual review as a Fact. The table represents what we want to fetch and the
registry represents what can actually be fetched, so when implementing, treat the registry side as
authoritative.

`review.verdict` and `review.reviewed_sha` are in the registry but not in the table above. That is
because their origin is not an external service but the execution of the review-role Actor this
controller started, which makes them a different thing from `github.pr.review_decision` (a review by
a human or bot on GitHub). `reviewed_sha` is placed alongside `verdict` because "it passed" alone
does not tell you which point in time's code was reviewed, and you would end up using a Fact from
before the implementation moved on directly for judging completion. If Goal YAML writes
`verification: { type: fact, key: review.verdict, equals: approved }`, then while the Fact is absent
a Gap remains and COMPLETE is out of reach (§3.1). No condition saying "pass review" has been added
to the guard. The chosen shape is one that gets by without moving the boundary of judging completion
(§7).

**On a tick where the implement role ran, this matching rule is not applied.** OBSERVE is at the head
of the tick (§3.6) and commit and publish come after it (§10-11), so the `local.head_sha` VERIFY
reads is an observation from before ACT. When the implement role stacks up commits, the HEAD at the
end of the tick is a commit nobody has read, and yet a match between two observation-time values
survives as "a review of the current HEAD." In fact, the `review.verdict == approved` criterion went
`passed` only on ticks where implementation landed, and went back to `failed` on the next tick. So on
a tick where the implement role ran, the review-related criteria are not judged and are stacked into
`unresolved` as `pending` (`pendingReviewCriteria`, `src/domain/verification.ts`). **They are not
failed.** Whether anyone read the HEAD after ACT is something that tick has no way of confirming, and
recording something unconfirmable as a failure puts a hole in the observation onto the PR as a defect
in the implementation (§3.1).

Along with that, the `criteria.<id>.passed` Facts produced on that tick are dropped. Facts are
carried over to the next tick, so leaving them would keep a pass against a commit nobody has read
alive as VERIFIED. What is dropped is only `criteria.<id>.passed`; the observations themselves
(`review.verdict` / `review.reviewed_sha`) are kept. The freshness judgment itself
(`judgeReviewVerdict`) is untouched. This is a problem of ordering, not a problem of the judgment
logic.

On a tick where the implement role did not run, there is no role to push the tree, so HEAD normally
does not move (the review role only reads the same tree, and `investigate` uses a different tree),
and judgment proceeds as before. However, the controller's commit (§10-11) does not branch on role,
so if the previous tick's uncommitted diff is still there and the machine-side criteria pass, a path
remains where HEAD moves even though the implement role did not run. That one is not closed off.

The producing side is `ReviewPort` (`src/observe/index.ts`). It reads the final message from the raw
log of a Run that ran with `role: review` (§4.6's `runs/<run-id>/log.jsonl`), and observe turns that
into a Fact. It was shaped as an added Port rather than an `ObserveTarget` because `observeTargetOf`,
which assembles `ObserveTarget`, is in `src/controller/index.ts` (inside `PROTECTED_PATH_FLOOR`), so
"which Run to read" is resolved on the Port side. **A string the review role uttered is not yet a
Fact.** The `verdict:` line is matched against the whole line (for the same reason as §10-4: picking
up the same string appearing mid-body as the conclusion would let a fabricated approval be
manufactured), and when the line is absent, present two or more times, neither of the two values, or
when the sha of the commit that was read cannot be determined, neither key is turned into a Fact and
it is left in `unobserved` as `pending`. It is not made a `shape_mismatch`. That one is for failures
the guard escalates immediately as "waiting will not fix it," and the review role does not
necessarily return the same output every time. On a tick where the review role was never started, it
produces neither a Fact nor an `unobserved`.

**The flattened body itself is emitted to the `--report` destination (§9's "PRs and notifications,"
issue #59).** The path above leaves only two things, the single word `verdict` and the sha, and both
the reasons attached to an `approved` and its reservations sink into `runs/<run-id>/log.jsonl`.
`approved` does not mean "there is nothing to say," so `publish` reads `ReviewPort.latest()` once
more and appends it as a `## Review role message` section **after** the destination's body. It goes
after in order to keep the position of the criteria table the same regardless of destination — cut
in front of it, and you cannot reach the pass status without skimming past a long body. The body is
not summarized, and no line break, table, or code block is dropped (it goes through neither
`flatten` nor `oneLine`).

**The body is not turned into a Fact here.** It is emitted only to the destination a human reads,
and the observe side turns into a Fact only what passed the matching rule above. It is also carried
only on the `--report` destination and is not emitted to the PR comment (the `--report` body and the
PR comment body will no longer be identical). On a tick without `--report`, the raw log is not opened
— opening it every tick for a body that will not be used only adds one more interface that can fail.
When it could not be read, the reason is emitted in the section; for a Run where no body remains, the
id of the Run that was read is emitted. **Dropping it silently would manufacture one more instance of
the very breakage this section is trying to fix.** Even when the read fails, `publish` does not throw
(§9). No new Port or Adapter is created; using the fact that `ControllerDeps` extends `ObserveDeps`,
the already-existing `ReviewPort` is received as an optional dependency of `PublishDeps`.

The reason it is not emitted to the PR comment is that if 14,000 characters pile up every tick in a
place humans subscribe to, they stop reading. **This reason bites differently at the two `--report`
destinations.** `--report stdout` emits once per invocation so nothing piles up, but `--report
<path>` appends (`src/cli/present.ts`), and appending is a choice made to avoid only the last tick
surviving when driven from cron. On top of that, what `ReviewPort.latest()` returns is the most
recent **completed** review-role Run, so the same body comes back every tick until the next review
finishes (the stretch where `WAIT(human_review_pending)` continues is exactly this). **The reason for
rejecting the PR comment reproduces itself as-is at the file destination.** If it is the same Run as
the previous tick, a shape that collapses the section is possible, but publish does not hold what it
emitted on the previous tick, so that would mean adding a `PublishTarget`. That has not been added
for now.

The conditions under which `latest()` returns null are also broader than they look.
`latestReviewRun()` (`src/adapters/review-run.ts`) considers only Runs with `status: "completed"` as
candidates, so a Goal whose review role has only ever ended as `interrupted` or `failed` also gets
null. **The distinction from "never started once" is not carried in the Port's return value.**

There are two paths for reading the sha. **The one looked at first is the explicit `reviewed_sha:`,
and that is now the normal path.** If there is exactly one explicit mention it is taken, and if there
are two or more whose values disagree it drops to `pending` without recounting — output that states
in two different ways which commit was read is not settled by counting. Only when there is not a
single explicit mention does it fall through to the side that counts 40-digit strings in the body.
The same sha stated any number of times counts as one, and if different shas are lined up, there is
no deciding which one the result was read from, so it goes to `pending`.

The counting side was **the original default**, and the path that looks for the explicit mention was
added in front of it later. The reading side was added first because the prompt at the time said only
"state the sha of the commit you read," and **a shape able to pick up the output the counting-only
rule drops — writing the diff's comparison base out in full alongside it, quoting one line of
`git log` output; every one of them is a way of writing that follows the instruction — could only be
placed on the reading side** (`src/adapters/claude.ts` is inside `PROTECTED_PATH_FLOOR`, and the
Actor cannot touch it).

The prompt side now demands the explicit mention as well. That is because when the `semantic-review`
skill was handed to the review role (§4.2), that output format lines up two shas, base and head, in
the body, so the counting-only rule started failing every time, and **a human rewrote `REVIEW_PROMPT`
to add it.** The reading side's rule stays as it is. There is no reason to treat output without an
explicit mention — Runs from before the prompt was swapped, Runs that did not use the skill — as a
failure that waiting will not fix. Both the demanding side and the picking-up side exist, and if
either is missing it falls to the safe side (no Fact, `pending`).

The starting side is the DECIDE prompt. One ACT with `role: review` is added to the choosable
actions, and while `review.reviewed_sha` matches `local.head_sha` — which means the implementation
has not moved a single line — that option is removed with a reason. The judgment is not added to the
guard because putting when to run a review on a deterministic footing would be the same as adding a
"pass review" condition in front of judging completion. Only when the LLM keeps returning the review
role that was supposed to be removed and exhausts the retries does it stop with
`ESCALATE(review_not_converging)` (it is not collapsed into `invalid_decision`).

**The option is offered only for Goals whose criteria demand a review conclusion.** A Gap only
motivates the LLM and does not narrow what can be started, so offering it unconditionally would let
the review role be started even for a Goal that does not write a single character of
`review.verdict`. The matter does not stop at one budget unit. Once one review-role Run exists, on a
tick where its final message could not be read, `review.*` is stacked into `unresolved` as `pending`,
and for a Goal with zero Gaps the guard's third check (§7) returns WAIT and the LLM is never called.
The very choice of running the review once more becomes impossible, and since `latest()` keeps
returning the same Run, the pending never clears on its own. A Goal that wrote it into criteria can
recover, because a missing verdict raises a Gap — so it inverts into **only the Goals that did not
write it failing to reach COMPLETE**. Keep the starting interface closed to criteria, and that Run
does not exist in the first place. Here too it is not a guard judgment but the range of options shown
to the LLM.

**`WAIT` is removed by the same move** (issue #61). When the review role returns
`changes_requested` and the commit that conclusion read (`review.reviewed_sha`) is still the
implement role's HEAD (`local.head_sha`), there is nothing that waiting will change. Only the
implement role can fix the points raised, and neither human approval nor CI moves this state forward.
Even so, DECIDE kept choosing `WAIT` — while converging one Goal, 6 of 19 ticks went that way, and
the only thing that moved it was a human adding one more criterion. **The real handle had become
"adding criteria."**

The removal is aligned to the same three points as the review role. It is dropped from the prompt
along with its JSON format (the enticing line "choose WAIT if you judge that you should wait for a
human" is dropped along with it; erase only the form and leave the enticement, and the one left
behind is the one that gets read), the reason for removing it and the commit's sha are written, and
**the same condition is placed on the receiving side too.** If it keeps returning the WAIT that was
supposed to be removed and exhausts the retries, it stops with `ESCALATE(invalid_decision)`. No new
`ESCALATE` reason is added, and it is not counted as `review_not_converging` either. That one points
at "trying to run only reviews while the implementation is not moving," and it needs to arrive as a
different thing for the human reading the reason it stopped. reason is not looked at. Switching who
is being waited on from a human to CI does not change the fact that the implementation has not moved
a single line. It is not added to the guard (same reason as the review role; §7's boundary of
judging completion is not moved).

**`local.head_sha` is read only from a Fact this tick's OBSERVE produced** (the same rule §10-11
writes about `local.dirty`). Being VERIFIED does not mean "it was confirmed on this tick." reconcile
builds on the previous tick's Facts, so on a tick where `LocalRepoPort` failed, the previous tick's
head stays VERIFIED. And this hole is structural. One tick goes OBSERVE → ACT, so on a tick where the
implement role ran, `reviewed_sha` and `local.head_sha` point at the same sha, and **if the local
observation merely fails on the next tick, the carried-over head necessarily matches reviewed_sha.**
What you want to choose on that tick is `WAIT(observation_failed)`, and that disappears. DECIDE is
handed both the carry-over-inclusive `facts` and this tick's `observedFacts`, and **only the side
that removes options** is limited to the latter (`ReconcileResult.observedFacts`). The two materials
differ in provenance because they rot differently. "A review that read commit X concluded this" does
not change afterwards, but "X is still HEAD" changes every time the Actor pushes. The same rule is
applied to the judgment that removes the review role. Bias only one of them toward this tick, and a
state remains where `local.head_sha`'s provenance differs from judgment to judgment.

`github.pr.review_decision` is derived from REST's `pulls/{n}` and `pulls/{n}/reviews`. GraphQL could
fetch it in one call, but conditional requests via ETag (§3.4) work only on REST GETs, so it is
assembled by looking at the last entry per reviewer. Change requests take priority over approvals.
`github.issue.linked_pr` is filled in only when "that Issue is itself a PR." A cross-referenced PR
requires the timeline API, so it is not observed yet.

Only `github.pr.unresolved_threads` is fetched from GraphQL's `pullRequest.reviewThreads`. It is an
**exception on the judgment side** of the above "ETag works only on REST GETs, so assemble from
REST." REST has no field expressing a thread's resolution state, and it appears only in GraphQL's
`reviewThreads.isResolved`, so there is no choice but to give up on ETag and pick GraphQL. Because of
that, this read actually flies out every tick (§3.4's line that "using ETag consumes almost no rate
limit" is about REST and does not apply here).

> [!NOTE]
> `unresolved` in this key refers to the resolution state of a GitHub review thread.
> It is a different thing from §3.1's `Unresolved` (a verification target that reached no conclusion).

When the read fails it does not throw; the count is set to `null` and **no Fact is produced**.
Reading what could not be counted as 0 would make
`verification: { type: fact, key: github.pr.unresolved_threads, equals: 0 }` hold while a bot's
comment is still outstanding.

**But "produce no Fact" alone does not fall to the convergence side.** That only holds through
the first tick. reconcile builds on the previous tick's Facts and overwrites them with this tick's
observation, so a key that receives no overwrite keeps the previous tick's value as VERIFIED. Observe
0 on tick N, have a bot open a new thread on tick N+1, and have GraphQL fail on that same tick, and
the criterion goes passed on the carried-over 0. On top of that, this read stacks no `unobserved`, so
it does not stop at WAIT either. Once the threads exceed 100 (`totalCount` counts resolved ones too,
so it is reached even without 100 unresolved), the read becomes permanently `null`, so this path
becomes permanent as well.

So one conditional expiry is placed in `expireStaleFacts` (`src/reconcile/index.ts`). **The
carried-over count is dropped only when "`github.pr.number` could be observed this tick but
`github.pr.unresolved_threads` could not."** On a tick where the PR itself could not be read it is not
dropped (same as the expiry of `github.ci.*`: what could not be confirmed is not read as "it
changed"). On that tick `github.pr` remains in `unobserved` as `port_failed`, so the reason to wait
lies over there. **"If there is no Fact the criterion is not filled in, so it does not fall to the
convergence side" holds only when paired with this expiry.**

The reason the expiry of `github.ci.*` is judged by a change in head_sha while this one cannot be
judged by sha is that what they are tied to differs. A CI conclusion is tied to the head sha and is
immutable for the same sha, so as long as the sha does not move it is safe to carry over. An
unresolved-thread count is not tied to a sha. **A bot can open a thread with no new commit**, so the
count alone changes while the sha stays the same. Using an hour-old count as the current count amounts
to the "fabricated observation" §3.1 forbids.

**Outstanding: a read failure leaves nothing at all on the observation side.** §3.1 settles that
"could not be confirmed" is stacked into `unobserved`, but this key falls through producing neither a
Fact nor an `unobserved`. Thanks to the expiry, the criterion is kept from passing, but **why it is
not filled in is left nowhere**.

**Even so, stacking `port_failed` right now is not correct.** DECIDE does not narrow `unresolved` by
its relationship to the criteria, so stacking even one entry would turn every Goal with zero Gaps
into `WAIT(observation_failed)`, and even a Goal that references not a single character of this key
could no longer complete. Stack it as `shape_mismatch` and the guard escalates immediately, so the
impact is broader still. What is missing is not how the observation side stacks it but **the concept,
on the DECIDE side, of an `unresolved` that bites only on criteria referencing that key**. Until that
is added first, this key alone cannot be brought in line with §3.1.

The pain of this outstanding item has grown now that the expiry has been added. On a permanent failure
— the token lacks GraphQL permission, GitHub changed the field, the threads exceeded 100 — the Goal
correctly stops converging, but the reason for it is left nowhere and it surfaces as
`max_unchanged_reconciles`'s `loop_detected`. **The stopping reason the human receives does not point
at the actual cause.**

**`github.pr.review_decision` *alone* cannot serve as the observation source for human approval.**
GitHub does not let you press Approve on a PR you created yourself, so as long as the controller
creates the PR under the same account as the Goal's owner, `reviewDecision` will never be `APPROVED`.
Use this as the sole judgment for `type: human` and reconcile cannot escape `WAIT(review_pending)`,
never reaching §9's judging of completion. We actually stepped on this with the Goal in
`.goals/assess-and-decide.yaml`.

The path itself is not wrong. `ApprovalPort` treats two things as signals: a review approval and a
boilerplate PR comment (the reasons and the order of judgment are in §10-4). The second one holds
even when the creator writes it themselves, so even in a one-person operation the wait for approval
can be cleared here.
### 4.4 State machine

```
Goal lifecycle

  DRAFT → AWAITING_CRITERIA_APPROVAL → ACTIVE
                                        ⇅
                    WAITING_HUMAN / WAITING_EXTERNAL / BLOCKED
                                        ↓
                      COMPLETED | FAILED | ABANDONED

Kinds of waiting (in every one of them, reconcile returns immediately)

  WAITING_HUMAN(reason: human_review_pending)  waiting for human approval
  WAITING_EXTERNAL(reason: ci_running)      waiting for CI to finish
  WAITING_EXTERNAL(reason: usage_limit)     usage limit of the selected LLM/Actor. Carries resume_after
  BLOCKED(reason: budget_exhausted)         budget, count, or time limit reached
```

The old name of `human_review_pending` is `review_pending`. **Do not remove it from the enum.**
The decisions table goes through `actionSchema.parse` on every read, so removing it makes past
Decision rows unreadable. The transition target also stays `WAITING_HUMAN`, unchanged.

What is listed here is only the reasons for `WAIT`. The reasons for dropping from `ESCALATE` into
`WAITING_HUMAN` (`protected_path_touched` / `uncommitted_changes` / `push_branch_declared_manual` /
`open_pull_request_declared_manual`) are on the §7 / §10-6 / §10-11 side.

**Dependency waiting (§10-12) is not in this list.** A tick where `goal.depends_on` is not satisfied
returns at the entrance of `tick` without taking the lease, so the Goal stays ACTIVE and moves not a
single piece of state. The reason surfaces only in the `skipped` of `ent run` (the exception in §3.6).

`AWAITING_CRITERIA_APPROVAL` is not implemented in the MVP. As stated in §3.2, review of the Goal
YAML serves as the approval gate itself, so `ent start` goes straight from `DRAFT` to `ACTIVE`.
It remains in the types, but no code writes this value.

ESCALATE is an action reconcile chooses; BLOCKED is a Goal status.
As a result of ESCALATE, the Goal transitions to BLOCKED or WAITING_HUMAN.

**Terminal states are never reverted.** In addition to `nextStatus` and `tick`, `ent start` also does
not put a terminal Goal back into ACTIVE. If COMPLETED could be undone afterward, judging completion
in §9 would itself lose its meaning. To redo it, revert the DB state explicitly.

LLM/Actor providers have usage limits according to time window or contract.
A controller that runs for hours can hit the limit, so rather than crashing or retrying immediately
it drops into `WAITING_EXTERNAL(usage_limit)`, sleeps until the reset time, and resumes automatically.
If the reset time cannot be obtained, exponential backoff.
When the limit is reached during Actor execution and not only during DECIDE, the failure
classification, tokens, and raw log are left on the Run, and the guard replaces that ACT with
`WAIT(usage_limit)`. This keeps the next tick's DECIDE on a different provider from creating a path
that immediately retries the same ACT.

### 4.5 Data model

The following are DB table definitions, and they do not correspond one-to-one with the types in
`src/domain/`. For example, evidence is spread across two columns in the DB,
`evidence_source` / `evidence_detail`, while the type holds it nested as `evidence: { source, detail }`.

```
Goal          id, name, desired_state, status, lease_owner, lease_until,
              resume_after, activated_at, reconciles, pr_number, issue_number,
              abandon_reason, guard_base_sha
StateSnapshot goal_id, observed_at
Fact          snapshot_id, seq, key, value, observed_at, confidence, evidence
Unresolved    snapshot_id, seq, key, reason, detail      targets that could not be observed
Verification  goal_id, reconcile_seq, criterion_id, result, reason,
              evidence, detail, verified_at
Decision      goal_id, reconcile_seq, observed_digest, action, rationale,
              decided_by, decided_at
Run           goal_id, intent, actor, role, worktree, attempt, status, started_at,
              finished_at, exit_code, log_ref, tokens, artifacts, detail,
              error_kind, actor_resume_after
LlmCall       goal_id, purpose, tokens, log_ref, ok, called_at

Criteria      Not created. The Goal YAML is authoritative for criteria
Plan / Task   Not created, by decision. Decomposition is held by sub-Goal declarations (§10-12)
Event         Not created. Add it for a Goal that brings in webhooks
```

`policies`, `budget`, and `goal.depends_on` are authoritative in the Goal YAML and are not held in
the DB. This follows the §4.6 split of not mixing the declaration with runtime state (deciding a
dependency needs no more than reading the `status` of the depended-on Goal. §10-12).

Only `Plan / Task` is not "not created yet" but **something decided against creating**, which differs
in meaning from `Criteria` and `Event`. Since the policy adopted is to stand up one Goal per
decomposed unit (§10-12), what corresponds to the Plan is the sub-Goal declaration itself. `REPLAN`
(§1 / §5) remains as an action DECIDE chooses, but its result is not held in a separate DB layer.

`LlmCall` was not in this list at first. As a result of moving DECIDE through the Actor layer (§3.5),
LLM calls that create no Run appeared, and a place was needed to keep their tokens as §7 requires.

**Targets that reached no conclusion are persisted too.** Dropping this makes the problem §3.1 wanted
to avoid — "collapsing into the absence of a Fact" — recur at the DB layer, and ASSESS can no longer
read what was missed. On the observation side it is held as `Unresolved` rows; on the verification
side, `Verification.result` is made three-valued —
`passed` / `failed` / `unresolved` (`reason` is filled only for `unresolved`).

**The contents of `failed` are kept too.** Back when only the exit code went into `evidence.detail`,
the flapping in which criteria fail once and pass on the next tick could not be traced. Running by
hand in the same worktree passed everything, and all that remained was `exit_code=1`. What §3.1
protects is "what could not be verified"; what was being dropped was **the contents of a verification
that came back failing**. Now the tail of the output is attached only when it fails
(`describeCommandResult`. Limit 2000 characters, and the fact that it was cut is written into the
body). It is not the raw log, so tens of MB are not pushed into SQLite (§4.6).

The `Verification` row and the `criteria.<id>.passed` Fact are a double representation of the same
result, but the division of roles is that the former is a per-criterion index and the latter is an
observed value passed to ASSESS.

**These two can reach different conclusions about the same criterion, and that is intended.**
reconcile layers this tick's observation on top of the previous tick's Facts, so a criterion that
could not be verified this tick still keeps the previous tick's `passed: true`. What ASSESS answers
is "is it satisfied on VERIFIED grounds", so that is not made a Gap (otherwise a Gap that was
supposedly fixed would come back just because GitHub was briefly down). What `Verification` answers
is "what happened on this tick", so `unresolved` is looked at before the Fact.
The roles differ, so the judgment is not folded into a single function. Folding it loses one of the
two meanings.

**`Decision` is always kept.** The L5 improvement layer is deferred, but the format of the history
fed to it is fixed from the start.

`lease_owner` / `lease_until` on `Goal` guarantee "at most one reconcile at a time per Goal".
Making it time-bounded ownership rather than a row lock means it is released automatically even if
the process crashes.

**The deadline keeps being extended while a tick is running.** ACT is execution of the selected
Actor, so it takes minutes (in the §9 measurement, the first tick consumes 1,341,349 tokens).
`leaseSeconds` is 300, so without extension the deadline expires in the middle of ACT. In the
cron-driven configuration (§3.6), another process takes the lease there and two ACTs run in parallel
in the same worktree (its name is determined from (goal.id, role). The implement role and the review
role land in the same place). This was not a rare race but the default behavior in real operation.

```sql
UPDATE goals
   SET lease_owner = :worker_id,
       lease_until = :now_plus_5min
 WHERE id = :goal_id
   AND (lease_owner IS NULL OR lease_owner = :worker_id
        OR lease_until IS NULL OR lease_until < :now);
-- If the number of updated rows is 0, another worker holds the lease. Skip this tick.
-- If we hold it ourselves, this is an extension of the deadline. Keeping acquisition and
-- extension in one and the same statement means no path can appear where you
-- "think you extended it but overwrite another worker's lease"
```

### 4.6 File layout

```
.goals/<slug>.yaml            Edited by humans. Git-managed. Declaration only
.goals/config.yaml            Edited by humans. Git-managed. The repository-scoped part of the declaration
.goals/.state/goals.db        SQLite. Written by machines only. gitignore
.goals/.state/runs/<run-id>/  Agent raw logs and diffs. The DB holds only the path
.goals/.state/worktrees/<slug>/ Worktree shared by the implement role and the review role. The implement role writes, the review role reads (§4.2)
.goals/.state/worktrees/<slug>-investigate/ Worktree for the investigate role
```

Do not mix the human-edited declaration with the runtime state the machine rewrites.
Putting them in the same file produces a diff on every reconcile and buries the human edit history.
`ent get <slug>` prints a single merged view of both to standard output, so at reference time it
looks like one file. Whether to add a path where the machine writes `.goals/<slug>.yaml` was decided
in §10-12. **Even as the number of writers grows, the line separating the declaration from runtime
state does not move. What moves is only the "edited by humans" side.**

**The declaration is split in two, by who decides the value — not by who edits it.** `repository`,
`setup`, and `policies` are decided by the repository rather than by the Goal, and written per Goal
they become the same text copied N times. They live in `.goals/config.yaml`, and every Goal under
`.goals/` inherits it. The merge happens on the raw YAML before validation, key by key, so a Goal's
own value always survives and `goalSchema` and everything below it stay unchanged; the two floors
(`protected_paths`, `require_human_approval`) take the config as an additional floor rather than a
replacement. Goal-specific keys — `budget` above all — are refused in `config.yaml`: pushed out to a
repository-wide default, reading one Goal YAML would no longer tell you when that Goal stops. The
schema and the merge are in `src/domain/goal-config.ts`. **This does cost the "read one file and you
know the behavior" property**, which is now "read one file plus the config".

**The declaration does not have to be committed.** Running ent by yourself inside a repository other
people share, `ent init --private-goals` writes the ignore line to `info/exclude` rather than the
tracked `.gitignore`, and ignores `.goals/` whole. What that would otherwise break is the review
role: `git worktree add` carries only tracked files, so an ignored declaration never reaches the
worktree the review role is told to read it from. The controller delivers it — but **only where git
ignores the path**, because a delivered file git can see becomes an untracked change that stops an
Actor which never touched it and rides into the PR diff. Delivery repeats on every role launch, so
the copy the review role reads is always the controller's.

The schema of `.goals/<slug>.yaml` is in `src/domain/goal.ts`. The slug is kept identical to `goal.id`
(the cross-check is in `src/domain/goal-parse.ts`). `config` is a reserved slug for that reason: the
file is not a Goal, and the CLI refuses it by name rather than letting the schema complain. File names come from the content of the Goal, not
from the Phase number. Phase is a plan on this document's side, not an attribute of the Goal.
Doing it this way keeps file names from rotting when the Phase boundaries change.

Do not put an Agent's entire output into a DB row. Pushing tens-of-MB strings into SQLite makes
queries slow and recovery painful when things break. Logs go to files; the DB sticks to indexes and
metadata.

### 4.7 Why use a DB and not just files

There are concurrency hazards too (simultaneous writes from multiple workers, lost updates from
read-modify-write), but the deciding factors are three others.

1. **History becomes a query rather than a scan.** L5 produces "which Actor has the higher success
   rate for this task type". That is not something you write as a file scan
2. **Crash consistency.** If reconcile dies mid-write, the JSON stays corrupted
3. **Idempotency of events.** Polling picks up the same event many times.
   "Has this event_id been processed" is naturally solved by an indexed lookup.
   This is a reason that takes effect once webhooks are in, and the `Event` table is not created yet (§4.5)

The SQLite settings are as follows. With WAL, "multiple readers + a single writer" run at the same time.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

---

## 5. MVP scope

The premise was "commit to a single real environment", but since that real environment (Notion pages,
the Slack workspace) does not yet exist, the dependencies were narrowed down to GitHub alone.

### In scope

- Goal registration and persistence. Desired State and Acceptance Criteria are hand-written in `.goals/*.yaml`
- OBSERVE (GitHub Issue / PR / CI, local repo)
- ASSESS (Gap computation), PLAN / REPLAN, DECIDE
- ACT (non-interactive execution of the selected Actor, git worktree isolation)
- VERIFY (`command` = verification command, `fact` = matching against observed values such as CI status, `human` = human approval)
- State machine, polling, write-ahead persistence, budget and loop limits, automatic waiting on usage limits
- Notification and approval are completed with GitHub PR comments + CLI standard output.
  There are two approval signals, review approval and a fixed phrase in a PR comment, and CLI standard output handles notification only (§10-4)

### Out of scope

- Notion integration (both reading and writing back. Add it once the environment exists)
- Slack integration (same as above)
- Web UI (CLI and generated reports only)
- GitLab / Linear / Jira Adapter implementations (only the interface is carved out)
- Parallel execution of multiple Actors (the interface supports multiple, the implementation is a
  single sequential one). The roles have grown in number (§4.2), but **the number of Actors launched
  in one tick stays one**, and Decision likewise stays one row per tick. Collaboration is established
  not simultaneously but by handing off across ticks. Running two in the same tick would change even
  the premises of Run finalization, lease, and write-ahead (§3.6 / §4.5).
  **The parallelism meant here is a matter of the inside of one tick.** Because the lease is per Goal,
  the data model can handle N of them in separate processes. The protected path gate that was blocking
  parallel execution in the same directory came off once observation of the state DB was moved to a
  per-Goal logical digest (§10-6).
  However, **what was verified is only running two ticks concurrently against the same DB inside Vitest**,
  and two `ent run` processes have not been stood up and run. The git lock contention (the first
  `git worktree add` takes `.git/index.lock`) and SQLite busy contention remain.
  See README "Running several Goals at once"
- ~~Codex CLI implementation~~ (`ENT_ACTOR=codex` or a per-phase setting selects the non-interactive JSONL Adapter)
- L5 improvement layer (History is only accumulated; no learning)

Dropping Notion and Slack made the MVP's external dependency a single one: GitHub.
The default Claude Code setup needs only a GitHub token and Claude Code's OAuth, and choosing Codex
additionally requires a saved Codex CLI login.
Validating the value proposition that "Adapters can be swapped" moves to after the MVP is done.
Phase 3 is also GitHub-only self-hosting, so it is not validated there.

---
## 6. Technology choices

### Language

**We adopted TypeScript. The deciding factor was the state of Claude Agent SDK support.**

| Language | Advantages | Disadvantages |
|---|---|---|
| **TypeScript** | Officially supported by the Agent SDK. Zod alone covers "structured LLM output, YAML validation, and DB schema." Discriminated unions are strong, so modeling Event / Decision is straightforward. Notion, Slack, and GitHub all have official SDKs. `yaml` has the best comment-preserving round-trip | Distribution is heavy (Node is assumed; a single binary means SEA or bun compile). Cross-compiling native dependencies is a nuisance. Memory management under long residency is sloppier than Go |
| Python | Officially supported by the Agent SDK. Pydantic is at least the equal of Zod. ruamel.yaml's round-trip is also excellent | Painful to distribute as a CLI (uv / pipx assumed). Unions are less expressive than in TS. asyncio and synchronous libraries tend to mix idioms |
| Go | Single-binary distribution keeps the barrier to adoption minimal. Long residency and concurrency are the most solid. The controller-runtime idioms can be brought over as-is | **There is no Agent SDK** (you end up exec'ing `claude -p`). No sum types, so union modeling is verbose. The Notion / Slack SDKs are unofficial |
| Rust | The best type system (enums are complete sum types). Single binary | No Agent SDK, and the surrounding SDKs are thin. MVP velocity drops |

Go fits the design philosophy best ("a controller converges declarative resources" belongs to Go's
world). It still loses on the single point that there is no Agent SDK, and that is the core
dependency here.

The weakness in distribution is covered well enough by making it possible to try with
`npx entelecheia`.

### Libraries

| Area | Adopted | Reason |
|---|---|---|
| Runtime | Node.js 24 (pinned in `mise.toml`) | Stability of native modules |
| Actor execution | `@anthropic-ai/claude-agent-sdk` / `codex exec --json` | Selected from a common specification and a per-phase override. Codex uses saved credentials and non-interactive JSONL |
| Schema | Zod | The verification gate for Agent output and YAML validation share a single definition |
| YAML | `yaml` (eemeli) | Comment-preserving round-trip editing. Essential if a machine writes back |
| DB | `node:sqlite` (Node standard) | The synchronous API keeps the code straightforward. Usable without a flag from Node 22.13 on (introduced in 22.5; absent before that). `mise.toml` pins Node 24 and `engines` is `>=24`, so it is always usable. We withdrew the plan to adopt better-sqlite3 + Drizzle (see below) |
| CLI | `parseArgs` from `node:util` (Node standard) | There are few subcommands (four at adoption time, eight now), so adding a dependency does not pay off. Past ten, we move to citty or oclif |
| Process execution | `node:child_process` (Node standard) | We only invoke verification commands and git, so the standard library suffices. If stream control becomes necessary, we move to execa |
| GitHub | `@octokit/rest` + plugin-throttling/retry | ETags save on polling rate limits |
| Logging | pino (not started) | Structured logging. Raw logs are kept separately from the Decision table. For now the CLI just emits a single JSON |
| Testing | Vitest | |
| Lint | Biome | Little configuration and fast |
| State machine | A hand-rolled discriminated union | DECIDE is an LLM judgment, so the state machine is kept thin. If visualization becomes desirable, XState |

`@notionhq/client` and `@slack/bolt` fell outside the MVP, so we are not adding them at this point.

### Why the DB and CLI were moved to Node standard libraries

Right before introducing better-sqlite3 + Drizzle and citty in the third pass of Phase 2, we
reconsidered and replaced both the DB and the CLI with Node 24 standard libraries. There were
three grounds for the decision.

1. better-sqlite3 is a native module, which further increases the distribution weight that the
   table above listed as a disadvantage of TypeScript. `node:sqlite` has the same synchronous API
   as standard
2. Drizzle's value is migrations, but the Goal YAML schema pins `version: 1` as a literal (§10-8),
   and no migration exists yet
3. The CLI has four subcommands — `start` / `run` / `show` / `list` (names at the time; `show` is
   today's `get`) — and the cost of one more dependency outweighs the benefit of citty's types

As a result, the body of the controller depends on only two things, zod and yaml. For the same
reason, process execution is `node:child_process` rather than execa.

External dependencies were pushed to the implementation side of the Ports. The fourth pass brought
in `@octokit/rest` (+ throttling / retry) and `@anthropic-ai/claude-agent-sdk`. octokit is closed
inside `src/adapters/`, and for the Agent SDK the only point that surfaces is the single place
where `src/wiring/index.ts` (the composition root of §3.3) injects `query`.

The `ent watch` that §3.6 mentions does not exist yet. Only the non-resident form (invoking `run`
from cron) is provided, and whether to add `watch` will be decided after actually running it from
cron.

`node:sqlite` may be standard, but it is not as battle-tested as better-sqlite3. If the API
changes, the migration target is better-sqlite3, and since it is closed inside the `Store`
interface, only the implementation needs to be swapped. Note that `node:sqlite` landed in Node
22.5 and requires a flag up through 22.13. `engines` in `package.json` is set to `>=24` (back when
it said `>=22`, there was a range that passed the engines check and then crashed at startup).

### Task runner

This repository was created from
[`slashkiko/repository-baseline`](https://github.com/slashkiko/repository-baseline), which has a
convention of pinning security tools with mise + aqua. The Node side was aligned to mise tasks to
match.

```
mise run typecheck / lint / build / test / verify   application side
mise run check                                      supply chain and workflow (from the baseline)
```

---

## 7. Controlling runaway behavior and cost

Since we let it run autonomously, this is treated on par with the functional requirements. We
explain four things in order: budgets, limits, and approval gates; how to choose what goes on the
protected-path list; the means of stopping publish by declaration; and credentials and external
commands.

### Budgets, limits, and operations that require approval

The following is an example of the notation. Actual values are specified per Goal in
`.goals/*.yaml`.

```yaml
budget:
  max_actor_runs: 20              # Actor launches per Goal
  max_reconciles: 50
  max_wall_clock: 6h
  max_consecutive_failures: 3
  max_unchanged_reconciles: 5     # Limit on ticks run while the observation stays unchanged (§10-2)
  usd: 20                         # Optional. Applies only to runs via an API key
```

Runs via Claude Max (OAuth) incur no charge, so they fall outside `usd`, but **token usage is
always recorded**. Actor executions go in `Run.tokens`, and LLM calls from DECIDE that create no
Run go in `LlmCall.tokens` (§4.5). Multiplying by a unit price afterwards yields "what it would
have cost under metered billing." When we split out to the Messages API, that carries straight
over to actual-cost calculation, and it also becomes material for evaluating cost efficiency at L5.

Other controls.

- **The LLM does not decide "how long to sleep," either.** Even if we close off only the kinds of
  actions, a `resume_after` on `WAIT` returning a distant future can stop a Goal indefinitely. The
  `resume_after` the LLM returns is not adopted. The only case where it may be filled in is when
  the usage-limit reset time is received from a Port (§10-3 / §10-5)
- **What `max_wall_clock` counts is the real time during which the machine side could act.** Time
  spent waiting on `WAIT`, and on `ESCALATE` other than budget exhaustion, is subtracted
  (`waitedSeconds`). It was the controller that ordered the wait, and no matter what the next tick
  does, the state will not change. Subtracting that time from the Goal's budget does not hold up.
  In fact, a Goal that had a single `type: human` criterion left and waited overnight for approval
  went `BLOCKED` with `budget_exhausted` after the approval arrived but before it observed it.
  There is no `ent complete` (§3.1), so at that point COMPLETED can no longer be reached (`budget`
  is authoritative in the Goal YAML, so a human can write in a higher limit to bring it back to
  ACTIVE).
  The length of the wait is derived from the Decision history. If we add one more piece of state
  and keep it in sync, then only the ticks where we fail to write it will silently stop enforcing
  the limit.
  **When material is missing, we fall to the side where the limit takes effect, in both cases.** If
  `activated_at` cannot be interpreted, elapsed time is set to Infinity and treated as "the limit
  was reached," and a Decision whose `decided_at` cannot be read is not counted as waiting. Treating
  it as 0 seconds makes comparisons with NaN always false, and `max_wall_clock` alone is silently
  disabled. Conversely, counting an unreadable timestamp as waiting extends the limit by exactly
  that much. Either way the stopping condition disappears, so we fall to the side that calls a human
- A retry limit for the same Task. On reaching it, a different Actor or a Replan; when those are
  exhausted too, ESCALATE
- ESCALATE if the observation does not change for N consecutive times (loop detection). N is
  `budget.max_unchanged_reconciles`. The material for the judgment is not the Gap but
  `Decision.observed_digest` (§10-2)
- Operations that require human approval: direct push to main, force push, merge, deployment,
  secret operations, and sending to the outside
- Additions when self-hosting: changes to paths listed in `policies.protected_paths`, and enforced
  worktree isolation

### What goes on the protected-path list

What to list in `protected_paths` is decided by **"if the Agent rewrote this, could it remove every
other control?"** The control loop itself (`src/controller/**`) and the Goal declaration
(`.goals/**`) are not enough.

Of these, **the floor that no Goal can remove** is placed in `PROTECTED_PATH_FLOOR`
(`src/domain/goal.ts`). Even if a Goal empties `protected_paths`, the schema mixes in the floor at
load time. If the scope of the gate stayed something the Goal side decides, then a Goal that wants
to remove the gate can remove it at any time. What goes in the floor is only **what stops the gate
itself from working if rewritten**; the verification set (`mise.toml` and the like) and
dependencies (`package.json`) do not go in. Those can legitimately be targets that some Goals touch.
The list below includes both the floor and what individual Goals add.
**`PROTECTED_PATH_FLOOR` is authoritative for the full contents of the floor.** The bullets below
are representative examples meant to explain the criterion, not an exhaustive list. If both carried
the same list, then when only one of them went stale, a reader could no longer tell which one is
the actual gate. The approval gate has a floor of the same shape, and `APPROVAL_GATE_FLOOR` mixes
`secret_access` and `external_send` into every Goal.

- The gate itself (`src/domain/protected-paths.ts`), and the file that decides the Agent's allowed
  and denied tools (`src/adapters/claude.ts`). If this is open, making the comparison always return
  false, or simply emptying the deny list, removes everything else. The same file also holds the
  skills shown per role (`SKILLS_FOR`) and the contract for the review conclusion (the two lines
  `verdict:` and `reviewed_sha:` that `REVIEW_PROMPT` requires; §4.3). That would let **the Actor
  rewrite both the perspective handed to it and how its own conclusion gets read**, so it cannot be
  taken out of the floor
- **The judgment rules that guard reads (`src/domain/guard-rules.ts`).** The counterpart the gate
  diffs against (`guardBaseOf`), the predicates the uncommitted-work gate looks at
  (`leavesWorkUncommitted` / `observedValue`), the determination of whether it is sleeping
  (`sleepingUntil`), and how elapsed time and consecutive failures are counted all live here.
  Rewriting them makes the gate see an empty diff every tick, and the wall-clock stopping condition
  can be silently disabled too. These used to be inside `src/controller/**`, covered by the floor.
  **If you move something out to the domain on the grounds that it is a rule with no dependencies,
  the place you moved it to is outside the floor.** The floor is path literals, so **when a
  refactor moves the location, the protection does not follow.** Every time something is relocated,
  move the floor along with it. `tests/protected-floor.test.ts` reads from the source which file
  declares the rules, and checks that this location is in the floor as well.
  They are gathered into one file to line up with the unit of protection; distributing them by
  vocabulary would mean adding several entries to the floor, and they would end up in the same
  files as vocabulary that Goals may legitimately touch
- **The composition root (`src/wiring/index.ts`).** Even if the rules are honored, the gate is
  powerless if the **inputs** flowing into those rules are open. This is where `localRepo` /
  `commandRunner` / `gitWorktree` are injected, and `verifyRoot` (§10-9), which decides the working
  tree the uncommitted-work gate and VERIFY look at, is in the same file. Without touching a single
  character of `guardBaseOf`, the very observation the gate reads can be swapped out. **This one is
  the opposite of the above**: before the refactor the same code was in `src/cli.ts` and outside the
  floor. It is not a hole opened by the relocation; it is one that had been open all along and was
  closed on the occasion of the relocation.
  `tests/protected-floor.test.ts` checks the locations of `tickPorts` and `verifyRoot` by the same
  method as `guard-rules.ts`
- The verification set (`mise.toml` / `mise-tasks/**` / `vitest.config.ts` / `biome.json` /
  `tsconfig*.json` / `.github/**`). VERIFY runs the criteria commands in a worktree (§10-9), so if
  this can be rewritten, the Agent can make its own Acceptance Criteria pass. The Fact born at that
  moment becomes VERIFIED, and §3.1's "only externally verifiable primary information" no longer
  holds
- Dependencies (`package.json` / `pnpm-lock.yaml`). The reason differs from the verification set:
  it is so that supply-chain judgments are not delegated to the Agent. This repository has a
  baseline convention of pinning dependencies (mise's `minimum_release_age`, pinact, renovate), and
  we do not leave a shape where the Agent can walk straight past just that
- `tests/**` is not included. "The mechanism that confirms the criteria" and "the content being
  confirmed" are different, and freezing the latter as well means an ESCALATE every time one new
  test is added
- All of `src/**` is not included either. That is exactly what the Agent implements, and protecting
  it wholesale would stop this tool from doing its job

### Stopping publish by declaration

What the approval gate above (`policies.require_human_approval`) stops is **Agent** operations. The
gate you write only turns the corresponding line of `DENIED_TOOLS` (`src/adapters/claude.ts`) into a
deny pattern, and **it has no effect whatsoever on the controller's own actions**. What performs
push and PR creation is the controller's publish (§10-11), so there was no way to declare "do not
open a PR on your own." In fact, a PR went up on the tick after a Goal was run, and by the time a
human went to check, the notification to reviewers had already gone out. Cancelling does not take
the notification back.

**Do not widen the meaning of the gate; make it a separate declaration.** We add `policies.publish`,
declaring `push_branch` and `open_pull_request` as `auto` / `manual` respectively. We do not adopt
the form of adding `open_pull_request` to `require_human_approval`. That would make the same
enumeration take effect at different gates depending on the subject (Agent / controller), and on
top of that, only the values with no corresponding `DENIED_TOOLS` line would pass straight through
on the Agent side. From a reader's standpoint, which value affects which side cannot be told from
the name.

| Declaration | Subject it stops | Where it takes effect |
|---|---|---|
| `policies.require_human_approval` | Agent | The denied tools handed to the Actor (`deniedOperations`) |
| `policies.publish` | controller | push and PR creation in `src/publish/index.ts` |

The values express the **acting subject** rather than "whether approval is required" (`auto` = the
controller, `manual` = a human). The mechanism that detects approval and proceeds (`/ent approve`,
§10-4) exists only for criteria, not for publish. Giving it a name that reads as "awaiting approval"
would send people searching for an approval interface that must exist somewhere.

The steps were split in two because they differ in irreversibility. A push only puts a branch on the
remote, whereas creating a PR carries a notification to reviewers. This makes it possible to write
"the branch may go out, but a human opens the PR."

**The default is `auto`, and no floor is placed.** `PROTECTED_PATH_FLOOR` and `APPROVAL_GATE_FLOOR`
have floors because being rewritten stops the gate itself from working; here, not stopping simply
means it works as before. Falling the default to `manual` would stop every Goal currently running.

A tick that is stopped becomes `ESCALATE(push_branch_declared_manual)` or
`ESCALATE(open_pull_request_declared_manual)`, and the state moves to `WAITING_HUMAN`. **It also
overrides COMPLETE.** Declaring "done" without a single PR would make judging completion
meaningless. The reasons are split by step because what `ent list` emits is only the kind and the
reason (`WAITING_HUMAN` also folds in other reasons, such as §10-6's `protected_path_touched`).
What a human must do for it to proceed is written in
`decision.rationale`.

**That rationale surfaces only as far as `ent get` and `ent list`.** The decision replacement
(`publishHeldDecision`) sits **after** publish, so the `decision` that publish put in the progress
comment is the pre-replacement one. §10-11's `uncommitted_changes` is replaced before publish, so
the same string appears in the PR and in `ent get`, but this one falls outside that convention.
**Moving the replacement earlier is not an option.** Whether to stop `open_pull_request` can only be
decided after confirming "the push went through and there is still no PR" — inside publish.

Instead, `heldNotes` (`src/publish/index.ts`) writes a `> [!NOTE]` into the PR. Even if the string
differs from the rationale, it **states the same facts** — that pushing by hand is invisible to the
controller, and that the declaration must be returned to `auto` or the Goal terminated with
`ent abandon`. Keeping this to a single line of "has not pushed" would mean the two things a human
most needs cannot be read from the PR side. A notification that tells you it stopped but does not
say what to do next is nearly the same as one that never rang.

**However, it only reaches Goals that already have a PR.** `push_branch: manual` returns before the
push, so a Goal that declared this from the start has no PR created and `heldNotes` has nowhere to
write. That case is the same as `open_pull_request` below: there is no route to notice other than
reading `ent list`.

**A tick stopped at `open_pull_request` surfaces nothing on the PR side.** What stops at this step
is only ticks where "there is a diff and there is still no PR," so there is not a single place to
write to. What is read is `ent get`, and the `publishHold` that comes next.

**A Goal stopped at this step appears in no notification.** There is no PR comment, it does not
fall to `BLOCKED`, and the wall clock stops too. In a setup that runs from cron where nobody reads
stdout, there is no route to notice that it stopped other than reading `ent list` periodically.
Whoever declares `open_pull_request: manual` should have that one route in place.

A Goal with `open_pull_request` stopped **proceeds once a human opens the PR, without rewriting the
declaration**. publish always searches for a PR with the same head before creating one
(`findPullRequest`), so the next tick finds it and moves on. What is stopped is only "creating"; a
progress comment on a PR that already exists is not stopped.

**`push_branch` has no such route.** The only material publish has for deciding whether a push is
needed is the result of `BranchPort.push`, so a human pushing by hand does not enter publish's
judgment (the remote itself is observed via `github.pr.head_sha` and the like, but the decision on
whether to push does not read that). Until the declaration is returned to `auto`, it keeps falling
to `WAITING_HUMAN` every tick for the same reason, and in the meantime only the reconcile budget
drains. This is where it differs from `protected_path_touched`, which is resolved by cleaning the
worktree. **We write in the rationale that this is a gate that cannot be resolved**
(`publishHeldDecision`). Without that, a human would have to hunt through the code for why it keeps
stopping despite having pushed.

**It does not fall to `BLOCKED`.** The decision replacement sits after publish, and if there is a
`held`, it overrides whatever DECIDE chose with `ESCALATE(*_declared_manual)`. The only thing that
becomes `BLOCKED` is `ESCALATE(budget_exhausted)` (§4.4), so while it is held, even reaching a limit
does not surface that. As a reason to call a human, `*_declared_manual` is the more concrete one, so
this direction of override is right, but whoever writes the declaration needs to know that "while
it is held, budget exhaustion is invisible."

**Some limits keep advancing and some stop.** Do not treat the three the same way.

| Limit | While it is held | Why |
|---|---|---|
| `max_reconciles` | Advances | `saveSnapshot` counts before publish, and even when held, one tick is one tick |
| `max_actor_runs` | Advances | ACT comes before publish. What is held is only push and PR creation, and the Actor runs |
| `max_wall_clock` | **Stops** | `waitsForOthers` counts `ESCALATE` other than `budget_exhausted` as waiting |

The wall clock alone does not hide but stops. `*_declared_manual` is an `ESCALATE`, and moreover not
`budget_exhausted`, so `waitedSeconds` (`src/domain/guard-rules.ts`) accumulates that window and
`usageOf` (`src/controller/index.ts`) subtracts it from `elapsedSeconds`. The held time falls
entirely outside the budget, so on the tick where the declaration is returned to `auto`, the wall
clock will never have reached its limit. **What can surface there is the `max_reconciles` and
`max_actor_runs` side.** It was the controller that made it wait, so subtracting holds up (§4.4),
but "while it is held, time does not decrease" is something anyone relying on `max_wall_clock` as a
stopping condition should know.

**Emit the fact that it was held in machine-readable form.** It is not only humans who invoke ticks.
In a setup driven by an agent, that agent opens the PR the controller did not create on its behalf.
For that, "it was not created" and "if you create it, here are the head and base" need to be
apparent without reading the prose of `decision.rationale`. We added `publishHold` to the output of
`ent run`.

```json
{
  "publishHold": {
    "step": "open_pull_request",
    "reason": "declared_manual",
    "pushed": true,
    "branch": "entelecheia/<goal-id>",
    "base": "main"
  }
}
```

The shape is aligned with `--report`'s `report` (`destination` / `written` / `error`). Both are "a
publish result that appears only on the tick that used that interface," returning where it went and
the result as structure. **On ticks that are not held, the key is not emitted at all.** The output
of anyone running an existing `.goals/*.yaml` with no such declaration does not change by a single
key (treated the same as `dryRun`).

`pushed` can be derived from `step` (you only reach the `open_pull_request` step after the push went
through), yet it is carried separately. A PR cannot be created with a head branch that is not on the
remote, so whoever creates it on the controller's behalf looks here before acting. Making them rely
on derivation means the reading side silently gets it wrong when publish's ordering changes.

The step and the reason are also kept separate. Folding "held by declaration" into `step` would
break the reading side's branching when more ways of holding for reasons other than a declaration
appear. For now the only thing that goes in `reason` is `declared_manual`.

**This key is not emitted on ticks held by the protected-path gate** (`blocksPush`). That case has
not pushed either, and it is not a state where pushing on its behalf is acceptable. Emitting it here
would become a route for the agent invoking the controller to bypass a gate the controller closed.
That would be the same as having no gate.

This hold is not reflected in `--dry-run`. It is a tick that does not run publish, so
`wouldTransitionTo` returns the pre-hold judgment as-is. The `push_branch` side is determined by the
declaration alone, so it could be previewed, but doing so would split the same gate's determination
across two places, publish and preview. The determination is unified into publish, and the fact that
it is not reflected is documented as a property of `preview`.

### Credentials and external commands

**Do not hand tokens to the Agent.** As long as Bash is permitted, both `printenv` and
`echo $GITHUB_TOKEN` can be executed. Neither matches the `secret_access` deny patterns
(`gh secret` / `gh auth token`), so a deny list cannot close them off. The Agent SDK's `env` is
"replacement, not a merge," so we drop `GITHUB_TOKEN` / `GH_TOKEN` from `process.env` before
passing it. Push and PR are performed only by the controller, so there is no situation where the
Actor side needs a token in the first place.

**Dropping alone is not enough.** If the token environment variables are absent, `gh` falls back to
the login in `$HOME/.config/gh/hosts.yml`. `HOME` has to be passed through (neither `mise` nor
`pnpm` would work otherwise), so authentication remained somewhere the removal list does not reach.
`NEUTRALIZED_ENV` points `GH_CONFIG_DIR` at a directory that does not exist, leaving `gh` inside the
Actor and the verification commands unauthenticated. **You need not only the side that erases, but
also the side that overwrites to neutralize** (`src/domain/withheld-env.ts`; the routes to be closed
are in §10-4).

**Closing off `gh` left git itself wide open.** With exactly the environment the Actor is handed
(token environment variables dropped, `GH_CONFIG_DIR` already neutralized),
`git ls-remote https://github.com/...` against a private repository went through
non-interactively, and feeding `protocol=https` / `host=github.com` to `git credential fill` put the
token itself on stdout. It comes from `credential.helper = osxkeychain` in the system gitconfig, and
**being a system setting it can be removed by neither repository nor user configuration.** Only
environment variables can close it. With the token in hand you can post a PR comment, so the Actor
can write the `/ent approve` boilerplate itself (§10-4) — the very reason `gh` was made
unauthenticated applied to git all along.

`NEUTRALIZED_ENV` layers four things on. The `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` /
`GIT_CONFIG_VALUE_0` trio is read **after** system, global, and local alike, and an empty value for
`credential.helper` resets the helper list. Once the helper is gone git goes asking the terminal and
askpass, so `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=/usr/bin/false` tip that into "it cannot ask,
so it fails". On the ssh side, dropping `SSH_AUTH_SOCK` is not enough (measured: it still went
through on the keys in `~/.ssh`), so `GIT_SSH_COMMAND=/usr/bin/false` kills the side that launches
ssh.

**What is closed is the route that arrives silently from the surrounding environment.** Writing the
setting back by name (`git -c credential.helper=osxkeychain`) is still open. It is filed as (i) in
§10-6.

**Invoke git with an argv array.** If external commands are assembled with template strings, then
any single argument not under the controller's control becomes a shell injection. `gitBranch.push`
reads the branch name from the worktree, but the contents of the worktree can be rewritten by the
Actor, and git permits `;` and `$()` in branch names. Simply by creating one branch named
`evil;touch${IFS}PWNED`, the Actor got an arbitrary command to run in the controller's process. It
writes no files, so it catches on neither the protected-path check, nor `Run.artifacts`, nor
`disallowedTools`.
Only the Goal YAML's `setup` and `verification.run` may go through a shell. For those two,
"streaming arbitrary shell commands" is a declared feature, so being a shell is itself part of the
specification.

---
## 8. Phase plan

Each phase is structured so that you build it by using the previous phase yourself.
The practical value of Goal YAML can only be verified by using it yourself, not on paper.

Each row shows the cumulative scope **at the point that phase is complete**. What is counted is the
stages the controller runs, not whether the code exists. In Phase 0 `observe()` is written, but the one
calling it is a human, so the Phase 0 row is "none".

| Phase | Scope the controller runs (cumulative) | What the human handles | What gets verified |
|---|---|---|---|
| 0 | none | all stages | whether the Goal YAML format can be written, and whether Acceptance Criteria come down to verification commands |
| 1 | OBSERVE / VERIFY | ASSESS / DECIDE / ACT, and starting every stage | whether automating verification holds up in practice |
| 2 | OBSERVE / ASSESS / DECIDE / ACT / VERIFY | writing Goals, approving them | whether the reconcile loop converges |
| 3 | same scope as Phase 2 (the target is this repository itself) | writing Goals, approving them | MVP complete |

### How Phase 0 works

Not one line of controller implementation is needed. The types, stubs, and tests are already prepared as
the starting point of Phase 0.

1. Write `.goals/observe-returns-facts.yaml` by hand
2. Write the Acceptance Criteria as actual Vitest. At this point every test fails
3. Start Claude Code, hand it the whole YAML, and have it implement
4. Run the verification commands. If they fail, feed the results back to Claude Code
5. Once everything passes, mark the Goal complete

The loop of 3–4 is exactly the manual version of ACT → VERIFY → OBSERVE.

The CLI (the `ent` command) implementation lands in Phase 2. In Phase 0 and Phase 1 you invoke `mise run`
directly.

### How Phase 1 works

Run the same procedure as Phase 0 against the Goal `.goals/automate-observe-and-verify.yaml`.
The differences are that the Goal is written using the Goal YAML schema (`src/domain/goal.ts`) that came
out of Phase 0, and that this Goal builds the record of what OBSERVE misses and VERIFY itself.

Once Phase 1 is complete, verification of the Acceptance Criteria is run by `verify()` instead of a human
typing commands. There is still no reconcile loop, so what remains for the human is ASSESS / DECIDE / ACT
and starting every stage.

### Phase 2 splits into 4 Goals

The scope of Phase 2 is ASSESS / DECIDE / ACT, persistence, the CLI, and the implementation of the Ports
that connect to GitHub and the Actor — too large for a single Goal.
A Phase counts the stages the controller runs, but a Goal counts the unit that closes in one
"declare → implement → verify", so the granularities do not line up.

| Order | Goal | Scope | Status |
|---|---|---|---|
| 1 | `.goals/assess-and-decide.yaml` | Derive the Gap from Facts and decide the next action. Pure logic with Port injection | Complete |
| 2 | `.goals/run-actor-in-worktree.yaml` | ACT. Headless execution of Claude Code, worktree isolation | Complete |
| 3 | `.goals/persist-and-resume.yaml` | Persistence. SQLite, write-ahead, lease, state machine, CLI | Complete |
| 4 | `.goals/connect-github-and-claude.yaml` | Implementation of the Ports. `@octokit/rest` (reading GitHub), Claude Agent SDK (Actor and LLM) | Complete |

This order was chosen because what Phase 2 wants to verify is "whether the reconcile loop converges".
To judge convergence, the same input must first produce the same Decision. The first Goal covers up to
that point. ACT and persistence are not needed for judging convergence itself.

The fourth was not originally counted in the scope of Phase 2. As a result of designing for Port
injection, the controller side could be written all the way to the end without any Port, and by the third
Goal it was in a state of "the code is all there but it is not connected to a real environment", so it was
split out. Unimplemented Ports were made to throw when called, and they remained in the state as
`unobserved` / `unverified` and `ESCALATE`. Since they return no fabricated observation, the difference
against the point of connecting could be read.

**With that, Phase 2 is complete.** The controller now runs OBSERVE / ASSESS / DECIDE / ACT / VERIFY
against real GitHub and real Claude Code. However, of the completion conditions in §9, what was believed
confirmed at this point was 4 of the 9 items, and the rest were left to be filled in during Phase 3.
Of those 4, "implementation" did not hold because no real Actor had been started, and it was retaken in
Phase 3.

What finishing the first Goal made clear was that reconcile can be kept pure up to "deciding".
Executing ACT and the write-ahead can sit outside reconcile. Since reconcile runs on Port injection alone,
convergence tests can be written without using real Claude Code or a real DB. reconcile here refers to the
decision core in `src/reconcile/`. Acquiring the lease and the write-ahead (§3.6) belong to the shell
outside it.

What the third made clear was that **you have to decide which layer creates the time**. If the Store calls
`new Date()`, the time axis splits from `tick()`, which runs on an injected `now`. In fact, the elapsed
time was off by several hours and it was judged to be over budget. The Store does not create time; it
receives it as an argument. Only the lease expiry check had been left as an exception on the real clock,
but that too was brought in line to receive it as an argument. Leave one exception and that one alone
cannot be reproduced from tests (in fact, the path that steals an expired lease was exactly that). In real
operation `deps.now()` returns the real clock, so the behavior does not change.

What the fourth made clear was that **the behavior of an external SDK is determined neither by the type
definitions nor by the documentation**. Distinguishing the usage limit (§10-3) was only settled after
reading in the order types → documentation → issues → implementation.
Along with that, the code as written from the documentation alone still carried three errors.
The pattern form of the deny rules, how to choose `permissionMode`, and the fact that "the subscription
limit" and "a transient 429" carry the same value and cannot be told apart. All of them are the kind of
error that does not surface until you actually start an Agent; when adding a Port, go read as far as the
implementation.

### Phase 3 was split into 5 Goals

The scope of Phase 3 is the remaining 5 items of §9, the retaken "implementation", and the constraints for
self-hosting in §7 — as with Phase 2, too large for a single Goal.

| Order | Goal | Scope | Status |
|---|---|---|---|
| 1 | `.goals/record-the-tick.yaml` | Recording one tick. Specifying the observation targets, the raw log and tokens of LlmPort, Verification | Complete |
| 2 | `.goals/open-pr-and-detect-approval.yaml` | Creating the PR and notifying, `ApprovalPort` (§10-4) | Complete |
| 3 | `.goals/sleep-and-stop.yaml` | Reading `resume_after` (§10-5), loop detection (§10-2), measured results for interruption and the usage limit | Complete |
| 4 | `.goals/guard-the-controller.yaml` | The safety device for self-hosting. `protected_paths` (§10-8) and the gate on the controller side (§10-6) | Complete |
| 5 | `.goals/list-goals.yaml` | One loop under self-hosting. **Implemented by the controller** | Complete |

What the first made clear was that **the wiring cannot be considered connected until you actually run it**.
`Store.setObserveTarget()` had no production caller, and not a single `github.*` was being observed.
Tests inject Ports, so they let this kind of broken wiring through.

What the third made clear was the general form of that. Because
`git branch --list --format=%(refname:short)` was being run through a shell, the parentheses were
interpreted, and **worktree creation had been failing ever since Phase 2**. ACT had not started on any
tick. The check that had been put on "implementation" in §9 only held once a real Actor was started.

What the fifth made clear was that **VERIFY was looking at the controller's own repository rather than the
worktree**. The Actor implements inside the worktree, but `mise run test` runs at `repoRoot`. What the
criteria check is "that change", not the code the controller is running on. It surfaced only once worktree
isolation actually took effect.

Along with that, because `publish` was looking at the existence of a PR and stopping the push, the Actor's
commits from the second tick onward were not reaching the remote. This error was pinned as the spec by a
test written in the second Goal, so it was broken even with the tests green.

The fourth piece of broken wiring was found after Phase 3, and one Goal was raised for it as
`.goals/commit-what-the-actor-wrote.yaml`. **The Actor had written the implementation out fully in the
worktree without committing it.** push only sends already-committed diffs, so nothing appears on the
remote, yet VERIFY looks at the worktree's working tree, so all criteria come out passed. From the
controller it looks like "local passes but only the PR is stale", and it stopped at
`WAIT(review_pending)`. The previous three were errors in the controller's implementation, but this one is
not. push, VERIFY, and DECIDE all worked to contract, and the cause is that **no one required the premise
that "the Actor commits"**. **Now that premise itself is not placed.** On a tick where all the
machine-side criteria (`command` type) pass, the controller commits what the Actor wrote. For a tick where
it still was not committed, on the tick that declares "there is nothing left for the machine side to do",
it reads the `local.dirty` that **this tick's observation built by looking at the worktree**, and if it is
dirty at VERIFIED it goes to `ESCALATE(uncommitted_changes)` (§10-11).
A tick where this could not be confirmed is not counted as a violation.

### Self-hosting needs constraints

Since you are letting it rewrite itself, if it runs wild the damage comes back to you.

- Always use worktree isolation. Physically separate the code running the controller itself from the code
  the Agent edits
- Do not let the Agent rewrite the control loop itself. `src/controller/**` and `.goals/**` alone are not
  enough as targets; include the gate itself and the verification system (how they are chosen is in §7)
- Do not hand the credentials the controller holds to the Agent, and invoke external commands as an argv
  array (also §7)

The second is declared as `policies.protected_paths`, and the controller inspects the worktree's changes
outside of ACT. The Agent-side `disallowedTools` is left in place, making it doubled.
One is Agent configuration, the other is a controller judgment, and they break in different ways.

When actually instructed to "add one line of comment to `src/controller/index.ts`", the Agent carried it
out inside the worktree, and the controller detected it and stopped at `WAITING_HUMAN`.
It was confirmed in practice that **the Agent-side configuration alone does not stop it**.

However, the inspection at that point was reading `Run.artifacts` and saw not a single write via Bash.
Now the changes observed by git are the primary source (§10-6).
**Do not place the evidence that "the Agent wrote it" on the Agent's own self-report.**
That git, too, was initially only run inside the worktree. Isolation is nothing more than a matter of
"where to put things", and the boundary of "what can be observed" has to be drawn separately.

---

## 9. MVP completion conditions

Excluding writing and approving Goals, the MVP is complete once the following can be confirmed without
human intervention. The nine items were confirmed across multiple Goals, not in one end-to-end run.
**All nine items have been confirmed. The MVP is complete.**
Of the 4 items checked in Phase 2, "implementation" did not hold, so it was retaken in Phase 3 after
fixing worktree isolation (§8).
If self-hosting passes, it will pass on other GitHub repositories too, but the converse cannot be said.

**The nine items ask only "whether the controller runs to the end".** Not one item covers "whether the
Agent can rewrite the control loop" or "whether approval can be forged". After completion a review was run
once through, and the holes found there were reflected into §7, §10-4, and §10-6.
Since it is run autonomously, confirming convergence and confirming control have to be set up separately.
Whether to add to the completion conditions themselves will be decided when running on other repositories.

- [x] **Registering a Goal** — write a feature addition for this tool itself into `.goals/*.yaml`, pass Zod validation, and it becomes ACTIVE with `ent start`
- [x] **Implementation** — the reconcile loop starts Claude Code on a worktree and implementation happens
- [x] **Verification** — the verification command passes and the Fact is recorded as VERIFIED
- [x] **PR and notification** — a PR is created and progress is written into PR comments
- [x] **Judging completion** — human approval is detected (the signal is §10-4), every criterion's `Verification.result` becomes `passed`, and it transitions to COMPLETED. It is not moved to COMPLETED while `unverified` is non-empty
- [x] **What was missed is visible** — artificially drop a Port, and confirm that targets that could not be observed remain in `unobserved` and that ASSESS does not read that as "no targets"
- [x] **Killable at any time** — send `SIGTERM` while the Actor is running and it exits immediately; invoke `ent run <slug>` again and it recovers the interrupted Task and continues from where it left off
- [x] **Sleeps at the limit and wakes up** — artificially raise a usage limit, and confirm that the process exits with `WAITING_EXTERNAL(usage_limit)` and resumes automatically on the next tick
- [x] **Does not run wild** — artificially create a case where the budget, the reconcile count, or loop detection kicks in, and confirm that it ESCALATEs

### There is a range in how things were confirmed

Even the same "confirmed" differs in how hands-on it was. Separate it out so that whoever reads it later
does not misunderstand.

| Degree | Items |
|---|---|
| Ran the real thing as-is | Registering a Goal, implementation, verification, PR and notification, judging completion |
| Created the condition artificially | What was missed is visible (dropped a Port), does not run wild (kept the same observation) |
| Swapped out one of the Ports | Killable at any time (fixed LlmPort), sleeps at the limit and wakes up (swapped `query()`) |

"Sleeps at the limit and wakes up" reproduces the message the Agent SDK emits at the limit; it did not
actually hit a real usage limit. The store, the controller, the state machine, and the `PortError`
judgment all go through the real thing.

"Judging completion" is counted as the real thing because, in `.goals/open-pr-and-detect-approval.yaml`, a
human wrote `/ent approve ac-6` and it was run through to where the guard chose `COMPLETE` and
transitioned to `COMPLETED`. The measured result below is from a different Goal, and it is stopped waiting
for approval, before approval.

The one who wrote `/ent approve` at that time was the PR's own author. Excluding the author from approval
would make this confirmation impossible to reproduce, so on the comment side the author is fixed as
counting (§10-4).

### Measured result of one full loop end to end

The record from having the controller implement `.goals/list-goals.yaml`.

```
tick 1  ACT   Actor implements in the worktree    1,341,349 tokens
tick 2  ACT   retry                                 462,017 tokens
tick 3  ACT   retry, commits to the worktree        446,598 tokens
tick 4  WAIT(review_pending) → WAITING_HUMAN
```

The controller raised the PR itself, stacked 3 progress comments, and stopped waiting for approval.
All the human did was write the Goal YAML and the Acceptance Criteria, run `ent start`, and then repeat
`ent run`.

The tokens on the first tick stand out because the Actor reads the entire codebase. Most of it is cache
reads, and `Run.tokens` holds the sum of four kinds (input / cache_creation / cache_read / output). The
unit prices differ, so you cannot get an accurate cost figure out of a single total.

---
## 10. Open questions

No open uncertainty blocks the MVP. **Two things have to be decided before running this in other
repositories: §10-8 and §10-9.** The main subject of both was settled in Phase 3, and one adjacent
question is open in each. **A strikethrough means "the main subject of that item is settled", and
(partly) is attached to the ones where part of it is still open.**

- **§10-8 (partly)** — where to put `protected_paths` is settled. What is open is the migration
  policy for when the Goal YAML schema changes.
- **§10-9 (partly)** — running VERIFY in the Goal's dedicated worktree is settled. What is open is
  that the command runs with the controller's privileges.

The two things §10-12 leaves open are not counted among the two above. One is the hole in the
`goal.depends_on` that went in, which matters when a coarse task is split across several Goals and
run. Self-hosting does not use `depends_on` yet. The other is the fingerprint that detects changes
to criteria when the decomposition is done by machine, and that path does not exist at all yet.

The rest do not leave a prerequisite missing for running in other repositories, so they get filled
in in the order real operation requires them.

### 10-1. ~~Goal YAML schema details~~

Settled after one lap of Phase 0. See `src/domain/goal.ts`. The differences from the Phase 0 version
are: `repository` and `setup` were added, `verification` was widened from the single `command` form
to the three forms `command` / `fact` / `human`, and `adapters` / `goal.status` / `goal.source` were
removed. `context.references` allows only `title` / `path` and does not accept URLs.

### 10-2. Initial tuning of the limits

Values such as `max_actor_runs` remain placeholders.

~~There is no N for loop detection~~ — settled in the third pass of Phase 3 by adding
`budget.max_unchanged_reconciles`. The input is `Decision.observed_digest`, not the previous tick's
Gap. Two consecutive ticks were measured to match exactly, so the Gap does not need to be persisted
separately. If this tick's digest differs from the current consecutive run, the count restarts.
Reading "it was the same three times but changed this time" as spinning would stop the Goal right
after it made progress.

The decision order is `budget_exhausted` → `COMPLETE` → `WAIT` → `loop_detected`. The observation
does not change while waiting for human approval either, so it is placed after the no-Gap case.

### 10-3. ~~How the usage limit is detected~~

Settled in the fourth pass of Phase 2. If the `rate_limit_info.status` carried by the Agent SDK's
`rate_limit_event` is `rejected`, that is the limit; it is built from the
`anthropic-ratelimit-unified-status` response header. `resetsAt` is in **seconds** (the
implementation subtracts it against `Date.now()/1000`). The `error: "rate_limit"` on an `assistant`
message is attached both for the limit and for a transient 429, so it is no evidence on its own; the
decision is made by whether a `rejected` was seen just before.

The path after the limit is detected is split between DECIDE and the Actor. The DECIDE Port throws
`PortError("usage_limit")`, and the DECIDE guard returns `WAIT(usage_limit, resumeAfter)`. The Actor
Port stores the same classification into the Run's `errorKind` and `resumeAfter`, and the
controller's guard replaces the original ACT with `WAIT(usage_limit, resumeAfter)`. For Codex, the
JSONL `error` or `turn.failed` takes precedence over the final message, and stdout and stderr are
kept in the raw log.

The Claude Agent SDK's usage-limit determination is not written down in the documentation; the basis
is a reading of the Claude Code implementation. It breaks silently if the SDK changes, so read it
again whenever the Claude-side Port is touched.

### 10-4. ~~Which signal detects human approval~~

Settled in the second pass of Phase 3, with **authorization** added in the MVP review. Who wrote it
was not being checked, so in a public repository a drive-by one-liner turned a `type: human`
criterion VERIFIED. Judging completion in §9 rests on human approval, so if this is open, judging
completion does not hold.

**Authorization is checked with `author_association`.** Both of the two signal paths (below) count
as approval only when it is `OWNER` / `MEMBER` / `COLLABORATOR`. `CONTRIBUTOR` (has a PR merged in
the past) is a different thing from write permission, so it is not included. If the association
cannot be read, fall to the not-approved side. A change request, on the other hand, counts on the
stop side regardless of permission. Being strict about approval and being strict about rejection are
different matters, and the direction to fall is the opposite.

Along with that, **the controller's own progress comments are not read as approval**. The `intent`
the LLM decided goes into `rationale` verbatim, so making it write the fixed phrase there produces
an approval line inside a comment posted with the controller's token. That was the controller
detouring around the path closed by forbidding the Agent `gh pr comment`. Progress comments carry an
HTML-comment marker and are excluded, and the newlines in `rationale` are collapsed as well, to make
it double.

**There are two signals, and either one of them alone counts as approval.** They are a GitHub review
approval (someone else presses Approve — the intended path when this is used at work) and the fixed
phrase `/ent approve <criterion-id>` in a PR comment. What §4.3 says is "you cannot rely on
`review_decision` *alone*"; the path itself is not wrong. That much is the definition of **there
being two** signals, and that has not changed since the second pass of Phase 3 (**whose posts get
counted was changed twice in the MVP review. Below**).

**How the PR author is treated is inverted between the two paths.** The review approval does not
count the author's own Approve (GitHub itself does not allow approving your own PR). **The comment
fixed phrase does count the author.** `GITHUB_TOKEN` is the developer's own token, so the person who
opens the PR is that same person, and excluding the author here would erase the `/ent approve` path
itself. **While developing alone, the only side that fails to hold is the review approval; the
comment fixed phrase holds even for one person.** In your own repository `author_association` is
`OWNER`, so it counts as approval as-is once the write permission has been confirmed.

The author was excluded once in order to close off self-approval, but **what needed closing was the
path "the Agent writes the fixed phrase under the author's name", not the human author.** Closing it
by reducing the set of people who can approve makes the very procedure that goes through "judging
completion" in §9 impossible to reproduce.

**That path is closed on the side that keeps the credentials from reaching it.** A deny list alone
is not enough. The `external_send` that drops comment posting sits in `APPROVAL_GATE_FLOOR` and
cannot be removed by any Goal (§7), but its contents are globs, so it matches neither
`gh api -X POST` (an alternate spelling of `--method POST`) nor an indirect call through `sh -c`.
**A control that enumerates the writable forms becomes a hole the moment one of them is left out.**
On top of that, what `WITHHELD_ENV` drops is only the token environment variables, and `HOME` has to
be passed, so the `gh` inside the Actor was getting through on the credentials of the human running
the controller. Now `NEUTRALIZED_ENV` points `GH_CONFIG_DIR` at a directory that does not exist,
**leaving `gh` unauthenticated in both the Actor and the verification commands**
(`src/domain/withheld-env.ts`. The VERIFY side is closed too because the tests the Actor wrote run
with the controller's privileges. §10-9).
On top of that, the controller's own progress comments are excluded by `PROGRESS_MARKER`, and each
role's prompt states explicitly "do not write the approval fixed phrase".

**Two assumptions remain.** One is that if a means other than `gh` is written (a raw HTTPS request),
it gets through. `Bash(curl *)` is on the deny list, but that too comes back to enumerating the
writable forms. The other is that both the deny list and the prompt are nothing but SDK settings
(§10-6). Not handing over the credentials works outside the SDK too, so that one part is a different
layer.

**The matching rules are set per path.** A review approval is against the PR as a whole, so it
satisfies every `type: human` criterion. If a change request remains as the latest, neither path
approves. The fixed phrase is matched against the whole line. Reading the same string inside a
quotation or a code example as approval would let a forged approval be created.

### 10-5. ~~Who reads `resume_after`~~

Settled in the third pass of Phase 3. `tick` decides at the entrance and returns doing nothing until
the time has passed. It does not take the lease either. Taking it would let a Goal that is merely
sleeping block other workers. A value that cannot be interpreted is read as "may wake". A Goal
stopping forever because of a broken value is worse than waking one tick early.

### 10-6. ~~Who stops `require_human_approval`~~

Settled in the fourth pass of Phase 3, with **the input to the inspection** swapped out in the MVP
review. The controller inspects outside of ACT, and if it finds edits that went outside the worktree
or edits to a protected path, it goes to `ESCALATE(protected_path_touched)`. The Agent-side
`disallowedTools` is kept, to make it double (the reason is in the self-hosting section of §8).

**The input to the inspection is git, not self-report.** Originally the inspection covered only
`Run.artifacts` (the paths Edit / Write / NotebookEdit touched). A Bash `tool_use` has no
`file_path`, so files written with `echo >` or `sed -i` **can never appear in artifacts, by
construction**. It assumed "you can write outside via Bash" while building the inspection on a data
source that could not capture that in principle. Now **the changes git observed**
(`status --porcelain -uall` and `diff --name-only` from the base) are the primary source. Looking at
"what actually got written" rather than a self-report is the only inspection point available while
Bash stays allowed.

**That base is not `default_branch`.** The question the gate wants to answer is "what did the Actor
write", while `repository.default_branch` answers "what is the difference from the release target".
The latter was being borrowed for the former, so even what a human wrote on the calling side's
branch was lined up as an Actor edit. ent runs from the calling side's worktree, something like
`.claude/worktrees/<name>`, and the Goal's declaration (`.goals/<slug>.yaml`) and the spec tests are
written there. If ent's worktree is cut from `main`, that declaration is not on the base side, so it
shows up in `main...HEAD`. `.goals/**` sits in `PROTECTED_PATH_FLOOR` and cannot be removed by any
Goal, so even a tick where the Actor did nothing ended in `protected_path_touched`.

Now the repoRoot HEAD at the moment `ent start` was run is recorded in `GoalState.guardBaseSha`, and
both what the worktree is cut from and what the gate compares against are aligned to it. **What it
was cut from and what it is compared against must be the same.** If they diverge, something absent
from the cut point is read as "the Actor wrote it", or conversely what the Actor wrote disappears
from the diff. The PR base (`publish`) stays `default_branch`.

**It is held as a sha, not a branch name.** With the three-dot notation (`base...HEAD`) the fork
point does not move as long as the base only moves ahead, but rewriting the fork-point commit itself
makes `merge-base` disappear and yields `guard_unavailable`. On a working branch both amend and
rebase are everyday operations, so a single one of them during a run leaves the gate unable to
stand. A Goal with no record (the ones started before this column existed) falls back to
`default_branch`. Re-cutting a running worktree onto a different commit makes the diff up to that
point disappear from the PR.

**It is recorded only when `ent start` is run on a Goal that has no Runs at all.** Making the
condition merely "there is no record yet" would hand the current HEAD as the baseline to a Goal that
was started before this column existed and whose worktree was cut from `default_branch`. If the
record is not shaped like a commit id, it does not fall back to `default_branch` but falls to
`guard_unavailable`. The state DB is already gitignored and does not show up in the observation of
dirt on the main side, so reading it without validating it means a single write of the literal
`HEAD` empties the diff permanently.

**Outside the worktree is seen with git too.** Running git inside the worktree cannot observe the
main-side working tree that `git worktree add` split off. `Run.artifacts` does not pick up Bash
either, so `bash -c 'echo > ../../../../src/controller/index.ts'` appeared in neither input. The
very file the isolation was supposed to protect was leaking out of the isolation's inspection.
`status --porcelain -uall` is run on the main repository side as well, returning absolute paths and
falling to `escaped_worktree`.

On the main side, only the difference between before and after ACT counts as a violation. Under
self-hosting the files a human is editing are dirty from the start, so making those violations would
set the gate off every tick. The comparison is done on **the fingerprint of the contents**, not on
the set of paths. Comparing by path name alone means that when the Actor overwrites a file a human
is editing, the same path lines up before and after and the difference vanishes. The Actor can read
which files are dirty with `git -C ../../../.. status`, so if the comparison were by path name
alone, the Actor could pick where to overwrite so as not to be detected.

**For the committed diff, if the base cannot be resolved, it throws rather than swallowing it.** It
used to be folded into "no changes" with `catch {}`, but the Actor could run
`git update-ref -d refs/heads/main`. Commit the violation and then delete the base ref: there are no
uncommitted changes, the diff goes fatal, and the inspection returns empty. `origin/main` survives,
so only the push goes through, and the violation flowed into the PR as an ordinary change. If the
local base is missing it falls back to `origin/<base>`, and if neither can be resolved it falls to
`guard_unavailable`.

Along with that, Bash calls that manipulate refs (`git update-ref` / `git symbolic-ref` /
`git branch -d|-D|--delete` / `git worktree`) are always denied regardless of the Goal's settings.
The Actor does not get to choose the input to the inspection itself. `git worktree` is denied
together with the read-only `list`. Enumerating subcommands becomes a hole the moment one writable
form is left out.

**The index's hiding bits are closed on the observing side, not with the deny list.**
`git status --porcelain -uall` honors `assume-unchanged` and `skip-worktree`, so running
`git -C ../../../.. update-index --assume-unchanged src/controller/index.ts` once from inside the
worktree and then rewriting the file on the main side leaves both `git status` and `git diff` empty,
and **it passes with zero violations**. `tsc` then reads from the filesystem rather than the index,
so the modified controller runs as is. (c) and (e) below keep "it reaches a human once" as their
guarantee; this route never rings at all.

So `changedPaths` and `repoDirtyState` read `git ls-files -v` and **add the paths whose hiding bits
are set into the observation without looking at their contents** (`indexHiddenPaths`,
src/adapters/local.ts). What is treated as a violation is not "it was edited" but "it was taken out
of the observation". On the main side the value is **a marker rather than the contents'
fingerprint**. With a fingerprint, every time a human edits a file they keep `assume-unchanged` on
(the verb's actual purpose) the value moves across ACT, and (d)'s false positive becomes the steady
state. With a marker, the only thing that shows up as a difference is a bit being set or cleared
inside the ACT window. In exchange, **writes to a file that was already hidden are invisible.**

The same verbs (`git update-index` / `git rm --cached` / `git stash` / `git push` /
`git credential`) were added to the deny list too, but **that side is an enumeration and does not
close.** Pulling the rule parsing and matching out of the Claude Code 2.1.197 binary and running
them showed that `Bash(git push *)` becomes a regex equivalent to `^git push( .*)?$`, which does not
match `git -C .. push origin HEAD:main`. Writing the `git * <verb>*` spelling alongside it picks up
the `-C` and `--git-dir=` prefixes, but prefixing an environment variable
(`GIT_DIR=... git push`) makes it not start with `git` and drops out of both spellings.
**The deny list is only one side of the doubling** (the self-hosting section of §8).

The violation kind (`escaped_worktree` / `protected_path`) and the ESCALATE reason are different
layers; whichever the kind is, the reason is `protected_path_touched`. If the inspection could not
run, `ESCALATE(guard_unavailable)`. Do not mix "did not touch" with "could not confirm" (§3.1).
Moving ahead while the gate is not working is the same as having no gate.

**The inspection runs every tick.** The violating edits are left in the worktree (so a human can
judge), so if only that tick's Run is examined, the moment the next tick finishes without touching a
protected path the dirty worktree gets pushed along with everything else. A violation is treated not
as an event in one tick but as a state that lasts as long as the worktree is dirty.

**What is examined is the working tree the Actor ran in on that tick** (the Run's `role`. §4.2)
**plus, always, the implement role's working tree**. On a tick where no Actor was started (anything
other than `ACT`, and dry-run) it is the implement role only. The implement role is always mixed in
**because what gets pushed is the implement role's working tree** (§10-11). Back when only the tree
of the role that ran was inspected, on a tick where the review role ran, "the tree that was
inspected" and "the tree that gets pushed" were different. A role with its own tree (currently
`investigate`) has no editing tools but does have Bash, so the path of writing with
`git -C <the implement role's tree>` and committing is not closed. That commit appears neither in
that role's `changedPaths` nor in the main-repository-side observation (where the worktree storage
location is excluded), and gets pushed. **The invariant to protect is "the tree that gets pushed is
always included in the trees that were inspected"**, and to get there the inspection side was
widened rather than making the push side follow the Run. `review` looks at the same tree as the
implement role (§4.2), so the trees to inspect collapse into one. The reverse — looking at the
`investigate` tree on an implement-role tick — is not done. There is no reason for the
implementation to stop over a diff the other one left behind. Violations stay in the worktree, so
they are re-detected every tick in either tree.

Matching is done after resolving symbolic links to their real targets, and is case-insensitive.
Neither macOS nor Windows distinguishes path case by default, so writing `src/Controller/index.ts`
reaches the same file while not matching the glob — that is a way out.

**Relative paths from the main-repository side, however, are not resolved.** Of the things that
arrive with `origin: "repo_root"`, the absolute ones are real paths from `repoDirtyState`; the rest
are display keys the controller and the Adapters assemble themselves (`.goals/.state/goals.db`,
`.git/hooks/**`, and `.git/config#core.hooksPath`, which is not even a file). These were being
resolved against the worktree root and taken through to their real targets, so **the result of that
resolution depended on a filesystem the Agent holds.** Plant one
`.goals/.state/goals.db -> ../../package.json` inside the worktree and the key resolves to
`package.json`, stops matching `.goals/**`, and rewriting the state DB directly produces no
violation. Set `guard_base_sha` to the worktree's HEAD and the diff is empty on every subsequent
tick — the gate is blinded permanently. Planting the symlink is itself invisible, hidden behind both
gitignore and `isRuntimeState`. A display key is a string the controller made and never needed the
filesystem for, so it is matched against the globs as a string, unresolved
(`tests/protected-paths-symlink-bypass.test.ts`). **This hole shipped because the existing test
rooted itself at a directory that does not exist, so `realpathSync` always threw.** Tests for the
gate touch the filesystem for real.

**A tick the gate stopped does neither the push nor the PR creation.** The moment a worktree
containing a violation reaches the remote, there is room for it to flow through as an ordinary
change. On top of that, **if a PR already exists, a comment is written even when the observation is
the same as the previous tick's.** The observation digest (`Decision.observed_digest` — a different
thing from the state DB's logical digest that comes up later in this section) is built from Facts
only, so it does not include Decisions. On a tick where the Actor wrote only outside the worktree,
not one character of the observation changes, so silently skipping it reaches `WAITING_HUMAN`
without the broken isolation ever showing up in the PR. On a tick that violated while there is still
no PR, no PR is created, so no notification is left either. What reaches the human in that case is
only `ent get` and the Decision history.

**For the state DB alone, rows are examined rather than the file.** `.goals/.state/goals.db` is a
protected target the gate watches and at the same time **a place the controller itself writes to**.
During the ACT window — between taking the baseline and running the inspection — the controller
always writes to this DB. That is the Run's write-ahead (`startRun`) and its finalization
(`finishRun`), plus the lease extension.

This too used to be watched by `outOfSightState` as **the file's byte string**. SQLite uses WAL, so
those writes normally land only in `goals.db-wal` and not one byte of `goals.db` moves. It moves
**when a commit pushes the WAL past the default threshold (1000 pages), an automatic checkpoint
runs, and the WAL contents are folded into `goals.db`**. Even with the tick's shape unchanged, the
fingerprint changed exactly on the runs where the amount that process had written so far crossed the
threshold, and it ended in `ESCALATE(protected_path_touched)`. The gate went off although neither a
human nor the Actor had touched anything, and the implement role's work stayed in the worktree
without being published.

**Whether it is protected is unchanged.** `.goals/.state/**` stays in `PROTECTED_PATH_FLOOR`. Remove
it and the gate would not go off even if the DB were rewritten directly to forge state. What changed
is how the observation is built: a deterministic hash is made **from the contents of the rows
belonging to that Goal, not from the byte string** (`Store.guardDigest`. The implementation is
`guardDigestOf` in `src/store/sqlite.ts`). The value does not move for a checkpoint, for a VACUUM,
or for a page relocation.

**It closes per Goal.** What is examined is only the rows of the Goal that tick is running. However
many rows another Goal adds, the value does not move, so a second ent running a different Goal in
the same directory does not set this gate off. The rows having a `goal_id` was already the case from
the start (`facts` and `unresolved` are reachable via `snapshots`), and the §4.5 schema is unchanged.
**What separating the rows alone could not solve is that there is only one WAL per DB file**, and
only paired with the logical digest does it become an observation that closes per Goal.

**The `status` of the Goals listed in `depends_on` is put into the projection too.** The dependency
gate (`dependencyGate`) reads it directly to decide whether to proceed, and moreover that call is
before the lease is taken — outside any tick's ACT window. Without it, running a single
`UPDATE goals SET status='COMPLETED'` against the dependency would open the gate with no difference
appearing in either Goal's digest. Only `status` is examined. `reconciles`, the lease, and
`pr_number` move under a second ent running the dependency or under a human's `ent start`, so
putting them in would leave the gate ringing constantly. For `status`, the condition to pass the
gate is `COMPLETED` (terminal), and a terminal Goal is run by no one, so it does not move.

**Only what the controller itself writes during the ACT window is taken out of the projection.** Two
things are taken out: the lease columns of `goals` (extended continuously through the tick), and the
row of the Run the controller created on that tick. What is dropped is **only the Run that was
handed over**, not the whole table. If someone slips a Run in during the ACT window, the gate goes
off.

**For the dropped Run's row, a separate gate takes charge of the immutable columns alone**
(`ownRunDrift`, `src/controller/index.ts`). What the controller rewrites during the ACT window is
only the nine columns of `finishRun` (`status` / `finished_at` / `exit_code` / `log_ref` / `tokens` /
`artifacts` / `detail` / `error_kind` / `actor_resume_after`); `intent` / `actor` / `role` /
`worktree` / `attempt` / `started_at` are written once by `startRun` and never move. Dropping the
whole row puts those immutable columns outside the observation too. **With `role` outside in
particular, the implement role could approve its own review.** Running
`UPDATE runs SET role='review' WHERE goal_id=? AND status='starting'` inside the implement role's
ACT window (without even needing to know the Run's id) makes `latestReviewRun` pick that Run on the
next tick as "the most recent review-role Run". `log_ref` is written correctly by the controller, so
no forgery of the raw log is needed either: the final message the implement role wrote itself
becomes the `review.verdict` and `review.reviewed_sha` Facts, and `judgeReviewVerdict` marks the
criterion passed. So after ACT, the tuple handed to `startRun` is checked against the DB row. The
row having disappeared from `listRuns` (a rewrite of `goal_id`) counts as tampering too, and if a
value is not on the schema and cannot be read, it falls to `guard_unavailable`. **But the gate goes
off only on the tick that did the rewrite, and the rewritten row stays in the DB.** On the next tick
that Run drops out of `ownRuns` and comes inside the projection, so the gate stops going off, and
unless a human cleans up, the `role='review'` row stays as it is ((h)).

The schema (`sqlite_master`) is examined too.
Planting a single trigger attaches a side effect to every later write without changing a single row.
**The file's existence and inode are examined too.** A connection left open keeps reading an
unlinked file, so watching rows alone notices neither that the file was deleted nor that a different
file was put at the same path. Existence alone lets the latter through, so the inode is examined
together with it.

**What was given up by discarding the byte string is written in (h). In exchange, (g) closed.** The
logical digest reads through SQLite, so rows that are still only in the WAL are visible too.

**Eight remaining holes are recorded here** (the letters do not move. (g) is closed, but if the
names of the other holes shifted, past reviews would point somewhere else, so it is left with a
strikethrough rather than deleted).

(a) Outside repoRoot (`~/.zshrc`, `~/.claude/**`) cannot be observed with git, so it is invisible.

(b) There are two families of things that do not show up in git's observation: gitignored paths
(`.goals/.state/**`), and things `git status` cannot produce in principle regardless of gitignore
(`.git/hooks/**`, and the `core.hooksPath` setting value, which is not a path in the first place).
The former shows up if `--ignored` is added, but the controller itself writes there every tick, so
its own writes would be lined up as violations every time. **In both families, the three that lead
to execution are compared before and after ACT** (SEC2 / SEC3 of the MVP review). `.git/hooks/**`
and `core.hooksPath` are fingerprinted by name by `outOfSightState`, and `.goals/.state/goals.db` is
watched by the controller through the `Store.guardDigest` logical digest. **On top of that, the raw
log of a completed review-role Run (`.goals/.state/runs/<id>/log.jsonl`) is carried in that same
digest.** The row was protected while what the row pointed at was watched by nobody. The implement
role can overwrite it from outside the worktree, and the body `reviewRunLog` reads becomes the
VERIFIED Facts `review.verdict` and `review.reviewed_sha` as is. Commit yourself to pin HEAD, write
`verdict: approved` into the previous review's log, and the criterion goes green on the next tick;
`reviewedHeadOf` then blocks re-reviewing the same commit, so **no real review ever runs again**
(`tests/state-db-review-log-digest.test.ts`). What is carried is only the rows that actually feed a
Fact; when what is read grows, this grows with it. The remaining hole is gitignored paths other than
these two; rewrites there are not detected.

(c) A violation on the main side stops setting the gate off if the same file is **left as it is**
until the next tick, because its contents then enter the baseline. Since the comparison is by
fingerprint, rewriting the same file once more sets it off again. It stops going off only in the
case of "a single modification left alone". Even so, if a stopped Goal keeps being run without a
human cleaning it up, the modified controller source stays on disk.

(d) If a human edits repoRoot during ACT, it lands in the diff and stops as
`protected_path_touched`. That is the safe side, but it is a false positive.

(e) The main side sees only uncommitted dirt. The worktree side follows the committed diff as well,
but the controller does not move the main-side branch, so it is kept to `status` alone.
`git -C ../../../.. commit` is not on the deny list, so if something is written on the main side and
then committed, it disappears from the set of dirty files and goes outside the inspection.
`git stash` was put on the deny list, but that side is an enumeration and a different spelling drops
out of it (the same `-C` story as above).

(f) What is visible for tampering with the state DB is only the rows of the Goal that tick is
running and the `status` of the Goals listed in `depends_on`. If rows of any other Goal are
rewritten, this tick does not notice. There is room for that other tick to notice inside its own
window, but what happens outside the window is seen by no one. This is the price of making the
observation close per Goal, and it is the flip side of being able to run a different Goal in the
same directory.

**The dependency gate is the sole exception that reads another Goal's rows.**
`dependencyGate` reads the dependency's `status` directly, and moreover that call is before the
lease is taken — outside any tick's ACT window. Since it was put into the projection, **a rewrite
inside some tick's ACT window sets the gate off**. If it is rewritten outside the window, the same
value enters this side's baseline and its inspection alike, so again no one sees it. Putting what is
read into the projection and being unable to see outside the window are different matters.

**False positives were not increased.** A dependency that passes the gate is limited to `COMPLETED`
(terminal), a terminal Goal is not run by `tick`, and both `ent start` and `ent abandon` refuse on
the grounds that it is terminal (`src/cli.ts`). No one can move the `status` that is in the
projection through a legitimate path, so even with a second ent running the dependency the gate does
not ring constantly. Putting the lease or `reconciles` in would set it off, so only `status` is put
in.

(g) ~~For tampering with the state DB, only `goals.db` is fingerprinted, and `goals.db-wal` is not
watched~~ (closed). The logical digest reads through SQLite, so rows that are still only in the WAL
are visible too. Back when it was watched as a byte string, a row rewritten through SQLite did not
appear in `goals.db` until the next checkpoint and sometimes did not show up in that tick's
difference.

(h) For the state DB, tampering of the form "the byte string differs but this Goal's logical rows
are the same" gets through. Two things are taken out of the projection: the lease columns of `goals`,
and the row of the Run the controller created on that tick.

The former lets the lease be stolen (= a tick can be dropped), but it is not a forgery of state.

For the latter, **only the mutable columns** remain. The nine columns `finishRun` writes — `status` /
`finished_at` / `exit_code` / `log_ref` / `tokens` / `artifacts` / `detail` / `error_kind` /
`actor_resume_after` — can be rewritten, so the budget count (`max_actor_runs` /
`max_consecutive_failures` in §7) can be cheated by one entry. **The immutable columns (`intent` /
`actor` / `role` / `worktree` / `attempt` / `started_at`) are checked against by `ownRunDrift`, so
the gate goes off on that tick.** This used to drop the whole row, and merely rewriting `role` to
`review` let the implement role approve its own review (the body above). The reach was not limited
to "one entry of budget".

**But the gate goes off only on the tick that did the rewrite, so a hole of the same shape as (c)
remains.** That tick falls to `WAITING_HUMAN` via `ESCALATE(protected_path_touched)`, but the
rewritten row stays in the DB. On the next tick that row drops out of `ownRunIds` and comes inside
the projection, so no difference appears before and after and the gate stops going off. If a stopped
Goal keeps being run without a human cleaning it up, the `role='review'` row stays as it is and the
next tick's `latestReviewRun` picks it. **What the gate guarantees goes as far as "it reaches a
human once"; it does not undo the tampering.** ("the gate goes off only on the tick that did the
rewrite" in `tests/controller-state-db-writes.test.ts` pins these two laps.)

On the file side, **existence and the inode are watched, so deletion (`rmSync`) and replacement
(unlink and put a different file at the same path) do set the gate off**. What remains is corruption
that does not change what is visible through a connection left open.

(i) The Actor can write a neutralized git setting back by naming it on the command line. The
`GIT_CONFIG_COUNT` trio is read before `-c`, so
`git -c credential.helper=osxkeychain ls-remote <private repo>` goes through, as measured (the
credentials section of §7). `GIT_SSH_COMMAND` can likewise be put back with `-c core.sshCommand=ssh`,
and there is the inline form `GIT_CONFIG_COUNT=0 git ...` too. **A deny list that enumerates
spellings cannot close this** — the command can be made not to start with `git`, and the helper's
name is readable straight out of the system gitconfig. What was closed is the route that arrives
silently from the surrounding environment; the form where the Actor deliberately writes it back
remains. Going further than that means running the Actor as a different user or in a sandbox that
cannot read the keychain credentials at all.

(c) and (d) are trade-offs facing opposite ways, and solving both at once requires either persisting
the detection or tying edits to the Actor process. In the MVP both are left in.
### 10-7. When to add Notion / Slack

Add them once a real environment exists.

### 10-8. ~~How to put path conditions on `require_human_approval`~~ (partly)

Settled in the fourth Goal of Phase 3.
It does not go into the enum; `policies.protected_paths` (an array of globs) is held separately.
The six enum values are "kinds of operation" and a path is a "target", so the axes differ. Mixing
them into a single enum fills the controller-side matching with branches.

**The migration policy for Goal YAML schema changes remains open.** Phase 3 changed it twice
(`budget.max_unchanged_reconciles` and `policies.protected_paths`), and both times the existing
8 to 9 YAML files were rewritten by hand. `version: 1` is still pinned as a literal, and the same
approach cannot continue once Goals multiply.

**The same problem exists on the values in the declaration.** When `protected_paths` was widened in
review, what got rewritten was only the two that actually run in self-hosting, and the nine
completed ones were left at `[]`. Even with `[]`, `PROTECTED_PATH_FLOOR` (§7) still applies, so
there is no Goal whose gate is off wholesale. What remains open is **where to put the part that is
wider than the floor**. Touching Goals that will not be re-run only adds diffs, but "which Goal is
protected how far" cannot be known without reading the YAML one file at a time. Where to put the
default has not been decided yet.

### 10-9. ~~Where to run VERIFY~~ (partly)

The fifth Goal of Phase 3 changed it from `repoRoot` to a Goal-dedicated worktree, but the rule has
become an implicit "if there is a worktree, use that one". Whether it should be specifiable from the
Goal YAML has not been decided. The asymmetry that the first tick has no worktree and therefore
looks at `repoRoot` also remains.

**Even as roles increase, what it looks at is pinned to the implement role's working tree** (§4.2).
`verifyRoot` does not write the location rule inline but goes through
`worktreeNameFor(goal.id, 'implement')`. If it were written in two places, nobody would notice when
the rule changed and verification alone kept looking at a different working tree. Verifying criteria
in the `investigate` working tree means reading the result of a working tree that contains not one
implementation as the verification result of the implementation.

**The larger open question is that the verification commands are executed with the controller's
privileges.** Running `mise run test` in a worktree also means that the worktree's `mise.toml`
decides what gets executed. The verification files were put into `protected_paths` (§7) so the Agent
cannot rewrite them, but that is a control that "detects a rewrite and stops", not isolation of the
execution itself. The proper answer is to run in a sandbox with the network cut off and no tokens
injected, and that is not in the scope of the MVP.

### 10-10. How to derive an amount of money from tokens

What is recorded is only the totals of four kinds, so an accurate amount cannot be derived (see the
measured results in §9). The breakdown is in the raw log, so producing §7's "what it would have cost
under usage-based pricing" requires an interface to read from there.

### 10-11. ~~Who verifies the premise that "the Actor commits"~~

Settled.
**That premise itself is no longer placed at all.** On a tick where the machine-side criteria pass,
**the controller commits** (see "The premise was dropped" below). The discussion of who verifies
stays below that. It still works today as the catcher for when nothing was committed.
**The order is: the protected-path gate → the controller's commit → (only when nothing was
committed) the uncommitted-work gate.**

The controller verifies outside ACT, and **once it verifies that uncommitted changes remain**, it
goes to `ESCALATE(uncommitted_changes)`. A tick where it could not verify is not treated as a
violation (see "the material" below. The direction it falls is the opposite of §10-6's
`guard_unavailable`. There the gate itself did not run, so it falls to the side of stopping; here,
on a tick where the material is missing the criteria are not complete either, so it never reaches
the `COMPLETE` that would have to be stopped).

**The path actually walked was the following.** push sends only committed diffs
(`git push -u origin HEAD:<branch>`), yet VERIFY looks at the worktree's **working tree**. If the
Actor writes the implementation and does not commit it, the local criteria all come out passed while
nothing appears on the remote. From the controller it looks like "local passes but only the PR is
stale", so it chose `WAIT(review_pending)` and stopped at `WAITING_HUMAN`. What the human is waiting
for is a PR that carries the implementation, so this wait never ends.

**The way it breaks differs from the disconnections so far.** push, VERIFY, and DECIDE all behaved
per contract, and nobody acted wrongly. What was missing is that nowhere required the premise that
"the Actor commits", and the shape was to proceed by treating the premise as satisfied without
verifying that it was. The configuration §3.1 wanted to avoid for Facts happened on the premise side
instead of on Facts.

**The gate goes only on ticks that are known not to resolve leftover writes.** That shape comes to
three: `COMPLETE`, `WAIT`, and `VERIFY`. The first two are ticks that declare "nothing is left for
the machine side to do"; the former is terminal and cannot be undone afterwards (§4.4), and the
latter means the machine side does nothing until the next tick. `VERIFY` only runs the criteria
commands and writes not one line into the worktree, so even if work remains, **the remaining work
does not resolve leftover writes**. The judgement is `leavesWorkUncommitted`
(`src/domain/guard-rules.ts`). On any of these ticks, no uncommitted changes may remain in the
worktree. The only one not swapped is `WAIT(usage_limit)`, which merely deferred the judgement
itself, so waiting has a continuation (§10-5).

**The material reads the `local.dirty` that was already there.** No observation was added. Like
VERIFY it looks at the Goal-dedicated worktree (`verifyRoot` in §10-9), and it remained every tick
as a VERIFIED Fact. **Nobody was reading it.** Calling a human with a fabricated violation makes the
gate itself untrusted (§3.1), so **it looks at when and where the value was observed.**

*When* — it reads only the Facts that this tick's OBSERVE produced. reconcile takes the previous
tick's Facts as the base and overwrites them with this tick's observations, so on a tick where
`LocalRepoPort` failed, the previous tick's `local.dirty` stays VERIFIED (the only thing that goes
stale and drops is `github.ci.*`). Reading that as the current observation turns "could not verify"
into "dirty". That tick proceeds as `WAIT(observation_failed)`.

*Where* — it looks only when `local.branch`, produced by the same observation, matches the
worktree's branch (`worktreeBranchFor`). **Because roles have increased (§4.2), it is stated
explicitly that the counterpart to match against is the branch of
`worktreeNameFor(goal.id, 'implement')`.** Observing `local.*` and running the criteria commands
both happen in the implement role's working tree (§10-9), and that is also the branch that gets
pushed. Pointing this at the `investigate` side means looking at a working tree that contains not
one implementation, and leftover writes by the implement role are missed. The worktree path shown to
the human is aligned to the same role. "If there is at least one Run, then a worktree is being
observed" is not a proxy. `act` writes Run(starting) before `worktree.ensure`, so a single Run that
failed without being able to create the worktree leaves `verifyRoot` pointing at the controller's
own repository, and human edits get read as the Actor's leftover writes.

**Two false detections in the opposite direction are avoided.** A dirty working tree in the middle
of implementation is normal, so ticks with a remaining Gap proceed. But the reason is **not** "if
there is a Gap it does not go through the gate". A tick with a Gap goes to the LLM, the LLM can
return `WAIT`, and that `WAIT` is stopped here. What does not go through the gate are ticks that
landed on `ACT` / `REPLAN`, all of which are ticks saying "work remains on the machine side". The
other is not looking at all at a Goal whose Actor has never once run. On the first tick there is no
worktree and `local.*` observes the controller's own repository (§10-9), so in self-hosting it is
normal for it to be dirty from human edits.

Like the protected-path gate (§10-6), the judgement treats this not as an event of one tick but as a
state that continues while the worktree is dirty. The leftover write happened on a previous tick, so
it looks at the history of Runs rather than this Run.

**Deliver the stop to the human.** As with the protected-path gate, if a PR already exists it writes
a comment even when the observation is the same as the previous tick. While it is stopped the
observation does not change by a single character, so writing only the first time leaves the PR
silent from the second tick on until it hits `max_reconciles` and goes to `BLOCKED`. The `rationale`
carries not only the reason for stopping but **how to make progress** (the worktree path, and
whether to commit or to revert). **This gate swaps the decision before publish**, so `ent get`'s
`decision.rationale` and the PR progress comment emit the same string. This is the only explanation
that reaches the human. Only the `policies.publish` gate (§7), which swaps after publish, falls
outside this convention and writes what goes to the PR separately.
What stops even push is two things, the protected-path gate and `policies.publish.push_branch` (§7);
this one (the uncommitted-work gate) does not stop it. What has been committed may go to the remote.

**To make that "may go" actually happen, the push opportunity was taken out of the Actor's
execution.** The resolution procedure for this gate is a human committing (now that the controller
commits, landing here is limited to ticks where the commit did not go through), and **that commit
has no Run attached.** `publish` had "do not push on a tick with no completed Run" as its condition,
so the diff the human cleaned up stayed off the remote. After a PR is up, DECIDE keeps choosing
`WAIT(review_pending)` and no next ACT comes either, so it freezes in a state where everything is
green locally while only the spec tests are on the remote and CI is red
(`use-ent-in-any-repository` / PR #34 actually stopped this way). Now it pushes regardless of
whether a Run exists and of its result. What it sends is still only committed diffs, so a failed
Actor's work-in-progress does not ride along. The tree it pushes is pinned to
`worktreeNameFor(goal.id, 'implement')`, not `run.worktree`. On a tick with no Run, `run.worktree`
cannot be read; and if the tree to push is made to follow the Run side, nobody would notice when the
push target drifted from the tree this gate and VERIFY look at.

**Including commit in `intent` is no substitute.** As a direction for narrowing the cause it is
correct, but intent is generated by the LLM, so while it can be verified that it was "written", it
cannot be verified that it was "followed" (§3.2). A tick that did not follow it still falls silently
to `WAIT`. What reduces to verification is only detection on the controller side.

**This was confirmed by measurement.** Reading and comparing three of the Actor's raw logs: the same
model (`claude-opus-5[1m]`), the same `permissionMode`, all of them `subtype: success` with no
truncation, and yet **both ticks that committed and ticks that did not appeared.** The side that
committed had even investigated how existing commit messages are written with
`git log -3 --format='%s%n%n%b---'` before committing, going that far without anyone telling it to.
The side that did not says nothing about commit. One of those had **"push the fix" spelled out in
its intent**. The prompt side does not ask for a commit either; the role-common tail
(`COMMON_TAIL`) says "the controller does everything, push included". In other words, the ones that
committed did so not because they were instructed to but because the Actor judged so, and being a
judgement, it varies per run. **It was never once guaranteed as a mechanism.**

**The premise was dropped.** On a tick where the machine-side criteria pass, the controller commits
what the Actor wrote (`WorktreePort.commit`). The judgement is the pure logic of
`machineCriteriaSatisfied` (`src/domain/guard-rules.ts`), placed after passing the protected-path
gate and before publish. On a tick the gate stopped, it does not commit. Putting a violating change
into the history creates room for it to flow later as an ordinary change (the same reason §10-6
stops push).

**It looks only at `command` type criteria.** The `fact` type includes things like
`github.ci.conclusion` that are only decided once pushed, and making that a premise for committing
closes into "no CI without a commit, and no commit unless CI passes". The `human` type is by
definition not decided here. In substance it becomes "commit once all criteria that can be verified
without pushing have passed". On a Goal with not a single `command` type, it does not commit.
Committing when nothing has been verified on the machine side would push, as committed, something
the Actor merely wrote.

**On a tick that committed, the uncommitted-work gate is not consulted.** `local.dirty` is an observation
from before the commit, so reading it would mean stopping yourself with the dirt you cleaned up
yourself. When nothing was committed (only gitignored files are dirty, or the commit itself failed),
the gate rings as before. **It was not removed; one of its firing conditions simply went away.**

**The remaining hole.** What it detects goes only as far as "not committed"; it does not look at
whether "what was committed is an implementation". If the Actor piles up an empty commit, the gate
does not ring. That part is taken up by CI (`github.ci.conclusion`) and `type: human` criteria.

### 10-12. At what granularity to hold task decomposition

The policy has been decided. **Stand up a Goal for each decomposed unit and declare dependencies
between Goals. No Task layer is cut under a Goal.**

**The side that declares order is in.** Line up ids in `goal.depends_on` (`src/domain/goal.ts`) and
`tick` does not run until all dependencies are COMPLETED. The judgement is the pure logic of
`dependencyGate` (`src/domain/guard-rules.ts`) and, like `resume_after`, it returns at the entrance
**without taking a lease** (the reason is in "Where the dependency judgement goes" below).

**The side where the machine performs the decomposition is in now, but only outside the tick.**
`ent plan` (`src/usecase/plan.ts`) takes the objective as prose, calls the planner once, and writes N
sub-Goal declarations into repoRoot's `.goals/`, ordering them with `depends_on`. A human invokes it,
and it writes nothing but the declaration — no runtime state, no Goal row, not even `DRAFT` — so
`ent start` stays the approval point (§3.2).

**Inside the tick nothing changed.** The controller still follows the order as written and never
splits a coarse task on its own, which is why §1 keeps its proviso on "the controller also decides
task decomposition". Splitting Phase 2 into four and Phase 3 into five was a human judgement (§8).

**It was a choice between two.** (a) sub-Goals + declared dependencies, (b) a Task layer under the
Goal (`Plan / Task` in §4.5).
**The decision was made on the difference in the shape of the artifacts, not on the difference in
cost.** Both touch inside `PROTECTED_PATH_FLOOR`, so **neither can be implemented by ent itself**.
(a) adds the dependency declaration to `goalSchema` (`src/domain/goal.ts`) and puts the rule of not
proceeding until dependencies are complete into the guard. (b) takes the shape where `guardBaseOf`
(`src/domain/guard-rules.ts`) returns a per-Task base. Both `src/domain/goal.ts` and
`src/domain/guard-rules.ts` are inside the floor (the constant is authoritative for the full list;
§7), so like `close-the-review-findings.yaml` (the Goal that closes the findings from "the review
after completion" in §9; it is declared that the implementation is done outside ent), it is work a
human writes outside ent. There is no difference where "only one of them can be self-hosted".

The deciding factor was **how many PRs a human reviews for one coarse task**.
(a) is N, (b) is one. Taking (b) splits everything that is currently aligned —
1 Goal = 1 worktree = 1 PR = 1 lease — into Task units. `GoalState` holds
`leaseOwner` / `prNumber` / `guardBaseSha` on the Goal's row, and both the gates and the push target
ride on that, so it extends to revisiting §5's "one Actor is started per tick, one Decision row per
tick". It is the foundation the gates stand on, so moving it means rebuilding the gates before the
decomposition. (a) breaks not one of these alignments.

**As a consequence of that, `design` (or `plan`) is not added to `ActorRole`.** The artifact of
(a)'s decomposition is the sub-Goal declaration, that is, `.goals/*.yaml`. `.goals/**` is in
`PROTECTED_PATH_FLOOR`, so **the gate rings the moment the Actor writes it**. Adding the role does
not let that role produce the artifact it should produce. The three roles in §4.2 are a division for
"writing or reading something in a worktree", and writing the declaration does not belong there.
Placing only the role declaration first produces the same shape as `review` sitting fully wired but
never started.

If the machine is to do the decomposition, its home is the controller side rather than the Actor
(**hereafter this path is called the planner. It is not an `ActorRole`**). Delegating how to fill a
Gap to the LLM is inside the boundary of §3.5, so the shape is to call `LlmPort` once (the tokens
remain in `LlmCall`) and write the sub-Goal declaration into repoRoot. **It is not written into a
worktree.** If `.goals/*.yaml` appears in the implement role's working tree, every tick becomes
`protected_path_touched` (the same shape §10-6 stepped on once). **Taking that path takes
`.goals/*.yaml` out of §4.6's "edited by a human", and §3.2's "the YAML review is the approval gate"
then applies only to what a human wrote.**

**Here it was decided on the side of letting the planner write, and that half is built.**
What is kept out of the model's hands in `ent plan` is `repository` / `policies` / `budget`. The
repository identity is read from `git remote` (a fabricated owner would surface only as a GitHub 404
on the first tick), and the two gate-bearing blocks are copied from the same values `ent init`'s
template carries, so a machine-written Goal never starts from a looser place than a hand-written one.
The whole set is validated — schema, id collisions with existing declarations, dependencies pointing
nowhere, cycles across the set and what is already declared — **before a single file is written**, so
a rejected set leaves `.goals/` exactly as it was rather than half-written.

**What is still not built is the planner rewriting YAML while the loop is running.** Since the need
to fix the plan arises mid-run, without it `REPLAN` ends up as just "think again". The repoRoot-side
gate counts only the difference before and after ACT (§10-6), so the reading is that what is written
in DECIDE is not a violation, but **that gets verified when the path is built.** `ent plan` does not
test that reading: it runs outside the tick entirely, so no gate is positioned to see it.

**The tokens `ent plan` spends are not held in the DB.** `llm_calls.goal_id` is
`NOT NULL REFERENCES goals(id)`, and at plan time no Goal row exists yet; inventing one would put a
Goal that no YAML declares into `ent list`. They land in the raw log (`runs/plan-<time>/log.jsonl`,
§4.6) and in the command's own output instead, which means **they count against no Goal's budget**.
That is a knowing gap in §7's accounting, bounded only by a human typing the command each time.

The proposal to narrow the writable range to a part of the declaration — putting what a human writes
and what the planner writes on different paths — is **not adopted**. The gate only works on paths
(what `findViolations` matches is the changed paths git observed against globs), so expressing
"`desired_state` may be written but `acceptance_criteria` may not" inside the same file requires a
different kind of gate that takes a semantic diff of the YAML. It is not a defense worth that. That
is because **the completeness of criteria was never absolute to begin with**: as long as §7 decides
not to put `tests/**` into the floor, freezing the criteria strings leaves the "what is actually
verified" side open. The planner has neither a reward signal nor a persistent objective function, so
closing it gains little.

**What is to be protected is not preventing forgery, but that the human can notice that the bar
moved.** Recording a fingerprint of `acceptance_criteria` / `policies` / `budget` just once at
`ent start` (placed the same way as `guardBaseSha`) and, if it changed, dropping to
`AWAITING_CRITERIA_APPROVAL` and returning it to the human is the cheapest shape. That state is the
one §4.4 leaves in the type while writing that "there is no code that writes it", and the catcher is
sitting open just as it is. It does not call the LLM, so it stays deterministic. However, §4.4's
diagram has no edge coming back from ACTIVE, and there is no Action in `nextStatus` that returns
this value either, so one edge would be added.

**It is not being built now.** It goes in once actually running it shows that the scenes where the
planner rewrites criteria on its own are many. There are two reasons. **One is the side that cannot
be thrown away.** If it cannot be noticed that criteria moved, §3.2's approval gate becomes a
formality, and §4.5's Decision history can no longer distinguish "did it converge, or did the bar
drop" (what L5 reads is that history). Structurally it is the same as §10-11's `intent`: **the thing
being verified is generated by the side being verified**. This is about drift, not malice; from
inside the loop, "improve the plan" and "rewrite it into a bar that can be met" cannot be told
apart. **The other is the side that cannot be placed now.** Putting the gate in before the frequency
is known makes the failure on the side of calling a human on every legitimate revision of the plan.

Note that what the fingerprint answers goes only as far as "did the criteria move midway", and
**who approves a sub-Goal newly written by the machine** it cannot answer, because there is nothing
to compare against. For that, the moment `ent start` is typed is the human's approval point, and it
stays as §3.2.

**The dependency judgement was placed at the entrance of `tick`** (the same position as §10-5's
`resume_after`). Making it "do not go ACTIVE" at the entrance of `ent start` would make it
impossible to write declarations in an order where the dependency has not been started yet.
Registering decomposed sub-Goals all at once is exactly that usage. **It does not take a lease.**
The one who decides how many to line up is the caller (README "Running several Goals at once"), so
if one that is waiting on a dependency keeps holding a slot, even the Goals that could proceed would
not get a turn in one cron cycle.

**`activated_at` is set even while waiting on dependencies.** `ent start` goes straight from `DRAFT`
to `ACTIVE` (§4.4). While the dependency gate keeps returning `skipped`, the budget judgement itself
is never reached, so a circular dependency is not stopped even by `max_wall_clock`. On the tick
after the dependency is resolved, the dependency wait is not a Decision `WAIT`, so the waiting time
cannot be subtracted, and `max_wall_clock` is evaluated including the time since `activated_at`.
When registering all at once, write a longer limit on the downstream Goals.

**When a dependency has fallen to a terminal state, it is counted separately from waiting.**
`dependencyGate` returns `pending` (not yet COMPLETED; waiting makes progress) and `unreachable`
(`FAILED` / `ABANDONED`; waiting will not resolve it) separately (this `pending` is a dependency
classification and is a different thing from the `pending` of §3.1's `Unresolved`. That one is the
result of a single observation or verification, this one refers to the ordering between Goals). For
the latter, the next move — redo the dependency side, or rewrite `depends_on` — is written into
`skipped` as well. **A dependency that is not registered goes into `pending`.** It may just be that
`ent start` was forgotten, so absence is not read as "it will never finish" (§3.1).

**Two holes remain in the dependency gate.** One is that the reason for stopping does not remain in
the state. As long as it takes no lease it cannot be written on the spot, so today it appears only
in `ent run`'s `skipped`. Whether to add a reason to §4.4's waiting and keep it there has not been
decided. The other is cycles: writing itself into `depends_on` is rejected by the schema, but a
cycle spanning two or more is not visible from a single Goal YAML, so everyone stops at `pending`.

**The side that reads before running was closed.**
`ent doctor` has a `dependencies` check that, from a position where it can read every declaration,
names cycles and "the dependency's `.goals/<id>.yaml` does not exist" and marks them failed
(`src/usecase/doctor.ts`). A diamond (`alpha → base` and `bravo → base`) is not closed, so it does
not count as a cycle. **Even so, it still does not apply at runtime.** doctor only reads, and
`dependencyGate` returns cycles as `pending` as before. Running `ent run` without hitting doctor
gives a run of ticks that take no lease and write nothing, and it keeps stopping without hitting
either `max_reconciles` or `max_wall_clock`. Stopping it at runtime is a matter of adding one more
kind of `unreachable` to `dependencyGate`, but that is inside `PROTECTED_PATH_FLOOR` and cannot be
written by ent itself. **The part that only needs reading has been taken first.**

The Plan / Task tables were **decided not to be built** (§4.5's table was fixed the same way). In
(a), what corresponds to a Plan is the sub-Goal declaration itself, so there is no reason to build
another layer in the DB.

---

## References

Existing projects referenced during the investigation.

- **L1 neighborhood**: [humanlayer/agentcontrolplane](https://github.com/humanlayer/agentcontrolplane),
  [lidangzzz/goal-driven](https://github.com/lidangzzz/goal-driven),
  [Kubernetes Agent Sandbox](https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox/)
- **L3 (the area not built in-house)**: [Emdash](https://github.com/generalaction/emdash),
  [mission-control](https://github.com/builderz-labs/mission-control)
- **L4 (referenced as parts)**: [LangChain Open SWE](https://github.com/langchain-ai/open-swe),
  [Cloudflare Agents](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/),
  [Amp Event-Driven Orbs](https://ampcode.com/news/event-driven-orbs)
- **L5 (research stage)**: [EvoRoute](https://arxiv.org/pdf/2601.02695)
- **Documentation**: [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)
- **Documentation**: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- **Documentation**: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
