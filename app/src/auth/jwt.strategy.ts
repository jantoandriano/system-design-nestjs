import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') as string,
    });
  }

  // Whatever this returns becomes `req.user` in protected route handlers.
  validate(payload: JwtPayload) {
    // Tokens issued before tenancy shipped (up to 1h old, the JWT expiry)
    // have no tenantId claim. Failing open here would let the request
    // proceed fully authenticated but unbound to any tenant context -
    // TenantContextInterceptor's `if (!user?.tenantId)` guard treats that
    // as a pass-through, not a rejection. Reject explicitly instead.
    if (!payload.tenantId) {
      throw new UnauthorizedException('Token is missing a tenant claim');
    }
    return { userId: payload.sub, username: payload.username, tenantId: payload.tenantId };
  }
}
