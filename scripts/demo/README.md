# Demo provisioning — quickly creating demo e-menus

A tool for sending prospective customers (cafes, bars, restaurants) demo
e-menus with their name, colors and products — in a few minutes, without
manually clicking through the admin panel.

> **If you don't use a terminal/Node.js:** for day-to-day demo creation,
> use the form at **agencijaepo.si/demo** (the "+ New demo" button) — it
> runs entirely through Supabase Edge Functions (`supabase/functions/provision-demo`
> and `delete-demo`), which you install once via the Supabase Dashboard (no
> CLI, no terminal) — see the comment at the top of each of those two files
> for exact instructions. The rest of this document describes the CLI version
> (`node provision.js ...`), intended for those who prefer the command line.

Runs **locally in Node.js**, using a Supabase **service role** key from `.env`,
which writes past RLS. The key never goes into frontend code or into git.

## 1. Installation (one-time)

```bash
cd scripts/demo
npm install
cp .env.example .env
```

Edit `.env`:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — Supabase Dashboard → Project
  Settings → API (service_role is under "Project API keys", **not** the anon key).
- `APP_DOMAIN` — the domain where the live menu is served (used in links and QR
  codes, e.g. `https://demo.agencijaepo.si` — the subdomain that actually serves
  the menu system; see the note about the domain in the main README.md).

Then, in the Supabase SQL Editor, run
`supabase/migrations/010_demo_tenants.sql` once (it adds the `tenants.is_demo`
column and a function for cleaning up orders) — if you haven't already.

## 2. Creating a new demo

1. Copy `examples/kavarna-vahtnca.json` to a new file, e.g.
   `demos/my-customer.json`, and fill in the venue's details:

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

   - `slug` — lowercase letters, digits and hyphens only (used in the URL).
   - `logo_url` — optional (URL to an image; leave blank if you don't have one yet).
   - `secondary_color`, `currency` — optional, have default values.
   - `tables` — how many tables (QR codes) to create (default 4).

2. Run:

   ```bash
   node provision.js demos/my-customer.json
   ```

   The script creates (or updates, if the `slug` already exists) the venue,
   categories and products, makes sure enough tables exist, and prints the
   links for each table and saves the main table's QR code as a PNG in
   `scripts/demo/demos/<slug>-qr.png`.

   Re-running with the same file is safe: the venue, categories and products
   get refreshed (useful if you correct prices), while existing tables and
   their QR tokens remain unchanged — QR codes already sent out keep working.

3. Send the customer the main link and/or attach `<slug>-qr.png`.

## 3. Listing demo venues

```bash
node list.js
```

Prints all venues with `is_demo = true`: name, slug, creation date and the
main link (the table with the lowest number).

## 4. Deleting a demo

```bash
node delete.js <slug>
```

Asks for confirmation and then deletes the venue and all related data
(categories, products, tables, orders, invoices) via `ON DELETE CASCADE`. For
non-interactive use, add `--yes`. The tool **refuses** to delete a venue that
isn't marked as a demo (`is_demo = false`), so you don't accidentally delete
a real customer.

## 5. Protecting demo venues

- The demo menu works normally — a guest can browse and place an order to see
  the full experience.
- The menu shows a discreet notice "DEMO — sample for [venue name]" (enabled
  automatically for venues with `is_demo = true`, see `js/menu.js` / `css/menu.css`).
- Test orders on demo venues **do not pile up indefinitely**: run this
  occasionally

  ```bash
  node cleanup-orders.js       # deletes orders older than 24 hours
  node cleanup-orders.js 6     # or choose a different cutoff (in hours)
  ```

  This calls the SQL function `cleanup_demo_orders()`, which deletes orders
  ONLY for venues with `is_demo = true` — real customers are not affected. If
  your Supabase plan has the `pg_cron` extension available, you can schedule
  the same function directly in the database (see the comment at the top of
  `supabase/migrations/010_demo_tenants.sql`), so the cleanup runs
  automatically without manually running this script.
