# Deploying the signage app

The signage app is deployed to two Raspberry Pi kiosks over
[Tailscale](https://tailscale.com) by the
[`Deploy to Raspberry Pis`](.github/workflows/deploy.yml) GitHub Actions
workflow.

| Pi hostname                 | Role                       |
| --------------------------- | -------------------------- |
| `raspberrypi-specials`      | Specials / trains loop     |
| `raspberrypi-standard-menu` | Standard menu (`MENU_ONLY`) |

Both Pis run **identical code** from `/home/tom/app` under the `signage`
systemd service. The difference between them lives only in each Pi's local
`.env` file (`MENU_ONLY=true` on the menu Pi), which is **not** in git and
is preserved on the device — the workflow excludes `.env`, `node_modules`,
and `.git` from the sync.

## How it runs

- **Automatically** on every push to `master` that touches app files.
- **Manually** via the *Actions → Deploy to Raspberry Pis → Run workflow*
  button (`workflow_dispatch`).

Each run, for both Pis in parallel:

1. Joins the tailnet as an ephemeral, `tag:ci`-tagged node.
2. `rsync`s the repo to `/home/tom/app` (with `--delete`, excluding the
   files above).
3. Runs `npm install --omit=dev` and `sudo systemctl restart signage`.

## One-time setup

### 1. GitHub secrets

Create a Tailscale **OAuth client**
(<https://login.tailscale.com/admin/settings/oauth>) with the `auth_keys`
write scope and the tag `tag:ci`. Then add two repository secrets
(*Settings → Secrets and variables → Actions*):

| Secret               | Value                         |
| -------------------- | ----------------------------- |
| `TS_OAUTH_CLIENT_ID` | OAuth client ID               |
| `TS_OAUTH_SECRET`    | OAuth client secret           |

### 2. Tailnet ACLs

In your tailnet policy file (<https://login.tailscale.com/admin/acls>):

```jsonc
{
  "tagOwners": {
    "tag:ci":      ["autogroup:admin"],
    "tag:signage": ["autogroup:admin"]
  },

  // Allow the CI runner to SSH into the Pis as the `tom` user via
  // Tailscale SSH (no SSH keys to manage).
  "ssh": [
    {
      "action": "accept",
      "src":    ["tag:ci"],
      "dst":    ["tag:signage"],
      "users":  ["tom"]
    }
  ]
}
```

Tag both Pis with `tag:signage` (e.g. `sudo tailscale up --advertise-tags=tag:signage`)
and make sure **Tailscale SSH** is enabled on each:

```bash
sudo tailscale up --ssh --advertise-tags=tag:signage
```

### 3. Passwordless sudo for the service restart

The deploy restarts a system service, so `tom` needs to run that one
command without a password. On each Pi:

```bash
echo 'tom ALL=(root) NOPASSWD: /usr/bin/systemctl restart signage' \
  | sudo tee /etc/sudoers.d/signage-deploy
sudo chmod 440 /etc/sudoers.d/signage-deploy
```

(Adjust the `systemctl` path if `which systemctl` differs.)

## Notes

- Data-only files (e.g. `specials.json`) are read fresh on each request, so
  the restart is mainly for `server.js`/dependency changes — but restarting
  every deploy keeps things simple and consistent.
- `rsync --delete` keeps the Pis byte-for-byte in sync with the repo;
  excluded files (`.env`, `node_modules`) are protected from deletion.
