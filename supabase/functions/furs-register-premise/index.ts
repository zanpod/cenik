// ============================================================================
// EPO.SI — Edge Function: furs-register-premise (OGRODJE, privzeto ONEMOGOČENO)
// ----------------------------------------------------------------------------
// Enkratna registracija poslovnega prostora pri FURS (pred izdajo davčno
// potrjenih računov). Pošlje BusinessPremiseRequest za dani poslovni prostor.
//
// Kot pri furs-fiscalize: dokler FURS_ENABLED !== 'true' ali manjkajo ključi,
// ne pošilja ničesar in vrne 501.
//
// Telo zahteve (primer):
//   {
//     "real_estate": {
//       "cadastral_number": 365, "building_number": 12, "building_section_number": 3,
//       "street": "Ulica", "house_number": "1", "house_number_additional": "",
//       "community": "Ljubljana", "city": "Ljubljana", "postal_code": "1000"
//     },
//     "validity_date": "2026-01-01"
//   }
// ALI za premično napravo (npr. stojnica): { "movable_type": "C" }  (A/B/C)
// ============================================================================

import {
  fursBaseUrl, fursDateTime, uuid, fursPost, type FursEnv,
} from '../_shared/furs.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const enabled = Deno.env.get('FURS_ENABLED') === 'true';
  const privateKey = Deno.env.get('FURS_PRIVATE_KEY_PEM');
  const certPem = Deno.env.get('FURS_CERT_PEM');
  const fursEnv = (Deno.env.get('FURS_ENV') as FursEnv) || 'test';

  if (!enabled || !privateKey || !certPem) {
    return json({
      error: 'fiscal_disabled',
      message: 'FURS davčno potrjevanje je onemogočeno (testni način).',
    }, 501);
  }

  try {
    const body = await req.json();

    // Avtorizacija + tenant (za davčno št. in oznako prostora/naprave).
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: 'Neavtoriziran' }, 401);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data: profile } = await admin.from('profiles').select('tenant_id').eq('id', user.id).maybeSingle();
    if (!profile?.tenant_id) return json({ error: 'Uporabnik ni povezan z lokalom' }, 403);
    const { data: tenant } = await admin.from('tenants').select('*').eq('id', profile.tenant_id).maybeSingle();
    if (!tenant) return json({ error: 'Lokal ne obstaja' }, 404);

    const taxNumber = String(tenant.tax_number || '').replace(/^SI/i, '');
    const now = fursDateTime(new Date().toISOString());

    // BPIdentifier: nepremičnina ali premična naprava — PREVERITE v FURS spec.
    let bpIdentifier: any;
    if (body.movable_type) {
      bpIdentifier = { PremiseType: body.movable_type }; // A/B/C
    } else {
      const re = body.real_estate || {};
      bpIdentifier = {
        RealEstateBP: {
          PropertyID: {
            CadastralNumber: re.cadastral_number,
            BuildingNumber: re.building_number,
            BuildingSectionNumber: re.building_section_number,
          },
          Address: {
            Street: re.street, HouseNumber: re.house_number,
            HouseNumberAdditional: re.house_number_additional || '',
            Community: re.community, City: re.city, PostalCode: re.postal_code,
          },
        },
      };
    }

    const payload = {
      BusinessPremiseRequest: {
        Header: { MessageID: uuid(), DateTime: now },
        BusinessPremise: {
          TaxNumber: Number(taxNumber),
          BusinessPremiseID: tenant.premise_label,
          BPIdentifier: bpIdentifier,
          ValidityDate: body.validity_date || now.slice(0, 10),
          SoftwareSupplier: [{ NameForeign: 'EPO.SI' }],
        },
      },
    };

    const { status, payload: respPayload, raw } = await fursPost(
      `${fursBaseUrl(fursEnv)}/invoices/register`, payload, privateKey, certPem,
    );
    console.log('FURS register response', status, JSON.stringify(raw));
    const br = respPayload?.BusinessPremiseResponse || {};
    if (br.Error) {
      return json({ error: 'furs_error', code: br.Error.ErrorCode, message: br.Error.ErrorMessage }, 502);
    }
    return json({ ok: true, status, response: respPayload });
  } catch (err) {
    console.error(err);
    return json({ error: 'exception', message: String(err?.message || err) }, 500);
  }
});
