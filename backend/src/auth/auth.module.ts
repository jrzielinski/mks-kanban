import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import { AuthController } from './auth.controller';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    /**
     * JwtModule is only used for desktop-token signing (HS256).
     * In web/JWKS mode this module still loads but JwtService.sign()
     * is never called — mks-identity handles token issuance.
     *
     * The secret is the same LOCAL_JWT_SECRET hex buffer that
     * JwtStrategy uses for verification, so sign() ↔ verify() always agree.
     */
    JwtModule.registerAsync({
      useFactory: () => {
        const localSecret = process.env.LOCAL_JWT_SECRET;
        return localSecret
          ? { secret: Buffer.from(localSecret, 'hex'), signOptions: { algorithm: 'HS256' } }
          : { secret: 'unused-in-jwks-mode' };
      },
    }),
  ],
  providers: [JwtStrategy],
  controllers: [AuthController],
  exports: [PassportModule, JwtModule],
})
export class AuthModule {}
