import { Controller, Post, Req, Inject } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/database/schema";
import { DATABASE_CONNECTION } from "@/database/database.module";
import { profiles, session as authSession } from "@/database/schema";
import { auth } from "@/lib/auth";
import { JwtDownloadService } from "./jwt-download.service";

@ApiTags("Download Token")
@Controller()
export class JwtDownloadController {
  constructor(
    private readonly jwtDownloadService: JwtDownloadService,
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
    // Usar directamente las cabeceras de Fastify de la misma forma que lo hace el AuthGuard
    let session = await auth.api
      .getSession({ headers: request.headers as any })
      .catch((err) => {
        console.error("[jwt-download] Error getSession:", err);
        return null;
      });

    // Fallback: Si better-auth falla debido a restricciones cross-domain o parseo de cabeceras en Fastify,
    // verificamos manualmente si el frontend envió un "Authorization: Bearer <token>" e interceptamos la DB.
    if (!session?.user) {
      const authHeader = request.headers.authorization;
      if (
        typeof authHeader === "string" &&
        authHeader.toLowerCase().startsWith("bearer ")
      ) {
        const tokenStr = authHeader.substring(7).trim();
        const sessionRecord = await this.db.query.session.findFirst({
          where: eq(authSession.token, tokenStr),
        });
        if (sessionRecord && sessionRecord.userId) {
          session = { user: { id: sessionRecord.userId } } as any;
        }
      }
    }

    if (!session?.user) {
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
    const profile = await this.db.query.profiles.findFirst({
      where: eq(profiles.userId, session.user.id),
      columns: { plan: true, premiumExpireAt: true },
    });

    const plan = profile?.plan ?? "basic";
    const premiumExpireAt = profile?.premiumExpireAt ?? null;
    const isPremium =
      plan === "premium" &&
      (premiumExpireAt === null || premiumExpireAt > new Date());

    const token = await this.jwtDownloadService.generateToken({
      userId: session.user.id,
      plan: plan as "free" | "basic" | "premium",
      isPremium,
      premiumExpireAt: premiumExpireAt?.toISOString() ?? null,
    });

    return { token };
  }
}
