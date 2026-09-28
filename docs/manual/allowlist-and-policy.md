# Allowlist and policy

## Who may open issues

When GitHub reports a newly **opened** issue in a guarded repository,
granary decides by the first rule that matches:

1. the author is on the **blocklist** (and the block hasn't expired) →
   **closed**, even if they are allowlisted or a maintainer;
2. the author's login is on the **allowlist** (case-insensitive) → kept open;
3. the author is an `OWNER`, `MEMBER` or `COLLABORATOR` of the repository →
   kept open (maintainers can't lock themselves out by accident — only by
   blocking themselves on purpose);
4. anyone else, bots included → **closed**.

**Verdicts** shows which rule decided (`blocklist`, `allowlist`,
`association` or `not-allowed`). A closed issue gets one comment and is
closed as *not planned*:

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
`GRANARY_SEED_ALLOWLIST=alice,bob`. It is applied once at startup and never
removes or overrides anything edited in the UI.

## The blocklist

**Allowlist → Blocklist** in the UI: admins block a login for 1 hour,
1 day, 7 days or until removed, with an optional note; everyone signed in
can view the list. Expired blocks stay listed (dimmed) and are no longer
enforced; there's nothing to clean up. Re-blocking a login replaces its
expiry and note.

**Testing the close flow yourself.** As the repository owner your issues are
normally always allowed. Click **Block me for 1 hour**, open an issue in a
guarded repository, and watch granary close it (Verdicts shows reason
`blocklist`). Unblock yourself afterwards, or let the hour run out.

From the command line on the host (see [CLI](cli.md)):

```sh
sudo -u granary granary blocklist add dhamidi --for 1h --note self-test
sudo -u granary granary blocklist list
sudo -u granary granary blocklist remove dhamidi
```

## What happens under the hood

Every delivery is written to the database before granary answers GitHub.
An issue actor then decides, and the GitHub side effect (comment, then
close) goes through a durable outbox that retries with backoff and never
posts the comment twice. **Overview**, **Deliveries**, **Effects** and
**Verdicts** show each step, and **Actors** shows the live state machines.
