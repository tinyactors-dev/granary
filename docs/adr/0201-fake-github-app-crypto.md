# 201. Real RSA keys and RS256 JWT checks in the fake

Date: 2026-09-28 · Status: accepted · Implements 0164

## Decision
- The manifest conversion returns a freshly generated 2048-bit RSA key as a
  **PKCS#1 PEM** (`-----BEGIN RSA PRIVATE KEY-----`), the format github.com
  uses — granary's app backend must accept it (`node:crypto.createPrivateKey`
  does). Generated with `node:crypto.generateKeyPairSync` rather than
  WebCrypto because WebCrypto cannot export PKCS#1. The fake stores only the
  SPKI public key; the private key lives in the one-time manifest code until
  its single conversion (1 h TTL).
- App JWTs are verified for real: `alg` RS256, signature against the app's
  public key, `iss` = app id (number or numeric string) **or** client id,
  `iat` ≤ now + 60 s, `exp` > now and ≤ now + 10 min + 60 s. Failures are 401
  with GitHub's messages.
- Installation tokens (`ghs_…`) expire after
  `FAKE_GITHUB_INSTALLATION_TOKEN_TTL_MS` (default 1 h, tests shorten it);
  expired/unknown → 401 `Bad credentials`; repos outside the installation →
  404. Comments made with them are authored by `<slug>[bot]` (type Bot).
  Tokens that are neither OAuth nor installation tokens keep the token-mode
  behaviour (`granary[bot]`). App JWTs on repo endpoints → 401.
- GitHub App user OAuth: `/login/oauth/*` accept an app's client id/secret
  and issue `ghu_…` tokens (`gho_…` for the env OAuth app).
