# FURS davčno potrjevanje — Edge Funkcije + RUNBOOK (TEST → PROD)

Davčno potrjevanje računov po **ZDavPR**. Tehnična specifikacija FURS:
<https://edavki.durs.si/edavkiportal/openportal/CommonPages/Opdynp/PageD.aspx?category=dpr_teh_spec>

Privzeto je **izklopljeno** (vrne `501`, dokler ni `FURS_ENABLED=true` in certifikat).
V TEST načinu dobite **pravi testni ZOI/EOR** iz FURS TEST sistema; računi **niso**
pravno veljavni.

## Funkciji

| Funkcija | Namen |
|---|---|
| `furs-register-premise` | Enkratna registracija poslovnega prostora (pred 1. računom) |
| `furs-fiscalize` | Potrditev računa → ZOI, EOR, QR; posodobi `invoices` |

---

## A) MVP v TEST okolju — korak za korakom

### 1. Testni certifikat
V TEST okolju uporabite **testni digitalni certifikat FURS** (`.p12`), ki ga
dobite iz FURS testnih materialov / na zahtevo (testno okolje `blagajne-test`).
Production certifikat se pridobi prek **eDavki** (namenski certifikat za blagajne).

Izvlecite PEM iz `.p12`:

```bash
openssl pkcs12 -in furs_test.p12 -nocerts -nodes -out furs_key.pem   # zasebni ključ
openssl pkcs12 -in furs_test.p12 -clcerts -nokeys -out furs_cert.pem  # certifikat
```

### 2. Skrivnosti v Supabase

```bash
supabase secrets set FURS_ENABLED=true
supabase secrets set FURS_ENV=test
supabase secrets set FURS_PRIVATE_KEY_PEM="$(cat furs_key.pem)"
supabase secrets set FURS_CERT_PEM="$(cat furs_cert.pem)"
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` so samodejni.

### 3. Objava funkcij

```bash
supabase functions deploy furs-register-premise
supabase functions deploy furs-fiscalize
```

### 4. Nastavitve lokala (admin → Nastavitve)
- **Izdajanje računov**: davčna številka (= davčna iz certifikata!), zavezanec za
  DDV (da/ne), stopnja DDV, oznaka poslovnega prostora + blagajne.
- **Davčno potrjevanje (FURS)**: vklopi stikalo → **Shrani**.

### 5. Registracija poslovnega prostora
Admin → Nastavitve → **Registriraj poslovni prostor (FURS)** (enkrat).
- Gumb privzeto pošlje *premično napravo* (`C`) — primerno za TEST.
- Za **fiksni prostor** je treba poslati podatke o nepremičnini (kataster,
  št. stavbe/dela, naslov). Pokličite funkcijo z `real_estate` telesom
  (primer v `furs-register-premise/index.ts`).

### 6. Testna izdaja računa
Nadzorna plošča → miza → **Račun / zapri mizo** → izberi postavke → obračunaj.
Ob uspehu dobi račun **ZOI, EOR in QR**. Preverite v dnevniku funkcije
(`supabase functions logs furs-fiscalize`) odgovor FURS.

### 7. Validacija / odpravljanje napak
FURS vrne v odgovoru `Error.ErrorCode` + `ErrorMessage`. Najpogostejše:
- napaka pri **certifikatu/glavi JWS** → preverite obliko `subject_name`/
  `issuer_name` v `_shared/furs.ts` (`formatDN`) — mora ustrezati certifikatu;
- **ZOI** zavrnjen → preverite vrstni red/format datuma (`yyyy-MM-ddTHH:mm:ss`,
  cona Europe/Ljubljana) in znesek (2 decimalki);
- **poslovni prostor ni registriran** → najprej korak 5;
- napaka TLS (veriga `sigov-ca`) → po potrebi dodajte FURS CA v zaupanja vredne.

> Te tri stvari (DN glave, format datuma, struktura `TaxesPerSeller`) so edine,
> ki lahko zahtevajo manjši popravek — vse je na enem mestu v `_shared/furs.ts`
> in `furs-fiscalize/index.ts`. Pošljite mi `ErrorMessage` in popravim točno to.

---

## B) Preklop v PRODUKCIJO

1. Pridobite **produkcijski** certifikat (eDavki) in z njim ponovite korak 1.
2. Posodobite skrivnosti:
   ```bash
   supabase secrets set FURS_ENV=prod
   supabase secrets set FURS_PRIVATE_KEY_PEM="$(cat furs_key_prod.pem)"
   supabase secrets set FURS_CERT_PEM="$(cat furs_cert_prod.pem)"
   ```
3. **Registrirajte poslovni prostor v PROD** (korak 5) — z resničnimi podatki o
   nepremičnini.
4. Objavite funkciji (če sta se spremenili) in v Nastavitvah pustite **FURS
   vklopljen**.
5. Od zdaj imajo računi ZOI/EOR/QR in opozorilo »testni račun« izgine.
   Obvezno hranite **kopije računov** in poskrbite za vmesno potrditev
   (nakn%adni `SubsequentSubmit=true`), če je blagajna občasno brez povezave.

---

## Kako koda ve, ali je test ali prod?
- Strežnik: `FURS_ENV` (test/prod) → ustrezna končna točka.
- Aplikacija: `tenants.fiscal_enabled` (stikalo v Nastavitvah) → ali sploh
  kliče potrjevanje. Če je izklopljeno ALI certifikat ni nastavljen, je račun
  testni/nepotrjen in tako tudi označen.
