// ============================================================================
// EPO.SI — FURS fiskalna verifikacija: skupne pomožne funkcije
// ----------------------------------------------------------------------------
// Implementira ZOI, JWS (RS256) in QR po tehnični specifikaciji FURS
// (Protokol za izmenjavo podatkov — Davčno potrjevanje računov):
//   https://edavki.durs.si/.../PageD.aspx?category=dpr_teh_spec
//
// Uporablja node:crypto (podprto v Supabase Edge runtime / Deno).
// Opomba: format DN v glavi JWS (subject_name/issuer_name) ter morebitna
// odstopanja je treba potrditi proti FURS TEST okolju (vrača opisne napake).
// ============================================================================

import { createSign, createHash, X509Certificate } from 'node:crypto';

export type FursEnv = 'test' | 'prod';

// Uradni FURS končni točki.
export function fursBaseUrl(env: FursEnv): string {
  return env === 'prod'
    ? 'https://blagajne.fu.gov.si:9003/v1/cash_registers'
    : 'https://blagajne-test.fu.gov.si:9002/v1/cash_registers';
}

// --- base64url ---------------------------------------------------------------
function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// --- Datum/čas v formatu FURS "yyyy-MM-ddTHH:mm:ss" v coni Europe/Ljubljana --
// Pomembno: isti niz se uporabi v ZOI, v sporočilu (IssueDateTime) in na QR.
export function fursDateTime(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Ljubljana',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const m: Record<string, string> = {};
  parts.forEach((p) => { m[p.type] = p.value; });
  return `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}:${m.second}`;
}

// ============================================================================
// ZOI — Zaščitna oznaka izdajatelja
// Konkatenacija: davčna št. + datum/čas izdaje + zap. št. računa + oznaka
// poslovnega prostora + oznaka el. naprave + znesek. Podpis RSA-SHA256, nato
// MD5 → 32-mestni hex (male črke).
// ============================================================================
export interface ZoiParams {
  taxNumber: string;
  issueDateTime: string;       // FURS format "yyyy-MM-ddTHH:mm:ss"
  invoiceNumber: string | number;
  businessPremiseId: string;
  electronicDeviceId: string;
  invoiceAmount: string;       // npr. "24.31"
}

export function computeZOI(p: ZoiParams, privateKeyPem: string): string {
  const input =
    String(p.taxNumber) + p.issueDateTime + String(p.invoiceNumber) +
    p.businessPremiseId + p.electronicDeviceId + p.invoiceAmount;
  const signer = createSign('RSA-SHA256');
  signer.update(input, 'utf8');
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return createHash('md5').update(signature).digest('hex');
}

// ============================================================================
// QR koda (60 števk): 39 (ZOI hex→dec) + 8 (davčna) + 12 (YYMMDDHHmmss) + 1 (mod 10)
// Datum se vzame iz ISTEGA FURS niza, da je zagotovljena skladnost.
// ============================================================================
export function buildQrData(zoiHex: string, taxNumber: string, fursDateTimeStr: string): string {
  const dec = BigInt('0x' + zoiHex).toString().padStart(39, '0');
  const dt = fursDateTimeStr; // "yyyy-MM-ddTHH:mm:ss"
  const yy = dt.slice(2, 4) + dt.slice(5, 7) + dt.slice(8, 10) +
             dt.slice(11, 13) + dt.slice(14, 16) + dt.slice(17, 19);
  const base = dec + String(taxNumber).padStart(8, '0') + yy; // 59
  const control = (base.split('').reduce((a, c) => a + Number(c), 0) % 10).toString();
  return base + control;
}

// --- Format DN (subject/issuer) za glavo JWS --------------------------------
// node vrne npr. "C=SI\nO=...\nCN=...". FURS pričakuje en niz; uporabimo
// RFC4514 vrstni red (od najbolj specifičnega), ločeno z ", ".
function formatDN(dn: string): string {
  return dn.split('\n').map((s) => s.trim()).filter(Boolean).reverse().join(', ');
}

// ============================================================================
// JWS (kompaktni zapis) — RS256, glava z metapodatki certifikata.
// ============================================================================
export function buildJWS(payload: unknown, privateKeyPem: string, certPem: string): string {
  const cert = new X509Certificate(certPem);
  const header = {
    alg: 'RS256',
    subject_name: formatDN(cert.subject),
    date: fursDateTime(new Date().toISOString()),
    issuer_name: formatDN(cert.issuer),
    serial: BigInt('0x' + cert.serialNumber).toString(),
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput, 'utf8');
  signer.end();
  return `${signingInput}.${b64url(signer.sign(privateKeyPem))}`;
}

// Razčleni JWS odgovor FURS in vrne payload kot objekt.
export function parseJWS(token: string): any {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Neveljaven JWS odgovor.');
  return JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
}

export function uuid(): string {
  return crypto.randomUUID();
}

// Pošlje podpisano sporočilo na FURS. Če je nastavljen FURS_CA_PEM, uporabi
// lastno verigo zaupanja (FURS strežnik uporablja sigov-ca / SI-TRUST).
// Vrne status, razčlenjen payload (iz JWS) in surov odgovor za diagnostiko.
export async function fursPost(
  url: string, payload: unknown, privateKeyPem: string, certPem: string,
): Promise<{ status: number; payload: any; raw: any }> {
  const token = buildJWS(payload, privateKeyPem, certPem);
  const opts: RequestInit & { client?: unknown } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ token }),
  };
  const caPem = Deno.env.get('FURS_CA_PEM');
  if (caPem) {
    try { opts.client = (Deno as any).createHttpClient({ caCerts: [caPem] }); }
    catch (e) { console.error('FURS_CA_PEM client error:', e); }
  }
  const res = await fetch(url, opts as RequestInit);
  const text = await res.text();
  let raw: any; try { raw = JSON.parse(text); } catch { raw = { text }; }
  const payloadOut = raw && raw.token ? parseJWS(raw.token) : raw;
  return { status: res.status, payload: payloadOut, raw };
}
