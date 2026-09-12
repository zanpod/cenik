// ============================================================================
// EPO.SI — FURS fiscal verification: shared helper functions
// ----------------------------------------------------------------------------
// Implements ZOI, JWS (RS256) and QR per the FURS technical specification
// (Data exchange protocol — Fiscal verification of invoices):
//   https://edavki.durs.si/.../PageD.aspx?category=dpr_teh_spec
//
// Uses node:crypto (supported in the Supabase Edge runtime / Deno).
// Note: the DN format in the JWS header (subject_name/issuer_name) and any
// discrepancies need to be verified against the FURS TEST environment
// (it returns descriptive errors).
// ============================================================================

import { createSign, createHash, X509Certificate } from 'node:crypto';

export type FursEnv = 'test' | 'prod';

// Official FURS endpoints.
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

// --- Date/time in the FURS format "yyyy-MM-ddTHH:mm:ss" in the Europe/Ljubljana zone --
// Important: the same string is used in the ZOI, in the message (IssueDateTime) and on the QR.
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
// ZOI — Zaščitna oznaka izdajatelja (Issuer's protection mark)
// Concatenation: tax number + issue date/time + invoice sequence number +
// business premise ID + electronic device ID + amount. Signed with
// RSA-SHA256, then MD5 → 32-char hex (lowercase).
// ============================================================================
export interface ZoiParams {
  taxNumber: string;
  issueDateTime: string;       // FURS format "yyyy-MM-ddTHH:mm:ss"
  invoiceNumber: string | number;
  businessPremiseId: string;
  electronicDeviceId: string;
  invoiceAmount: string;       // e.g. "24.31"
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
// QR code (60 digits): 39 (ZOI hex→dec) + 8 (tax number) + 12 (YYMMDDHHmmss) + 1 (mod 10)
// The date is taken from the SAME FURS string to guarantee consistency.
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

// --- Format the DN (subject/issuer) for the JWS header ----------------------
// node returns e.g. "C=SI\nO=...\nCN=...". FURS expects a single string; we
// use RFC4514 order (most specific first), separated by ", ".
function formatDN(dn: string): string {
  return dn.split('\n').map((s) => s.trim()).filter(Boolean).reverse().join(', ');
}

// ============================================================================
// JWS (compact serialization) — RS256, header carries certificate metadata.
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

// Parses a FURS JWS response and returns the payload as an object.
export function parseJWS(token: string): any {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Neveljaven JWS odgovor.');
  return JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
}

export function uuid(): string {
  return crypto.randomUUID();
}

// Sends the signed message to FURS. If FURS_CA_PEM is set, uses a custom
// trust chain (the FURS server uses sigov-ca / SI-TRUST).
// Returns the status, the parsed payload (from the JWS), and the raw
// response for diagnostics.
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
