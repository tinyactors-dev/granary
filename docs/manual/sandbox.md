# A sandbox next to production

A sandbox is a second, throwaway granary on the same machine whose "GitHub"
is the fake GitHub that ships with granary. Use it to try things out —
introductions, the closing message, blocking yourself — without touching the
real instance or anyone on GitHub.

It is safe by construction:

- it has its own data directory and master key; `granary serve` refuses a
  sandbox's directory and `granary sandbox serve` refuses any other;
- it refuses to start unless its GitHub is on this machine, and the fake
  GitHub never talks to github.com;
- the app and the fake listen on `127.0.0.1` only; you reach them through an
  SSH tunnel;
- every page says "Sandbox".

## Set it up (once)

On the granary host, as the service user:

```sh
sudo install -d -o granary -g granary -m 0700 /var/lib/granary-sandbox
sudo -u granary granary sandbox init --data /var/lib/granary-sandbox --admins <your-github-login>
granary systemd-unit --unit sandbox --data /var/lib/granary-sandbox | sudo tee /etc/systemd/system/granary-sandbox.service
sudo systemctl daemon-reload && sudo systemctl enable --now granary-sandbox
```

Ports default to 3100 (the app) and 4010 (the fake GitHub); change them with
`--port` and `--github-port` on `sandbox init`.

## Use it

From your computer:

```sh
ssh -L 3100:127.0.0.1:3100 -L 4010:127.0.0.1:4010 <the granary host>
```

Open <http://localhost:3100/admin/sessions> and log in as your login (the
sandbox runs in development mode, so you can log in as anyone). The sandbox
connects to its fake GitHub by itself. Then:

- **Admin → Fake GitHub** opens issues and pull requests as anyone, and, under
  *Introductions*, turns on Discussions with an Introductions category and
  posts an introduction;
- **Introductions** is where you approve or decline them;
- <http://localhost:4010> is the fake GitHub's own page (repositories, issues,
  deliveries).

## Update, reset, remove

- The updater restarts only `granary`; after an update run
  `sudo systemctl restart granary-sandbox`.
- The fake GitHub keeps its state in memory: restarting the sandbox empties
  it, and granary connects to it again. To start completely fresh, stop the
  service and delete `/var/lib/granary-sandbox`, then `sandbox init` again.
- To remove it: `sudo systemctl disable --now granary-sandbox`, delete the
  unit file and the data directory.
