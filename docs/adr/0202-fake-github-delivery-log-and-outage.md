# 202. App delivery log, redelivery and the webhook outage switch

Date: 2026-09-28 · Status: accepted · Implements 0164, supports 0162

## Decision
- Every attempt of an app-targeted delivery (first attempt and each
  redelivery) appends one entry to the app's log: new numeric `id`, the
  delivery `guid` (= `X-GitHub-Delivery`), `event`, `action`,
  `status_code` (0 when no connection was made), `redelivery`,
  `installation_id`, `repository_id`, `delivered_at`, `duration`.
- `GET /app/hook/deliveries` returns entries newest first with `per_page`
  (≤ 100) and a `cursor` (the last id) plus a `Link: …; rel="next"` header,
  like GitHub. `POST /app/hook/deliveries/{id}/attempts` answers **202** and
  redelivers asynchronously with the same body and guid.
- `POST /__control/webhook-outage {down}`: while down, every delivery (app or
  default) fails without connecting (`status_code` 0 / `responseCode` null).
  `/__control/reset` clears it; `state.webhookOutage` reports it.
- `state` now always includes `apps` (no secrets), `installations`,
  `appDeliveries` (sorted by id) and `webhookOutage`.
