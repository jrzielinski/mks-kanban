import { Module } from '@nestjs/common';
import { ApiConfigService } from './api-config.service';
import { MultiProviderAiService } from './services/multi-provider-ai.service';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [AiModule],
  providers: [ApiConfigService, MultiProviderAiService],
  exports: [ApiConfigService, MultiProviderAiService],
})
export class ApiConfigModule {}
