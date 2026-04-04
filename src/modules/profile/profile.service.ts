import {
  Injectable,
  Inject,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, count, countDistinct } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import {
  account as authAccount,
  profiles,
  likes,
  comments,
  playlists,
  readingHistory,
  bookmarks,
  user as authUser,
} from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { CreateProfileDto, UpdateProfileDto } from './profile.dto';
import { buildSubscriptionSummary } from '@/modules/subscriptions/subscriptions.types';
import { StorageService } from '@/modules/media/storage.service';
import { isEmailVerificationRequired } from '@/lib/email-verification-policy';

const PROFILE_AVATAR_ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const PROFILE_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

@Injectable()
export class ProfileService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
    private readonly storageService: StorageService,
  ) {}

  async create(userId: string, dto: CreateProfileDto) {
    // Check if user already has a profile
    const existing = await this.db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });

    if (existing) {
      throw new ConflictException('Profile already exists for this user');
    }

    // Check if username is taken
    const usernameExists = await this.db.query.profiles.findFirst({
      where: eq(profiles.username, dto.username),
    });

    if (usernameExists) {
      throw new ConflictException('Username already taken');
    }

    const [profile] = await this.db.insert(profiles).values({
      userId,
      username: dto.username,
      visibleName: dto.visibleName,
      bio: dto.bio,
      avatarUrl: dto.avatarUrl,
      language: dto.language || 'es',
    }).returning();

    return profile;
  }

  async findByUserId(userId: string) {
    const profile = await this.db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });
    return profile ? this.mergeLegacySubscriptionState(profile) : null;
  }

  async findById(id: string) {
    const profile = await this.db.query.profiles.findFirst({
      where: eq(profiles.id, id),
    });
    return profile ? this.mergeLegacySubscriptionState(profile) : null;
  }

  async findByUsername(username: string) {
    return this.db.query.profiles.findFirst({
      where: eq(profiles.username, username),
    });
  }

  private async mergeLegacySubscriptionState(
    profile: typeof profiles.$inferSelect,
  ): Promise<typeof profiles.$inferSelect> {
    const legacyUser = await this.db.query.user.findFirst({
      where: eq(authUser.id, profile.userId),
    });

    if (!legacyUser) {
      return profile;
    }

    const legacyHasPremiumAccess =
      legacyUser.plan === 'premium' &&
      legacyUser.premiumExpireAt !== null;

    const nextPlan: typeof profiles.$inferSelect.plan =
      profile.plan === 'premium'
        ? 'premium'
        : legacyHasPremiumAccess
          ? 'premium'
          : profile.plan;
    const nextPremiumExpireAt =
      profile.premiumExpireAt ??
      (legacyHasPremiumAccess ? legacyUser.premiumExpireAt : null) ??
      null;

    if (nextPlan === profile.plan && nextPremiumExpireAt === profile.premiumExpireAt) {
      return profile;
    }

    await this.db
      .update(profiles)
      .set({
        plan: nextPlan,
        premiumExpireAt: nextPremiumExpireAt,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, profile.id));

    return {
      ...profile,
      plan: nextPlan,
      premiumExpireAt: nextPremiumExpireAt,
    };
  }

  toPrivateProfileResponse(profile: typeof profiles.$inferSelect) {
    return {
      id: profile.id,
      username: profile.username,
      visibleName: profile.visibleName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      language: profile.language,
      dateOfBirth: profile.dateOfBirth,
      isAdultContent: profile.isAdultContent,
      plan: profile.plan,
      premiumSource: profile.premiumSource,
      premiumCycle: profile.premiumCycle,
      premiumStartedAt: profile.premiumStartedAt,
      premiumExpireAt: profile.premiumExpireAt,
      stripeCustomerId: profile.stripeCustomerId,
      stripeSubscriptionId: profile.stripeSubscriptionId,
      stripeSubscriptionStatus: profile.stripeSubscriptionStatus,
      stripeCancelAtPeriodEnd: profile.stripeCancelAtPeriodEnd,
      stripeCurrentPeriodStart: profile.stripeCurrentPeriodStart,
      stripeCurrentPeriodEnd: profile.stripeCurrentPeriodEnd,
      stripeProductName: profile.stripeProductName,
      stripePriceLabel: profile.stripePriceLabel,
      stripeLastSyncedAt: profile.stripeLastSyncedAt,
      subscription: buildSubscriptionSummary(profile),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  async toPrivateProfileResponseForUser(profile: typeof profiles.$inferSelect) {
    const [authRecord, credentialAccount] = await Promise.all([
      this.db.query.user.findFirst({
        where: eq(authUser.id, profile.userId),
      }),
      this.db.query.account.findFirst({
        where: and(
          eq(authAccount.userId, profile.userId),
          eq(authAccount.providerId, 'credential'),
        ),
        columns: {
          providerId: true,
        },
      }),
    ]);

    const requiresEmailVerification = isEmailVerificationRequired({
      emailVerified: authRecord?.emailVerified === true,
      hasCredentialAccount: credentialAccount?.providerId === 'credential',
    });

    return {
      ...this.toPrivateProfileResponse(profile),
      emailVerified: authRecord?.emailVerified === true,
      requiresEmailVerification,
      canUseAccountFeatures: !requiresEmailVerification,
    };
  }

  async update(profileId: string, dto: UpdateProfileDto) {
    const profile = await this.findById(profileId);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    if (dto.username && dto.username !== profile.username) {
      const usernameExists = await this.db.query.profiles.findFirst({
        where: eq(profiles.username, dto.username),
      });
      if (usernameExists) {
        throw new ConflictException('Username already taken');
      }
    }

    const [updated] = await this.db
      .update(profiles)
      .set({
        ...dto,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, profileId))
      .returning();

    return updated;
  }

  async delete(profileId: string) {
    await this.db.delete(profiles).where(eq(profiles.id, profileId));
  }

  private validateAvatarUpload(
    body: Buffer,
    fileName: string | null | undefined,
    mimeType: string | null | undefined,
  ) {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException('Avatar image body is required');
    }

    if (body.length > PROFILE_AVATAR_MAX_BYTES) {
      throw new BadRequestException('Avatar image must be 5MB or smaller');
    }

    if (!fileName?.trim()) {
      throw new BadRequestException('Avatar file name is required');
    }

    const normalizedMimeType = mimeType?.split(';')[0]?.trim().toLowerCase() || null;
    if (!normalizedMimeType || !PROFILE_AVATAR_ALLOWED_MIME_TYPES.has(normalizedMimeType)) {
      throw new BadRequestException('Avatar image must be JPG, PNG, or WEBP');
    }

    return {
      fileName: fileName.trim(),
      mimeType: normalizedMimeType,
    };
  }

  async uploadAvatar(
    profileId: string,
    file: {
      body: Buffer;
      fileName: string | null | undefined;
      mimeType: string | null | undefined;
    },
  ) {
    const profile = await this.findById(profileId);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    const normalizedFile = this.validateAvatarUpload(
      file.body,
      file.fileName,
      file.mimeType,
    );
    const nextStorageKey = this.storageService.createScopedStorageKey(
      'profiles/avatars',
      profileId,
      normalizedFile.fileName,
    );

    await this.storageService.uploadObject(
      nextStorageKey,
      file.body,
      normalizedFile.mimeType,
    );

    const previousStorageKey = this.storageService.extractStorageKeyFromUrl(
      profile.avatarUrl,
    );
    const nextAvatarUrl = this.storageService.buildPublicUrl(nextStorageKey);

    const [updatedProfile] = await this.db
      .update(profiles)
      .set({
        avatarUrl: nextAvatarUrl,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, profileId))
      .returning();

    if (previousStorageKey && previousStorageKey !== nextStorageKey) {
      await this.storageService.deleteObject(previousStorageKey).catch((error) => {
        console.error('[ProfileService] Failed to delete previous avatar:', error);
      });
    }

    return updatedProfile;
  }

  async deleteAvatar(profileId: string) {
    const profile = await this.findById(profileId);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    const previousStorageKey = this.storageService.extractStorageKeyFromUrl(
      profile.avatarUrl,
    );

    const [updatedProfile] = await this.db
      .update(profiles)
      .set({
        avatarUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, profileId))
      .returning();

    if (previousStorageKey) {
      await this.storageService.deleteObject(previousStorageKey).catch((error) => {
        console.error('[ProfileService] Failed to delete avatar from storage:', error);
      });
    }

    return updatedProfile;
  }

  async getStats(profileId: string) {
    const [likesResult, commentsResult, playlistsResult, readingResult, bookmarksResult] = await Promise.all([
      this.db.select({ count: count() }).from(likes).where(eq(likes.profileId, profileId)),
      this.db.select({ count: count() }).from(comments).where(eq(comments.profileId, profileId)),
      this.db.select({ count: count() }).from(playlists).where(eq(playlists.profileId, profileId)),
      this.db.select({ count: countDistinct(readingHistory.comicId) }).from(readingHistory).where(eq(readingHistory.profileId, profileId)),
      this.db.select({ count: count() }).from(bookmarks).where(eq(bookmarks.profileId, profileId)),
    ]);

    return {
      likesCount: likesResult[0]?.count ?? 0,
      commentsCount: commentsResult[0]?.count ?? 0,
      playlistsCount: playlistsResult[0]?.count ?? 0,
      comicsReadCount: readingResult[0]?.count ?? 0,
      bookmarksCount: bookmarksResult[0]?.count ?? 0,
    };
  }
}
