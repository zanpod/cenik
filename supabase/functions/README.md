# FURS davčno potrjevanje — Edge Funkcije (OGRODJE)

To je **skelet** za davčno potrjevanje računov po **ZDavPR** (Zakon o davčnem
potrjevanju računov). **Privzeto je ONEMOGOČEN** — dokler ne nastavite
certifikata in `FURS_ENABLED=true`, funkciji ne pošiljata ničesar na FURS in
vrneta `501 fiscal_disabled`. Tako ostane projekt v testnem načinu (računi
ostanejo označeni kot *TESTNI / NI DAVČNO POTRJEN*).

> ⚠️ Algoritmi (ZOI, JWS glava, struktura sporočil) so pripravljeni, a jih je
> treba **preveriti v FURS TEST okolju** z realnim certifikatom, ker FURS
> občasno posodobi tehnično specifikacijo. Ne uporabljajte v produkciji brez
> uspešnega testa.

## Funkciji

| Funkcija | Namen |
|---|---|
| `furs-register-premise` | Enkratna **registracija poslovnega prostora** (pred prvim računom) |
| `furs-fiscalize` | **Potrditev enega računa** → izračun ZOI, pridobitev EOR, posodobitev `invoices` |

## Predpogoji

1. Namensko **digitalno potrdilo FURS** za fiskalne blagajne (`.p12`), ki ga
   pridobite prek **eDavki**.
2. Iz `.p12` izvlecite PEM ključ in certifikat:

```bash
# zasebni ključ (PEM)
openssl pkcs12 -in furs.p12 -nocerts -nodes -out furs_key.pem
# certifikat (PEM)
openssl pkcs12 -in furs.p12 -clcerts -nokeys -out furs_cert.pem
```

## Nastavitev skrivnosti (Supabase)

```bash
supabase secrets set FURS_ENABLED=true
supabase secrets set FURS_ENV=test            # test | prod
supabase secrets set FURS_PRIVATE_KEY_PEM="$(cat furs_key.pem)"
supabase secrets set FURS_CERT_PEM="$(cat furs_cert.pem)"
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` in `SUPABASE_SERVICE_ROLE_KEY` so na voljo
samodejno.

## Objava

```bash
supabase functions deploy furs-register-premise
supabase functions deploy furs-fiscalize
```

## Postopek za vklop v živo

1. Nastavite skrivnosti in objavite funkciji (zgoraj), `FURS_ENV=test`.
2. V Nastavitvah lokala izpolnite davčno številko, prostor/napravo, DDV.
3. Registrirajte poslovni prostor: enkrat pokličite `furs-register-premise`.
4. Testno izdajte račun → frontend pokliče `furs-fiscalize` → preverite, da
   prejmete **EOR** in da se **ZOI/EOR/QR** izpišejo na računu.
5. Ko test uspe: `FURS_ENABLED=true`, `FURS_ENV=prod`, v bazi nastavite
   `tenants.fiscal_enabled = true`. Od tedaj so računi **davčno potrjeni** in
   opozorilo »testni račun« izgine.

## Klic iz frontenda (že pripravljeno, neaktivno v testu)

`js/invoice.js` po izdaji računa pokliče `furs-fiscalize`, **samo če** je
`tenant.fiscal_enabled = true`. V testu (false) se klic preskoči in račun ostane
testni.

```js
await sb.functions.invoke('furs-fiscalize', { body: { invoice_id } });
```

## Opomba glede TLS

FURS končni točki uporabljata strežniške certifikate (veriga `sigov-ca`). Če
`fetch` javi napako preverjanja certifikata, dodajte FURS CA v zaupanja vredne
(npr. prek `DENO_CERT` / `--cert`), kot navaja FURS dokumentacija.
