import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import {
  comics,
  chapters,
  entityReactions,
} from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';

export type EntityReactionTarget = 'comic' | 'chapter';
export type EntityReactionType =
  | 'upvote'
  | 'funny'
  | 'love'
  | 'surprised'
  | 'angry'
  | 'sad';

const DEFAULT_REACTION_SUMMARY: Record<EntityReactionType, number> = {
  upvote: 0,
  funny: 0,
  love: 0,
  surprised: 0,
  angry: 0,
  sad: 0,
};

@Injectable()
export class EntityReactionsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  private assertTargetType(entityType: string): EntityReactionTarget {
    if (entityType !== 'comic' && entityType !== 'chapter') {
      throw new BadRequestException('Invalid entity type');
    }
    return entityType;
  }

  private assertReactionType(reactionType: string): EntityReactionType {
    if (
      reactionType !== 'upvote' &&
      reactionType !== 'funny' &&
      reactionType !== 'love' &&
      reactionType !== 'surprised' &&
      reactionType !== 'angry' &&
      reactionType !== 'sad'
    ) {
      throw new BadRequestException('Invalid reaction type');
    }

    return reactionType;
  }

  private async getTargetEntity(
    entityType: EntityReactionTarget,
    entityId: number,
  ) {
    if (entityType === 'comic') {
      const entity = await this.db.query.comics.findFirst({
        where: eq(comics.id, entityId),
        columns: { id: true, reactionsTotal: true, reactionsSummary: true },
      });
      if (!entity) {
        throw new NotFoundException('Comic not found');
      }
      return entity;
    }

    const entity = await this.db.query.chapters.findFirst({
      where: eq(chapters.id, entityId),
      columns: { id: true, reactionsTotal: true, reactionsSummary: true },
    });
    if (!entity) {
      throw new NotFoundException('Chapter not found');
    }
    return entity;
  }

  private getNextSummary(
    currentSummary: Record<EntityReactionType, number> | null | undefined,
    previousReaction: EntityReactionType | null,
    nextReaction: EntityReactionType | null,
  ) {
    const summary = {
      ...DEFAULT_REACTION_SUMMARY,
      ...(currentSummary || {}),
    };

    if (previousReaction) {
      summary[previousReaction] = Math.max(0, (summary[previousReaction] || 0) - 1);
    }
    if (nextReaction) {
      summary[nextReaction] = (summary[nextReaction] || 0) + 1;
    }

    const reactionsTotal = Object.values(summary).reduce(
      (total, value) => total + value,
      0,
    );

    return { summary, reactionsTotal };
  }

  async getSummary(
    rawEntityType: string,
    entityId: number,
    profileId?: string | null,
  ) {
    const entityType = this.assertTargetType(rawEntityType);
    const entity = await this.getTargetEntity(entityType, entityId);

    let currentUserReaction: EntityReactionType | null = null;
    if (profileId) {
      const currentReaction = await this.db.query.entityReactions.findFirst({
        where: and(
          eq(entityReactions.entityType, entityType),
          eq(entityReactions.entityId, entityId),
          eq(entityReactions.profileId, profileId),
        ),
        columns: { reactionType: true },
      });
      currentUserReaction = currentReaction?.reactionType ?? null;
    }

    return {
      entityType,
      entityId,
      reactionsTotal: entity.reactionsTotal,
      reactionsSummary: {
        ...DEFAULT_REACTION_SUMMARY,
        ...(entity.reactionsSummary || {}),
      },
      currentUserReaction,
    };
  }

  async toggleReaction(
    profileId: string,
    rawEntityType: string,
    entityId: number,
    rawReactionType: string,
  ) {
    const entityType = this.assertTargetType(rawEntityType);
    const reactionType = this.assertReactionType(rawReactionType);

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${entityType}:${entityId}:${profileId}`}))`,
      );

      const entity =
        entityType === 'comic'
          ? await tx.query.comics.findFirst({
              where: eq(comics.id, entityId),
              columns: { id: true, reactionsTotal: true, reactionsSummary: true },
            })
          : await tx.query.chapters.findFirst({
              where: eq(chapters.id, entityId),
              columns: { id: true, reactionsTotal: true, reactionsSummary: true },
            });

      if (!entity) {
        throw new NotFoundException(
          entityType === 'comic' ? 'Comic not found' : 'Chapter not found',
        );
      }

      const existing = await tx.query.entityReactions.findFirst({
        where: and(
          eq(entityReactions.entityType, entityType),
          eq(entityReactions.entityId, entityId),
          eq(entityReactions.profileId, profileId),
        ),
      });

      const previousReaction = existing?.reactionType ?? null;
      const nextReaction =
        previousReaction === reactionType ? null : reactionType;

      if (existing && nextReaction === null) {
        await tx
          .delete(entityReactions)
          .where(eq(entityReactions.id, existing.id));
      } else if (existing && nextReaction !== null) {
        await tx
          .update(entityReactions)
          .set({
            reactionType: nextReaction,
            updatedAt: new Date(),
          })
          .where(eq(entityReactions.id, existing.id));
      } else {
        await tx
          .insert(entityReactions)
          .values({
            entityType,
            entityId,
            profileId,
            reactionType: nextReaction!,
          })
          .onConflictDoUpdate({
            target: [
              entityReactions.entityType,
              entityReactions.entityId,
              entityReactions.profileId,
            ],
            set: {
              reactionType: nextReaction!,
              updatedAt: new Date(),
            },
          });
      }

      const { summary, reactionsTotal } = this.getNextSummary(
        entity.reactionsSummary as Record<EntityReactionType, number> | null,
        previousReaction,
        nextReaction,
      );

      if (entityType === 'comic') {
        await tx
          .update(comics)
          .set({
            reactionsSummary: summary,
            reactionsTotal,
            updatedAt: new Date(),
          })
          .where(eq(comics.id, entityId));
      } else {
        await tx
          .update(chapters)
          .set({
            reactionsSummary: summary,
            reactionsTotal,
            updatedAt: new Date(),
          })
          .where(eq(chapters.id, entityId));
      }

      return {
        entityType,
        entityId,
        currentUserReaction: nextReaction,
        reactionsSummary: summary,
        reactionsTotal,
      };
    });
  }
}
