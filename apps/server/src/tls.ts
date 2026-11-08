// Server TLS identity (NFR-SEC-01, DL-009, DL-011): ECDSA P-256 self-signed certificate,
// generated at install. The private key is sealed with the master key at rest.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { webcrypto, X509Certificate, createPrivateKey } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { spkiPin } from '@advence/protocol';
import type { SecretStore } from './secrets.js';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

export interface TlsIdentity {
  certPem: string;
  keyPem: string;
  pin: string;
}

const CERT_FILE = 'tls-cert.pem';

export async function loadOrCreateTls(dataDir: string, secrets: SecretStore, name: string): Promise<TlsIdentity> {
  const certPath = path.join(dataDir, CERT_FILE);
  const keyPem = secrets.get('tls.key');
  if (fs.existsSync(certPath) && keyPem) {
    const certPem = fs.readFileSync(certPath, 'utf8');
    return { certPem, keyPem, pin: pinFromCertPem(certPem) };
  }
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
  const keys = (await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('hex').replace(/^[89a-f]/, '1'),
    name: `CN=${name.replace(/[,=+<>#;\\"]/g, ' ')}`,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 10 * 365 * 86_400_000),
    keys,
    signingAlgorithm: alg,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], false),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }, { type: 'dns', value: os.hostname() || 'advence' }, { type: 'ip', value: '127.0.0.1' }]),
    ],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const keyPemNew = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }).toString();
  const certPem = cert.toString('pem');
  secrets.set('tls.key', keyPemNew);
  fs.writeFileSync(certPath, certPem, { mode: 0o644 });
  return { certPem, keyPem: keyPemNew, pin: pinFromCertPem(certPem) };
}

export function pinFromCertPem(certPem: string): string {
  const c = new X509Certificate(certPem);
  const spki = c.publicKey.export({ type: 'spki', format: 'der' });
  return spkiPin(new Uint8Array(spki));
}

export function readCertPin(dataDir: string): string {
  return pinFromCertPem(fs.readFileSync(path.join(dataDir, CERT_FILE), 'utf8'));
}
