# Public product development school operations

Install these templates on the school host after replacing `__PUBLIC_IPV4__` with `101.201.141.133`, `__CERTBOT59__` with `/opt/xunjie-school-acme/bin/certbot-ipv4`, `__SCHOOL_USER__` with the existing school owner `xunjie-admin`, and `__SCHOOL_ROOT__`, `__APP_DIR__`, `__NODE24_21__` with the actual absolute values. The school daemon is the existing `app/daemon.js --root` in the foreground; the private school root is mode `0700` and owned by `xunjie-admin`. The saved product installation must already use the loopback HTTP endpoint `127.0.0.1:3444`, profile `school`, and exactly `space-course` plus `learning-data`. Check `installation.json.resources.nodePath` and the actual package snapshot before rendering the service. Do not use the product CLI `start` alongside the systemd daemon.

## Paths and activation

| Source | Install path |
| --- | --- |
| `nginx-bootstrap.conf.template`, then `nginx.conf.template` | `/etc/nginx/sites-available/xunjie-school.conf` (linked from `sites-enabled`) |
| `xunjie-school*.service`, `xunjie-school*.timer` | `/etc/systemd/system/` |
| `school.py`, `monitor.py`, `backup.py`, `cert-deploy.py` | `/usr/local/lib/xunjie/product-school/` (hook executable, all root owned) |
| `certbot-ipv4.py` | `/opt/xunjie-school-acme/bin/certbot-ipv4` (executable, root owned) |
| `product-school.example.json`, `product-school-backup.example.json` | `/etc/xunjie/product-school.json`, `/etc/xunjie/product-school-backup.json` (root, `0600`) |

The host already has ports 80/443 open, nginx with `server_name 101.201.141.133`, ACME webroot `/var/www/xunjie-school-acme`, and Certbot 5.9.0 under `/opt/xunjie-school-acme`. Keep this webroot and its current HTTP challenge route. The staging issuance uses a separate `/var/lib/xunjie-school/acme-staging/config`; it does not create the production live certificate. On this IPv4-only public endpoint, the IPv6 ACME connection path has hung while IPv4 succeeds; `certbot-ipv4` limits only this Certbot process's urllib3 address selection to `AF_INET`. It does not change system networking, Python site customization, or TLS verification. Install it and render `__CERTBOT59__` to `/opt/xunjie-school-acme/bin/certbot-ipv4` for both first issuance and renewal. The bootstrap config is HTTP only because nginx cannot load certificate paths before first production issuance. Check an external GET to the challenge path, then issue the production certificate once staging has completed:

```sh
sudo __CERTBOT59__ certonly --preferred-profile shortlived --webroot --webroot-path /var/www/xunjie-school-acme --ip-address __PUBLIC_IPV4__ --non-interactive --agree-tos -m __OPERATOR_EMAIL__
```

Use the final nginx config after `/etc/letsencrypt/live/__PUBLIC_IPV4__/fullchain.pem` and `privkey.pem` exist. Run `nginx -t && systemctl reload nginx`. Install the hook and private config, then `systemctl daemon-reload`; enable `xunjie-school.service`, `xunjie-school-cert-renew.timer`, and `xunjie-school-health.timer`. Stop any existing product CLI daemon before enabling the service so only one process owns port 3444. Check for another Certbot renewal timer before enabling this one, so renewals use the same deploy hook. The cert timer checks at 00/06/12/18 with persistent scheduling and a stable delay of at most 10 minutes. The 160-hour IP certificate becomes due near 80 hours remaining, leaving about 13 six-hour checks. It holds `/run/lock/xunjie-school-certbot.lock`; Certbot's own renewal sleep is disabled because the timer provides jitter. The deploy hook only runs after an issued renewal, checks `nginx -t`, gracefully reloads nginx, and records the observed leaf certificate in `/var/lib/xunjie/maintenance/product-school-cert-reload.json`. A failed hook leaves a durable failed state for the health checker.

The health timer runs every 10 minutes: development outages should be found within a working session, while sub-minute polling adds little value here. The same small check verifies trusted HTTPS and the IP SAN, compares the served leaf SHA-256 against the current fullchain on disk, reads `/runtime/status`, and requires the exact two school modules. These local certificate checks make no ACME requests. `<=48h` is warning; `<=24h`, TLS failure, fingerprint mismatch, missing readiness, or wrong modules is critical. Its private status file includes actions and both fingerprints. The only stdout is a small state/actions summary. `monitor.py` reads the existing `/etc/xunjie/monitoring.json` to reuse `credentialsFile` and `groupId`; credentials never enter this new config or output.

CMS uses one `xunjie_school_health` series under `application=xunjie-product-school`: `3=ok`, `2=warning`, `1=critical`. The `xunjie-school-health` rule uses the existing contact group, Minimum, warning =2, critical <=1, one observation, a 900-second statistical period and 600-second evaluation interval. `NoDataPolicy=INSUFFICIENT_DATA` detects a stopped checker after a window with no samples; the 15-minute window accommodates the 10-minute reporting cadence. Repeated notifications are muted for six hours. Read back the real metric and rule; no test notification is needed. Keep metric names, dimensions, severity values and alarm thresholds aligned when changing this setup.

## Encrypted recovery backups

This development school uses checkpoints before upgrades, migrations and bulk data changes, with no periodic backup timer. Keep the pre-cutover recovery point. `backup.py` calls the **current product recovery CLI** (`app/cli.js backup --root ... --file ...`) against the running daemon and keeps three complete checkpoints. The CLI caller is root; the running daemon writes recovery exports as `__SCHOOL_USER__`, so its configured backup directory must be writable by that user. It supplies an existing private `recoveryKeyRef` and `leaveClosed:false`, and holds the existing maintenance lock throughout the CLI call. Confirm that lock path against the host's current deployment config. It prints only state/backup ID and writes one root-only status JSON. Product recovery artifacts stay in their private directory. Do not use `tools/i0-cloud/backup-retained.mjs` for this school.

To create the key reference once, with root-only files and no product `backup-policy` (that policy starts its own scheduler):

```sh
sudo install -d -m 0700 /etc/xunjie /var/lib/xunjie/maintenance
sudo install -d -o __SCHOOL_USER__ -g __SCHOOL_USER__ -m 0700 /var/lib/xunjie/recovery/product-school/checkpoints
sudo __NODE24_21__ __APP_DIR__/cli.js recovery-key --out /etc/xunjie/product-school-recovery.key
sudo sh -c 'umask 077; base64 -w 0 /etc/xunjie/product-school-recovery.key > __SCHOOL_ROOT__/recovery-import.b64'
sudo chown __SCHOOL_USER__:__SCHOOL_USER__ __SCHOOL_ROOT__/recovery-import.b64
sudo -u __SCHOOL_USER__ __NODE24_21__ __APP_DIR__/cli.js set-credential --root __SCHOOL_ROOT__ --ref recovery-__UUID__ --file __SCHOOL_ROOT__/recovery-import.b64
sudo rm __SCHOOL_ROOT__/recovery-import.b64
```

Put the same reference in private `product-school-backup.json` and check its Node/CLI/root paths, directory and lock path. Keep the raw recovery key in private storage independent of the server for restore; the product root holds its private reference for backup. Check a resulting backup through the product `backup-list --root ... --file` with `{"directory":"<configured directory>"}`, then perform a separate isolated restore exercise. `backup-list` needs the running daemon. Existing `backup-policy.json` and retired school backup timers must be reconciled so they do not start a second scheduler. Timers belonging to other environments retain their own policy.

For the snapshot immediately before deployment, run the same wrapper directly against the existing running daemon after installing its script and private config; this does not start a second daemon:

```sh
sudo python3 /usr/local/lib/xunjie/product-school/backup.py --config /etc/xunjie/product-school-backup.json
```

Only proceed with deployment after it reports `complete` and `backup-list` authenticates that directory. The checkpoint contains the school's PostgreSQL owner exports, learning resources and product recovery material. Save nginx/systemd configuration separately before changing it. Stop and remove the isolated restore environment after checking login, original identities and read-only behavior; keep the encrypted checkpoint and its recovery key.

## Operator checks

```sh
sudo nginx -t
sudo systemctl status xunjie-school.service xunjie-school-cert-renew.timer xunjie-school-health.timer
sudo python3 /usr/local/lib/xunjie/product-school/monitor.py --config /etc/xunjie/product-school.json
sudo cat /var/lib/xunjie/maintenance/product-school-health.json
sudo cat /var/lib/xunjie/maintenance/product-school-backup.json
```

Run `python3 -m unittest discover -s tools/product-school -p 'test_*.py'` locally for the logic tests. They use no production endpoint, CMS request, notification, or live certificate. Validate each host installation with nginx syntax, systemd unit validation, one real HTTPS health sample, CMS data readback, and an isolated restore. The current school's fixed source, bundle hashes and acceptance are recorded in `school-v2-source-info.json` next to its root.
