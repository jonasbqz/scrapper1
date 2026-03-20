import { Injectable } from "@nestjs/common";
import { SignJWT } from "jose";
import { randomBytes } from "crypto";
import { getRedisRaw } from "@/lib/redis-raw";

const REDIS_KEY = "JWT_DOWNLOAD";
const SECRET_TTL_SECONDS = 8 * 24 * 60 * 60; // 8 días
const TOKEN_TTL_SECONDS = 20 * 60; // 20 minutos para usuarios registrados
const ANON_TOKEN_TTL_SECONDS = 10 * 60; // 10 minutos para anónimos

export type DownloadTokenPayload = {
  userId: string | null;
  plan: "free" | "basic" | "premium";
  isPremium: boolean;
  premiumExpireAt: string | null;
  oneTimeUse?: boolean;
};

@Injectable()
export class JwtDownloadService {
  private async getOrCreateSecret(): Promise<Uint8Array> {
    const redis = getRedisRaw();

    if (redis) {
      try {
        let secret = await redis.get(REDIS_KEY);

        if (!secret) {
          secret = randomBytes(32).toString("hex");
          await redis.set(REDIS_KEY, secret, "EX", SECRET_TTL_SECONDS);
          console.log(
            "[jwt-download] Nuevo secreto JWT_DOWNLOAD generado en Redis.",
          );
        }

        return new TextEncoder().encode(secret);
      } catch (err) {
        console.error(
          "[jwt-download] Error leyendo Redis, usando fallback:",
          err,
        );
      }
    }

    // Fallback para desarrollo sin Redis
    const fallback = process.env.JWT_DOWNLOAD_SECRET_FALLBACK;
    if (!fallback) {
      throw new Error(
        "No hay secreto JWT disponible. Configura REDIS_URL o JWT_DOWNLOAD_SECRET_FALLBACK.",
      );
    }

    return new TextEncoder().encode(fallback);
  }

  async generateToken(payload: DownloadTokenPayload): Promise<string> {
    const secret = await this.getOrCreateSecret();
    const isAnon = payload.userId === null;
    const ttl = isAnon ? ANON_TOKEN_TTL_SECONDS : TOKEN_TTL_SECONDS;

    const token = await new SignJWT({
      userId: payload.userId,
      plan: payload.plan,
      isPremium: payload.isPremium,
      premiumExpireAt: payload.premiumExpireAt,
      ...(isAnon ? { oneTimeUse: true } : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
      .sign(secret);

    return token;
  }
}
