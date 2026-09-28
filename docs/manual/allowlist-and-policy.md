# Allowlist and policy

## Who may open issues and pull requests

When GitHub reports a newly **opened** issue or pull request (drafts
included) in a guarded repository, granary decides by the first rule that
matches:

1. the author is on the **blocklist** (and the block hasn't expired) →
   **closed**, even if they are allowlisted or a maintainer;
2. the author's login is on the **allowlist** (case-insensitive) → kept open;
3. the author is an `OWNER`, `MEMBER` or `COLLABORATOR` of the repository →
   kept open (maintainers can't lock themselves out by accident — only by
   blocking themselves on purpose);
4. anyone else, bots included → **closed**.

**Verdicts** shows which rule decided (`blocklist`, `allowlist`,
`association` or `not-allowed`). A closed issue gets one comment and is
closed as *not planned*. By default the comment says:

> Thanks for the report! Issues in this repository can only be opened by
> approved contributors, so this one was closed automatically.

You can change it — see [The closing message](#the-closing-message).

Pull requests get the pull request template (default: "Thanks for the pull
request! Pull requests in this repository can only be opened by approved
contributors, so this one was closed automatically.") and are closed; pull
requests have no *not planned* reason. They are gated only when the app has
pull request access and the repository's **Pull requests** switch is on (see
[First run §4](first-run.md#granting-pull-request-access-to-an-existing-app)).

Only `issues` / `opened` and `pull_request` / `opened` are acted on.
Reopened, edited, transferred or `ready_for_review` issues and pull requests
are left alone, so a maintainer reopening one is final. Everything else
GitHub sends is stored as *ignored*, with the reason visible on
**Deliveries**.

## The closing message

**Policy → Closing message** (admins edit, everyone else can read) sets
the comment's text: one template for issues, one for pull requests, and
optional overrides per repository. Templates are Markdown with variables in
double braces; the page shows a live preview with sample data.

| Variable | Meaning |
|---|---|
| `{{author}}` | Login of the person who opened it (without `@`; write `@{{author}}` to mention them) |
| `{{title}}` | The title, escaped: it can't mention anyone, add links or HTML |
| `{{number}}` | Issue or pull request number |
| `{{kind}}` | `issue` or `pull request` |
| `{{owner}}`, `{{repo}}`, `{{repository}}` | Owner, name, and `owner/repo` |
| `{{url}}` | Link to the issue or pull request |
| `{{association}}` | The author's association, e.g. `NONE` |

Unknown variables are rejected when you save. granary always appends a
hidden marker (`<!-- granary:… -->`) so it never comments twice; a template
can't remove it, and an empty template posts only the marker. The text is
fixed when granary decides to close: editing the template doesn't change a
close that is already being retried.

From the command line (same validation):

```sh
sudo -u granary granary config set messages.closing \
  '{"issue":"Thanks @{{author}}! This repository only takes issues from maintainers.","pullRequest":null,"repos":{}}'
```

`null` means "use the default"; `repos` is keyed by `owner/repo`.

## Managing the allowlist

**Policy → Allowlist & blocklist** in the UI: admins add and remove logins, everyone signed in
can view them. Changes take effect for the next issue.

For a first install you can seed logins with the environment variable
`GRANARY_SEED_ALLOWLIST=alice,bob`. It is applied once at startup and never
removes or overrides anything edited in the UI.

## The blocklist

**Policy → Allowlist & blocklist** in the UI: admins block a login for 1 hour,
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
