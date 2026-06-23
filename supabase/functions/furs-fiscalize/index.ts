// ============================================================================
// EPO.SI — Edge Function: furs-fiscalize (OGRODJE, privzeto ONEMOGOČENO)
// ----------------------------------------------------------------------------
// Davčno potrjevanje enega računa pri FURS (ZDavPR): izračuna ZOI, pošlje
// InvoiceRequest, pridobi EOR in posodobi vrstico v `invoices`.
//
// VARNOST: dokler FURS_ENABLED !== 'true' ali manjkajo ključi, funkcija NE
// pošilja ničesar na FURS in vrne 501 (testni način). Tako se v testu ne more
// pomotoma izdati davčno potrjen račun.
//
// Skrivnosti (Supabase: `supabase secrets set ...`):
//   FURS_ENABLED=true|false
//   FURS_ENV=test|prod
//   FURS_PRIVATE_KEY_PEM   (zasebni ključ iz FURS .p12, PEM)
//   FURS_CERT_PEM          (certifikat iz FURS .p12, PEM)
// Samodejno na voljo: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  computeZOI, buildQrData, fursBaseUrl, fursDateTime, uuid, fursPost,
  type FursEnv,
} from '../_shared/furs.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const enabled = Deno.env.get('FURS_ENABLED') === 'true';
  const privateKey = Deno.env.get('FURS_PRIVATE_KEY_PEM');
  const certPem = Deno.env.get('FURS_CERT_PEM');
  const fursEnv = (Deno.env.get('FURS_ENV') as FursEnv) || 'test';

  // --- TESTNI VARNOSTNI ZAPAH ---------------------------------------------
  if (!enabled || !privateKey || !certPem) {
    return json({
      error: 'fiscal_disabled',
      message:
        'FURS davčno potrjevanje je onemogočeno (testni način). Nastavite ' +
        'FURS_ENABLED=true ter FURS_PRIVATE_KEY_PEM in FURS_CERT_PEM, da ga aktivirate.',
    }, 501);
  }

  try {
    const { invoice_id } = await req.json();
    if (!invoice_id) return json({ error: 'invoice_id manjka' }, 400);

    // 1) Preveri klicatelja (njegov JWT) in pridobi tenant.
    const authHeader = req.headers.get('Authorization') || '';
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: 'Neavtoriziran' }, 401);

    // 2) Service-role klient za branje/posodobitev računa.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data: profile } = await admin.from('profiles').select('tenant_id').eq('id', user.id).maybeSingle();
    if (!profile?.tenant_id) return json({ error: 'Uporabnik ni povezan z lokalom' }, 403);

    const { data: inv } = await admin.from('invoices').select('*').eq('id', invoice_id).maybeSingle();
    if (!inv || inv.tenant_id !== profile.tenant_id) return json({ error: 'Račun ne obstaja' }, 404);
    if (inv.eor) {
      const dt0 = fursDateTime(inv.issued_at);
      return json({ zoi: inv.zoi, eor: inv.eor, qr: buildQrData(inv.zoi, String(inv.seller_tax_number || '').replace(/^SI/i, ''), dt0) });
    }

    const taxNumber = String(inv.seller_tax_number || '').replace(/^SI/i, '');
    const amount = Number(inv.gross_total).toFixed(2);
    const issueDateTime = fursDateTime(inv.issued_at);

    // 3) ZOI
    const zoi = computeZOI({
      taxNumber,
      issueDateTime,
      invoiceNumber: inv.seq,
      businessPremiseId: inv.premise_label,
      electronicDeviceId: inv.device_label,
      invoiceAmount: amount,
    }, privateKey);

    // 4) InvoiceRequest (po FURS specifikaciji)
    const vat = (inv.vat_breakdown || []).map((v: any) => ({
      TaxRate: Number(v.rate), TaxableAmount: Number(v.base), TaxAmount: Number(v.vat),
    }));
    // Zavezanec za DDV → VAT; mali zavezanec (oproščeno 94. čl.) → ExemptVATTaxableAmount.
    const taxesPerSeller = inv.seller_vat_registered
      ? [{ VAT: vat }]
      : [{ ExemptVATTaxableAmount: Number(amount) }];

    const payload = {
      InvoiceRequest: {
        Header: { MessageID: uuid(), DateTime: issueDateTime },
        Invoice: {
          TaxNumber: Number(taxNumber),
          IssueDateTime: issueDateTime,
          NumberingStructure: 'B', // B = številčenje po elektronski napravi (naš števec je po napravi)
          InvoiceIdentifier: {
            BusinessPremiseID: inv.premise_label,
            ElectronicDeviceID: inv.device_label,
            InvoiceNumber: String(inv.seq),
          },
          InvoiceAmount: Number(amount),
          PaymentAmount: Number(amount),
          TaxesPerSeller: taxesPerSeller,
          OperatorTaxNumber: Number(inv.operator_tax_no || taxNumber), // idealno davčna št. operaterja
          ProtectedID: zoi,
          SubsequentSubmit: false,
        },
      },
    };

    // 5) Podpiši JWS in pošlji FURS (z lastno CA verigo, če je nastavljena)
    const { status, payload: respPayload, raw } = await fursPost(
      `${fursBaseUrl(fursEnv)}/invoices`, payload, privateKey, certPem,
    );
    console.log('FURS invoice response', status, JSON.stringify(raw));

    // 6) Razčleni odgovor → EOR
    const ir = respPayload?.InvoiceResponse || {};
    if (ir.Error) {
      return json({ error: 'furs_error', code: ir.Error.ErrorCode, message: ir.Error.ErrorMessage, zoi }, 502);
    }
    const eor = ir.UniqueInvoiceID;
    if (!eor) return json({ error: 'EOR ni bil prejet', status, raw: respPayload, zoi }, 502);

    // 7) Posodobi račun
    await admin.from('invoices').update({ zoi, eor, is_fiscal: true }).eq('id', inv.id);

    return json({ zoi, eor, qr: buildQrData(zoi, taxNumber, issueDateTime) });
  } catch (err) {
    console.error(err);
    return json({ error: 'exception', message: String(err?.message || err) }, 500);
  }
});
