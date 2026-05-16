# NourLMS Code-Server — Production Deployment Guide

This guide walks through deploying `nourlms-codeserver` to a production
Linux server (Ubuntu 22.04 / Debian 12 reference). The result is a
hardened, login-gated, browser-based VS Code that talks to your NourLMS
backend through a single proxy origin and runs as a systemd service
behind nginx + TLS.

---

## 1. What you'll need on the server

| Requirement | Notes |
|---|---|
| Ubuntu 22.04+ / Debian 12+ (or any modern Linux) | Tested on x86_64. ARM64 also works. |
| **Node.js 22.x LTS** | The repo's `.nvmrc` pins the version used during development. |
| `git`, `python3`, `make`, `g++`, `pkg-config`, `libsecret-1-dev`, `libx11-dev`, `libxkbfile-dev` | Native deps for the build (`apt install -y`). |
| ≥ 4 GB RAM, ≥ 10 GB free disk | Build is memory-heavy; disk holds extensions + per-student workspaces. |
| Public DNS name + TLS cert | We assume `code.example.com` below. Use Let's Encrypt or your CA. |
| A reachable NourLMS API endpoint | e.g. `https://api.nourlms.example.com/api`. |

> The server itself runs as an unprivileged user (`nourlms`). Do **not** run
> the production process as root.

---

## 2. Build the artefact (once, on a build host)

You can build on the production server itself, or on a separate build
host and ship the `out/` and `node_modules/` directories. Building takes
~3 minutes on a 4-core box.

```bash
sudo apt update
sudo apt install -y git python3 make g++ pkg-config libsecret-1-dev libx11-dev libxkbfile-dev curl

# Node 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

git clone <your-fork-url> /opt/nourlms-codeserver
cd /opt/nourlms-codeserver

npm ci                         # install dev + runtime deps
npm run compile                # transpiles src -> out (≈ 2 minutes, must end with "Finished compile")
```

The compile output the deployment needs is the `out/`, `node_modules/`,
`extensions/`, `resources/`, `product.json`, and `package.json` files
of the repo. If you're shipping them to another host, rsync the
checkout directory excluding `.git`, `out-build`, `.history`, and
`.specify`.

---

## 3. Create the runtime user and directories

```bash
sudo useradd --system --create-home --home /var/lib/nourlms --shell /usr/sbin/nologin nourlms
sudo mkdir -p /var/lib/nourlms/workspaces /var/lib/nourlms/data /etc/nourlms
sudo chown -R nourlms:nourlms /var/lib/nourlms
sudo chmod 750 /etc/nourlms
```

`/var/lib/nourlms/workspaces` is where each student's per-account
workspace lives. `/var/lib/nourlms/data` is the VS Code server's data
folder (extensions, user settings).

---

## 4. Configure the server with `.env`

Drop your config in `/etc/nourlms/server.env`:

```bash
sudo install -m 0640 -o root -g nourlms /dev/null /etc/nourlms/server.env
sudo nano /etc/nourlms/server.env
```

Paste the values from `.env.example` and adjust:

```env
NOURLMS_API_URL=https://api.nourlms.example.com/api
NOURLMS_WORKSPACES_DIR=/var/lib/nourlms/workspaces
NOURLMS_HOST=127.0.0.1
NOURLMS_PORT=8000
NOURLMS_CONNECTION_TOKEN=please-rotate-this-long-random-string
NOURLMS_DISABLE_TELEMETRY=true
```

> Lock the file down (`chmod 0640`, owner `root`, group `nourlms`) — it
> contains the connection token.

The server picks the file up via the systemd unit's `EnvironmentFile=`
(see step 6) and via the in-process `.env` loader. The loader honors
`NOURLMS_ENV_FILE` if you'd rather pin a custom path:

```env
[Service]
Environment=NOURLMS_ENV_FILE=/etc/nourlms/server.env
```

The bind host (`NOURLMS_HOST`) is `127.0.0.1` because nginx will sit in
front of the process and handle TLS — never expose the raw process to
the public internet.

---

## 5. Sanity-check from the command line

Before installing the systemd unit, run the server by hand once to make
sure it boots and reaches the upstream API:

```bash
cd /opt/nourlms-codeserver
sudo -u nourlms env $(grep -v '^#' /etc/nourlms/server.env | xargs) \
    node ./out/server-main.js \
    --server-data-dir /var/lib/nourlms/data \
    --user-data-dir /var/lib/nourlms/data \
    --start-server
```

You should see, in order:
- `[NourLMS] Loaded N env variable(s) from /etc/nourlms/server.env`
- `Server bound to 127.0.0.1:8000`
- (no warnings about `NOURLMS_API_URL` being unset)

Open a browser to `http://127.0.0.1:8000/?tkn=<your token>` (use SSH
port-forwarding) and confirm you get the NourLMS login page. Stop the
process with Ctrl-C.

---

## 6. Install the systemd unit

```bash
sudo nano /etc/systemd/system/nourlms-codeserver.service
```

```ini
[Unit]
Description=NourLMS Code Server (browser VS Code with NourLMS auth)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=nourlms
Group=nourlms
WorkingDirectory=/opt/nourlms-codeserver
EnvironmentFile=/etc/nourlms/server.env
ExecStart=/usr/bin/node /opt/nourlms-codeserver/out/server-main.js \
    --server-data-dir /var/lib/nourlms/data \
    --user-data-dir /var/lib/nourlms/data \
    --start-server \
    --accept-server-license-terms

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/nourlms /opt/nourlms-codeserver/out
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=yes
RestrictRealtime=yes

# Auto-restart
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nourlms-codeserver
sudo systemctl status nourlms-codeserver         # should be "active (running)"
sudo journalctl -u nourlms-codeserver -f         # live logs
```

---

## 7. Put nginx + TLS in front

The server speaks plain HTTP on `127.0.0.1:8000`. Nginx terminates TLS
and proxies WebSocket traffic (which VS Code needs for the extension
host).

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d code.example.com         # provisions cert + edits nginx
```

Edit the nginx server block at `/etc/nginx/sites-available/code.example.com`
to make sure WebSocket upgrades are forwarded correctly:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl http2;
    server_name code.example.com;

    ssl_certificate     /etc/letsencrypt/live/code.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/code.example.com/privkey.pem;

    # Bigger upload limit for "Submit from file" payloads (1 MB hard cap in app, 2 MB
    # at the proxy)
    client_max_body_size 4m;

    # Important: long-lived WebSocket connections for the extension host
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-Prefix /;

        # WebSocket upgrade (mandatory)
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        $connection_upgrade;
    }
}

server {
    listen 80;
    server_name code.example.com;
    return 301 https://$host$request_uri;
}
```

Reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Browse to `https://code.example.com/` — you should see the NourLMS
login page over HTTPS.

---

## 8. First-login smoke test

1. Sign in as a real student and confirm:
   - Workspace folder appears under `/var/lib/nourlms/workspaces/<student>/`.
   - Activity bar is hidden, Explorer is open on the left, **Homework**
     view is open on the right (Secondary Side Bar).
   - Settings, Extensions, Source Control, Debug are not reachable.
2. Sign in as an admin and confirm:
   - Student Workspaces sidebar is visible (left).
   - Homework's Question Bank + Assigned to Current Student tabs are
     visible (right).
   - Copilot/Chat is not visible anywhere (no chat icon, no `Ctrl+I`,
     no command-palette entries for chat).
3. Open the network tab in DevTools while in the panel. You must NOT
   see any direct calls to the upstream API host — every call must
   go through `https://code.example.com/nourlms-api/...`. The Sanctum
   bearer token must never appear in the browser.

---

## 9. Updating to a new build

```bash
cd /opt/nourlms-codeserver
sudo -u nourlms git pull --rebase
sudo -u nourlms npm ci
sudo -u nourlms npm run compile
sudo systemctl restart nourlms-codeserver
```

For zero-downtime rolls, run two units behind nginx with `upstream {
server 127.0.0.1:8000; server 127.0.0.1:8001 backup; }` and restart
them in turn.

---

## 10. Backups

Two things are worth backing up:

| What | Where | Why |
|---|---|---|
| `/var/lib/nourlms/workspaces/` | per-student work | Replaces a student's lost code. |
| `/var/lib/nourlms/data/User/` | server-wide settings & extensions | Restores extensions list after disk loss. |
| `/etc/nourlms/server.env` | runtime config | Token + API URL. |

The NourLMS database itself is upstream of this server — back it up
where the API runs.

---

## 11. Common pitfalls

- **"Empty Secondary Side Bar"** for an admin → make sure the build
  ran the latest `homework/nourlmsHomework.contribution.ts`. The
  Homework container is `hideIfEmpty: true`; if neither the student
  view nor the admin views are gated correctly by role, the container
  collapses.
- **WebSocket disconnects every minute** → the nginx `proxy_read_timeout`
  is too low. Bump to ≥ `3600s`.
- **`NOURLMS_API_URL is not set`** at startup → the systemd unit's
  `EnvironmentFile=` doesn't point at a readable file, or the file is
  missing the variable. The in-process `.env` loader only reads from
  `process.cwd()`, the path in `NOURLMS_ENV_FILE`, and
  `~/.nourlms/.env`; under systemd `cwd` is `WorkingDirectory=`.
- **Login fails with "Upstream unreachable"** → check from the host
  that `NOURLMS_API_URL` is reachable and presents a valid TLS cert.
- **Per-student workspaces missing the sidecar** → the user the server
  runs as needs write access to `NOURLMS_WORKSPACES_DIR`. The systemd
  unit grants this via `ReadWritePaths=`.

---

## 12. Removing it cleanly

```bash
sudo systemctl disable --now nourlms-codeserver
sudo rm /etc/systemd/system/nourlms-codeserver.service
sudo rm -rf /etc/nourlms /opt/nourlms-codeserver /var/lib/nourlms
sudo userdel nourlms
sudo systemctl daemon-reload
```

The student's nourlms account/data inside the upstream LMS is
untouched.
