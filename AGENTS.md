# Virtual PMS

LG webOS auto-checkout systeem met beheerdashboard.

## Architectuur

- **server.js** — Express 5 backend, start met `npm start` (poort via `PORT` env, default 3000)
- **app/index.html** — Checkout-pagina voor in PCC iframe; gebruikt `idcap.js` (LG IDCAP SDK) voor webOS communicatie
- **app/dashboard/** — SPA beheerpaneel (vanilla JS), geserved op `/admin/`
- **db/database.js** — SQLite via `better-sqlite3`, database in `data/pms.db`

## API endpoints

| Endpoint | Auth | Functie |
|---|---|---|
| `POST /api/login` | Nee | Inloggen (sessie) |
| `GET/POST /api/customers` | Sessie | Klanten CRUD |
| `GET /api/customers/:id/tvs` | Sessie | TV's per klant |
| `POST /api/customers/:id/regenerate-key` | Sessie | Nieuwe API key |
| `POST /api/checkout/register` | API key | Auto-registreer TV (device_id via localStorage) |
| `GET /api/checkout/validate` | API key | Valideer key voor iframe |
| `POST /api/checkout/log` | API key | Log checkout resultaat |
| `GET /api/logs` | Sessie | Alle checkout logs |

## Checkout flow (iframe kant)

1. Pagina laadt in TV browser via PCC iframe
2. `init()` genereert/stored `device_id` in localStorage
3. Valideert `?key=` via `/api/checkout/validate`
4. Registreert TV via `/api/checkout/register`
5. Plan checkout op `?hour=&min=` (default 11:00)
6. Om checkout-tijd: `idcap://tv/checkout/request` (gast-sessies wissen, apps blijven intact)

## PCC widget

- **Altijd `<iframe>` gebruiken** — `<object>` en `<script>` tags werken niet op alle LG TV modellen
- **Geen apps vernietigen** bij checkout — `idcap://tv/checkout/request` wist alleen gast-sessies, alle apps (Netflix, YouTube, KPN, NexoTV etc.) blijven intact
- Widget code voorbeeld:
  ```html
  <iframe src="https://pms.clubdisplay.nl/?key=APIKEY&hour=11&min=0" sandbox="allow-scripts allow-same-origin" style="width:100%;height:100%;border:none"></iframe>
  ```

## Belangrijke nuances

- **Express 5** — route wildcards (`/admin*`) werken niet; gebruik `/:page` of losse routes
- **SQLite** — ALTER TABLE faalt als kolom al bestaat; altijd in try-catch
- **IDCAP SDK** werkt alleen op LG webOS TV; op desktop browser gooit het errors (worden gevangen)
- **Body checkout pagina** staat `display:none` in CSS; alleen zichtbaar met `?debug=on`
- **API key per klant** — uniek, resetbaar via dashboard; zonder geldige key werkt checkout niet

## Commando's

```bash
npm start          # Start server (PORT=80 voor productie)
pm2 start ecosystem.config.cjs  # Productie met PM2
```

## Deploy

- Draait op Hetzner VM (`91.99.115.169`) met PM2 + systemd auto-start
- Git push naar `main` → pull op VM → `pm2 restart virtual-pms`
- Database: `data/pms.db` (WAL mode)

## SSL / certificaten

- **Let's Encrypt via certbot (snap)**, domein `pms.clubdisplay.nl`, ECDSA.
- `server.js` leest het certificaat bij **opstarten** uit `/etc/letsencrypt/live/${DOMAIN}/` en draait zelf HTTP (80) én HTTPS (443). Er is géén nginx.
- Renewal gebruikt **webroot** (niet standalone!): de app serveert `/.well-known/acme-challenge` vanaf `/var/www/certbot`. Reden: poort 80 is door de app zelf in gebruik, dus de standalone-plugin faalde met `Address already in use` en het cert verliep.
- Na renewal herstart `renew_hook` (`/usr/local/bin/pms-cert-reload.sh`) automatisch PM2, zodat het nieuwe cert wordt ingelezen. Log: `/var/log/pms-cert-reload.log`.
- Handmatig testen: `certbot renew --dry-run` en `certbot certificates`.
- Extra (sub)domein toevoegen: `certbot certonly --webroot -w /var/www/certbot -d pms.clubdisplay.nl -d nieuw.domein.nl`.
- **Geen `X-Frame-Options`/CSP zetten** op de checkout-pagina — die moet in een iframe op de PCC-portal kunnen laden.

## Locale ontwikkeling

- **Project NIET in iCloud Drive** — native modules (better-sqlite3) falen door sync-timeouts
- Werk vanuit `~/Projects/Virtual-PMS` (gekopieerd uit iCloud)
- **Gebruik Node 22** (`/opt/homebrew/opt/node@22/bin/node`) — Node 26 heeft geen prebuilt `better-sqlite3`
- Starten: `/opt/homebrew/opt/node@22/bin/node ~/Projects/Virtual-PMS/server.js`
- Dashboard op `http://localhost:3000/admin/` (admin/admin)
