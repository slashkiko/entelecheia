# repository-baseline

A GitHub template repository for a small, review-first supply-chain security
baseline. It is intentionally independent of dotfiles and contains no machine
configuration or credentials.

## Use

Create a repository from this template, then run:

```sh
mise install --locked
mise run check
mise run repository-initialize
```

Enable Renovate as a GitHub App only for repositories that should receive
dependency update pull requests. Do not enable automatic merge.

## Controls

- mise locks the security-tool supply chain and waits seven days before using a
  new release.
- Pinact requires full commit-SHA pinning for GitHub Actions.
- actionlint and zizmor check workflow syntax and security properties.
- Betterleaks scans the full Git history.
- The weekly audit detects an OSPS Baseline version change without writing to
  GitHub or changing configuration.

The weekly workflow uses the third-party `jdx/mise-action`; configure the
repository Actions allow-list to permit `actions/*`, `github/dependency-review-action`,
and `jdx/mise-action` by full commit SHA.

Run `mise run repository-initialize --configure-github` only after reviewing
its dry-run output. For a private repository, GitHub cannot use a pattern-based
Actions allow-list; the initializer requires full SHA pinning instead.

For local use, enable mise's `paranoid = true` in your global mise
configuration. mise intentionally ignores this setting when it appears in a
project configuration file.

## Updating the baseline

Renovate creates update pull requests for tools and pinned Actions. Review one
update category at a time and merge only after the required checks and
CODEOWNERS review pass. When the weekly audit detects an OSPS version change,
review the upstream change, update `baseline-version.toml` and
`docs/security-baseline.md` in the same pull request.
