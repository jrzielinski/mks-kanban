import { Module } from '@nestjs/common';
import { EncryptionService } from './services/encryption.service';

// Compatibility shim — exposes only EncryptionService (the part of the
// full credentials module that KanbanAgentService actually uses).
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class CredentialsModule {}
