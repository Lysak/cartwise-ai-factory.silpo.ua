import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class TokenCipherService {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, 'base64');

    if (this.key.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
  }

  decrypt(payload: string): string {
    const [encodedIv, encodedTag, encodedCiphertext] = payload.split('.');

    if (!encodedIv || !encodedTag || !encodedCiphertext) {
      throw new Error('Invalid encrypted token');
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encodedIv, 'base64url'));
      decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final()
      ]).toString('utf8');
    } catch {
      throw new Error('Invalid encrypted token');
    }
  }
}
