import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

/**
 * Licensing stub — desktop / SQLite mode.
 *
 * The mks-kanban frontend checks /api/v1/licensing/config and
 * /api/v1/licensing/status on startup. In the standalone desktop
 * app there is no licensing server, so we return a permissive
 * "all features unlocked" response to prevent the frontend from
 * showing errors or blocking the UI.
 */
@Controller('licensing')
export class LicensingController {
  @Get('config')
  @HttpCode(HttpStatus.OK)
  config() {
    return {
      planType: 'desktop',
      customerName: 'Local User',
      expiresAt: '2099-12-31T00:00:00.000Z',
      daysUntilExpiration: 99999,
      features: {
        flows: true,
        whatsapp: false,
        ai: true,
        bankReconciliation: false,
        customNodes: true,
        apiAccess: true,
        sso: false,
        multiTenant: false,
      },
      limits: {
        maxUsers: 1,
        maxFlows: 9999,
        maxExecutionsPerMonth: 999999,
        maxWhatsappNumbers: 0,
        maxStorageGB: 100,
        maxApiCallsPerDay: 999999,
      },
    };
  }

  @Get('status')
  @HttpCode(HttpStatus.OK)
  status() {
    return {
      isValid: true,
      planType: 'desktop',
      expiresAt: '2099-12-31T00:00:00.000Z',
      daysUntilExpiration: 99999,
    };
  }
}
