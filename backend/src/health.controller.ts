import { Controller, Get } from '@nestjs/common';

/**
 * Tiny health endpoint. The Electron shell polls this before showing the
 * window so the renderer never beats the backend to startup.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { ok: true; uptime: number; ts: string } {
    return {
      ok: true,
      uptime: Math.round(process.uptime()),
      ts: new Date().toISOString(),
    };
  }
}
