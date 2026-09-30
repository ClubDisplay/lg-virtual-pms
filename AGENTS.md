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
7. **Dagelijks herhalend:** na elke checkout plant de pagina automatisch opnieuw voor de volgende dag (ook zonder paginareload). Een `lastCheckoutDay`-guard voorkomt een dubbele checkout op dezelfde dag. Een TV die aan blijft staan checkt dus elke dag uit.

## PCC widget

- **Altijd `<iframe>` gebruiken** — `<object>` en `<script>` tags werken niet op alle LG TV modellen
- **Geen apps vernietigen** bij checkout — `idcap://tv/checkout/request` wist alleen gast-sessies, alle apps (Netflix, YouTube, KPN, NexoTV etc.) blijven intact
- Widget code voorbeeld:
  ```html
  <iframe src="https://pms.clubdisplay.nl/?key=APIKEY&hour=11&min=0" sandbox="allow-scripts allow-same-origin" style="width:100%;height:100%;border:none"></iframe>
  ```
- **Het grijze "This content is blocked. Contact the site owner to fix the issue."-vlak in de Pro:Centric Cloud *editor-preview* is normaal en geen fout.** De editor serveert een CSP **zonder `frame-src`** (valt terug op `default-src 'self' *.lgbusinesscloud.com *.amazonaws.com ...`), dus externe iframes worden in de preview geblokkeerd. Bewezen met headless Chrome: *"Framing 'https://pms.clubdisplay.nl/' violates the following Content Security Policy directive ... 'frame-src' was not explicitly set, so 'default-src' is used as a fallback."* Dit raakt **alleen de preview in de editor**; op de echte TV laadt de iframe wél (bewijs: TV's registreren zich via `/api/checkout/register` en checken uit). Negeer het grijze vlak; test op een echte TV of open de URL direct.

## Belangrijke nuances

- **Express 5** — route wildcards (`/admin*`) werken niet; gebruik `/:page` of losse routes
- **SQLite** — ALTER TABLE faalt als kolom al bestaat; altijd in try-catch
- **IDCAP SDK** werkt alleen op LG webOS TV; op desktop browser gooit het errors (worden gevangen)
- **Body checkout pagina** staat `display:none` in CSS; alleen zichtbaar met `?debug=on`
- **API key per klant** — uniek, resetbaar via dashboard; zonder geldige key werkt checkout niet
- **SQLite + better-sqlite3: gebruik ENKELE quotes** voor string-literals (`datetime('now','localtime')`). Dubbele quotes (`datetime("now","localtime")`) worden als kolomnamen gezien → `no such column: now` en de query faalt stil. Dit was de oorzaak van de `last_checkout`-bug (zie Geschiedenis).
- **Checkouts zijn afhankelijk van TV-activiteit** — een TV die uit staat of niet op de checkout-pagina staat, checkt niet uit. Het aantal checkouts per dag is dus lager dan het aantal gekoppelde TV's; over een week checken alle actieve TV's minstens één keer uit.

## Commando's

```bash
npm start          # Start server (PORT=80 voor productie)
pm2 start ecosystem.config.cjs  # Productie met PM2
```

## Deploy

- Draait op Hetzner VM (`91.99.115.169`) met PM2 + systemd auto-start
- Git push naar `main` → pull op VM → `pm2 restart virtual-pms`
- Database: `data/pms.db` (WAL mode)
- **Tijdzone server = `Europe/Amsterdam`** — de code gebruikt overal `datetime('now','localtime')`. Staat de VM op UTC, dan wijken alle tijden 1-2 uur af. Instellen: `timedatectl set-timezone Europe/Amsterdam` + `pm2 restart virtual-pms`.

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

## Geschiedenis / opgeloste issues

### 2026-09-30

1. **SSL-certificaat verlopen** (iframe toonde *"This content is blocked"*). Oorzaak: certbot gebruikte de `standalone`-plugin en wilde poort 80 binden, maar de app draait zelf op poort 80 → renewal faalde elke 6 uur met `Address already in use` → cert verliep op 31 aug. **Fix:** renewal omgezet naar **webroot** (`/.well-known` geserveerd vanaf `/var/www/certbot`) + `renew_hook` die PM2 herstart. Zie *SSL / certificaten*.
2. **`last_checkout` werd nooit opgeslagen.** Oorzaak: `datetime("now","localtime")` met dubbele quotes in `server.js` → `no such column: now`. De checkout-log werd wél geschreven, maar de TV-status-update faalde bij élke checkout. **Fix:** enkele quotes. Historische `last_checkout` uit `checkout_logs` teruggezet (56/71 TV's).
3. **Tijdzone.** Server stond op UTC terwijl de code `datetime('now','localtime')` gebruikt → alle tijden 1-2 uur te vroeg (checkout 09:00 i.p.v. 11:00). **Fix:** VM op `Europe/Amsterdam` + bestaande timestamps +2 uur gemigreerd (backup in `data/backups/`, marker in tabel `_migrations`).
4. **Checkout nu dagelijks herhalend** i.p.v. eenmalig per paginareload (met dubbel-checkout-guard). Zie *Checkout flow* stap 7.
5. **Pro:Centric editor-CSP** onderzocht → grijze vlak is alleen de editor-preview, TV's werken. Zie *PCC widget*.

### Aandachtspunten voor later

- De **laatste 8 TV's van Magnifigue X** (van 19) waren nog niet geregistreerd toen ze werden geïnstalleerd; ze registreren zich zodra ze de portal-pagina laden (uit/aan). `tv_limit` = 19, dus er is ruimte.
- 4 oudere TV's (2× Anna House, 2× De Smulpot, waarvan 1 test-TV `tv-test-manual`) hebben **nooit** uitgecheckt — even controleren of die nog actief zijn.
- Bij een **nieuw (sub)domein** voor de checkout: voeg het toe aan het certbot-certificaat én check dat het niet in de Pro:Centric-CSP hoeft (alleen editor-preview).
