export type PayChannel = 'alipay' | 'wechat';

export type PayOrderStatus = 'pending' | 'paid' | 'expired' | 'closed';

export type PayProduct = 'export';

/** Set true to require a paid order before saving an export. */
export const EXPORT_REQUIRES_PAYMENT = false;

export interface CreatePayOrderRequest {
  channel: PayChannel;
  product: PayProduct;
  /** Override placeholder amount in fen; omit to use server/default. */
  amountFen?: number;
  meta?: {
    tempPath?: string;
    suggestedName?: string;
    format?: string;
  };
}

export interface PayOrder {
  orderId: string;
  channel: PayChannel;
  product: PayProduct;
  amountFen: number;
  currency: 'CNY';
  status: PayOrderStatus;
  qrContent: string;
  expiresAt: string;
  paidAt?: string;
  /** True when created by local mock (no PAYMENT_API_BASE). */
  mock: boolean;
}

export interface PayQuote {
  product: PayProduct;
  amountFen: number;
  currency: 'CNY';
  label: string;
  mock: boolean;
}

export interface PaymentApi {
  getQuote(product: PayProduct): Promise<PayQuote>;
  createOrder(request: CreatePayOrderRequest): Promise<PayOrder>;
  queryOrder(orderId: string): Promise<PayOrder>;
  /** Only available in mock mode. */
  simulatePay(orderId: string): Promise<PayOrder>;
}

export const PaymentIpc = {
  quote: 'pay:quote',
  create: 'pay:create',
  query: 'pay:query',
  simulate: 'pay:simulate',
} as const;

export function formatAmountYuan(amountFen: number): string {
  return `¥${(amountFen / 100).toFixed(2)}`;
}
