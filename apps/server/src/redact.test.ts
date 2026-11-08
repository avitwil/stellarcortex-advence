import { describe, it, expect } from 'vitest';
import { redact, registerSecret } from './redact.js';

describe('NFR-SEC-09 redaction filter', () => {
  it('redacts common token formats', () => {
    const samples = [
      'sk-ant-api03-abcdefghijklmnop', 'sk-proj-abcdefghijklmnopqrstuv', 'AIzaSyA1234567890abcdefghijklmnopqrstu',
      'ya29.a0AfH6SMBabcdefg', '1//0gabcdefghijklmnopqrstuvwxyz', 'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'GOCSPX-abcdefghijklmnop', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlc2ln',
      '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
    ];
    for (const s of samples) expect(redact(`x ${s} y`)).not.toContain(s.slice(6));
  });
  it('redacts key=value and JSON fields', () => {
    expect(redact('{"password":"hunter22222"}')).not.toContain('hunter22222');
    expect(redact('api_key=abcdef123456')).not.toContain('abcdef123456');
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstu')).not.toContain('abcdefghijklmnopqrstu');
  });
  it('redacts registered runtime secrets anywhere', () => {
    registerSecret('my-custom-local-model-key');
    expect(redact('using my-custom-local-model-key now')).toBe('using [REDACTED] now');
  });
  it('leaves ordinary text alone', () => {
    expect(redact('hello world, bot finished the task')).toBe('hello world, bot finished the task');
  });
});
