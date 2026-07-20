# Google Maps scraper service

This is the local service used by the **Google Maps Scraper** n8n Code node. It must be running and healthy at the `scraper.baseUrl` configured in the workflow (normally `http://localhost:3000`).

## Production installation

```bash
cd googlemaps-scraper
npm ci
npx playwright install --with-deps chromium
npm start
```

`npx playwright install --with-deps chromium` is required after every Playwright version change and on every new server/image. A missing browser executable produces a `500` response; it is not an n8n workflow error.

For a managed service, run it with the supplied PM2 configuration:

```bash
pm2 start ecosystem.config.js
pm2 save
```

## Health check and recovery

```bash
curl --fail http://127.0.0.1:3000/health
```

The response includes `browserConnected` and `queueLength`. `browserConnected: false` before the first search is normal because the browser launches lazily. If searches repeatedly return a Playwright `Page crashed` error:

1. Confirm the Chromium installation command above completed successfully.
2. Check memory and kernel OOM logs (`free -h`, `dmesg -T | tail`). Give the scraper sufficient memory; the service processes one request at a time.
3. Restart the service (`pm2 restart googlemaps-scraper` or restart the container). The service automatically recreates the browser once for each retry after a page crash.
4. Do not run more than one instance against the same low-memory host unless each has an explicit resource limit.

## Behaviour

- The service blocks image, media, and font requests and uses a 1280×720 viewport to reduce Chromium renderer memory usage.
- A `Page crashed`/closed-target error recycles the whole browser process before retrying. Reloading a crashed Page is intentionally avoided because it cannot recover.
- Tune `MAX_RETRIES`, `RETRY_DELAY`, `TIMEOUT`, and `HEADLESS` in `.env`; restart the service after changing them.
