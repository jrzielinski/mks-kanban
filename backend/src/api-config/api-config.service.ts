import { Injectable } from '@nestjs/common';

// Compatibility shim — returns a minimal config object so existing callers
// that do apiConfigService.findActive(tenantId) don't throw.
@Injectable()
export class ApiConfigService {
  async findActive(_tenantId: string): Promise<Record<string, unknown>> {
    return {};
  }
}
