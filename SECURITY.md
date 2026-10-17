# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Include what you found, how to reproduce it, and what it lets someone do.

You will get an answer within 3 working days. Confirmed problems are fixed in order of risk, and the fix
is released before details are published. If the problem needs a secret changed (a key, a password, an
intake credential), say so and it is rotated first.

## What is in scope

The application in [`avn_cms/`](avn_cms/): sign-in and sessions, two-step verification, the API,
workspace isolation (one agency must never see another's data), the documents vault, imports and
exports, the website intake endpoints and the automation rules.

Out of scope: findings that need a stolen device or an already-signed-in administrator, denial of service
by sheer traffic, and problems in a host or service we do not run (your hosting, Cloudflare, your email
provider).

## How the application defends itself

[`docs/SECURITY.md`](docs/SECURITY.md) describes the controls, the internal penetration-test checklist and
its results, and what is still open.
