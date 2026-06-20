// ============================================================================
// EPO.SI — FURS fiskalna verifikacija: skupne pomožne funkcije (OGRODJE)
// ----------------------------------------------------------------------------
// To je SKELET za davčno potrjevanje računov (ZDavPR). Implementira algoritme
// (ZOI, JWS, QR), ki jih je treba pred uporabo v živo PREVERITI v FURS TEST
// okolju z realnim certifikatom. Brez veljavnega certifikata in FURS_ENABLED
// se ne kliče (glej index.ts vsake funkcije).
//
// Uporablja node:crypto (podprto v Supabase Edge runtime).
// ============================================================================

import { createSign, createHash, X509Certificate } from 'node:crypto';

export type FursEnv = 'test' | 'prod';

// Uradni FURS končni točki (preverite trenutne v tehnični dokumentaciji FURS).
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

// ============================================================================
// ZOI — Zaščitna oznaka izdajatelja
// ----------------------------------------------------------------------------
// Konkatenacija: davčna št. + datum/čas izdaje + zap. št. računa + oznaka
// poslovnega prostora + oznaka el. naprave + znesek računa. Podpis RSA-SHA256,
// nato MD5 → 32-mestni hex (mala črka). Točen format datuma in vrstni red
// PREVERITE v FURS tehnični specifikaciji v TEST okolju.
// ============================================================================
export interface ZoiParams {
  taxNumber: string;          // 8-mestna davčna številka
  issueDateTime: string;      // "yyyy-MM-dd'T'HH:mm:ss"
  invoiceNumber: string | number; // zaporedna številka (numerator)
  businessPremiseId: string;  // oznaka poslovnega prostora
  electronicDeviceId: string; // oznaka elektronske naprave
  invoiceAmount: string;      // npr. "24.31"
}

export function computeZOI(p: ZoiParams, privateKeyPem: string): string {
  const input =
    String(p.taxNumber) +
    p.issueDateTime +
    String(p.invoiceNumber) +
    p.businessPremiseId +
    p.electronicDeviceId +
    p.invoiceAmount;

  const signer = createSign('RSA-SHA256');
  signer.update(input, 'utf8');
  signer.end();
  const signature = signer.sign(privateKeyPem); // Buffer
  return createHash('md5').update(signature).digest('hex'); // 32 hex, lowercase
}

// ============================================================================
// QR koda na računu (60 števk):
//   39 števk: ZOI (hex → decimalno, ničle spredaj)
// +  8 števk: davčna številka
// + 12 števk: datum/čas "YYMMDDHHmmss"
// +  1 števka: kontrolna (vsota vseh števk mod 10)
// ============================================================================
export function buildQrData(zoiHex: string, taxNumber: string, issueDateTime: string): string {
  const dec = BigInt('0x' + zoiHex).toString().padStart(39, '0');
  const d = new Date(issueDateTime);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dt =
    String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()) +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const base = dec + String(taxNumber).padStart(8, '0') + dt; // 59
  const control = (base.split('').reduce((a, c) => a + Number(c), 0) % 10).toString();
  return base + control; // 60
}

// ============================================================================
// JWS (kompaktni zapis) — FURS sporočila so podpisana z RS256.
// Glava vsebuje podatke o certifikatu. Točna polja/format glave PREVERITE v
// FURS specifikaciji (subject_name/issuer_name format, serial kot decimalka).
// ============================================================================
export function buildJWS(payload: unknown, privateKeyPem: string, certPem: string): string {
  const cert = new X509Certificate(certPem);
  const header = {
    alg: 'RS256',
    subject_name: cert.subject.replace(/\n/g, ','),
    date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    issuer_name: cert.issuer.replace(/\n/g, ','),
    serial: BigInt('0x' + cert.serialNumber).toString(),
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput, 'utf8');
  signer.end();
  const sig = b64url(signer.sign(privateKeyPem));
  return `${signingInput}.${sig}`;
}

// Razčleni JWS odgovor FURS in vrne payload kot objekt.
export function parseJWS(token: string): any {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Neveljaven JWS odgovor.');
  return JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
}

// --- Gradnja sporočil --------------------------------------------------------
export function uuid(): string {
  return crypto.randomUUID();
}

export function fursDateTime(iso: string): string {
  // FURS pričakuje "yyyy-MM-dd'T'HH:mm:ss" (brez milisekund/cone).
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, '').replace('Z', '');
}
