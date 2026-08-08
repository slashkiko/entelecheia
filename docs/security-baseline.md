# Security baseline status

This repository adopts OpenSSF OSPS Baseline `v2026.02.19` as its security
requirements catalogue. A version change requires a review of the upstream
control delta and an update to this document in the same pull request.

| Control area | Implementation |
| --- | --- |
| Dependency provenance | mise lockfile, provenance verification, and seven-day release age |
| GitHub Actions | full commit-SHA pinning, Pinact, zizmor, least-privilege permissions |
| Secret handling | Betterleaks plus GitHub secret scanning and push protection |
| Review | CODEOWNERS and protected main branch |
| Dependency updates | Renovate PRs; no automatic merge |
