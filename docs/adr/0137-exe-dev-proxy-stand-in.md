# 137. The exe.dev proxy stand-in

Date: 2026-09-28 · Status: accepted

## Decision
Two extra listeners in front of the OTLP receiver:
- **token front** (`FAKE_INFRA_EXE_TOKEN_PORT`, default port+1; stands in
  for `https://<vm>.exe.xyz:4318`): requires `X-Exedev-Authorization: Bearer
  <exe VM token>`; otherwise **401 with exe.dev's login-redirect HTML**. The
  header is stripped and `X-ExeDev-UserID` added before forwarding.
- **peer front** (`FAKE_INFRA_EXE_PEER_PORT`, default port+2; stands in for
  `http://<n>.int.exe.xyz`): no auth, adds `X-Exedev-Source-Vm`.

`PUT /__control/exe-proxy {tokenMode, peerMode, peerSourceVm?}` starts/stops
the listeners (a stopped front refuses connections, like a VM that is down);
state reports `tokenPort`/`peerPort` or `null`. Faults with target
`exe-proxy` fire before auth. Ports `0` pick ephemeral ports (tests).
