import {
  dateToDays,
  daysToDate,
  generateActivationNumber,
  getLicenseSecret,
  readActivationNumber,
} from './license-crypto';

// A fixed, obviously-fake secret used ONLY to pin the wire format below —
// never the real ROBOCODERS_LICENSE_SECRET.
const TEST_SECRET = Buffer.from(
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  'base64',
);

describe('license-crypto', () => {
  describe('generateActivationNumber — byte-format regression', () => {
    // Pinned known-vector: if this ever changes for the same inputs, the
    // wire format has drifted and every already-issued key (and the real
    // desktop app's independent implementation) is now out of sync with
    // whatever this function produces. There is no external reference
    // implementation in this repo to diff against (see the module's header
    // comment), so this pinned vector is the only regression guard.
    it('produces byte-identical output for a fixed input set', () => {
      const key = generateActivationNumber({
        machineId: 'AABBCCDDEEFF0011',
        startDate: '2026-01-01',
        expiryDate: '2026-12-31',
        licenseNumber: 10001,
        secret: TEST_SECRET,
      });
      expect(key).toBe('55F4FYW-QPP2R4F-SMLTJQM');
    });

    it('round-trips through readActivationNumber with the same secret', () => {
      const key = generateActivationNumber({
        machineId: 'AABBCCDDEEFF0011',
        startDate: '2026-01-01',
        expiryDate: '2026-12-31',
        licenseNumber: 10001,
        secret: TEST_SECRET,
      });
      const decoded = readActivationNumber(key, TEST_SECRET);
      expect(decoded).toEqual({
        valid: true,
        machineId: 'AABBCC', // only the first 3 bytes (6 hex chars) are wire-bound, by design
        startDate: '2026-01-01',
        expiryDate: '2026-12-31',
        licenseNumber: 10001,
      });
    });

    it('rejects a machine ID that is not exactly 16 hex characters', () => {
      expect(() =>
        generateActivationNumber({
          machineId: 'AABBCC',
          startDate: '2026-01-01',
          expiryDate: '2026-12-31',
          licenseNumber: 1,
          secret: TEST_SECRET,
        }),
      ).toThrow('Machine ID must be 16 hex characters');
    });

    it('rejects a license number outside 0..99999', () => {
      expect(() =>
        generateActivationNumber({
          machineId: 'AABBCCDDEEFF0011',
          startDate: '2026-01-01',
          expiryDate: '2026-12-31',
          licenseNumber: 100000,
          secret: TEST_SECRET,
        }),
      ).toThrow('License number must be an integer between 0 and 99999');
    });
  });

  describe('readActivationNumber — tamper detection', () => {
    it('rejects a key decoded with the wrong secret', () => {
      const key = generateActivationNumber({
        machineId: 'AABBCCDDEEFF0011',
        startDate: '2026-01-01',
        expiryDate: '2026-12-31',
        licenseNumber: 10001,
        secret: TEST_SECRET,
      });
      const wrongSecret = Buffer.from(
        'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
        'base64',
      );
      const decoded = readActivationNumber(key, wrongSecret);
      expect(decoded.valid).toBe(false);
    });

    it('rejects a key with a single flipped character', () => {
      const key = generateActivationNumber({
        machineId: 'AABBCCDDEEFF0011',
        startDate: '2026-01-01',
        expiryDate: '2026-12-31',
        licenseNumber: 10001,
        secret: TEST_SECRET,
      });
      const tampered = key.slice(0, -1) + (key.at(-1) === 'A' ? 'B' : 'A');
      const decoded = readActivationNumber(tampered, TEST_SECRET);
      expect(decoded.valid).toBe(false);
      expect(decoded.reason).toMatch(/invalid or was modified/i);
    });

    it('rejects garbage input', () => {
      expect(readActivationNumber('not-a-key', TEST_SECRET).valid).toBe(false);
      expect(readActivationNumber('', TEST_SECRET).valid).toBe(false);
    });
  });

  describe('date helpers', () => {
    it('round-trips a date through dateToDays/daysToDate', () => {
      expect(daysToDate(dateToDays('2026-07-28'))).toBe('2026-07-28');
    });

    it('rejects a date before the epoch', () => {
      expect(() => dateToDays('2024-12-31')).toThrow('Date out of range');
    });
  });

  describe('getLicenseSecret', () => {
    const original = process.env.ROBOCODERS_LICENSE_SECRET;
    afterEach(() => {
      if (original === undefined) delete process.env.ROBOCODERS_LICENSE_SECRET;
      else process.env.ROBOCODERS_LICENSE_SECRET = original;
    });

    it('throws instead of silently falling back to a known default when unset', () => {
      delete process.env.ROBOCODERS_LICENSE_SECRET;
      expect(() => getLicenseSecret()).toThrow(/ROBOCODERS_LICENSE_SECRET/);
    });

    it('returns the configured secret decoded from base64', () => {
      process.env.ROBOCODERS_LICENSE_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      expect(getLicenseSecret()).toEqual(TEST_SECRET);
    });
  });
});
