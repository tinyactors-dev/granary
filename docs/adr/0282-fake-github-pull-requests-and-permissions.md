# 282. Fake GitHub: pull requests and accepted permissions

Date: 2026-09-28 · Status: accepted

## Decision
- Pull requests live in the repository actor next to issues, sharing the
  number sequence (`pullRequest: {draft}` on the stored item). REST:
  `GET|PATCH /repos/{o}/{r}/pulls/{n}`; issues endpoints return pull
  requests with a `pull_request` key, comments work on both.
- `POST /__control/pulls` opens one and delivers `pull_request`/`opened`.
- Installations carry the **accepted** `permissions`/`events` (copied from
  the app at install time). Webhooks go only to installations that accepted
  the event; `PATCH …/pulls/{n}` needs accepted `pull_requests: write`
  (403 "Resource not accessible by integration" otherwise); installation
  tokens report the accepted permissions.
- `POST /__control/apps/{id}/permissions` changes what the app asks for;
  `POST /__control/installations/{id}/accept-permissions` accepts and
  delivers `installation`/`new_permissions_accepted`.
- Event log gains `pull_request.opened` / `pull_request.closed`.
