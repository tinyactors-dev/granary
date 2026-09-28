# Allowlist and policy

## Who may open issues

When GitHub reports a newly **opened** issue in a guarded repository,
granary keeps it open if:

- the author's login is on the **allowlist** (case-insensitive), or
- the author is an `OWNER`, `MEMBER` or `COLLABORATOR` of the repository
  (maintainers can never lock themselves out).

Everyone else, bots included, gets one comment and the issue is closed as
*not planned*:

> Thanks for the report! Issues in this repository can only be opened by
> approved contributors, so this one was closed automatically.

Only `issues` / `opened` is acted on. Reopened, edited or transferred issues
are left alone, so a maintainer reopening an issue is final. Everything else
GitHub sends is stored as *ignored*, with the reason visible on
**Deliveries**.

## Managing the allowlist

**Allowlist** in the UI: admins add and remove logins, everyone signed in
can view them. Changes take effect for the next issue.

For a first install you can seed logins with the environment variable
`ALLOWED_USERS_SEED=alice,bob`. It is applied once at startup and never
removes or overrides anything edited in the UI.

## What happens under the hood

Every delivery is written to the database before granary answers GitHub.
An issue actor then decides, and the GitHub side effect (comment, then
close) goes through a durable outbox that retries with backoff and never
posts the comment twice. **Overview**, **Deliveries**, **Effects** and
**Verdicts** show each step, and **Actors** shows the live state machines.
