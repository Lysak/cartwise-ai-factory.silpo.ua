import { TokenCipherService } from './token-cipher.service';

describe('TokenCipherService', () => {
  const key = Buffer.alloc(32, 1).toString('base64');

  it('round-trips a token and produces distinct ciphertexts', () => {
    const cipher = new TokenCipherService(key);
    const first = cipher.encrypt('access-token');

    expect(cipher.decrypt(first)).toBe('access-token');
    expect(cipher.encrypt('access-token')).not.toBe(first);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new TokenCipherService(Buffer.alloc(31).toString('base64')))
      .toThrow('TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  });

  it.each([
    '',
    'iv.tag',
    'iv..ciphertext',
    '.tag.ciphertext',
    'iv.tag.',
    'AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA'
  ])('rejects malformed encrypted payload %p', (payload) => {
      const cipher = new TokenCipherService(key);

      expect(() => cipher.decrypt(payload)).toThrow('Invalid encrypted token');
    });
});
