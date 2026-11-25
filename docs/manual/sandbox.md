# A sandbox next to production

A sandbox is a second, throwaway granary on the same machine, running the
whole simulation that ships with granary: the fake GitHub, fake infra
(fake R2, an OTLP receiver, exe.dev's proxy) and the load generator with its
personas. Use it to demo granary and to try things out — introductions, the
closing message, a load scenario, blocking yourself — without touching the
real instance, its data or anyone on GitHub.

It is safe by construction:

- it has its own data directory and master key; `granary serve` refuses a
  sandbox's directory and `granary sandbox serve` refuses any other;
- it refuses to start unless its GitHub, its fakes, and where it sends
  backups and telemetry are all on this machine; the fakes never talk to
  github.com, R2 or Grafana;
- the sandbox and its fakes listen on `127.0.0.1` only;
- only production's admins reach it through production, and every page says
  "Sandbox".

## Set it up (once)

Admin → Sandbox in production shows these commands with your instance's
address filled in. On the granary host:

```sh
sudo install -d -o granary -g granary -m 0700 /var/lib/granary-sandbox
sudo -u granary granary sandbox init --data /var/lib/granary-sandbox --via https://granary.example.com --admins <your-github-login>
granary systemd-unit --unit sandbox --data /var/lib/granary-sandbox | sudo tee /etc/systemd/system/granary-sandbox.service
sudo systemctl daemon-reload && sudo systemctl enable --now granary-sandbox
```

`--via` is your production granary's address: the sandbox's links to
GitHub pages open there. Ports default to 3100 (the sandbox), 4010 (fake
GitHub), 4090–4092 (fake infra) and 4040 (load generator); change them with
`--port`, `--github-port`, `--infra-port` and `--loadgen-port`. Production
looks for its sandbox at `http://127.0.0.1:3100`; if you changed `--port`,
set `GRANARY_SANDBOX_URL` in production's `granary.env` (empty turns the
sandbox off).

## Use it

1. In production, open **Admin → Sandbox** and click **Enter the sandbox**.
   From now on this browser is served by the sandbox; the amber strip at the
   top says so.
2. The sandbox has its own sign-in: on its Sessions page, log in as any
   login (it runs in development mode).
3. Play:
   - **Admin → Fake GitHub** opens issues and pull requests as anyone, and,
     under *Introductions*, turns on Discussions with an Introductions
     category and posts an introduction;
   - **Admin → Load tester** and **Personas** run scenarios of simulated
     contributors against the sandbox;
   - **Admin → Fake infra** and **Ops** show the sandbox's backups going to
     the fake R2 and its telemetry to the fake receiver;
   - links to "GitHub" open the fake GitHub's pages under
     `/__sandbox/github`.
4. Click **Back to production** in the amber strip to leave.

Without production in the way, an SSH tunnel to the sandbox's port works
too: `ssh -L 3100:127.0.0.1:3100 <the granary host>`, then
<http://localhost:3100>. Initialize the sandbox without `--via` for that, so
its links point at the tunnel.

## Update, reset, remove

- The updater restarts only `granary`; after an update run
  `sudo systemctl restart granary-sandbox`.
- The fakes keep their state in memory: restarting the sandbox empties
  them, and granary connects to the fake GitHub again. To start completely
  fresh, stop the service and delete `/var/lib/granary-sandbox`, then
  `sandbox init` again.
- To remove it: `sudo systemctl disable --now granary-sandbox`, delete the
  unit file and the data directory.
