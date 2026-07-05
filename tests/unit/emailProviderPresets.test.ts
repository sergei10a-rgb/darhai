/**
 * Unit tests for email provider smart-default detection.
 */
import { describe, it, expect } from 'vitest';
import { detectEmailProvider, emailDomain } from '@/common/channels/emailProviderPresets';

describe('emailDomain', () => {
  it('extracts and lowercases the domain', () => {
    expect(emailDomain('User@Gmail.com')).toBe('gmail.com');
    expect(emailDomain('a.b+tag@sub.example.co.uk')).toBe('sub.example.co.uk');
  });
  it('returns null for malformed addresses', () => {
    for (const bad of ['', 'nope', 'no-at-sign', 'trailing@', '@nodomain', 'a@b']) {
      expect(emailDomain(bad)).toBeNull();
    }
  });
});

describe('detectEmailProvider', () => {
  it('maps common consumer providers to the right IMAP/SMTP settings', () => {
    const gmail = detectEmailProvider('waylandbot@gmail.com');
    expect(gmail?.id).toBe('gmail');
    expect(gmail?.imapHost).toBe('imap.gmail.com');
    expect(gmail?.imapPort).toBe(993);
    expect(gmail?.smtpHost).toBe('smtp.gmail.com');
    expect(gmail?.smtpPort).toBe(587);

    expect(detectEmailProvider('x@hotmail.com')?.id).toBe('outlook');
    expect(detectEmailProvider('x@live.com')?.imapHost).toBe('outlook.office365.com');
    expect(detectEmailProvider('x@icloud.com')?.imapHost).toBe('imap.mail.me.com');
    expect(detectEmailProvider('x@yahoo.com')?.smtpPort).toBe(465);
    expect(detectEmailProvider('x@fastmail.com')?.id).toBe('fastmail');
  });

  it('special-cases Proton to the local Bridge with a note', () => {
    const proton = detectEmailProvider('x@proton.me');
    expect(proton?.imapHost).toBe('127.0.0.1');
    expect(proton?.imapPort).toBe(1143);
    expect(proton?.note).toMatch(/Bridge/i);
  });

  it('accepts a bare domain too', () => {
    expect(detectEmailProvider('gmail.com')?.id).toBe('gmail');
  });

  it('returns null for custom / unknown domains (e.g. a Workspace domain)', () => {
    // ferroxlabs.com is really Gmail (Workspace) but cannot be matched by domain
    // alone - that needs an MX/autoconfig lookup (future enhancement).
    expect(detectEmailProvider('waylandbot@ferroxlabs.com')).toBeNull();
    expect(detectEmailProvider('x@some-random-company.org')).toBeNull();
    expect(detectEmailProvider('')).toBeNull();
  });
});
