# FURS davčno potrjevanje — PODROBEN priročnik (TEST okolje)

Cilj: izdati **testni račun z ZOI in EOR** iz FURS TEST okolja. Vse spodaj se
izvaja na **tvojem računalniku** (ne v Supabase brskalniku), ker je treba
objaviti Edge funkciji in nastaviti skrivnosti.

> Pojmi: **ZOI** = zaščitna oznaka izdajatelja (izračuna blagajna). **EOR** =
> enkratna identifikacijska oznaka računa (vrne FURS). **Poslovni prostor** =
> lokal; pred prvim računom ga je treba enkrat registrirati.

---

## 0. Kaj potrebuješ (predpogoji)

1. **Računalnik** (Mac / Windows / Linux) s terminalom.
2. **openssl** (Mac/Linux ga imata; na Windows uporabi Git Bash).
3. **Supabase CLI** (namestitev v koraku 2).
4. **Git** (da kloniraš repozitorij z Edge funkcijami).
5. **FURS TEST certifikat** `.p12` + geslo zanj (korak 1).

---

## 1. Pridobi FURS TEST certifikat

Za **testno okolje** FURS izda poseben testni digitalni certifikat (datoteka
`.p12` z geslom). Dobiš ga:

- prek **eDavki** (zahtevek za testni certifikat za fiskalne blagajne), ali
- iz **tehničnih materialov FURS** za testno okolje (na strani s specifikacijo
  `dpr_teh_spec`, razdelek za testno okolje / primeri).

Rezultat: datoteka npr. `10489008.p12` in **geslo** (npr. dobiš ga skupaj s
certifikatom). Certifikat je izdan za **določeno davčno številko** — to davčno
številko boš v koraku 5 vnesel v aplikacijo (mora se ujemati!).

Datoteko shrani v mapo, npr. `~/furs/`.

---

## 2. Namesti Supabase CLI in se prijavi

**Namestitev** (izberi svoj sistem):

```bash
# macOS (Homebrew)
brew install supabase/tap/supabase

# Windows (Scoop)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# Linux / drugo (prek npm)
npm install -g supabase
```

Preveri: `supabase --version`

**Prijava** (odpre brskalnik za potrditev):
```bash
supabase login
```

---

## 3. Kloniraj repozitorij in poveži projekt

```bash
git clone <URL_TVOJEGA_REPO> epo
cd epo
git checkout claude/upbeat-volta-9gl98f      # veja s funkcijami

# poveži z Supabase projektom (ref je iz URL-ja projekta)
supabase link --project-ref mctepmjamozqlihbpmrs
```

`--project-ref` je oznaka iz tvojega Supabase URL-ja
`https://mctepmjamozqlihbpmrs.supabase.co` → `mctepmjamozqlihbpmrs`.

---

## 4. Izvleci PEM iz .p12 in nastavi skrivnosti

V mapi s certifikatom (`~/furs/`):

```bash
# zasebni ključ (vpiši geslo certifikata, ko vpraša)
openssl pkcs12 -in 10489008.p12 -nocerts -nodes -out furs_key.pem
# certifikat
openssl pkcs12 -in 10489008.p12 -clcerts -nokeys -out furs_cert.pem
# CA veriga TEST strežnika (da TLS klic uspe)
openssl s_client -connect blagajne-test.fu.gov.si:9002 -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN CERT/,/END CERT/' > furs_ca_chain.pem
```

Nato (iz mape `epo`, kjer si povezal projekt) nastavi skrivnosti:

```bash
supabase secrets set FURS_ENABLED=true
supabase secrets set FURS_ENV=test
supabase secrets set FURS_PRIVATE_KEY_PEM="$(cat ~/furs/furs_key.pem)"
supabase secrets set FURS_CERT_PEM="$(cat ~/furs/furs_cert.pem)"
supabase secrets set FURS_CA_PEM="$(cat ~/furs/furs_ca_chain.pem)"
```

Preveri: `supabase secrets list` (vidiš imena, ne vrednosti).

---

## 5. Objavi Edge funkciji

```bash
supabase functions deploy furs-register-premise
supabase functions deploy furs-fiscalize
```

Hiter test, da sta objavljeni (vrne naj JSON):
```bash
curl -i -X POST \
  "https://mctepmjamozqlihbpmrs.functions.supabase.co/furs-fiscalize" \
  -H "Content-Type: application/json" -d '{}'
```
(Pričakuj 401 ali napako o avtorizaciji — to je v redu, pomeni da funkcija teče.)

---

## 6. Nastavitve lokala v aplikaciji

Admin → **Nastavitve**:

1. *Izdajanje računov*:
   - **Davčna številka = davčna iz certifikata** (npr. `10489008`) — KLJUČNO.
   - Zavezanec za DDV: kot ustreza testnemu zavezancu.
   - Oznaka poslovnega prostora (npr. `P1`) in blagajne (npr. `BL1`).
2. *Davčno potrjevanje (FURS)*: **vklopi stikalo → Shrani**.
3. (Priporočeno) Pri svojem osebju (zavihek Osebje) vnesi **davčno številko
   operaterja** (lahko ista kot zavezanec za test).

---

## 7. Registriraj poslovni prostor

Admin → Nastavitve → **»Registriraj poslovni prostor (FURS)«** (enkrat).
Gumb pošlje registracijo (testno: premična naprava). Ob uspehu dobiš obvestilo.

Če javi napako, poglej log (korak 9) in mi pošlji `ErrorMessage`.

---

## 8. Izdaj testni račun

Admin → **Po mizah** → izberi naročilo → **Račun / zapri mizo** → **Obračunaj**.
Ob uspehu se na računu izpišejo **ZOI, EOR in QR koda**. Opozorilo »testni
račun« izgine (ker je `is_fiscal=true`).

---

## 9. Diagnostika (pošlji mi ob napaki)

```bash
supabase functions logs furs-register-premise
supabase functions logs furs-fiscalize
```

Pošlji mi vrstice:
- `FURS register response ...` oz. `FURS invoice response ...` (surov odgovor),
- morebitni `ErrorCode` + `ErrorMessage`.

Na podlagi tega točno popravim eno od treh stvari (vse so na enem mestu v
`supabase/functions/_shared/furs.ts`):
- **format glave JWS** (`subject_name`/`issuer_name`),
- **ZOI / datum** (vrstni red, cona),
- **strukturo sporočila** (`TaxesPerSeller`, `NumberingStructure`, ...).

---

## Pogoste napake

| Simptom | Vzrok / rešitev |
|---|---|
| `exception ... certificate` / TLS | manjka/napačen `FURS_CA_PEM` → ponovi CA korak |
| `furs_error` o certifikatu/podpisu | format DN v glavi JWS → javi mi, popravim `formatDN` |
| `ZOI ... ni veljaven` | format datuma/zneska → uskladim |
| `poslovni prostor ni registriran` | najprej korak 7 |
| `fiscal_disabled (501)` | manjka `FURS_ENABLED=true` ali ključi → korak 4 |
| davčna se ne ujema | davčna v Nastavitvah ≠ davčna certifikata → korak 6 |

---

## Preklop v PRODUKCIJO (kasneje)

1. Produkcijski certifikat (eDavki).
2. `supabase secrets set FURS_ENV=prod` + novi PEM-i (in CA za
   `blagajne.fu.gov.si:9003`).
3. Registracija poslovnega prostora v PROD z **realnimi** podatki o nepremičnini.
4. Ostane vklopljeno; računi dobijo ZOI/EOR/QR in so pravno veljavni.
