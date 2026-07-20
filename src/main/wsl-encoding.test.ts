import { describe, it, expect } from 'vitest';
import { decodeWslOutput } from './wsl-encoding';

const BOM = '﻿';
const SOH = '';

describe('decodeWslOutput', () => {
  it('decodes plain UTF-8', () => {
    expect(decodeWslOutput(Buffer.from('hello world', 'utf8'))).toBe('hello world');
  });

  it('decodes UTF-16LE (high NUL density)', () => {
    expect(decodeWslOutput(Buffer.from('Ubuntu-22.04', 'utf16le'))).toBe('Ubuntu-22.04');
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(decodeWslOutput(Buffer.from(BOM + 'data', 'utf8'))).toBe('data');
  });

  it('strips a leading BOM from UTF-16LE', () => {
    expect(decodeWslOutput(Buffer.from(BOM + 'distro', 'utf16le'))).toBe('distro');
  });

  it('keeps SOH-separated scan output as UTF-8 (SOH is not NUL)', () => {
    // The /proc scan emits 0x01 (SOH) separators and never NUL, so even a row
    // full of control bytes must still be sniffed as UTF-8, not UTF-16LE.
    const row = ['P', 'term', '1234', '5678', 'bash'].join(SOH);
    expect(decodeWslOutput(Buffer.from(row, 'utf8'))).toBe(row);
  });

  it('returns empty string for an empty buffer', () => {
    expect(decodeWslOutput(Buffer.alloc(0))).toBe('');
  });
});
