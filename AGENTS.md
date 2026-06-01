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
6. Om checkout-tijd: `destroyAllApplications()` via IDCAP, dan `idcap://tv/checkout/request`

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
