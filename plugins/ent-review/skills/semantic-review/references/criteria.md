# Semantic Review point reference

Handle only the semantic mismatches defined here. When the repository's own conventions or design docs are more specific than this document, prefer that primary source.

## A. Intent alignment

### A1. Missing implementation

No change corresponds to a declared implementation item or acceptance criterion.

- Confirm that existing code does not already satisfy it before calling it `Mismatch`
- Exclude items whose follow-up is stated explicitly. When there is no tracking reference and the follow-up cannot be identified, raise the missing tracking information as `Unverifiable`

### A2. Scope creep

Among changes outside the intent, label `Undeclared` those that change any of the public contract, persisted data, an execution path, side effects, user-visible behaviour, or a security boundary.

Do not list generated files, fixtures, test helpers, or mechanical follow-through to a signature change on their own.

### A3. Description contradicts the diff

When an explicit statement such as "behaviour is unchanged" disagrees with the actual semantic change, label it `Mismatch`. Minor discrepancies in file or line counts alone are out of scope.

### A4. Stated acceptance criteria cannot be verified

When a ticket or spec states an acceptance criterion but no test observes it, or the test does not reach the target branch, label it `Mismatch`.

Follow acceptance criterion -> fixture -> execution branch -> observation point -> assertion. General lack of tests is out of scope.

## B. Behaviour change

Record observable changes as before / after. When they match the intent, do not raise them as findings; leave them in the detail table.

### B1. Public contract

- Changes to API fields, numbers, types, requiredness, endpoints, methods, or exported functions
- `Mismatch` when it breaks existing consumers and no migration path exists
- Even when CI checks compatibility, check generated files, consumers, and what CI does not cover

### B2. Data contract

- Type, requiredness or constraint changes in the DB, search index, cache, events, or file formats
- Check for disagreement with similar existing definitions, and for changes that make stored data unreadable
- When schema information is needed, read only definitions and metadata; do not read business data

### B3. Existing callers

Check that semantic changes to return values, arguments, errors, and nil/empty values do not break the assumptions of callers outside the diff. List the references to the changed symbols across the repository.

### B4. Execution paths

Check changes to conditionals, early returns, boundary values, error handling, and ordering.

### B5. Side effects

Check whether external calls, persistence, notifications, shared state, transaction boundaries, or partial-failure handling change. Re-execution safety of new code belongs to F.

### B6. Implicit behaviour

Check changes to defaults, null/empty values, ordering, time and time zone, rounding, and case sensitivity.

## C. Whole-feature semantic coherence

Label `Mismatch` only when evidence from outside the diff can be shown. The evidence format follows the shared rules at the end. When it cannot be traced fully, use `Unverifiable` only when the needed information can be named concretely.

### C1. Producer and consumer disagree

Check whether only one side of a one-way flow changed: producer and consumer, write and read, send and receive, store and derived-data update.

### C2. Conflict with the existing spec

For each changed domain concept, check that it does not contradict the definitions in existing code, specs and design docs. Do not assert a conflict whose counterpart cannot be shown.

### C3. Symmetric operation pairs

Check whether only one side of a paired operation changed: create/update, register/delete, encode/decode, apply/rollback, write/invalidate.

### C4. State transitions

When an enum, state or kind is added or changed, check that the switches, display, search, aggregation, persistence and serialization that handle it follow.

### C5. Fan-out

Treat as fan-out targets only the places belonging to the same interface, schema, spec, template, or an explicit operation pair. Similar names or structure alone are not a finding.

## D. Semantically broken implementation

Handle changes that are correct in syntax and types but mean something other than what was intended.

### D1. Wrong variable or field

Compare similarly named values, values of the same type, the two sides of an assignment, and created-at against updated-at.

### D2. Wrong condition

Read `&&` / `||`, negation, comparison direction, boundary inclusiveness, and early-return conditions out in plain language, and compare them against the intent.

### D3. Argument order and target

For calls with several arguments of the same type, compare the parameter names at the definition against the meaning of the actual arguments.

### D4. Unit, scale and ID kind

Check the meaning of seconds/milliseconds, currency units, 0- or 1-based indexing, time zones, and the various kinds of ID.

### D5. Loop and branch target

Check that the loop variable, the outer variable, nested indexes, and the thing tested against the thing operated on all agree.

### D6. Leftovers from what was copied

Handle only semantic leftovers in audit logs, outward-facing messages, error codes, retry decisions, monitoring conditions and constant values. An odd internal name alone is not a finding.

## E. Cross-cutting invariants

Evaluate when the diff touches data access, public APIs, authentication and authorization, or tenant boundaries.

### E1. Subject, ownership and tenant boundary

- Is the subject or scope taken from the authenticated context rather than from client input
- Is the owner ID in the request checked against the authenticated subject
- Does the scope propagate through DB queries, search, cache keys, events and external side effects
- Check the repository's own positive examples and auth middleware. Do not settle on an auth scheme from general knowledge alone

### E2. Authorization registration and defaults

- Is a new public operation registered correctly in the router, policies, permission definitions and exclusion lists
- Confirm from the implementation whether the default when unregistered is fail-open or fail-closed
- When it cannot be decided whether the public operation is intentional, use `Unverifiable`

## F. Runtime semantics

Evaluate when the diff touches transactions, queues, event subscriptions, scheduled jobs or concurrency. Check the runtime's official guarantees or the wrapper implementation in the repository. Do not guess at guarantees.

### F1. External side effects inside a retried scope

Check that a transaction or callback that may be re-executed contains no non-idempotent external API call, publish, random generation, or append to an outer variable.

### F2. Defence against duplicate delivery

For at-least-once queues and subscribers, check that the duplicate key, state check or idempotent update comes before the side effect.

### F3. Order of side effect and record

Where the design records completion after the side effect, check that a mid-way failure and a retry cannot execute it twice. Compare against the existing approach: outbox, idempotency key, state transition.

### F4. Multiple instances and concurrency

Check whether a scheduled job or worker can run in more than one instance at a time, and which of platform configuration, distributed lock, lease or state guard prevents it.

## G. Migration and coexistence window

Evaluate when the diff touches a DB, API, event or index schema.

### G1. Existing data

For new fields and constraints, check how nulls, defaults and old formats in existing rows are read. Follow the conversions and fallbacks on the reading side too.

### G2. Staged migration

Check that adding, backfilling, switching reads and writes, tightening constraints and dropping the old definition are split into safe stages. Follow-up work needs a tracking reference.

### G3. Apply order

Check that the deploy units and order for schema, application, configuration and jobs are stated, and agree with the actual release procedure. When the order cannot be read, use `Unverifiable`.

### G4. Old and new in coexistence

List and check the combinations: old code x new data, new code x old data, rolling updates, delayed events, and the window while a search index is being rebuilt.

## H. Code and environment definitions

Evaluate when the diff touches configuration, environment variables, headers, hosts, ports or permissions.

### H1. Configuration and each environment

- Do the configuration struct or schema and each environment's config file, Secret and ConfigMap correspond
- Is the decoder strict, and does the default on absence really apply
- Identify the target environments from the repository's own layout and its operational documents

### H2. Routes, allow lists and permissions

Check that new headers, endpoints, origins, service accounts and permissions are followed through into the gateway, CORS, proxy, IAM, network policies and deploy definitions.

## Shared rules for avoiding false positives

- Do not report an existing problem the diff did not introduce as a defect of this PR
- Do not evaluate the contents of generated code; look only at whether the generator and the generated output agree
- On incident, hotfix and emergency PRs, do not fault the normal steps that were explicitly skipped as A2/C5
- On revert PRs, exclude A in principle, and look for what was not reverted and for semantic breakage under C/D
- Follow-up work in a staged PR is not treated as missing when a tracking reference exists
- Do not put more than one label on the same event; pick one primary point
- When there is no verifiable intent and `INSUFFICIENT_CONTEXT` applies, do not evaluate A at all
- Do not label a low-confidence event `Mismatch`
- C-H show evidence from outside the diff. Code and conventions inside the repository are given as `file:line`; an external primary source gives the URL, document name, version and section
- When asserting that nothing else exists, record the search terms, target directories and exclusions in the review scope
