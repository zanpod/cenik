# FURS Tax Fiscalization — DETAILED runbook (TEST environment)

Goal: issue a **test invoice with a ZOI and EOR** from the FURS TEST environment. Everything
below is done **on your own computer** (not in the Supabase browser UI), because you need
to deploy the Edge Functions and set secrets.

> Terms: **ZOI** (Zaščitna oznaka izdajatelja) = protective mark of the issuer (calculated by
> the cash register). **EOR** (Enkratna identifikacijska oznaka računa) = unique invoice
> identification mark (returned by FURS). **Poslovni prostor** (business premises) =
> the venue; it must be registered once before the first invoice.

---

## 0. What you need (prerequisites)

1. A **computer** (Mac / Windows / Linux) with a terminal.
2. **openssl** (Mac/Linux already have it; on Windows use Git Bash).
3. **Supabase CLI** (installed in step 2).
4. **Git** (to clone the repository with the Edge Functions).
5. A **FURS TEST certificate** `.p12` + its password (step 1).

---

## 1. Get the FURS TEST certificate

For the **test environment**, FURS issues a special test digital certificate (a
`.p12` file with a password). You get it:

- via **eDavki** (request a test certificate for fiscal cash registers), or
- from **FURS technical materials** for the test environment (on the page with the
  `dpr_teh_spec` specification, in the section for the test environment / examples).

Result: a file such as `10489008.p12` and a **password** (e.g. you receive it together with
the certificate). The certificate is issued for a **specific tax number** — you will
enter this tax number into the application in step 5 (it must match!).

Save the file to a folder, e.g. `~/furs/`.

---

## 2. Install the Supabase CLI and log in

**Installation** (pick your system):

```bash
# macOS (Homebrew)
brew install supabase/tap/supabase

# Windows (Scoop)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# Linux / other (via npm)
npm install -g supabase
```

Verify: `supabase --version`

**Log in** (opens a browser to confirm):
```bash
supabase login
```

---

## 3. Clone the repository and link the project

```bash
git clone <URL_OF_YOUR_REPO> epo
cd epo
git checkout claude/upbeat-volta-9gl98f      # branch with the functions

# link to the Supabase project (the ref comes from the project's URL)
supabase link --project-ref mctepmjamozqlihbpmrs
```

`--project-ref` is the identifier from your Supabase URL
`https://mctepmjamozqlihbpmrs.supabase.co` → `mctepmjamozqlihbpmrs`.

---

## 4. Extract the PEM from the .p12 and set the secrets

In the folder with the certificate (`~/furs/`):

```bash
# private key (enter the certificate password when prompted)
openssl pkcs12 -in 10489008.p12 -nocerts -nodes -out furs_key.pem
# certificate
openssl pkcs12 -in 10489008.p12 -clcerts -nokeys -out furs_cert.pem
# CA chain of the TEST server (so the TLS call succeeds)
openssl s_client -connect blagajne-test.fu.gov.si:9002 -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN CERT/,/END CERT/' > furs_ca_chain.pem
```

Then (from the `epo` folder, where you linked the project) set the secrets:

```bash
supabase secrets set FURS_ENABLED=true
supabase secrets set FURS_ENV=test
supabase secrets set FURS_PRIVATE_KEY_PEM="$(cat ~/furs/furs_key.pem)"
supabase secrets set FURS_CERT_PEM="$(cat ~/furs/furs_cert.pem)"
supabase secrets set FURS_CA_PEM="$(cat ~/furs/furs_ca_chain.pem)"
```

Verify: `supabase secrets list` (shows the names, not the values).

---

## 5. Deploy the Edge Functions

```bash
supabase functions deploy furs-register-premise
supabase functions deploy furs-fiscalize
```

A quick test to confirm they're deployed (should return JSON):
```bash
curl -i -X POST \
  "https://mctepmjamozqlihbpmrs.functions.supabase.co/furs-fiscalize" \
  -H "Content-Type: application/json" -d '{}'
```
(Expect a 401 or an authorization error — that's fine, it means the function is running.)

---

## 6. Venue settings in the application

Admin → **Settings**:

1. *Invoice issuing*:
   - **Tax number = the tax number on the certificate** (e.g. `10489008`) — CRUCIAL.
   - VAT liable: as applicable to the test taxpayer.
   - Business premises code (e.g. `P1`) and cash register code (e.g. `BL1`).
2. *Tax fiscalization (FURS)*: **turn on the toggle → Save**.
3. (Recommended) For your staff (Staff tab), enter the **operator's tax
   number** (can be the same as the taxpayer's, for testing).

---

## 7. Register the business premises

Admin → Settings → **"Register business premises (FURS)"** (once).
The button submits the registration (test: mobile device). On success you get a notification.

If it reports an error, check the log (step 9) and send me the `ErrorMessage`.

---

## 8. Issue a test invoice

Admin → **By tables** → select an order → **Invoice / close table** → **Charge**.
On success, the invoice displays the **ZOI, EOR and QR code**. The "test
invoice" warning disappears (because `is_fiscal=true`).

---

## 9. Diagnostics (send me this if there's an error)

```bash
supabase functions logs furs-register-premise
supabase functions logs furs-fiscalize
```

Send me the lines:
- `FURS register response ...` or `FURS invoice response ...` (the raw response),
- any `ErrorCode` + `ErrorMessage`.

Based on that I can fix exactly one of three things (all located in one place,
in `supabase/functions/_shared/furs.ts`):
- the **JWS header format** (`subject_name`/`issuer_name`),
- **ZOI / date** (order, timezone),
- the **message structure** (`TaxesPerSeller`, `NumberingStructure`, ...).

---

## Common errors

| Symptom | Cause / fix |
|---|---|
| `exception ... certificate` / TLS | `FURS_CA_PEM` missing/incorrect → repeat the CA step |
| `furs_error` about certificate/signature | DN format in the JWS header → let me know, I'll fix `formatDN` |
| `ZOI ... not valid` | date/amount format → I'll align it |
| `business premises not registered` | do step 7 first |
| `fiscal_disabled (501)` | `FURS_ENABLED=true` or the keys are missing → step 4 |
| tax number mismatch | tax number in Settings ≠ tax number on the certificate → step 6 |

---

## Switching to PRODUCTION (later)

1. Production certificate (eDavki).
2. `supabase secrets set FURS_ENV=prod` + new PEM files (and the CA for
   `blagajne.fu.gov.si:9003`).
3. Register the business premises in PROD with **real** real-estate data.
4. Stays enabled; invoices get ZOI/EOR/QR and are legally valid.
