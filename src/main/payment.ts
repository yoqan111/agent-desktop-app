import { randomUUID } from 'node:crypto';
import type {
  CreatePayOrderRequest,
  PayOrder,
  PayOrderStatus,
  PayProduct,
  PayQuote,
} from '../shared/payment';

interface StoredOrder extends PayOrder {
  consumed: boolean;
}

const orders = new Map<string, StoredOrder>();

function paymentApiBase(): string {
  return (process.env.PAYMENT_API_BASE || '').trim().replace(/\/$/, '');
}

function isMockMode(): boolean {
  return !paymentApiBase();
}

function defaultAmountFen(): number {
  const raw = Number(process.env.PAYMENT_AMOUNT_FEN);
  if (Number.isFinite(raw) && raw >= 0) {
    return Math.round(raw);
  }
  return 1;
}

function toPublic(order: StoredOrder): PayOrder {
  const { consumed: _consumed, ...rest } = order;
  return rest;
}

async function remoteJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = paymentApiBase();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `支付接口失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export function getPayQuote(product: PayProduct): PayQuote {
  const amountFen = defaultAmountFen();
  return {
    product,
    amountFen,
    currency: 'CNY',
    label: product === 'export' ? '导出到本地' : product,
    mock: isMockMode(),
  };
}

export async function createPayOrder(request: CreatePayOrderRequest): Promise<PayOrder> {
  if (request.product !== 'export') {
    throw new Error('暂不支持该商品。');
  }
  if (request.channel !== 'alipay' && request.channel !== 'wechat') {
    throw new Error('请选择支付宝或微信支付。');
  }

  if (!isMockMode()) {
    const remote = await remoteJson<PayOrder>('/pay/orders', {
      method: 'POST',
      body: JSON.stringify({
        channel: request.channel,
        product: request.product,
        amountFen: request.amountFen ?? defaultAmountFen(),
        meta: request.meta,
      }),
    });
    const stored: StoredOrder = {
      ...remote,
      mock: false,
      consumed: false,
    };
    orders.set(stored.orderId, stored);
    return toPublic(stored);
  }

  const amountFen = request.amountFen ?? defaultAmountFen();
  const orderId = `mock_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  const order: StoredOrder = {
    orderId,
    channel: request.channel,
    product: request.product,
    amountFen,
    currency: 'CNY',
    status: 'pending',
    qrContent: `mock://${request.channel}/pay/${orderId}`,
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
    mock: true,
    consumed: false,
  };
  orders.set(orderId, order);
  return toPublic(order);
}

export async function queryPayOrder(orderId: string): Promise<PayOrder> {
  if (!orderId) {
    throw new Error('订单号无效。');
  }

  if (!isMockMode()) {
    const remote = await remoteJson<PayOrder>(`/pay/orders/${encodeURIComponent(orderId)}`);
    const existing = orders.get(orderId);
    const stored: StoredOrder = {
      ...remote,
      mock: false,
      consumed: existing?.consumed ?? false,
    };
    orders.set(orderId, stored);
    return toPublic(stored);
  }

  const order = orders.get(orderId);
  if (!order) {
    throw new Error('订单不存在。');
  }
  if (order.status === 'pending' && Date.parse(order.expiresAt) <= Date.now()) {
    order.status = 'expired';
  }
  return toPublic(order);
}

export async function simulatePayOrder(orderId: string): Promise<PayOrder> {
  if (!isMockMode()) {
    throw new Error('当前为远程支付模式，不支持模拟支付。');
  }
  const order = orders.get(orderId);
  if (!order) {
    throw new Error('订单不存在。');
  }
  if (order.status === 'expired' || order.status === 'closed') {
    throw new Error('订单已失效。');
  }
  if (order.status !== 'paid') {
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
  }
  return toPublic(order);
}

export async function assertOrderPaidForExport(orderId: string): Promise<PayOrder> {
  const order = await queryPayOrder(orderId);
  const stored = orders.get(orderId);
  if (!stored) {
    throw new Error('支付订单无效，请重新支付。');
  }
  if (stored.status !== 'paid') {
    throw new Error('请先完成支付后再导出。');
  }
  if (stored.consumed) {
    throw new Error('该支付单已用于导出，请重新支付。');
  }
  return toPublic(stored);
}

export function consumePaidOrder(orderId: string): void {
  const order = orders.get(orderId);
  if (order && order.status === 'paid') {
    order.consumed = true;
  }
}

export function normalizePayStatus(status: string): PayOrderStatus {
  if (status === 'paid' || status === 'pending' || status === 'expired' || status === 'closed') {
    return status;
  }
  return 'pending';
}
