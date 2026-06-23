# EPO.SI — Digitalni meni & naročanje za mizo

Multi-tenant digitalni meni in sistem za naročanje za bare, restavracije in
kavarne. Gost skenira QR kodo na mizi, brska po meniju in odda naročilo; osebje
naročila vidi v realnem času na admin nadzorni plošči, urejena po mizah.

> Podrobna tehnična dokumentacija (arhitektura, podatkovni model, varnost,
> moduli) je v [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

- **Frontend:** čisti HTML/CSS/JS (brez ogrodij, brez build koraka) → Netlify
- **Backend:** Supabase (PostgreSQL, Auth, Realtime, Storage)
- **Oblika:** temna tema, glassmorphism, modro-vijolični gradienti, mobile-first
- **Večnajemniško (multi-tenant):** ena koda + ena baza streže vsem lokalom,
  izolacija podatkov z Row Level Security (RLS)

## Struktura

```
/
├── index.html              -- Pristajalna stran
├── menu/index.html         -- Meni za gosta + naročanje
├── admin/                  -- Admin panel (prijava, nadzorna plošča, meni, mize, zgodovina, nastavitve)
├── css/                    -- common.css, menu.css, admin.css
├── js/                     -- supabase-config.js + logika strani
├── assets/                 -- notification.wav, logo.svg
├── supabase/schema.sql     -- Tabele, RLS, storage, realtime
├── supabase/seed.sql       -- Testni podatki (demo lokal "Bar Lipa")
├── netlify.toml / _redirects
```

## Namestitev

### 1. Supabase

1. Ustvarite nov Supabase projekt.
2. V **SQL Editor** zaženite `supabase/schema.sql` (ustvari tabele, RLS
   politike, `menu-images` storage bucket in vklopi Realtime na `orders` +
   `order_items`).
3. (Neobvezno) Zaženite `supabase/seed.sql` za demo lokal **Bar Lipa**.
4. V **Authentication → Providers** vklopite **Email** (geslo).
5. Ustvarite admin uporabnika (Authentication → Users → Add user) in ga
   povežite z lokalom — v `seed.sql` na dnu odkomentirajte `profiles` INSERT in
   vstavite `id` uporabnika iz `auth.users`.

### 2. Konfiguracija ključev

Uredite `js/supabase-config.js` in vnesite svoj **Project URL** in **anon
public key** (Project Settings → API). Anon ključ je javen — varujejo ga RLS
politike. Nastavite tudi `APP_DOMAIN` na vašo Netlify domeno (uporablja se v QR
kodah).

Alternativno lahko vrednosti vbrizgate prek `window.EPO_SUPABASE_URL`,
`window.EPO_SUPABASE_ANON_KEY` in `window.EPO_APP_DOMAIN` (npr. Netlify snippet
injection), brez urejanja datoteke.

### 3. Netlify

1. Povežite repozitorij ali povlecite mapo na Netlify.
2. Build ni potreben (`publish = "."`). `netlify.toml` / `_redirects` poskrbita
   za preusmeritev `/menu/*` na enotno stran menija.

## Uporaba

- **Gost:** `https://<domena>/menu/<slug-lokala>?table=<qr_code_token>`
  (QR kode generirate v admin panelu → Mize).
- **Osebje:** `https://<domena>/admin` → prijava → nadzorna plošča naročil v
  realnem času (zvočno + sistemsko obvestilo ob novem naročilu).

## Realni čas

Nadzorna plošča se naroči na Supabase Realtime za `orders` (INSERT/UPDATE) in
`order_items` (INSERT), filtrirano po `tenant_id`. Nova naročila se prikažejo
takoj, predvaja se zvonček (`assets/notification.wav`, s sintetiziranim Web
Audio fallbackom) in pokaže sistemsko obvestilo (če je dovoljeno).

## Opombe

- Cene postavk naročila so **denormalizirane** (`item_name`, `item_price` se
  shranita ob naročilu), tako da spremembe menija ne vplivajo na zgodovino.
- Časi se hranijo v UTC in prikazujejo v `Europe/Ljubljana`.
- Naročila starejša od 24 ur izginejo z žive plošče (vidna v Zgodovini).
- Vsa uporabniška besedila so v slovenščini.

## Varnost (RLS)

Vsaka tabela ima vklopljen RLS:
- Anonimni gostje lahko **berejo** aktivne lokale/kategorije/postavke/mize in
  **vstavljajo** naročila — ne morejo brati/spreminjati naročil.
- Prijavljeno osebje dostopa **samo** do podatkov svojega lokala (prek
  `profiles.tenant_id`), kar onemogoča dostop med najemniki.
