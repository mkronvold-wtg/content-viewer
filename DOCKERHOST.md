# Docker host deployment prompt

Use this as a copy/paste prompt when deploying an app to the shared Docker host and exposing it through Nginx Proxy Manager.

````text
Deploy this app to the Docker host `sv4dhoap15.dev.e2open.com` and expose it through the existing Nginx Proxy Manager container.

Context:
- SSH target: `sv4dhoap15.dev.e2open.com`.
- Use non-interactive SSH commands where possible. From PowerShell, the connection pattern is:
  ```powershell
  $env:PASSCODE='<passcode>'
  ssh sv4dhoap15.dev.e2open.com 'hostname -s'
  ```
- App source directories live under `~/src/` on the host.
- The main ingress is the Nginx Proxy Manager stack in `~/src/npm`.
- Nginx Proxy Manager is abbreviated as NPM in this prompt.
- Existing NPM compose file: `~/src/npm/compose.yaml`.
- NPM exposes host ports `80`, `81`, and `443`.
- The shared internal proxy network is the external Docker network named `npm-proxy`.
- Apps should usually attach only their public web service to `npm-proxy`.
- App services should use `expose`, not public `ports`, when they are only meant to be reached through NPM.
- Private app databases, APIs, workers, and internal services should stay on app-local Docker networks.
- Temporary DNS names already exist and point at this host:
  - `winter.dev.e2open.com`
  - `spring.dev.e2open.com`
  - `summer.dev.e2open.com`
  - `fall.dev.e2open.com`
- `summer.dev.e2open.com` is currently in use by Whiplash.
- Track seasonal hostname usage on the host in:
  `~/src/npm/temporary-dns-hostnames.md`
- These seasonal names use the same wildcard `*.dev.e2open.com` certificate as the other NPM hosts.

Safety rules:
1. Do not print secrets. When inspecting `.env` files, show variable names only.
2. Do not expose app containers directly on host ports unless explicitly requested.
3. Do not widen NPM or app access beyond the existing host/network model.
4. Keep tokens and passwords in `.env`, Docker secrets, or another protected host-local secret mechanism.
5. Before changing an app, check its current Docker Compose state and working tree.
6. Before assigning a seasonal hostname, read and update `~/src/npm/temporary-dns-hostnames.md`.
7. If a hostname is already in use, do not reuse it without explicit approval.

Discovery commands:

```sh
hostname -s
pwd
find ~/src -maxdepth 4 -type f \( \
  -iname '*compose*.yml' -o \
  -iname '*compose*.yaml' -o \
  -iname 'docker-compose*.yml' -o \
  -iname 'docker-compose*.yaml' \
\) -print | sort
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker network ls --format '{{.Name}}' | sort
```

Inspect NPM and existing app conventions:

```sh
cd ~/src/npm
sed -n '1,240p' compose.yaml
docker compose ps

cd ~/src/whiplash
sed -n '1,260p' docker-compose.npm.yml
docker compose -f docker-compose.npm.yml ps

cd ~/src/infohub
sed -n '1,240p' docker-compose.npm.yml
docker compose -f docker-compose.npm.yml ps
```

Inspect `.env` files without revealing values:

```sh
for f in ~/src/npm/.env ~/src/*/.env; do
  [ -f "$f" ] || continue
  echo "--- ${f#$HOME/} keys ---"
  sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1=<redacted>/p' "$f"
done
```

Inspect generated NPM proxy host configs without revealing certificate paths:

```sh
docker exec npm-npm-1 sh -lc '
for f in /data/nginx/proxy_host/*.conf; do
  [ -f "$f" ] || continue
  echo "--- $f ---"
  sed -n "1,220p" "$f" |
    sed -E "s#(ssl_certificate_key )[^;]+#\1<redacted>#; s#(ssl_certificate )[^;]+#\1<redacted>#"
done
'
```

Observed NPM host pattern:
- `infohub.dev.e2open.com` forwards to `http://infohub:3000`.
- `sv4dhoap15.dev.e2open.com` forwards to `http://infohub:3000`.
- `npmadmin.dev.e2open.com` forwards to NPM admin on `127.0.0.1:81`.
- `npmstats.dev.e2open.com` forwards to `http://grafana:3000`.
- `summer.dev.e2open.com` forwards to `http://whiplash-web:4173`.
- Proxy hosts usually use the wildcard `*.dev.e2open.com` certificate and force SSL.

Compose pattern for an app exposed by NPM:

```yaml
services:
  app:
    build:
      context: .
    restart: unless-stopped
    env_file:
      - .env
    expose:
      - "8080"
    environment:
      HOST: 0.0.0.0
      PORT: 8080
    networks:
      app:
      npm-proxy:
        aliases:
          - my-app

networks:
  app:
  npm-proxy:
    external: true
    name: npm-proxy
```

If the app has internal dependencies, keep them off `npm-proxy`:

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - app-postgres:/var/lib/postgresql/data
    networks:
      app:

  api:
    build:
      context: .
      dockerfile: Dockerfile.api
    restart: unless-stopped
    expose:
      - "3000"
    depends_on:
      db:
        condition: service_started
    networks:
      app:

  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    restart: unless-stopped
    expose:
      - "4173"
    depends_on:
      api:
        condition: service_started
    networks:
      app:
      npm-proxy:
        aliases:
          - app-web

volumes:
  app-postgres:

networks:
  app:
  npm-proxy:
    external: true
    name: npm-proxy
```

Deployment flow:
1. SSH to the host.
2. Choose or create `~/src/<app-name>`.
3. Put the app source and Docker Compose files there.
4. Create a production `.env` with only required runtime values.
5. Ensure the public-facing service binds inside the container to `0.0.0.0`.
6. Ensure the public-facing service has `expose`, not host `ports`.
7. Attach the public-facing service to the external `npm-proxy` network.
8. Start the app:
   ```sh
   cd ~/src/<app-name>
   docker compose -f docker-compose.npm.yml up -d --build
   docker compose -f docker-compose.npm.yml ps
   docker compose -f docker-compose.npm.yml logs --tail=100
   ```
9. Verify from inside the Docker network:
   ```sh
   docker run --rm --network npm-proxy curlimages/curl:8.8.0 \
     -fsS http://<service-alias>:<container-port>/
   ```
10. Choose an available seasonal hostname from `~/src/npm/temporary-dns-hostnames.md`.
11. Create or update an NPM proxy host:
    - Domain Names: selected hostname, for example `winter.dev.e2open.com`.
    - Scheme: `http`.
    - Forward Hostname/IP: Docker service alias on `npm-proxy`, for example `content-viewer`.
    - Forward Port: container port, for example `8080`.
    - Websockets Support: enable if the app needs websockets or server-sent events.
    - Block Common Exploits: enable unless the app has a known incompatibility.
    - SSL Certificate: wildcard `*.dev.e2open.com` certificate.
    - Force SSL: enable.
    - HTTP/2 Support: enable.
12. Update `~/src/npm/temporary-dns-hostnames.md` with the assignment:
    - Hostname.
    - Status.
    - Current target, such as `content-viewer:8080`.
    - App name and owner/purpose.
13. Verify externally:
    ```sh
    curl -kI https://<hostname>/
    curl -kfsS https://<hostname>/api/health
    ```
14. Check NPM logs if routing fails:
    ```sh
    docker logs npm-npm-1 --tail=100
    docker exec npm-npm-1 sh -lc 'ls -l /data/logs && tail -100 /data/logs/proxy-host-*_error.log'
    ```

NPM proxy host setup can be done through the NPM admin UI. If automation is requested, use the NPM API only after credentials are explicitly provided or an existing authenticated mechanism is found. Do not scrape or print admin credentials from `.env` or the database.

For the content-viewer app specifically:
1. Use a compose file that exposes the Node server on `8080`.
2. Set `HOST=0.0.0.0` inside the container.
3. Attach the service to `npm-proxy` with alias `content-viewer`.
4. Use a read-only GitHub token in `.env` for content repo clone/pull.
5. Point an available seasonal hostname to `http://content-viewer:8080`.
6. Validate `GET /api/health` through the NPM hostname.

When finished, report:
- App directory.
- Compose file used.
- Container names and health.
- NPM hostname.
- NPM forward target.
- Whether `~/src/npm/temporary-dns-hostnames.md` was updated.
- Any manual NPM UI step still required.
````

