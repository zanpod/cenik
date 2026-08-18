# Demo provisioning — hitro ustvarjanje demo e-cenikov

Orodje za pošiljanje potencialnim strankam (kavarne, bari, restavracije) demo
e-cenikov z njihovim imenom, barvami in izdelki — v nekaj minutah, brez
ročnega klikanja po adminu.

> **Če ne uporabljate terminala/Node.js:** za vsakodnevno ustvarjanje demotov
> uporabite obrazec na **agencijaepo.si/demo** (gumb "+ Nov demo") — deluje v
> celoti prek Supabase Edge Functions (`supabase/functions/provision-demo` in
> `delete-demo`), ki jih namestite enkrat prek Supabase Dashboard (brez CLI,
> brez terminala) — glej komentar na vrhu vsake od teh dveh datotek za točna
> navodila. Preostanek tega dokumenta opisuje CLI različico (`node
> provision.js ...`), ki je namenjena tistim, ki imajo raje ukazno vrstico.

Teče **lokalno v Node.js**, s Supabase **service role** ključem iz `.env`, ki
piše mimo RLS. Ključ nikoli ne gre v frontend kodo ali v git.

## 1. Namestitev (enkratno)

```bash
cd scripts/demo
npm install
cp .env.example .env
```

Uredite `.env`:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — Supabase Dashboard → Project
  Settings → API (service_role je pod "Project API keys", **ne** anon key).
- `APP_DOMAIN` — domena, kjer je meni v živo (uporabi se v povezavah in QR
  kodah, npr. `https://demo.agencijaepo.si` — poddomena, ki dejansko streže
  cenik sistemu; glej opombo o domeni v glavnem README.md).

Nato v Supabase SQL Editorju enkrat zaženite
`supabase/migrations/010_demo_tenants.sql` (doda stolpec `tenants.is_demo` in
funkcijo za čiščenje naročil) — če tega še niste storili.

## 2. Ustvarjanje novega demota

1. Skopirajte `examples/kavarna-vahtnca.json` v novo datoteko, npr.
   `demos/moja-stranka.json`, in izpolnite podatke o lokalu:

   ```json
   {
     "slug": "kavarna-vahtnca",
     "name": "Kavarna VAHTNCA",
     "primary_color": "#8B5A2B",
     "logo_url": "",
     "categories": [
       { "name": "Tople pijače", "icon": "☕", "items": [
         { "name": "Espresso", "price": 1.60 },
         { "name": "Cappuccino", "price": 2.20 }
       ]}
     ],
     "tables": 6
   }
   ```

   - `slug` — samo male črke, številke in vezaji (uporabi se v URL-ju).
   - `logo_url` — neobvezno (URL do slike; pustite prazno, če ga (še) nimate).
   - `secondary_color`, `currency` — neobvezna, imata privzeto vrednost.
   - `tables` — koliko miz (QR kod) naj se ustvari (privzeto 4).

2. Poženite:

   ```bash
   node provision.js demos/moja-stranka.json
   ```

   Skript ustvari (ali posodobi, če `slug` že obstaja) lokal, kategorije in
   izdelke, poskrbi da obstaja dovolj miz, ter izpiše povezave za vsako mizo
   in shrani QR kodo glavne mize kot PNG v `scripts/demo/demos/<slug>-qr.png`.

   Ponovni zagon z isto datoteko je varen: lokal, kategorije in izdelki se
   osvežijo (uporabno, če popravite cene), obstoječe mize in njihovi QR žetoni
   pa ostanejo nespremenjeni — poslane QR kode ne prenehajo delovati.

3. Pošljite stranki glavno povezavo in/ali priložite `<slug>-qr.png`.

## 3. Seznam demo lokalov

```bash
node list.js
```

Izpiše vse lokale z `is_demo = true`: ime, slug, datum kreiranja in glavno
povezavo (miza z najnižjo številko).

## 4. Brisanje demota

```bash
node delete.js <slug>
```

Vpraša za potrditev in nato izbriše lokal ter vse povezane podatke (kategorije,
izdelke, mize, naročila, račune) prek `ON DELETE CASCADE`. Za neinteraktivno
uporabo dodajte `--yes`. Orodje **zavrne** brisanje lokala, ki ni označen kot
demo (`is_demo = false`), da po nesreči ne izbrišete prave stranke.

## 5. Zaščita demo lokalov

- Demo meni deluje normalno — gost lahko brska in odda naročilo, da vidi celo
  izkušnjo.
- Na meniju je diskreten napis "DEMO — primer za [ime lokala]" (vklopi se
  samodejno za lokale z `is_demo = true`, glej `js/menu.js` / `css/menu.css`).
- Testna naročila demo lokalov se **ne kopičijo v nedogled**: poženite občasno

  ```bash
  node cleanup-orders.js       # briše naročila starejša od 24 ur
  node cleanup-orders.js 6     # ali izberite drugo mejo (v urah)
  ```

  To pokliče SQL funkcijo `cleanup_demo_orders()`, ki briše naročila SAMO
  lokalov z `is_demo = true` — prave stranke niso prizadete. Če ima vaš
  Supabase plan na voljo razšeritev `pg_cron`, lahko isto funkcijo razporedite
  neposredno v bazi (glej komentar na vrhu
  `supabase/migrations/010_demo_tenants.sql`), tako da čiščenje teče samodejno
  brez ročnega poganjanja tega skripta.
