import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { premiumRefundRequests, profiles, user } from '@/database/schema';
import type * as schema from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  getAllowedPersonalEmailDomainsLabel,
  isAllowedPersonalEmailDomain,
} from '@/lib/email-policy';
import {
  buildSubscriptionSummary,
  type PremiumCycle,
  type PremiumRefundRequest,
  type PremiumRefundRequestListResponse,
  type ProfileRecord,
  type PremiumSource,
  type RefundRequestStatus,
  type SubscriptionSummary,
} from './subscriptions.types';

type StripeSubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid'
  | 'paused';

interface StripeRecurring {
  interval: 'day' | 'week' | 'month' | 'year';
  interval_count: number;
}

interface StripePrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: StripeRecurring | null;
  product:
    | string
    | {
        id: string;
        name?: string;
      };
}

interface StripeSubscriptionItem {
  current_period_start?: number | null;
  current_period_end?: number | null;
  price: StripePrice;
}

interface StripeSubscription {
  id: string;
  customer: string | null;
  status: StripeSubscriptionStatus;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  current_period_start: number | null;
  current_period_end: number | null;
  metadata?: Record<string, string | undefined>;
  items: {
    data: StripeSubscriptionItem[];
  };
}

interface StripeEvent<T = unknown> {
  id: string;
  type: string;
  data: {
    object: T;
  };
}

interface StripeCheckoutSession {
  id: string;
  url: string | null;
  customer: string | null;
  subscription?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string | undefined>;
  status?: string | null;
  payment_status?: string | null;
}

type RefundRequestRecord = typeof premiumRefundRequests.$inferSelect & {
  username: string | null;
  visibleName: string | null;
  email: string | null;
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly checkoutLocks = new Map<
    string,
    Promise<{ url: string; sessionId: string }>
  >();

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly configService: ConfigService,
  ) {}

  async getProfileSubscriptionSummary(profileId: string): Promise<SubscriptionSummary> {
    const profile = await this.getProfileById(profileId);
    return buildSubscriptionSummary(profile);
  }

  async getCurrentRefundRequest(profileId: string): Promise<PremiumRefundRequest | null> {
    const profile = await this.getProfileById(profileId);

    if (!profile.stripeSubscriptionId) {
      return null;
    }

    const request = await this.findLatestRefundRequestForSubscription(
      profile.id,
      profile.stripeSubscriptionId,
    );

    return request ? this.mapRefundRequestRecord(request) : null;
  }

  async createRefundRequest(
    profileId: string,
    reason: string,
  ): Promise<PremiumRefundRequest> {
    const normalizedReason = reason?.trim();

    if (!normalizedReason || normalizedReason.length < 10) {
      throw new BadRequestException(
        'Explain the refund reason with at least 10 characters',
      );
    }

    if (normalizedReason.length > 2000) {
      throw new BadRequestException('Refund reason is too long');
    }

    const profile = await this.getProfileById(profileId);
    const summary = buildSubscriptionSummary(profile);

    if (
      summary.paymentMethod !== 'stripe' ||
      summary.plan !== 'premium' ||
      !summary.stripeSubscriptionId
    ) {
      throw new BadRequestException(
        'Only Stripe premium subscriptions can create refund requests',
      );
    }

    const existingOpenRequest = await this.findOpenRefundRequest(
      profile.id,
      summary.stripeSubscriptionId,
    );

    if (existingOpenRequest) {
      throw new BadRequestException(
        'There is already an open refund request for this subscription',
      );
    }

    const inserted = await this.db
      .insert(premiumRefundRequests)
      .values({
        profileId: profile.id,
        userId: profile.userId,
        stripeSubscriptionId: summary.stripeSubscriptionId,
        stripeCustomerId: profile.stripeCustomerId,
        reason: normalizedReason,
        status: 'pending',
        plan: summary.plan,
        cycle: summary.cycle,
        paymentMethod: summary.paymentMethod,
        currentPeriodEnd: summary.currentPeriodEnd
          ? new Date(summary.currentPeriodEnd)
          : null,
        priceLabel: summary.priceLabel,
        productName: summary.productName,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({
        id: premiumRefundRequests.id,
      });

    return this.getRefundRequestById(inserted[0].id);
  }

  async listRefundRequests(input: {
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<PremiumRefundRequestListResponse> {
    const requestedPage =
      typeof input.page === 'number' && Number.isFinite(input.page)
        ? input.page
        : 1;
    const requestedLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? input.limit
        : 20;
    const page = Math.max(1, requestedPage);
    const limit = Math.min(100, Math.max(1, requestedLimit));
    const offset = (page - 1) * limit;
    const whereClause = this.buildRefundRequestWhereClause(input);

    const items = await this.db
      .select({
        id: premiumRefundRequests.id,
        profileId: premiumRefundRequests.profileId,
        userId: premiumRefundRequests.userId,
        stripeSubscriptionId: premiumRefundRequests.stripeSubscriptionId,
        stripeCustomerId: premiumRefundRequests.stripeCustomerId,
        reason: premiumRefundRequests.reason,
        status: premiumRefundRequests.status,
        adminNote: premiumRefundRequests.adminNote,
        resolvedByAdminId: premiumRefundRequests.resolvedByAdminId,
        resolvedAt: premiumRefundRequests.resolvedAt,
        plan: premiumRefundRequests.plan,
        cycle: premiumRefundRequests.cycle,
        paymentMethod: premiumRefundRequests.paymentMethod,
        currentPeriodEnd: premiumRefundRequests.currentPeriodEnd,
        priceLabel: premiumRefundRequests.priceLabel,
        productName: premiumRefundRequests.productName,
        createdAt: premiumRefundRequests.createdAt,
        updatedAt: premiumRefundRequests.updatedAt,
        username: profiles.username,
        visibleName: profiles.visibleName,
        email: user.email,
      })
      .from(premiumRefundRequests)
      .leftJoin(profiles, eq(premiumRefundRequests.profileId, profiles.id))
      .leftJoin(user, eq(premiumRefundRequests.userId, user.id))
      .where(whereClause)
      .orderBy(desc(premiumRefundRequests.createdAt))
      .limit(limit)
      .offset(offset);

    const totalRows = await this.db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(premiumRefundRequests)
      .leftJoin(profiles, eq(premiumRefundRequests.profileId, profiles.id))
      .leftJoin(user, eq(premiumRefundRequests.userId, user.id))
      .where(whereClause);

    const total = Number(totalRows[0]?.count ?? 0);

    return {
      items: items.map((item) => this.mapRefundRequestRecord(item)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async getRefundRequestById(id: string): Promise<PremiumRefundRequest> {
    const request = await this.findRefundRequestById(id);

    if (!request) {
      throw new NotFoundException('Refund request not found');
    }

    return this.mapRefundRequestRecord(request);
  }

  async updateRefundRequest(inputId: string, input: {
    status?: string;
    adminNote?: string;
    actorId?: string | null;
  }): Promise<PremiumRefundRequest> {
    const request = await this.findRefundRequestById(inputId);

    if (!request) {
      throw new NotFoundException('Refund request not found');
    }

    const nextStatus = input.status
      ? this.parseRefundRequestStatus(input.status)
      : request.status;
    const nextAdminNote =
      input.adminNote !== undefined ? input.adminNote.trim() || null : request.adminNote;

    if (nextStatus !== request.status) {
      if (nextStatus === 'reviewing' && request.status !== 'pending') {
        throw new BadRequestException(
          'Only pending refund requests can move to reviewing',
        );
      }

      if (
        (nextStatus === 'approved' || nextStatus === 'rejected') &&
        !['pending', 'reviewing'].includes(request.status)
      ) {
        throw new BadRequestException(
          'Only pending or reviewing refund requests can be resolved',
        );
      }
    }

    const isResolved = nextStatus === 'approved' || nextStatus === 'rejected';
    const statusChanged = nextStatus !== request.status;

    await this.db
      .update(premiumRefundRequests)
      .set({
        status: nextStatus,
        adminNote: nextAdminNote,
        resolvedByAdminId: isResolved
          ? statusChanged
            ? input.actorId ?? null
            : request.resolvedByAdminId ?? null
          : null,
        resolvedAt: isResolved
          ? statusChanged
            ? new Date()
            : request.resolvedAt ?? null
          : null,
        updatedAt: new Date(),
      })
      .where(eq(premiumRefundRequests.id, inputId));

    return this.getRefundRequestById(inputId);
  }

  async createCheckoutSession(profileId: string, cycle: PremiumCycle) {
    if (!['1w', '1m', '3m', '6m'].includes(cycle)) {
      throw new BadRequestException('Unsupported premium cycle');
    }

    const checkoutLockKey = this.buildCheckoutLockKey(profileId, cycle);
    const inFlightCheckout = this.checkoutLocks.get(checkoutLockKey);
    if (inFlightCheckout) {
      return inFlightCheckout;
    }

    const checkoutPromise = this.createCheckoutSessionInternal(
      profileId,
      cycle,
    );
    this.checkoutLocks.set(checkoutLockKey, checkoutPromise);

    try {
      return await checkoutPromise;
    } finally {
      this.checkoutLocks.delete(checkoutLockKey);
    }
  }

  async confirmCheckoutSession(
    profileId: string,
    sessionId: string,
  ): Promise<SubscriptionSummary> {
    if (!sessionId?.startsWith('cs_')) {
      throw new BadRequestException('Invalid Stripe checkout session id');
    }

    const profile = await this.getProfileById(profileId);
    const checkoutSession = await this.retrieveStripeCheckoutSession(sessionId);

    const sessionProfileId =
      checkoutSession.client_reference_id ??
      checkoutSession.metadata?.profileId ??
      null;

    if (sessionProfileId !== profile.id) {
      throw new BadRequestException('Checkout session does not belong to this profile');
    }

    const subscriptionId = checkoutSession.subscription ?? null;

    if (!subscriptionId) {
      return buildSubscriptionSummary(profile);
    }

    const subscription = await this.waitForStripeSubscriptionPeriods(subscriptionId);

    if (!subscription) {
      return buildSubscriptionSummary(profile);
    }

    if (!this.isPremiumPriceAllowed(subscription)) {
      throw new BadRequestException('Stripe checkout session is not linked to an allowlisted premium price');
    }

    const updatedProfile = await this.syncProfileFromStripeSubscription(
      profile,
      subscription,
    );

    return buildSubscriptionSummary(updatedProfile);
  }

  private async createCheckoutSessionInternal(
    profileId: string,
    cycle: PremiumCycle,
  ) {

    const profile = await this.getProfileById(profileId);
    const summary = buildSubscriptionSummary(profile);
    const currentPeriodEnd = summary.currentPeriodEnd
      ? new Date(summary.currentPeriodEnd)
      : null;
    const hasPremiumAccess =
      summary.plan === 'premium' &&
      !!currentPeriodEnd &&
      Number.isFinite(currentPeriodEnd.getTime()) &&
      currentPeriodEnd.getTime() > Date.now() &&
      ['active', 'canceling', 'past_due'].includes(summary.status);

    if (hasPremiumAccess) {
      throw new BadRequestException('Premium access is already active for this profile');
    }

    const authUser = await this.db.query.user.findFirst({
      where: eq(user.id, profile.userId),
    });

    if (!authUser) {
      throw new NotFoundException('User not found');
    }

    if (!authUser.emailVerified) {
      throw new BadRequestException(
        'Debes verificar tu correo antes de comprar Premium con Stripe',
      );
    }

    if (!isAllowedPersonalEmailDomain(authUser.email)) {
      throw new BadRequestException(
        `Solo aceptamos correos personales de: ${getAllowedPersonalEmailDomainsLabel()}.`,
      );
    }

    const price = await this.resolveStripeCheckoutPrice(cycle);
    const session = await this.createStripeCheckoutForProfile({
      profile,
      email: authUser.email ?? null,
      priceId: price.id,
    });

    if (!session.url) {
      throw new BadRequestException('Stripe checkout session was created without a URL');
    }

    if (session.customer && session.customer !== profile.stripeCustomerId) {
      await this.db
        .update(profiles)
        .set({
          stripeCustomerId: session.customer,
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, profile.id));
    }

    return {
      url: session.url,
      sessionId: session.id,
    };
  }

  async cancelSubscriptionAtPeriodEnd(profileId: string): Promise<SubscriptionSummary> {
    const profile = await this.getProfileById(profileId);

    if (profile.premiumSource !== 'stripe' || !profile.stripeSubscriptionId) {
      throw new BadRequestException('No active Stripe subscription found');
    }

    const subscription = await this.updateStripeSubscription(
      profile.stripeSubscriptionId,
      new URLSearchParams({
        cancel_at_period_end: 'true',
      }),
    );

    const updatedProfile = await this.syncProfileFromStripeSubscription(profile, subscription);
    return buildSubscriptionSummary(updatedProfile);
  }

  async reactivateSubscription(profileId: string): Promise<SubscriptionSummary> {
    const profile = await this.getProfileById(profileId);

    if (profile.premiumSource !== 'stripe' || !profile.stripeSubscriptionId) {
      throw new BadRequestException('No active Stripe subscription found');
    }

    const subscription = await this.updateStripeSubscription(
      profile.stripeSubscriptionId,
      new URLSearchParams({
        cancel_at_period_end: 'false',
      }),
    );

    const updatedProfile = await this.syncProfileFromStripeSubscription(profile, subscription);
    return buildSubscriptionSummary(updatedProfile);
  }

  async takeOverStripeSubscription(profileId: string): Promise<SubscriptionSummary> {
    const profile = await this.getProfileById(profileId);

    if (profile.premiumSource !== 'stripe') {
      throw new BadRequestException('Only Stripe-managed subscriptions can be taken over');
    }

    let nextProfile = profile;

    if (profile.stripeSubscriptionId) {
      let subscription: StripeSubscription | null = null;

      if (profile.stripeCancelAtPeriodEnd) {
        subscription = await this.retrieveStripeSubscription(profile.stripeSubscriptionId);
      } else {
        subscription = await this.updateStripeSubscription(
          profile.stripeSubscriptionId,
          new URLSearchParams({
            cancel_at_period_end: 'true',
          }),
        );
      }

      nextProfile = await this.syncProfileFromStripeSubscription(profile, subscription);
    }

    await this.db
      .update(profiles)
      .set({
        premiumSource: 'manual',
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, nextProfile.id));

    const updatedProfile = await this.getProfileById(nextProfile.id);
    return buildSubscriptionSummary(updatedProfile);
  }

  async resyncProfileSubscription(profileId: string): Promise<SubscriptionSummary> {
    const profile = await this.getProfileById(profileId);

    if (profile.premiumSource !== 'stripe') {
      return buildSubscriptionSummary(profile);
    }

    const subscription = await this.findStripeSubscriptionForProfile(profile);

    const updatedProfile = await this.syncProfileFromStripeSubscription(profile, subscription);
    return buildSubscriptionSummary(updatedProfile);
  }

  async handleWebhook(rawBody: Buffer | string | undefined, signatureHeader?: string) {
    if (!rawBody || !signatureHeader) {
      throw new BadRequestException('Missing Stripe webhook payload');
    }

    const payloadBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    this.verifyWebhookSignature(payloadBuffer, signatureHeader);

    const event = JSON.parse(payloadBuffer.toString('utf8')) as StripeEvent<any>;
    const eventObject = event.data?.object;

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.syncSubscriptionEvent(eventObject as StripeSubscription, event.id);
        return;
      case 'invoice.paid':
      case 'invoice.payment_failed':
        await this.syncInvoiceEvent(eventObject, event.id);
        return;
      default:
        this.logger.debug(`Ignoring Stripe event ${event.type}`);
    }
  }

  private async syncSubscriptionEvent(
    subscription: StripeSubscription,
    eventId: string,
  ) {
    if (!this.isPremiumPriceAllowed(subscription)) {
      this.logger.debug(
        `Stripe event ${eventId} ignored: subscription ${subscription.id} is not allowlisted`,
      );
      return;
    }

    const profile = await this.findProfileForStripeMetadata(subscription.metadata);
    if (!profile) {
      this.logger.warn(
        `Stripe event ${eventId} ignored: no profile match for subscription ${subscription.id}`,
      );
      return;
    }

    if (this.shouldIgnoreStripeMutation(profile)) {
      this.logger.warn(
        `Stripe event ${eventId} ignored: profile ${profile.id} is managed manually/legacy`,
      );
      return;
    }

    await this.syncProfileFromStripeSubscription(profile, subscription);
  }

  private async syncInvoiceEvent(invoice: any, eventId: string) {
    const subscriptionId =
      typeof invoice?.subscription === 'string'
        ? invoice.subscription
        : invoice?.subscription?.id;

    if (!subscriptionId) {
      this.logger.warn(`Stripe event ${eventId} ignored: invoice has no subscription`);
      return;
    }

    const subscription = await this.retrieveStripeSubscription(subscriptionId);
    if (!this.isPremiumPriceAllowed(subscription)) {
      this.logger.debug(
        `Stripe event ${eventId} ignored: invoice subscription ${subscription.id} is not allowlisted`,
      );
      return;
    }
    const profile = await this.findProfileForStripeMetadata(subscription.metadata);

    if (!profile) {
      this.logger.warn(
        `Stripe event ${eventId} ignored: no profile match for subscription ${subscription.id}`,
      );
      return;
    }

    if (this.shouldIgnoreStripeMutation(profile)) {
      this.logger.warn(
        `Stripe event ${eventId} ignored: profile ${profile.id} is managed manually/legacy`,
      );
      return;
    }

    await this.syncProfileFromStripeSubscription(profile, subscription);
  }

  private shouldIgnoreStripeMutation(profile: ProfileRecord) {
    return (
      profile.premiumSource === 'manual' ||
      (profile.premiumSource === null && profile.plan === 'premium')
    );
  }

  private verifyWebhookSignature(rawBody: Buffer, signatureHeader: string) {
    const webhookSecret = this.getRequiredConfig('STRIPE_WEBHOOK_SECRET');
    const elements = signatureHeader.split(',').reduce<Record<string, string>>((acc, chunk) => {
      const [key, value] = chunk.split('=');
      if (key && value) {
        acc[key] = value;
      }
      return acc;
    }, {});

    const timestamp = elements.t;
    const signature = elements.v1;

    if (!timestamp || !signature) {
      throw new BadRequestException('Invalid Stripe signature header');
    }

    const expectedSignature = createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature);
    const receivedBuffer = Buffer.from(signature);

    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      throw new BadRequestException('Invalid Stripe signature');
    }
  }

  private async findStripeSubscriptionForProfile(
    profile: ProfileRecord,
  ): Promise<StripeSubscription | null> {
    if (profile.stripeSubscriptionId) {
      try {
        return await this.retrieveStripeSubscription(profile.stripeSubscriptionId);
      } catch (error) {
        this.logger.warn(
          `Failed to retrieve Stripe subscription ${profile.stripeSubscriptionId}: ${String(error)}`,
        );
      }
    }

    const searchQueries = [
      `metadata['profileId']:'${profile.id}'`,
      `metadata['userId']:'${profile.userId}'`,
    ];

    for (const query of searchQueries) {
      const response = await this.stripeRequest<{ data?: StripeSubscription[] }>(
        `/v1/subscriptions/search?${this.buildStripeQuery({
          query,
          limit: '5',
          'expand[]': 'data.items.data.price.product',
        })}`,
      );
      const match = response.data?.find((subscription) => this.isPremiumPriceAllowed(subscription));
      if (match) {
        return match;
      }
    }

    return null;
  }

  private async findProfileForStripeMetadata(
    metadata?: Record<string, string | undefined>,
  ): Promise<ProfileRecord | null> {
    const profileId = metadata?.profileId;
    if (profileId) {
      const profile = await this.db.query.profiles.findFirst({
        where: eq(profiles.id, profileId),
      });
      if (profile) {
        return profile;
      }
    }

    const userId = metadata?.userId;
    if (userId) {
      const profile = await this.db.query.profiles.findFirst({
        where: eq(profiles.userId, userId),
      });
      if (profile) {
        return profile;
      }
    }

    return null;
  }

  private async syncProfileFromStripeSubscription(
    profile: ProfileRecord,
    subscription: StripeSubscription | null,
  ): Promise<ProfileRecord> {
    if (!subscription && profile.premiumSource !== 'stripe') {
      return profile;
    }

    const updatePayload = this.buildProfileUpdateFromStripe(profile, subscription);

    await this.db
      .update(profiles)
      .set({
        ...updatePayload,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, profile.id));

    await this.db
      .update(user)
      .set({
        plan: updatePayload.plan,
        premiumExpireAt: updatePayload.premiumExpireAt,
        updatedAt: new Date(),
      })
      .where(eq(user.id, profile.userId));

    const updatedProfile = await this.getProfileById(profile.id);
    return updatedProfile;
  }

  private buildProfileUpdateFromStripe(
    profile: ProfileRecord,
    subscription: StripeSubscription | null,
  ) {
    if (!subscription) {
      return {
        plan: 'basic' as const,
        premiumSource: 'stripe' as PremiumSource,
        premiumCycle: profile.premiumCycle,
        premiumStartedAt: profile.premiumStartedAt,
        premiumExpireAt: profile.premiumExpireAt,
        stripeCustomerId: profile.stripeCustomerId,
        stripeSubscriptionId: profile.stripeSubscriptionId,
        stripePriceId: profile.stripePriceId,
        stripeProductId: profile.stripeProductId,
        stripeProductName: profile.stripeProductName,
        stripePriceLabel: profile.stripePriceLabel,
        stripeSubscriptionStatus: profile.stripeSubscriptionStatus ?? 'canceled',
        stripeCancelAtPeriodEnd: false,
        stripeCanceledAt: profile.stripeCanceledAt ?? new Date(),
        stripeCurrentPeriodStart: profile.stripeCurrentPeriodStart,
        stripeCurrentPeriodEnd: profile.stripeCurrentPeriodEnd,
        stripeLastSyncedAt: new Date(),
      };
    }

    const selectedItem = subscription.items.data.find((item) =>
      this.isPriceAllowed(item.price),
    ) ?? subscription.items.data[0];
    const recurring = selectedItem?.price?.recurring ?? null;
    const cycle = recurring ? this.mapStripeRecurringToCycle(recurring) : null;
    const currentPeriodStart = this.fromStripeTimestamp(
      subscription.current_period_start ?? selectedItem?.current_period_start,
    );
    const currentPeriodEnd = this.fromStripeTimestamp(
      subscription.current_period_end ?? selectedItem?.current_period_end,
    );
    const isPremiumPlan =
      ['active', 'trialing', 'past_due'].includes(subscription.status) &&
      !!currentPeriodEnd &&
      currentPeriodEnd.getTime() > Date.now();

    return {
      plan: isPremiumPlan ? ('premium' as const) : ('basic' as const),
      premiumSource: 'stripe' as PremiumSource,
      premiumCycle: cycle,
      premiumStartedAt: currentPeriodStart,
      premiumExpireAt: currentPeriodEnd,
      stripeCustomerId: subscription.customer ?? null,
      stripeSubscriptionId: subscription.id,
      stripePriceId: selectedItem?.price?.id ?? null,
      stripeProductId:
        typeof selectedItem?.price?.product === 'string'
          ? selectedItem.price.product
          : selectedItem?.price?.product?.id ?? null,
      stripeProductName:
        typeof selectedItem?.price?.product === 'string'
          ? null
          : selectedItem?.price?.product?.name ?? null,
      stripePriceLabel: this.formatStripePriceLabel(selectedItem?.price ?? null),
      stripeSubscriptionStatus: subscription.status,
      stripeCancelAtPeriodEnd: subscription.cancel_at_period_end,
      stripeCanceledAt: this.fromStripeTimestamp(subscription.canceled_at),
      stripeCurrentPeriodStart: currentPeriodStart,
      stripeCurrentPeriodEnd: currentPeriodEnd,
      stripeLastSyncedAt: new Date(),
    };
  }

  private parseRefundRequestStatus(value: string): RefundRequestStatus {
    if (
      value === 'pending' ||
      value === 'reviewing' ||
      value === 'approved' ||
      value === 'rejected'
    ) {
      return value;
    }

    throw new BadRequestException('Invalid refund request status');
  }

  private buildRefundRequestWhereClause(input: {
    status?: string;
    search?: string;
  }) {
    const conditions: any[] = [];

    if (input.status) {
      conditions.push(
        eq(
          premiumRefundRequests.status,
          this.parseRefundRequestStatus(input.status),
        ),
      );
    }

    const normalizedSearch = input.search?.trim();
    if (normalizedSearch) {
      const pattern = `%${normalizedSearch}%`;
      conditions.push(
        or(
          ilike(profiles.username, pattern),
          ilike(profiles.visibleName, pattern),
          ilike(user.email, pattern),
          ilike(premiumRefundRequests.stripeSubscriptionId, pattern),
        )!,
      );
    }

    if (conditions.length === 0) {
      return undefined;
    }

    return and(...conditions);
  }

  private async findOpenRefundRequest(
    profileId: string,
    stripeSubscriptionId: string,
  ) {
    return this.db.query.premiumRefundRequests.findFirst({
      where: and(
        eq(premiumRefundRequests.profileId, profileId),
        eq(premiumRefundRequests.stripeSubscriptionId, stripeSubscriptionId),
        or(
          eq(premiumRefundRequests.status, 'pending'),
          eq(premiumRefundRequests.status, 'reviewing'),
        )!,
      ),
      orderBy: [desc(premiumRefundRequests.createdAt)],
    });
  }

  private async findLatestRefundRequestForSubscription(
    profileId: string,
    stripeSubscriptionId: string,
  ): Promise<RefundRequestRecord | null> {
    const rows = await this.db
      .select({
        id: premiumRefundRequests.id,
        profileId: premiumRefundRequests.profileId,
        userId: premiumRefundRequests.userId,
        stripeSubscriptionId: premiumRefundRequests.stripeSubscriptionId,
        stripeCustomerId: premiumRefundRequests.stripeCustomerId,
        reason: premiumRefundRequests.reason,
        status: premiumRefundRequests.status,
        adminNote: premiumRefundRequests.adminNote,
        resolvedByAdminId: premiumRefundRequests.resolvedByAdminId,
        resolvedAt: premiumRefundRequests.resolvedAt,
        plan: premiumRefundRequests.plan,
        cycle: premiumRefundRequests.cycle,
        paymentMethod: premiumRefundRequests.paymentMethod,
        currentPeriodEnd: premiumRefundRequests.currentPeriodEnd,
        priceLabel: premiumRefundRequests.priceLabel,
        productName: premiumRefundRequests.productName,
        createdAt: premiumRefundRequests.createdAt,
        updatedAt: premiumRefundRequests.updatedAt,
        username: profiles.username,
        visibleName: profiles.visibleName,
        email: user.email,
      })
      .from(premiumRefundRequests)
      .leftJoin(profiles, eq(premiumRefundRequests.profileId, profiles.id))
      .leftJoin(user, eq(premiumRefundRequests.userId, user.id))
      .where(
        and(
          eq(premiumRefundRequests.profileId, profileId),
          eq(premiumRefundRequests.stripeSubscriptionId, stripeSubscriptionId),
        ),
      )
      .orderBy(desc(premiumRefundRequests.createdAt))
      .limit(1);

    return rows[0] ?? null;
  }

  private async findRefundRequestById(id: string): Promise<RefundRequestRecord | null> {
    const rows = await this.db
      .select({
        id: premiumRefundRequests.id,
        profileId: premiumRefundRequests.profileId,
        userId: premiumRefundRequests.userId,
        stripeSubscriptionId: premiumRefundRequests.stripeSubscriptionId,
        stripeCustomerId: premiumRefundRequests.stripeCustomerId,
        reason: premiumRefundRequests.reason,
        status: premiumRefundRequests.status,
        adminNote: premiumRefundRequests.adminNote,
        resolvedByAdminId: premiumRefundRequests.resolvedByAdminId,
        resolvedAt: premiumRefundRequests.resolvedAt,
        plan: premiumRefundRequests.plan,
        cycle: premiumRefundRequests.cycle,
        paymentMethod: premiumRefundRequests.paymentMethod,
        currentPeriodEnd: premiumRefundRequests.currentPeriodEnd,
        priceLabel: premiumRefundRequests.priceLabel,
        productName: premiumRefundRequests.productName,
        createdAt: premiumRefundRequests.createdAt,
        updatedAt: premiumRefundRequests.updatedAt,
        username: profiles.username,
        visibleName: profiles.visibleName,
        email: user.email,
      })
      .from(premiumRefundRequests)
      .leftJoin(profiles, eq(premiumRefundRequests.profileId, profiles.id))
      .leftJoin(user, eq(premiumRefundRequests.userId, user.id))
      .where(eq(premiumRefundRequests.id, id))
      .limit(1);

    return rows[0] ?? null;
  }

  private mapRefundRequestRecord(record: RefundRequestRecord): PremiumRefundRequest {
    return {
      id: record.id,
      profileId: record.profileId,
      userId: record.userId,
      username: record.username ?? null,
      visibleName: record.visibleName ?? null,
      email: record.email ?? null,
      stripeSubscriptionId: record.stripeSubscriptionId,
      stripeCustomerId: record.stripeCustomerId ?? null,
      reason: record.reason,
      status: record.status,
      adminNote: record.adminNote ?? null,
      resolvedByAdminId: record.resolvedByAdminId ?? null,
      resolvedAt: record.resolvedAt ? new Date(record.resolvedAt).toISOString() : null,
      plan: record.plan,
      cycle: record.cycle ?? null,
      paymentMethod: record.paymentMethod ?? null,
      currentPeriodEnd: record.currentPeriodEnd
        ? new Date(record.currentPeriodEnd).toISOString()
        : null,
      priceLabel: record.priceLabel ?? null,
      productName: record.productName ?? null,
      createdAt: record.createdAt
        ? new Date(record.createdAt).toISOString()
        : new Date().toISOString(),
      updatedAt: record.updatedAt
        ? new Date(record.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  }

  private mapStripeRecurringToCycle(recurring: StripeRecurring): PremiumCycle | null {
    if (recurring.interval === 'week' && recurring.interval_count === 1) {
      return '1w';
    }
    if (recurring.interval === 'month' && recurring.interval_count === 1) {
      return '1m';
    }
    if (recurring.interval === 'month' && recurring.interval_count === 3) {
      return '3m';
    }
    if (recurring.interval === 'month' && recurring.interval_count === 6) {
      return '6m';
    }
    return null;
  }

  private isPremiumPriceAllowed(subscription: StripeSubscription) {
    return subscription.items.data.some((item) => this.isPriceAllowed(item.price));
  }

  private isPriceAllowed(price: StripePrice) {
    const allowedPriceIds = this.parseListConfig('STRIPE_PREMIUM_PRICE_IDS');
    const allowedProductIds = this.parseListConfig('STRIPE_PREMIUM_PRODUCT_IDS');

    if (allowedPriceIds.length === 0 && allowedProductIds.length === 0) {
      return true;
    }

    const productId =
      typeof price.product === 'string' ? price.product : price.product?.id ?? null;

    return allowedPriceIds.includes(price.id) || (productId ? allowedProductIds.includes(productId) : false);
  }

  private async retrieveStripeSubscription(subscriptionId: string): Promise<StripeSubscription> {
    return this.stripeRequest<StripeSubscription>(
      `/v1/subscriptions/${subscriptionId}?${this.buildStripeQuery({
        'expand[]': 'items.data.price.product',
      })}`,
    );
  }

  private async waitForStripeSubscriptionPeriods(
    subscriptionId: string,
  ): Promise<StripeSubscription> {
    let lastSubscription = await this.retrieveStripeSubscription(subscriptionId);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (
        typeof lastSubscription.current_period_start === 'number' &&
        typeof lastSubscription.current_period_end === 'number'
      ) {
        return lastSubscription;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
      lastSubscription = await this.retrieveStripeSubscription(subscriptionId);
    }

    return lastSubscription;
  }

  private async updateStripeSubscription(
    subscriptionId: string,
    body: URLSearchParams,
  ): Promise<StripeSubscription> {
    return this.stripeRequest<StripeSubscription>(
      `/v1/subscriptions/${subscriptionId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      },
    );
  }

  private async retrieveStripePrice(priceId: string): Promise<StripePrice> {
    return this.stripeRequest<StripePrice>(
      `/v1/prices/${priceId}?${this.buildStripeQuery({
        'expand[]': 'product',
      })}`,
    );
  }

  private async retrieveStripeCheckoutSession(
    sessionId: string,
  ): Promise<StripeCheckoutSession> {
    return this.stripeRequest<StripeCheckoutSession>(
      `/v1/checkout/sessions/${sessionId}`,
    );
  }

  private async resolveStripeCheckoutPrice(cycle: PremiumCycle): Promise<StripePrice> {
    const directPriceId = this.configService.get<string>(
      `STRIPE_PREMIUM_PRICE_ID_${cycle.toUpperCase()}`,
    );

    if (directPriceId) {
      return this.retrieveStripePrice(directPriceId);
    }

    const allowedPriceIds = this.parseListConfig('STRIPE_PREMIUM_PRICE_IDS');
    if (allowedPriceIds.length === 0) {
      throw new BadRequestException(
        'No Stripe premium prices are configured for checkout',
      );
    }

    const prices = await Promise.all(
      allowedPriceIds.map(async (priceId) => {
        try {
          return await this.retrieveStripePrice(priceId);
        } catch (error) {
          this.logger.warn(
            `Failed to retrieve Stripe price ${priceId} while resolving checkout cycle ${cycle}: ${String(error)}`,
          );
          return null;
        }
      }),
    );

    const matchedPrice = prices.find((price) => {
      if (!price?.recurring) {
        return false;
      }

      return this.mapStripeRecurringToCycle(price.recurring) === cycle;
    });

    if (!matchedPrice) {
      throw new BadRequestException(
        `No Stripe price is configured for premium cycle ${cycle}`,
      );
    }

    return matchedPrice;
  }

  private async createStripeCheckoutForProfile(args: {
    profile: ProfileRecord;
    email: string | null;
    priceId: string;
  }): Promise<StripeCheckoutSession> {
    const frontendUrl = this.getFrontendUrl();
    const body = new URLSearchParams({
      mode: 'subscription',
      success_url: `${frontendUrl}/premium/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/premium?checkout=canceled`,
      client_reference_id: args.profile.id,
      'line_items[0][price]': args.priceId,
      'line_items[0][quantity]': '1',
      'metadata[profileId]': args.profile.id,
      'metadata[userId]': args.profile.userId,
      'subscription_data[metadata][profileId]': args.profile.id,
      'subscription_data[metadata][userId]': args.profile.userId,
      billing_address_collection: 'auto',
      allow_promotion_codes: 'true',
    });

    if (args.profile.stripeCustomerId) {
      body.set('customer', args.profile.stripeCustomerId);
    } else if (args.email) {
      body.set('customer_email', args.email);
    }

    return this.stripeRequest<StripeCheckoutSession>('/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  }

  private buildCheckoutLockKey(profileId: string, cycle: PremiumCycle) {
    return `subscriptions:checkout-lock:${profileId}:${cycle}`;
  }

  private async stripeRequest<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const stripeSecretKey = this.getRequiredConfig('STRIPE_SECRET_KEY');
    const response = await fetch(`https://api.stripe.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        ...(init?.headers || {}),
      },
    });

    const data = await response.json();
    if (!response.ok) {
      const message =
        typeof data?.error?.message === 'string'
          ? data.error.message
          : 'Stripe request failed';
      throw new BadRequestException(message);
    }

    return data as T;
  }

  private buildStripeQuery(values: Record<string, string>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      params.append(key, value);
    }
    return params.toString();
  }

  private parseListConfig(key: string) {
    const rawValue = this.configService.get<string>(key);
    if (!rawValue) {
      return [];
    }

    return rawValue
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private getRequiredConfig(key: string) {
    const value = this.configService.get<string>(key);
    if (!value) {
      throw new BadRequestException(`${key} is not configured`);
    }
    return value;
  }

  private getFrontendUrl() {
    const configuredFrontendUrl =
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService
        .get<string>('CORS_ORIGIN')
        ?.split(',')
        .map((value) => value.trim())
        .find(Boolean);

    return (configuredFrontendUrl || 'http://localhost:3000').replace(/\/+$/, '');
  }

  private fromStripeTimestamp(value: number | null | undefined) {
    return typeof value === 'number' ? new Date(value * 1000) : null;
  }

  private formatStripePriceLabel(price: StripePrice | null) {
    if (!price || price.unit_amount === null) {
      return null;
    }

    const amount = (price.unit_amount / 100).toFixed(2);
    const currency = price.currency.toUpperCase();
    const recurring = price.recurring;

    if (!recurring) {
      return `${amount} ${currency}`;
    }

    const intervalLabel =
      recurring.interval === 'month' && recurring.interval_count > 1
        ? `cada ${recurring.interval_count} meses`
        : recurring.interval === 'month'
          ? 'por mes'
          : recurring.interval === 'week'
            ? 'por semana'
            : `cada ${recurring.interval_count} ${recurring.interval}`;

    return `${amount} ${currency} ${intervalLabel}`;
  }

  private async getProfileById(profileId: string) {
    const profile = await this.db.query.profiles.findFirst({
      where: eq(profiles.id, profileId),
    });

    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    const authUser = await this.db.query.user.findFirst({
      where: eq(user.id, profile.userId),
    });

    if (!authUser) {
      return profile;
    }

    const nextPlan =
      profile.plan === 'premium'
        ? profile.plan
        : authUser.plan === 'premium' && authUser.premiumExpireAt !== null
          ? 'premium'
          : profile.plan;
    const nextPremiumExpireAt =
      profile.premiumExpireAt ??
      (authUser.plan === 'premium' ? authUser.premiumExpireAt : null) ??
      null;

    if (nextPlan !== profile.plan || nextPremiumExpireAt !== profile.premiumExpireAt) {
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

    return profile;
  }
}
