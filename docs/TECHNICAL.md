# EPO.SI — Tehnična dokumentacija

Ta dokument je tehnična referenca za razvijalce projekta **EPO.SI** —
večnajemniškega (multi-tenant) digitalnega menija in sistema za naročanje za
mize v barih, restavracijah in kavarnah. Za hitra navodila za namestitev glej
[`README.md`](../README.md); ta dokument opisuje arhitekturo, podatkovni
model, varnostni model in posamezne module v večji podrobnosti.

## Kazalo

1. [Pregled arhitekture](#1-pregled-arhitekture)
2. [Tehnološki sklad](#2-tehnološki-sklad)
3. [Struktura repozitorija](#3-struktura-repozitorija)
4. [Podatkovni model](#4-podatkovni-model)
5. [Varnost in več-najemništvo (RLS)](#5-varnost-in-več-najemništvo-rls)
6. [Toki podatkov](#6-toki-podatkov)
7. [Frontend moduli (JS)](#7-frontend-moduli-js)
8. [Realnočasovne (Realtime) povezave](#8-realnočasovne-realtime-povezave)
9. [Račune in fiskalizacija (FURS)](#9-računi-in-fiskalizacija-furs)
10. [Konfiguracija in okoljske spremenljivke](#10-konfiguracija-in-okoljske-spremenljivke)
11. [Namestitev / razvojno okolje](#11-namestitev--razvojno-okolje)
12. [PWA in offline podpora](#12-pwa-in-offline-podpora)
13. [Testiranje](#13-testiranje)
14. [Znane omejitve in zasnovne odločitve](#14-znane-omejitve-in-zasnovne-odločitve)

---

## 1. Pregled arhitekture

Aplikacija nima lastnega strežniškega backenda — vsa poslovna logika, ki
zahteva zaupanje (npr. spremljanje zaloge, omejevanje hitrosti naročanja,
izdaja računov), je implementirana neposredno v **PostgreSQL** kot funkcije,
sprožilce (triggers) in RLS politike znotraj **Supabase**. Frontend je čist
HTML/CSS/JavaScript brez gradnikov in brez build koraka, ki preko Supabase JS
SDK (PostgREST + Realtime + Storage + Auth) komunicira neposredno z bazo.

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│        Brskalnik         │        │           Supabase            │
│                          │        │                              │
│  /menu/index.html  ──────┼───────▶│  PostgREST (REST nad tabelami) │
│   (gost, brez prijave)   │        │  RPC funkcije (izdaja računov) │
│                          │        │  Realtime (WebSocket)          │
│  /admin/*.html      ─────┼───────▶│  Auth (e-poštna prijava)       │
│   (osebje, prijavljeno)  │        │  Storage (slike menija)        │
│                          │◀───────┼  Edge Functions (FURS)         │
└─────────────────────────┘        └──────────────────────────────┘
```

Ključna posledica te zasnove: **varnost in poslovna pravila se ne zanašajo na
frontend kodo**. Tudi če bi nekdo poskušal poklicati API mimo strani, ga RLS
politike in `SECURITY DEFINER` funkcije omejujejo na enak način.

## 2. Tehnološki sklad

| Plast | Tehnologija |
|---|---|
| Frontend | Vanilla HTML5 / CSS3 / ES6 JavaScript (brez ogrodij, brez bundlerja) |
| Odjemalec do baze | [`@supabase/supabase-js`](https://github.com/supabase/supabase-js) v2 (naloženo prek CDN v `index.html`/straneh) |
| Baza | PostgreSQL (gostuje Supabase) z Row Level Security |
| Avtentikacija | Supabase Auth (e-poštno geslo) |
| Realni čas | Supabase Realtime (WebSocket replication na `orders`, `order_items`) |
| Datotečna shramba | Supabase Storage (bucket `menu-images`, javno berljiv) |
| Strežniška logika brez lastnega strežnika | Supabase Edge Functions (Deno) — FURS fiskalizacija |
| QR kode | `qrcodejs` (CDN), generirane na strani admin/Mize |
| Gostovanje | Netlify (statični hosting, `publish = "."`) |
| PWA / offline | Service Worker (`sw.js`) + `manifest.webmanifest` |

Ni `package.json`, ni npm odvisnosti, ni build pipeline-a — vse JS/CSS
datoteke se strežejo takšne, kot so.

## 3. Struktura repozitorija

```
/
├── index.html                  Pristajalna stran
├── manifest.webmanifest        PWA manifest
├── sw.js                       Service Worker (offline cache)
├── netlify.toml / _redirects   Netlify konfiguracija in URL preusmeritve
│
├── menu/
│   └── index.html              Meni za gosta + košarica + oddaja naročila
│
├── admin/
│   ├── index.html               Prijava
│   ├── dashboard.html            Žive naročila (realtime), tiskanje bonov
│   ├── new-order.html            Ročni vnos naročila (osebje)
│   ├── menu.html                 Urejanje menija (kategorije, postavke, slike)
│   ├── tables.html                Mize + generiranje/prenos QR kod
│   ├── inventory.html             Zaloga (sestavine, recepti, prevzemi)
│   ├── orders.html                Zgodovina naročil + izdani računi
│   └── settings.html              Nastavitve lokala, osebje, FURS
│
├── js/                          Logika posamezne strani (glej poglavje 7)
├── css/                         common.css, menu.css, admin.css
├── assets/                      Logo, ikone, notification.wav
│
└── supabase/
    ├── schema.sql               Osnovna shema, RLS, storage, realtime
    ├── seed.sql                 Demo lokal "Bar Lipa" s testnimi podatki
    ├── setup.sql                Združen skript (shema + vse migracije)
    ├── migrations/               Inkrementalne SQL migracije 002–009
    └── functions/                Supabase Edge Functions (Deno/TypeScript)
        ├── furs-register-premise/index.ts
        ├── furs-fiscalize/index.ts
        ├── _shared/furs.ts
        └── README.md             Navodila za FURS fiskalizacijo (TEST→PROD)
```

## 4. Podatkovni model

Vse tabele (razen `auth.users`, ki je Supabase-ova) so v shemi `public` in
imajo `tenant_id` za izolacijo med najemniki.

### Osrednje tabele (`schema.sql`)

| Tabela | Namen | Pomembni stolpci |
|---|---|---|
| `tenants` | En zapis = en lokal | `slug` (URL identifikator), `logo_url`, `primary_color`/`secondary_color`, `currency`, `sound_enabled`, `is_active`, davčni podatki (`business_name`, `tax_number`, `vat_registered`, `default_vat_rate`, `receipt_width`, `fiscal_enabled`) |
| `categories` | Kategorije menija | `tenant_id`, `name`, `icon` (emoji), `sort_order`, `is_active` |
| `menu_items` | Postavke menija | `category_id`, `name`, `description`, `price`, `image_url`, `is_available`, `allergens`, `track_stock`, `stock_quantity`, `vat_rate`, `prep_station` (kuhinja/bar), `variants` (JSONB) |
| `tables` | Fizične mize | `table_number`, `label`, `qr_code_token` (unikaten, vgrajen v URL QR kode), `is_active` |
| `orders` | Naročila | `table_id`, `status` (`new` → `preparing` → `served`, ali `cancelled`), `notes`, `total`, `created_at`/`updated_at` |
| `order_items` | Postavke naročila | `order_id`, `menu_item_id`, **denormalizirano** `item_name`/`item_price` (zgodovina se ne spremeni, če se meni kasneje spremeni), `quantity`, `notes` |
| `profiles` | Uporabniki osebja | `id` = FK na `auth.users.id`, `tenant_id`, `full_name`, `role` (`owner`/`admin`/`staff`), `staff_code`, `tax_number` |

### Izdaja računov (migracije 002, 005, 006, 008, 009)

| Tabela | Namen |
|---|---|
| `invoices` | Izdan račun: `invoice_number`/`seq` (zaporedna številka), `seller_*` (podatki izdajatelja), `payment_method`, `net_total`/`vat_total`/`gross_total`, `vat_breakdown` (JSONB po stopnjah DDV), `items` (JSONB — denormalizirana kopija postavk), `discount_pct`, `tip_amount`, `amount_cash`/`amount_card`/`amount_other` (razdeljeno plačilo), `doc_type` (`normal`/`storno`), `is_fiscal`, `zoi`/`eor` (FURS identifikatorji) |
| `invoice_counters` | Zaporedna numeracija računov po lokalu/blagajni |

### Zaloga in recepti (migracije 003, 004)

| Tabela | Namen |
|---|---|
| `ingredients` | Surovine: `unit` (g/ml/kos), `stock_quantity`, `low_threshold`, `purchase_price`, `sale_price` |
| `item_ingredients` | Recept: koliko posamezne sestavine porabi ena postavka menija |
| `ingredient_movements` | Knjiga gibanj zaloge: `delta`, `reason` (`intake`/`sale`/`cancel`/`adjust`), povezava na `order_id` |

### Sprožilci (triggers)

- `orders_set_updated_at` — samodejno posodobi `updated_at` ob spremembi naročila.
- `order_items_decrement_stock` — ob vstavitvi postavke naročila zmanjša zalogo končnega izdelka **in** sestavin po receptu.
- `orders_restock_on_cancel` — ob preklicu naročila povrne zalogo (obratna gibanja).
- `orders_rate_limit` — varnostni ukrep: največ 5 naročil na mizo v 20 sekundah (preprečuje zlorabo anonimnega vstavljanja).
- `invoices_fill_operator` — samodejno vpiše kodo/ime operaterja (osebja) ob izdaji računa.

### RPC funkcije (klicane prek `supabase.rpc(...)`)

- `issue_invoice(p_order_id, p_payment_method)` — izda račun za celotno naročilo.
- `issue_invoice_for_quantities(p_lines, p_discount_pct, p_cash, p_card, p_tip)` — delna/razdeljena izdaja računa po izbranih količinah postavk.
- `storno_invoice(p_invoice_id)` — razveljavi (stornira) že izdan račun.

## 5. Varnost in več-najemništvo (RLS)

Vsaka tabela ima vklopljen **Row Level Security**. Izolacija med najemniki ni
implementirana v aplikacijski kodi, temveč izključno v bazi:

- Pomožna funkcija `current_tenant_id()` prebere `tenant_id` prijavljenega
  uporabnika iz `profiles` in jo uporabljajo vse politike za osebje.
- Pomožna funkcija `current_user_role()` se uporablja za omejitev nekaterih
  akcij (npr. povabilo novega osebja) samo na `owner`/`admin`.

**Anonimni gostje** (brez prijave):
- Lahko **berejo** aktivne lokale, kategorije, postavke menija in mize (samo
  `is_active = true` zapise).
- Lahko **vstavljajo** (`INSERT`) v `orders` in `order_items`, vendar ne morejo
  brati ali spreminjati obstoječih naročil.
- Veljavnost mize se preverja prek `qr_code_token`, ki je del URL-ja menija.

**Prijavljeno osebje**:
- Vidi in ureja **izključno** podatke svojega `tenant_id` (prek
  `current_tenant_id()` v vseh RLS politikah).
- Vloga `staff` ima na frontend strani omejen dostop (glej `js/admin-auth.js`)
  — preusmerjen je na nadzorno ploščo, če poskusi odpreti Meni/Zalogo/
  Mize/Zgodovino/Nastavitve. To je UX zaščita; resnično zaupanja vredna meja
  je RLS v bazi.

**Storage**: bucket `menu-images` je javno berljiv, pisanje/urejanje/brisanje
pa zahteva avtentikacijo.

## 6. Toki podatkov

### Gost → naročilo

1. Gost skenira QR kodo → odpre `/menu/<slug>?table=<qr_code_token>`.
2. `js/menu.js` preveri `tenants` po `slug` in `tables` po `qr_code_token` +
   `tenant_id` (oba morata biti `is_active = true`).
3. Naloži `categories` in `menu_items` za ta `tenant_id`.
4. Gost dodaja postavke v košarico (`js/cart.js`, shranjena v `localStorage`,
   ločeno po mizi).
5. Ob oddaji: `INSERT` v `orders` (status `new`), nato `INSERT` več vrstic v
   `order_items` (z denormaliziranimi `item_name`/`item_price`).
6. Sprožilec `order_items_decrement_stock` samodejno zniža zalogo.

### Naročilo → osebje → račun

1. `js/dashboard.js` se naroči na Supabase Realtime kanal, filtriran po
   `tenant_id`; ob `INSERT`/`UPDATE` na `orders` ali `INSERT` na `order_items`
   se nadzorna plošča takoj posodobi, zaigra se zvok in prikaže sistemsko
   obvestilo.
2. Osebje naročilo potrdi (`status` → `preparing`), natisne bon po postaji
   (kuhinja/bar prek `prep_station`), nato ob postrežbi (`status` → `served`).
3. Ob zaključku mize osebje izda račun (`js/invoice.js`) prek RPC
   `issue_invoice`/`issue_invoice_for_quantities` — podpira razdeljeno
   plačilo (gotovina/kartica/drugo), popust in napitnino.
4. Če je `tenants.fiscal_enabled = true`, se račun po izdaji potrdi pri FURS
   (glej poglavje 9); sicer je račun oznanjen kot testni/nepotrjen.

## 7. Frontend moduli (JS)

| Datoteka | Stran | Vloga |
|---|---|---|
| `supabase-config.js` | vse | Inicializacija Supabase odjemalca, branje konfiguracije (URL/anon key/domena) |
| `common.js` | vse | Skupni pripomočki: toast obvestila, formatiranje cen/datumov, branding, registracija service workerja |
| `cart.js` | meni | Košarica gosta v `localStorage`, ločena po mizi |
| `menu.js` | meni | Nalaganje menija, preverjanje mize/lokala, oddaja naročila |
| `admin-auth.js` | admin | Zaščita prijave, `AdminShell` (stranska vrstica, navigacija, odjava), omejitev dostopa po vlogi |
| `dashboard.js` | admin/dashboard | Žive naročila, Realtime naročnine, tiskanje bonov po postajah |
| `new-order.js` | admin/new-order | Ročni vnos naročila s strani osebja (npr. naročilo po telefonu) |
| `menu-manage.js` | admin/menu | Urejanje kategorij, postavk, variant, slik (nalaganje v Storage) |
| `tables.js` | admin/tables | Upravljanje miz, generiranje in prenos QR kod |
| `inventory.js` | admin/inventory | Sestavine, recepti, prevzemi blaga, popis zaloge |
| `invoice.js` | admin (dashboard/orders) | Izdaja/razdelitev/storniranje računov, tiskanje |
| `orders-history.js` | admin/orders | Zgodovina naročil in izdanih računov |
| `settings.js` | admin/settings | Nastavitve lokala, brending, osebje, FURS stikalo in registracija poslovnega prostora |

## 8. Realnočasovne (Realtime) povezave

Nadzorna plošča (`dashboard.js`) odpre Supabase Realtime kanal po
`tenant_id` in posluša:

```
postgres_changes  INSERT/UPDATE na "orders"      filter: tenant_id=eq.<id>
postgres_changes  INSERT       na "order_items"  filter: tenant_id=eq.<id>
```

Ob dogodku se UI posodobi brez ponovnega nalaganja strani, zaigra
`assets/notification.wav` (s sintetiziranim Web Audio API fallbackom, če
datoteka ne naloži), in po dovoljenju prikaže sistemsko (`Notification API`)
obvestilo. Naročila starejša od 24 ur se na živi plošči ne prikazujejo več
(na voljo so v `admin/orders.html` — Zgodovina).

## 9. Računi in fiskalizacija (FURS)

Davčno potrjevanje računov po slovenskem **ZDavPR** je implementirano kot dve
Supabase Edge Funkciji (Deno/TypeScript):

| Funkcija | Namen |
|---|---|
| `furs-register-premise` | Enkratna registracija poslovnega prostora pri FURS (pred prvim računom) |
| `furs-fiscalize` | Potrditev posameznega računa → vrne ZOI, EOR in QR kodo, posodobi `invoices` |

Privzeto je fiskalizacija **izklopljena** (funkcija vrne `501`), dokler
skrivnost `FURS_ENABLED` ni `true` in ni nastavljen digitalni certifikat
(`FURS_PRIVATE_KEY_PEM`, `FURS_CERT_PEM`, neobvezno `FURS_CA_PEM`). Stikalo
`tenants.fiscal_enabled` v Nastavitvah določa, ali aplikacija sploh poskuša
klicati fiskalizacijo za ta lokal.

Podroben korak-za-korakom vodnik (TEST → PRODUKCIJA, pridobitev certifikata,
odpravljanje napak) je v [`supabase/functions/README.md`](../supabase/functions/README.md).

## 10. Konfiguracija in okoljske spremenljivke

Projekt **ne uporablja `.env` datotek**. Konfiguracija frontenda je v
`js/supabase-config.js`:

```js
const SUPABASE_URL = window.EPO_SUPABASE_URL || '<privzeti demo URL>';
const SUPABASE_ANON_KEY = window.EPO_SUPABASE_ANON_KEY || '<privzeti demo anon key>';
const APP_DOMAIN = window.EPO_APP_DOMAIN || location.origin;
```

Te vrednosti se lahko nastavijo na tri načine:
1. Neposredno urejanje `js/supabase-config.js`.
2. Nastavitev `window.EPO_SUPABASE_URL`/`EPO_SUPABASE_ANON_KEY`/`EPO_APP_DOMAIN`
   (npr. prek Netlify snippet injection, brez spreminjanja repozitorija).
3. Per-tenant nastavitve (barve, valuta, davčni podatki, širina tiskalnika
   računov) se urejajo v `admin/settings.html` in shranjujejo v `tenants`.

Skrivnosti za Edge Funkcije (FURS) se nastavljajo z `supabase secrets set ...`
(glej poglavje 9) — niso del frontend kode in se ne smejo nikoli commitati.

## 11. Namestitev / razvojno okolje

Ni build koraka. Za lokalni razvoj:

```bash
python -m http.server 8000   # ali kateri koli statični strežnik
```

Priprava baze (v Supabase SQL Editor, po vrsti — ali enkratno z `setup.sql`,
ki združuje vse spodnje):

1. `supabase/schema.sql` — osnovne tabele, RLS, storage bucket, realtime.
2. `supabase/seed.sql` — demo lokal "Bar Lipa" (neobvezno).
3. `supabase/migrations/002_invoices.sql` … `009_pos_final.sql` — po vrstnem redu.

Za FURS Edge Funkcije: `supabase functions deploy furs-register-premise` in
`supabase functions deploy furs-fiscalize` (Supabase CLI).

## 12. PWA in offline podpora

- `manifest.webmanifest` + ikoni (`icon-192.png`, `icon-512.png`) omogočajo
  namestitev na mobilni zaslon.
- `sw.js` uporablja **network-first** strategijo za isti izvor (GET): poskusi
  omrežje, ob neuspehu vrne predpomnjeno verzijo. Cross-origin klici (Supabase
  API, CDN skripte) se nikoli ne predpomnijo — vedno gredo prek omrežja.
- Brskanje po meniju deluje offline (predpomnjene strani/sredstva), oddaja
  naročila pa zahteva povezavo (zapis v bazo).

## 13. Testiranje

Projekt nima avtomatiziranih testov (ni testnega ogrodja, ni testne mape).
Priporočeni ročni testni scenariji:

1. **Gost**: odpri `/menu/<slug>?table=<qr_token>` → dodaj postavke → oddaj
   naročilo → preveri, da se naročilo prikaže na nadzorni plošči v realnem
   času.
2. **Osebje**: prijava → `dashboard.html` → potrdi naročilo → natisni bon →
   izdaj račun → preveri pravilen izračun DDV in skupnega zneska.
3. **Zaloga**: dodaj sestavino z receptom → oddaj naročilo postavke, ki jo
   uporablja → preveri samodejno znižanje zaloge; prekliči naročilo → preveri
   povrnitev zaloge.
4. **Fiskalizacija** (če je konfigurirana): izdaj račun s `fiscal_enabled =
   true` → preveri prisotnost `zoi`/`eor` na zapisu računa.
5. **Več-najemništvo**: preveri, da prijavljen uporabnik lokala A ne vidi
   nobenih podatkov lokala B (mize, naročila, postavke menija).

## 14. Znane omejitve in zasnovne odločitve

- **Brez build koraka**: hitrejše iteracije, preprosto gostovanje, a brez
  minifikacije/bundlinga in brez TypeScript preverjanja na frontendu.
- **Denormalizirani podatki** (`order_items.item_name`/`item_price`,
  `invoices.items`): zgodovina naročil in računov se ne spremeni, če se meni
  kasneje uredi ali izbriše postavka.
- **`SECURITY DEFINER` funkcije/sprožilci**: omogočajo, da tudi anonimni gost
  (brez prijave) sproži operacije, ki zahtevajo višje pravice (npr. znižanje
  zaloge), brez da bi gost imel neposreden dostop do teh tabel.
- **Vse poslovne omejitve so v bazi (RLS), ne v frontendu** — frontend
  preverjanja (npr. omejitev vlog v `admin-auth.js`) so zgolj UX, ne varnostna
  meja.
- **Slovenski trg**: jezik, časovni pas (`Europe/Ljubljana`), valuta in fiskalna
  skladnost (ZDavPR/ZDDV-1) so vgrajeni kot privzeti, ne kot konfigurabilna
  internacionalizacija.
