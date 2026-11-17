# 🛠️ Development

Use Node.js >=22.19.0 and npm. Run `npm ci`, `npm run build` and `npm run check`. TypeScript runs directly; there is no compiled distribution. Tests use synthetic credentials and mock transports. Windows ACL tests create ignored local fixtures. No cloud credentials are required.

`main` allows low-risk owner commits. Branches and PRs are optional for larger/shared work; no mandatory independent reviewer, CI, hooks or release branches. Use lightweight Conventional Commits, e.g. `fix: preserve node lock ownership`.

Before a commit: inspect `git status` and `git diff`; stage only intended paths; inspect `git diff --cached` and run `git diff --cached --check`. Never stage private outputs or all changes blindly. Tests passing do not authorize deployment or publication.

Before release: run a fresh lockfile install and tests; review all candidate files and history for secrets; confirm the license and asset obligations. RouteQuay uses MIT; preserve the root LICENSE and keep Xray and dependency licenses separate. Report descriptive issues in English or Simplified Chinese, with redacted reproduction steps. No duplicate translation is needed. Do not publish secrets or unpatched vulnerability details in public issues; no private reporting channel is claimed.

Account-level [handbook](https://github.com/forgottenlab/.github/blob/main/docs/standards/README.md), [contribution guide](https://github.com/forgottenlab/.github/blob/main/CONTRIBUTING.md), Issue Forms and PR template are reused without local overrides. CI is deferred until there is a repeatable need; no deployment/release workflows are configured.
