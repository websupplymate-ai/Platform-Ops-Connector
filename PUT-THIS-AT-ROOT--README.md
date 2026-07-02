# Platform Ops Connector

Powers three Founder Tools from one service, per your Doc 03 §10 "one
service, no app touches the raw API" principle:

- **Repository Overview** — `/repos` (GitHub API)
- **Deployment Overview** — `/deployments` (Cloudflare API)
- **Infrastructure Monitoring** — `/infrastructure` (Cloudflare Analytics)

## One-time setup

1. **Set your Account ID**
   In `wrangler.toml`, replace `REPLACE_WITH_YOUR_CLOUDFLARE_ACCOUNT_ID` with
   your real Cloudflare Account ID (Workers & Pages → right sidebar →
   Account Details). This one is not secret — safe as a plain variable.

2. **Deploy the repo**
   Push this to GitHub as `Platform-Ops-Connector` under `websupplymate-ai`,
   same as your other repos. Connect it in Cloudflare the same way
   (Workers & Pages → Create application → Import a repository).

3. **Set the two secrets** (after first deploy, in the Worker's
   Settings → Variables and Secrets — same as GOOGLE_SHEETS_API_KEY earlier):
   - `GITHUB_TOKEN` — your GitHub Personal Access Token (`public_repo` scope)
   - `CLOUDFLARE_API_TOKEN` — the Cloudflare API token
     (`Workers Scripts: Read` + `Account Analytics: Read`)

## Test it

```
GET /health
GET /repos
GET /deployments
GET /infrastructure
```

## Notes

- Responses are cached 2 minutes at the edge — this hits two external APIs,
  so caching matters more here than on the Sheets connector.
- `/infrastructure` status logic: 0 errors = Operational, error rate above
  5% = Degraded. Adjust the threshold in `getInfrastructure()` if needed.
- If `/repos` shows `latestCommit: null` for a repo, that repo has no
  commits yet (empty) — not an error.
