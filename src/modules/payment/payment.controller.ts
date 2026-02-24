import { Controller, Post, Body, Req, UnauthorizedException, Headers, BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { FastifyRequest } from 'fastify';

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('checkout')
  async createCheckout(@Req() req: FastifyRequest) {
    const userId = (req as any).user?.id || (req as any).profile?.id;
    // Adapt to their auth context, we will need to ensure we have profile id.
    if (!userId) {
      throw new UnauthorizedException('Debe iniciar sesión para realizar un pago.');
    }
    const result = await this.paymentService.createInvoice(userId);
    return result;
  }

  @Post('webhook')
  async handleWebhook(
    @Body() payload: any,
    @Headers('sign') signature: string
  ) {
    if (!signature) {
      throw new BadRequestException('Missing signature');
    }
    await this.paymentService.handleWebhook(payload, signature);
    return { success: true };
  }
}
