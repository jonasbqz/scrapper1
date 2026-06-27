import { Controller, Post, Req, Inject, ForbiddenException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/database/schema";
import { DATABASE_CONNECTION } from "@/database/database.module";
import { account, profiles, user as authUser } from "@/database/schema";
import { SessionResolverService } from "@/modules/auth/session-resolver";
import { JwtDownloadService } from "./jwt-download.service";
import {
  getEmailVerificationRequiredError,
  isEmailVerificationRequired,
} from "@/lib/email-verification-policy";

@ApiTags("Download Token")
@Controller()
export class JwtDownloadController {
  constructor(
    private readonly jwtDownloadService: JwtDownloadService,
    private readonly sessionResolver: SessionResolverService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * POST /api/download-token
   * Devuelve un JWT de descarga corto (5 min).
   * Si hay sesión activa → incluye userId, plan, isPremium.
   * Si no hay sesión → devuelve token anónimo (userId: null, plan: 'free').
   */
  @Post("download-token")
  @ApiOperation({
    summary: "Generate a short-lived download JWT",
    description:
      "Authenticated users get a token with their plan. Anonymous users get a free-tier token valid for 10 minutes.",
  })
  async generateDownloadToken(@Req() request: FastifyRequest) {
    // Resolve session via shared service (cookie + Bearer token fallback)
    const session = await this.sessionResolver.resolveSession(
      request.headers as Record<string, any>,
    );

    if (!session) {
      // Token anónimo
      const token = await this.jwtDownloadService.generateToken({
        userId: null,
        plan: "free",
        isPremium: false,
        premiumExpireAt: null,
        oneTimeUse: true,
      });
      return { token };
    }

    // Obtener perfil del usuario para saber el plan
    const [profile, credentialAccount, authRecord] = await Promise.all([
      this.db.query.profiles.findFirst({
        where: eq(profiles.userId, session.user.id),
        columns: { plan: true, premiumExpireAt: true },
      }),
      this.db.query.account.findFirst({
        where: and(
          eq(account.userId, session.user.id),
          eq(account.providerId, "credential"),
        ),
        columns: {
          providerId: true,
        },
      }),
      this.db.query.user.findFirst({
        where: eq(authUser.id, session.user.id),
        columns: {
          emailVerified: true,
        },
      }),
    ]);

    const requiresEmailVerification = isEmailVerificationRequired({
      emailVerified: authRecord?.emailVerified === true,
      hasCredentialAccount: credentialAccount?.providerId === "credential",
    });

    if (requiresEmailVerification) {
      throw new ForbiddenException(getEmailVerificationRequiredError());
    }

    const plan = profile?.plan ?? "basic";
    const premiumExpireAt = profile?.premiumExpireAt ?? null;
    const isPremium =
      plan === "premium" &&
      premiumExpireAt !== null &&
      premiumExpireAt > new Date();

    const token = await this.jwtDownloadService.generateToken({
      userId: session.user.id,
      plan: plan as "free" | "basic" | "premium",
      isPremium,
      premiumExpireAt: premiumExpireAt?.toISOString() ?? null,
    });

    return { token };
  }
}
