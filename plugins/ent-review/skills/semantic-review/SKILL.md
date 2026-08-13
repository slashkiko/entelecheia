---
name: semantic-review
description: Compare a PR's declared intent, spec and implementation, and return a review body reporting missing implementation, scope creep, conflicts with the existing spec, semantically broken implementation, and migration or runtime-guarantee mismatches. Use it when semantic review, intent-alignment review, spec review, or detection of semantic bugs is explicitly requested. Do not post the result; investigate read-only.
---

# Semantic Review

Review what the change means for behaviour, not how the PR's code looks.

This skill goes as far as returning the review body. It does not change code, create branches, or post PR comments. The caller decides where and how to post.

## Assumptions

- The target is a GitHub Pull Request. Open, Draft, and already-merged PRs read for evaluation are all in scope
- Use whatever can read GitHub PR metadata, diffs and comments. Prefer the `gh` CLI when available
- Read linked tickets, design docs and discussion threads with whatever connectors or CLIs are available. Do not stop when they cannot be fetched; record why
- Treat the repository's own `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, design docs, CI and operational rules as primary sources

## Responsibilities

| Item | Content |
| --- | --- |
| Input | The PR title, body and diff; linked tickets and specs; the code around the changes; existing tests; the conventions and design docs in the repository |
| Output | The review body, with the assessment and findings at the top and the scope and mappings folded away at the bottom |
| Assessment | `MISALIGNED` / `INSUFFICIENT_CONTEXT` / `ALIGNED` |

## Points

| Symbol | Name | Compared against | Fires when |
| --- | --- | --- | --- |
| A | Intent alignment | declared intent <-> diff | Always, in principle. Excluded for revert PRs and when `INSUFFICIENT_CONTEXT` applies |
| B | Behaviour change | before <-> after | Always |
| C | Whole-feature semantic coherence | diff <-> the whole feature and the existing spec | Always |
| D | Semantically broken implementation | the code as written <-> the code as intended | Always |
| E | Cross-cutting invariants | diff <-> repository-wide rules for security, ownership and authorization | Diffs touching data access, public APIs, authentication and authorization, tenant boundaries |
| F | Runtime semantics | what the code assumes <-> what the runtime guarantees | Diffs touching transactions, queues, event subscriptions, scheduled jobs, concurrency |
| G | Migration and coexistence window | diff <-> existing data and the release timeline | Diffs touching DB schema, API schema, event formats, search indexes |
| H | Code and environment definitions | code <-> configuration, permissions, routing, deploy definitions | Diffs touching configuration, environment variables, headers, hosts, ports, permissions |

Do not evaluate any of E-H whose firing condition does not hold. B describes what changed; D states that the way it changed is wrong. Do not count the same event as both.

Always read [references/criteria.md](references/criteria.md) for the point definitions and the false-positive rules.

## Out of scope

- Problems that formatters, linters, type checkers, builds and ordinary CI detect directly
- Naming preferences, responsibility splits, general refactoring suggestions
- Performance improvements with no measurement or requirement behind them
- Hypothetical future risks not covered by the current spec
- Existing problems the diff did not introduce

Do not label a borderline call `Mismatch`. Use `Unverifiable` only when the information needed to decide can be named concretely; when it cannot, output nothing.

## Procedure

### Step 1. Collect the target and the sources of intent

Take a PR number or URL. When it is omitted, find the PR for the current branch.

Investigate the following, and record both what was fetched and the reason for anything that was not.

1. PR title, body, base/head SHA, changed files, existing comments
2. Tickets, specs, design docs and discussion threads linked from the PR body
3. Design docs, schema definitions and API definitions added or changed in the PR
4. The repository's `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, related runbooks and CI rules
5. Existing semantic review comments and the implementer's replies

Past semantic review comments do not count as a source of intent. Use them to avoid repeating findings already answered, and to update the assessment against the state after those answers. When an external source cannot be read, do not fill the gap with a guess.

### Step 2. Break the intent into verifiable items

From the sources, list what this PR declares it does, one verification unit per item. Make each acceptance criterion its own item. Items explicitly marked as follow-up work are not treated as missing, but check whether a tracking reference exists.

### Step 3. Map the diff and the intent in both directions

Get the diff with `gh pr diff <PR>` or similar.

- For each intent item, look for the matching diff and mark it `Implemented` / `Partial` / `Missing`
- For each diff, look for the matching intent item, and record semantic changes that tie to none as undeclared diffs
- Generated files, fixtures, snapshots and mechanical follow-through are not undeclared when they follow necessarily from the declared change

### Step 4. Decide which points fire, and read outside the diff

Decide which of E-H fire, and record the points evaluated and the reason for each one not evaluated. Explore the following.

- Definitions, callers and callees of the changed functions, types and constants
- Paired operations such as create and update, register and delete, encode and decode
- Existing implementations that follow the same interface, schema, convention or template
- Every branch and test that handles the changed values or state
- The repository's own rules for authentication and authorization, transactions, delivery guarantees, migration and config rollout

Record the search scope, and leave enough evidence of the search before concluding that something does not exist.

### Step 5. Assess the semantic mismatches

Follow [references/criteria.md](references/criteria.md).

- B: list the observable before / after
- C: follow the feature end to end and look for one-sided changes, conflicts with the existing spec, and state or fan-out that was missed
- D: read the changed lines and check variables, conditions, argument order, units, loop targets, and leftovers from what was copied
- E: check that the authenticated subject, ownership, authorization and data scope hold on every path
- F: compare the code's assumptions against the guarantees for retries, duplicate delivery, multiple instances, concurrent execution and partial failure
- G: check old code x new data, new code x old data, apply order, backfill and rollback
- H: compare the code against each environment's configuration, routing, permissions, allow lists and manifests

When consulting an external system, limit it to the metadata and schemas needed to decide. Do not read business data or personal information.

### Step 6. Assemble the body and return it

Follow [references/output-format.md](references/output-format.md) and return one review body. Do not post it.

- Put the assessment, the counts and the evaluated points at the top
- Give each finding an ID in `SR-001` form, and do not split one cause
- Findings for C-H show evidence from outside the diff. Evidence inside the repository is `file:line`; an external primary source gives the URL, document name, version and section
- Exclude findings already answered, and update the assessment against those answers

## Labels

| Label | Meaning | Expected response |
| --- | --- | --- |
| `Mismatch` | Intent, spec and implementation disagree, and a fix is needed | Fix the implementation or the declaration |
| `Undeclared` | Nothing is semantically broken, but the semantic change is not declared | Add it to the PR description, or split the change out |
| `Unverifiable` | Not decidable for lack of information | Supply the missing premise or intent |

Give each finding an impact (high / medium / low) and a confidence (high / medium / low). Do not label a low-confidence event `Mismatch`. Do not put more than one label on the same event.

## Assessment

Evaluate top to bottom.

1. One or more `Mismatch` gives `MISALIGNED`
2. No `Mismatch`, the only sources of intent being the PR title and body, and no verifiable intent items, gives `INSUFFICIENT_CONTEXT`
3. Anything else gives `ALIGNED`

`Undeclared` and `Unverifiable` alone give `ALIGNED`. Under `INSUFFICIENT_CONTEXT`, do not map point A; evaluate B-D and whichever of E-H fire.

## Constraints

- Run read-only. Do not change code, branches, PRs, tickets or threads
- Do not fill what cannot be read with a guess
- Read only the metadata and schemas the review needs from external systems. Do not fetch or copy business data or personal information
- Do not repeat a finding that has already been answered

## References

- [references/criteria.md](references/criteria.md): the details of points A-H and the false-positive rules
- [references/output-format.md](references/output-format.md): the review body template and the output rules
