import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { EncryptedCredentialData } from '../types/credential.types';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly encryptionKey: Buffer;

  constructor(private readonly configService: ConfigService) {
    const key = this.configService.get<string>('ENCRYPTION_KEY');

    if (!key) {
      this.logger.warn(
        'ENCRYPTION_KEY not found in environment. Generating a temporary key. ' +
        'THIS IS NOT SECURE FOR PRODUCTION! Please set ENCRYPTION_KEY in your .env file.',
      );
      this.encryptionKey = crypto.randomBytes(32);
    } else {
      if (key.length !== 64) {
        throw new Error(
          'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
          'Generate one with: node -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"',
        );
      }
      this.encryptionKey = Buffer.from(key, 'hex');
    }
  }

  encrypt(data: any): string {
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);

      const jsonData = JSON.stringify(data);
      let encrypted = cipher.update(jsonData, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const authTag = cipher.getAuthTag();

      const result: EncryptedCredentialData = {
        iv: iv.toString('hex'),
        encryptedData: encrypted,
        authTag: authTag.toString('hex'),
      };

      return JSON.stringify(result);
    } catch (error) {
      this.logger.error(`Encryption failed: ${error.message}`);
      throw new Error('Failed to encrypt credential data');
    }
  }

  decrypt(encryptedString: string): any {
    try {
      const { iv, encryptedData, authTag }: EncryptedCredentialData = JSON.parse(encryptedString);

      const decipher = crypto.createDecipheriv(
        this.algorithm,
        this.encryptionKey,
        Buffer.from(iv, 'hex'),
      );

      decipher.setAuthTag(Buffer.from(authTag, 'hex'));

      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return JSON.parse(decrypted);
    } catch (error) {
      this.logger.error(`Decryption failed: ${error.message}`);
      throw new Error(
        'Failed to decrypt credential data. ' +
        'A chave de criptografia (ENCRYPTION_KEY) pode ter sido alterada desde que esta credencial foi salva. ' +
        'Recrie a credencial para corrigir.'
      );
    }
  }

  generateEncryptionKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}
