# Introductions

People granary closed can introduce themselves, and you decide whether to
let them in. They write a post in an **Introductions** discussion category
on GitHub; granary lists each one under **Introductions**. When you approve
one, granary:

1. adds the author to the allowlist for that repository (or, for an
   introduction in your organization's discussions, for all of its
   repositories),
2. reopens the issues and pull requests it closed on them there,
3. replies on the discussion to tell them.

Declining is recorded in granary only; nothing is posted on GitHub.

Closing comments link to the category once a repository has it ("Want to
contribute? Introduce yourself…"), so people find it without you saying
anything. In your own closing message templates, use `{{introduce}}` (the
sentence, or nothing while there is no category) or `{{introduce_url}}`.

## Set it up

GitHub has no API for creating a discussion category, so these steps are
yours; granary checks each repository and tells you what is missing.

1. **Discussions access for the GitHub App.** In the app's settings →
   Permissions & events: Repository permissions → *Discussions: Read and
   write*; Subscribe to events → *Discussion*; Save. Then, on each
   installation, *Review request* → *Accept new permissions*. Apps created
   from granary's setup page ask for this from the start.
2. **In each repository:** Settings → General → Features → *Discussions*.
   Then Discussions → Categories → *New category*: name **Introductions**,
   format *Open-ended discussion*. The Introductions page shows the exact
   links and a description to paste.
3. Optional, **organization-wide:** GitHub backs an organization's
   discussions with one repository, `.github` unless you choose another. Add
   the Introductions category there, and an introduction lets the person in
   to every repository of the organization. If you use another repository,
   name it on the Introductions page.

Then press **Check again** on the Introductions page (granary also checks
every 15 minutes and whenever a discussion arrives).

## The reply

The reply to an approved introduction is a template on the Introductions
page, with `{{author}}`, `{{scope}}`, `{{repository}}`, `{{owner}}`,
`{{url}}` and `{{reopened}}` (the list of reopened items).

## Trying it out

Set up a [sandbox](sandbox.md) and use Admin → Fake GitHub → *Introductions*
to play the person introducing themselves.
