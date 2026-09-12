# FURS Tax Fiscalization — Edge Functions + RUNBOOK (TEST → PROD)

Fiscalization of invoices under **ZDavPR** (the Slovenian Tax Verification of Invoices Act). FURS technical specification:
<https://edavki.durs.si/edavkiportal/openportal/CommonPages/Opdynp/PageD.aspx?category=dpr_teh_spec>

By default it is **disabled** (returns `501` until `FURS_ENABLED=true` and a certificate are set).
In TEST mode you get a **real test ZOI/EOR** from the FURS TEST system; the invoices are
**not** legally valid.

## Functions

| Function | Purpose |
|---|---|
| `furs-register-premise` | One-time registration of the business premises (before the 1st invoice) |
| `furs-fiscalize` | Confirms an invoice → ZOI, EOR, QR; updates `invoices` |

---

## A) MVP in the TEST environment — step by step

### 1. Test certificate
In the TEST environment, use the **FURS test digital certificate** (`.p12`), which you
obtain from FURS test materials / on request (test environment `blagajne-test`).
The production certificate is obtained via **eDavki** (a dedicated certificate for fiscal cash registers).

Extract the PEM from the `.p12`:

```bash
openssl pkcs12 -in furs_test.p12 -nocerts -nodes -out furs_key.pem   # private key
openssl pkcs12 -in furs_test.p12 -clcerts -nokeys -out furs_cert.pem  # certificate
```

### 2. Secrets in Supabase

```bash
supabase secrets set FURS_ENABLED=true
supabase secrets set FURS_ENV=test
supabase secrets set FURS_PRIVATE_KEY_PEM="$(cat furs_key.pem)"
supabase secrets set FURS_CERT_PEM="$(cat furs_cert.pem)"
# Optional, but often required: the CA chain of the FURS server (sigov-ca / SI-TRUST),
# otherwise the call may fail with a TLS certificate verification error.
supabase secrets set FURS_CA_PEM="$(cat furs_ca_chain.pem)"
```

> You can get the CA chain of the FURS test server (`blagajne-test.fu.gov.si`) from FURS
> technical materials, or export it from the connection itself (e.g. `openssl s_client -connect
> blagajne-test.fu.gov.si:9002 -showcerts`). Combine the root + intermediate certificates into
> a single PEM and set it as `FURS_CA_PEM`.

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are set automatically.

### 3. Deploying the functions

```bash
supabase functions deploy furs-register-premise
supabase functions deploy furs-fiscalize
```

### 4. Venue settings (admin → Settings)
- **Invoice issuing**: tax number (= the tax number on the certificate!), VAT
  liable (yes/no), VAT rate, business premises code + cash register code.
- **Tax fiscalization (FURS)**: turn on the toggle → **Save**.

### 5. Registering the business premises
Admin → Settings → **Register business premises (FURS)** (once).
- By default the button submits a *mobile device* (`C`) — suitable for TEST.
- For a **fixed premises** you need to submit real-estate data (cadastral
  number, building/part number, address). Call the function with a
  `real_estate` body (example in `furs-register-premise/index.ts`).

### 6. Issuing a test invoice
Dashboard → table → **Invoice / close table** → select items → charge.
On success the invoice receives a **ZOI, EOR and QR**. Check the FURS
response in the function log (`supabase functions logs furs-fiscalize`).

### 7. Validation / troubleshooting
FURS returns `Error.ErrorCode` + `ErrorMessage` in its response. Most common:
- an error in the **certificate/JWS header** → check the format of
  `subject_name`/`issuer_name` in `_shared/furs.ts` (`formatDN`) — it must
  match the certificate;
- **ZOI** rejected → check the date order/format (`yyyy-MM-ddTHH:mm:ss`,
  Europe/Ljubljana zone) and the amount (2 decimal places);
- **business premises not registered** → do step 5 first;
- TLS error (`sigov-ca` chain) → add the FURS CA to your trusted store if needed.

> These three things (DN headers, date format, `TaxesPerSeller` structure) are the
> only ones that may need a small fix — everything is in one place, in
> `_shared/furs.ts` and `furs-fiscalize/index.ts`. Send me the `ErrorMessage`
> and I'll fix exactly that.

---

## B) Switching to PRODUCTION

1. Obtain the **production** certificate (eDavki) and repeat step 1 with it.
2. Update the secrets:
   ```bash
   supabase secrets set FURS_ENV=prod
   supabase secrets set FURS_PRIVATE_KEY_PEM="$(cat furs_key_prod.pem)"
   supabase secrets set FURS_CERT_PEM="$(cat furs_cert_prod.pem)"
   ```
3. **Register the business premises in PROD** (step 5) — with real
   real-estate data.
4. Deploy the functions (if changed) and leave **FURS
   enabled** in Settings.
5. From now on, invoices carry ZOI/EOR/QR and the "test invoice"
   warning disappears. Make sure to keep **copies of invoices** and set up
   subsequent submission (`SubsequentSubmit=true`) in case the cash register
   is occasionally offline.

---

## How does the code know whether it's test or prod?
- Server side: `FURS_ENV` (test/prod) → the matching endpoint.
- Application side: `tenants.fiscal_enabled` (the toggle in Settings) → whether
  fiscalization is called at all. If it's disabled OR no certificate is set, the
  invoice is a test/unconfirmed one and is marked as such.
