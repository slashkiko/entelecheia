# Semantic Review output format

Collect everything into one summary body. Put the assessment and the must-fix items at the top, and fold the investigation details into a `<details>` at the end. Do not post it.

## Structure

| Position | Content | Condition |
| --- | --- | --- |
| 1 | Assessment, counts, evaluated points | Always |
| 2 | Must-fix list | Two or more `Mismatch` |
| 3 | Must-fix details | Any `Mismatch` |
| 4 | Needs explanation | Any `Undeclared` |
| 5 | Open questions | Any `Unverifiable` |
| 6 | Investigation details | Always |

Use the GitHub alert that matches the assessment.

| Assessment | alert |
| --- | --- |
| `MISALIGNED` | `[!CAUTION]` |
| `INSUFFICIENT_CONTEXT` | `[!WARNING]` |
| `ALIGNED` | `[!TIP]` |

## Template

````markdown
## Semantic Review

<!-- semantic-review:summary -->

> [!CAUTION]
> **Assessment: MISALIGNED** -- 2 must fix / 1 needs explanation / 1 open question
> Points evaluated: A, B, C, D, G (E, F, H did not fire and were not evaluated)

### Must fix

| ID | Point | Place | Content |
| --- | --- | --- | --- |
| SR-001 | G2 | `{file}` | {symptom in one line} |
| SR-002 | G4 | `{file}` | {symptom in one line} |

#### SR-001 {title}

- Point: G2 (related: {related points, if any})
- Impact: {high / medium / low} / Confidence: {high / medium / low}
- Place: `{file}:{line}`
- Trigger: {the input or state where the problem occurs}
- Expected: {the intended behaviour}
- Actual: {the current behaviour}
- Evidence: {the intent as written, the spec, or existing code. For C-H, give file:line when it is inside the repository, or the URL, document name, version and section for an external primary source}
- Fix: {the smallest fix that works}

### Needs explanation

#### SR-003 {title}

- Point: A2
- Impact: {high / medium / low} / Confidence: {high / medium / low}
- Place: `{file}:{line}`
- Content: {the semantic change that was not declared}
- Evidence: {which of A2's listed conditions it falls under}

### Open questions

These do not assert a defect in the implementation; they ask for the information needed to decide.

#### SR-004 {title}

- Point: {C2, G3, ...}
- Impact: {high / medium / low} / Confidence: {high / medium / low}
- Place: `{file}:{line}`
- Content: {what cannot be decided}
- Evidence: {what could be confirmed outside the diff so far. Same format as must fix}
- Needed: {what would settle it}

<details>

<summary>Investigation details</summary>

#### Review scope

| Item | Content |
| --- | --- |
| Compared | `{base SHA}` ... `{head SHA}` |
| Points evaluated | A, B, C, D, G |
| Points not evaluated | {points and reasons} |
| Confirmed | {callers, paired operations, implementations and conventions compared against} |
| Not confirmed | {information that could not be fetched, consumers outside the repository} |
| Existence searches | {search terms, target directories, exclusions} |

#### Sources consulted

| Source | Result |
| --- | --- |
| PR title and body | fetched |
| Ticket or spec | fetched ({title}) / no link / fetch failed ({reason}) |
| Discussion thread | fetched / no link / fetch failed ({reason}) |
| Design docs and conventions in the repository | {path} / none |
| API and data schemas | {path or metadata} / out of scope / unavailable ({reason}) |
| Existing semantic review | fetched ({URL or ID}) / none |

#### Intent <-> diff mapping

| # | Declared intent | Matching diff | State | Related |
| --- | --- | --- | --- | --- |
| 1 | {intent as written} | `{file}:{line}` | Implemented | -- |
| 2 | {intent as written} | `{file}:{line}` | Partial | SR-001 |
| 3 | {intent as written} | -- | Missing | SR-002 |

#### Diffs not declared

| Diff | Content | Related |
| --- | --- | --- |
| `{file}` | {the semantic change} | SR-003 |

#### Behaviour changes

| Trigger | Target | Before | After | Reaches | Point | Related |
| --- | --- | --- | --- | --- | --- | --- |
| {input or state} | `{file}:{line}` | {before} | {after} | {consumers, data, side effects} | B4 | -- |

</details>

<sub>Semantic Review checks for semantic mismatches between a PR's intent, spec and implementation. Code style, naming and general performance improvements are out of scope.</sub>
````

## When `ALIGNED`

When there is nothing to fix, nothing to explain and nothing to ask, output only the alert and the details.

````markdown
> [!TIP]
> **Assessment: ALIGNED** -- 0 must fix
> Points evaluated: A, B, C, D (E, F, G, H did not fire and were not evaluated)
````

## When `INSUFFICIENT_CONTEXT`

State the missing information in the alert. Omit the mapping table for A and the section for diffs that were not declared, and output the results for B-D and whichever of E-H fired.

````markdown
> [!WARNING]
> **Assessment: INSUFFICIENT_CONTEXT** -- 0 must fix / 0 needs explanation / {N} open questions
> No verifiable intent could be fetched, so point A could not be evaluated
> Intent sources read: PR title and body only / Points evaluated: B, C, D
````

## Output rules

- Do not output empty sections
- With one must-fix item, drop the list table and start from the detail
- Within one label, order by impact, highest first
- Do not split one cause; pick one primary point and note the related ones
- Do not make a finding out of a guess with no evidence
- Use `Unverifiable` only for concrete questions the implementer should answer
- Put a blank line after `<details>` and after `<summary>`
- Keep the wording of the source for intent items; do not summarize in a way that changes the meaning
- Keep `<!-- semantic-review:summary -->` as the identifier of the output. Whether it is used for updates is the caller's decision
- The `SR-001` numbering runs within one review only
- Do not fix a destination-specific way to re-run or reply into the footer; the caller adds it when needed
