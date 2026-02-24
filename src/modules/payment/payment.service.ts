import { Injectable, Logger, BadRequestException, Inject } from '@nestjs/common';
import { profiles } from '../../database/schema';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DATABASE_CONNECTION } from '../../database/database.module';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly cryptomusMerchantId = process.env.CRYPTOMUS_MERCHANT_ID || '';
  private readonly cryptomusPaymentKey = process.env.CRYPTOMUS_PAYMENT_KEY || '';
  private readonly backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
  private readonly frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  constructor(@Inject(DATABASE_CONNECTION) private readonly db: any) {}

  async createInvoice(profileId: string) {
    if (!this.cryptomusMerchantId || !this.cryptomusPaymentKey) {
      this.logger.error('Cryptomus credentials are not configured.');
      throw new BadRequestException('Pasarela de pago no configurada');
    }

    const orderId = `premium_${profileId}_${Date.now()}`;
    const amount = "2.44";
    const payload = {
      amount: amount,
      currency: "USD",
      order_id: orderId,
      url_return: `${this.frontendUrl}/premium/success`,
      url_success: `${this.frontendUrl}/premium/success`,
      url_callback: `${this.backendUrl}/api/payment/webhook`,
    };

    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const sign = crypto.createHash('md5').update(payloadBase64 + this.cryptomusPaymentKey).digest('hex');

    try {
      const response = await fetch('https://api.cryptomus.com/v1/payment', {
        method: 'POST',
        headers: {
          'merchant': this.cryptomusMerchantId,
          'sign': sign,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      
      if (!response.ok || data.state !== 0) {
        this.logger.error('Cryptomus API Error:', data);
        throw new BadRequestException('Error al crear la orden de pago');
      }

      return {
        url: data.result.url,
        orderId: data.result.order_id
      };
    } catch (error) {
      this.logger.error('Payment implementation error', error);
      throw new BadRequestException('Error conectando con la pasarela de pago');
    }
  }

  async handleWebhook(payload: any, signature: string) {
    if (!this.cryptomusPaymentKey) {
      this.logger.error('Cryptomus Payment Key is not configured for Webhook');
      return;
    }

    // Cryptomus signature verification
    const { sign, ...payloadWithoutSign } = payload;
    const payloadBase64 = Buffer.from(JSON.stringify(payloadWithoutSign)).toString('base64');
    const expectedSign = crypto.createHash('md5').update(payloadBase64 + this.cryptomusPaymentKey).digest('hex');

    if (expectedSign !== signature) {
      this.logger.error('Invalid Cryptomus webhook signature');
      throw new BadRequestException('Firma inválida');
    }

    const status = payload.status;
    const orderId = payload.order_id as string; // Format: premium_{profileId}_{timestamp}

    if (status === 'paid' || status === 'paid_over') {
      const parts = orderId.split('_');
      if (parts.length >= 3 && parts[0] === 'premium') {
        const profileId = parts[1];
        
        const expireDate = new Date();
        expireDate.setDate(expireDate.getDate() + 30); // 30 days of premium

        this.logger.log(`Upgrading user ${profileId} to premium until ${expireDate}`);
        
        await this.db.update(profiles)
          .set({ 
            plan: 'premium',
            premiumExpireAt: expireDate
          })
          .where(eq(profiles.id, profileId));
      }
    } else {
      this.logger.log(`Ignoring webhook status: ${status} for order: ${orderId}`);
    }
  }

  // Cron job to expire premium plans daily
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handlePremiumExpiration() {
    this.logger.log('Checking for expired premium plans...');
    const now = new Date();
    
    // In Drizzle we can query profiles with premium plan and expired date
    // But since Drizzle doesn't have a simple LessThan for dates without raw SQL in some setups,
    // We can do it using sql`` operator if needed, or fetch and check.
    
    // Given the constraints of Drizzle's syntax without importing `lt`, we can simply
    // build the query properly.
    const { sql } = await import('drizzle-orm');
    
    await this.db.update(profiles)
      .set({ 
        plan: 'basic',
        premiumExpireAt: null
      })
      .where(
        sql`plan = 'premium' AND premium_expire_at < ${now.toISOString()}`
      );
      
    this.logger.log('Premium plan expiration check completed.');
  }
}
