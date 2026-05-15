/**
 * Shape of the encrypted blob persisted by EncryptionService.encrypt().
 * AES-256-GCM produces three pieces: IV, ciphertext, and auth tag.
 */
export interface EncryptedCredentialData {
  iv: string;
  encryptedData: string;
  authTag: string;
}
