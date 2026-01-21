import { Injectable, Inject, ConflictException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { profiles } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { CreateProfileDto, UpdateProfileDto } from './profile.dto';

@Injectable()
export class ProfileService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
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
    return this.db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });
  }

  async findById(id: string) {
    return this.db.query.profiles.findFirst({
      where: eq(profiles.id, id),
    });
  }

  async findByUsername(username: string) {
    return this.db.query.profiles.findFirst({
      where: eq(profiles.username, username),
    });
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
}
