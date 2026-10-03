# Schema Audit

Schema Audit is a free, dependency-free Node.js CLI that checks the JSON-LD structured data already present in web pages. It needs no API key and no browser: it fetches HTML, parses every `application/ld+json` block, and writes a Markdown and JSON health report.

## How it works

1. Read target URLs from `targets.txt` (one per line) or a JSON array in `targets.json`.
2. Fetch each page with a browser-like User-Agent. If Node's HTTP request fails, try `curl` as a fallback.
3. Parse all JSON-LD script blocks. If strict JSON parsing fails, retry after stripping control characters; report recovered blocks as `invalid-JSON (recovered by sanitization)` and unrecoverable blocks as `unparseable`.
4. Walk nested objects, including `@graph`, and recognize scalar or array `@type` values.
5. Score each recognized object for recommended fields and write `audit.md` and `audit.json`.

## Scoring

Each recognized object receives an easy-to-read score from 0 to 100: the percentage of its recommended field slots with a nonempty value, rounded to the nearest integer. A page score is the average of its recognized objects' scores, also rounded. Pages with no recognized schema types score 0. Product's image/description slot is satisfied by either `image` or `description`.

| Type | Recommended fields | Slots |
|---|---|---:|
| `JobPosting` | `title`, `datePosted`, `description`, `hiringOrganization`, `jobLocation`, `baseSalary` | 6 |
| `Product` | `name`, `image` or `description`, `offers` | 3 |
| `Event` | `name`, `startDate`, `location` | 3 |
| `Organization` | `name`, `url`, `logo` | 3 |

These are practical completeness signals, not a substitute for Google's or schema.org's validation tools. Unknown types are not scored.

## Run locally

Requires Node.js 18 or newer. `curl` is only needed when Node's fetch fails for a target.

```sh
node audit.mjs
node audit.mjs --targets targets.json
node audit.mjs --strict          # exit 1 if any page scores below 70%
node audit.mjs --strict 85       # choose a different page-score threshold
```

Reports are written next to `audit.mjs`. Use `file:` URLs for local HTML fixtures, for example `file:fixtures/broken-jobposting.html`. Targets should be pages you own or are permitted to audit. Check site terms and access limits before adding targets.

## Use in your repository

Copy `audit.mjs` and a targets file into your repository. Add your URLs, then run `node audit.mjs`. The included GitHub Actions workflow runs on relevant pushes, on a daily UTC schedule, or manually; it commits only changed `audit.md` and `audit.json` reports. Review the workflow and target list before enabling write permissions in your own repository.

## Monetization

The core CLI is free and MIT-licensed. A future Pro tier may offer convenience features through a Stripe Payment Link; no paid service, tracking, or API key is required to use this project.

Project: https://github.com/nursatechstudio/schema-audit

Built by nursatechstudio.

## License

MIT. See `LICENSE`.
