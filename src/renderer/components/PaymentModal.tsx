import { useEffect, useRef, useState } from 'react';
import type { CreatePayOrderRequest, PayChannel, PayOrder, PayQuote } from '../../shared/payment';
import { formatAmountYuan } from '../../shared/payment';

interface PaymentModalProps {
  open: boolean;
  meta: CreatePayOrderRequest['meta'];
  onClose: () => void;
  onPaid: (order: PayOrder) => void;
}

const CHANNELS: Array<{ id: PayChannel; name: string; hint: string }> = [
  { id: 'alipay', name: '支付宝', hint: '扫码支付' },
  { id: 'wechat', name: '微信支付', hint: '扫码支付' },
];

export function PaymentModal({ open, meta, onClose, onPaid }: PaymentModalProps) {
  const [quote, setQuote] = useState<PayQuote | null>(null);
  const [channel, setChannel] = useState<PayChannel>('alipay');
  const [order, setOrder] = useState<PayOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const paidRef = useRef(false);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    paidRef.current = false;
    setOrder(null);
    setError('');
    setBusy(false);
    let cancelled = false;
    void (async () => {
      try {
        const next = await window.payment.getQuote('export');
        if (!cancelled) {
          setQuote(next);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '获取报价失败');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !order || order.status === 'paid') {
      return undefined;
    }
    let stopped = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const latest = await window.payment.queryOrder(order.orderId);
          if (stopped) {
            return;
          }
          setOrder(latest);
          if (latest.status === 'paid' && !paidRef.current) {
            paidRef.current = true;
            onPaid(latest);
          }
          if (latest.status === 'expired' || latest.status === 'closed') {
            setError('订单已失效，请重新下单。');
          }
        } catch {
          // ignore transient poll errors
        }
      })();
    }, 1500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open, order, onPaid]);

  if (!open) {
    return null;
  }

  async function createOrder(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const created = await window.payment.createOrder({
        channel,
        product: 'export',
        amountFen: quote?.amountFen,
        meta,
      });
      setOrder(created);
      if (created.status === 'paid' && !paidRef.current) {
        paidRef.current = true;
        onPaid(created);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建订单失败');
    } finally {
      setBusy(false);
    }
  }

  async function simulate(): Promise<void> {
    if (!order) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const paid = await window.payment.simulatePay(order.orderId);
      setOrder(paid);
      if (paid.status === 'paid' && !paidRef.current) {
        paidRef.current = true;
        onPaid(paid);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '模拟支付失败');
    } finally {
      setBusy(false);
    }
  }

  async function copyQr(): Promise<void> {
    if (!order?.qrContent) {
      return;
    }
    try {
      await navigator.clipboard.writeText(order.qrContent);
    } catch {
      setError('复制失败，请手动选择下方内容。');
    }
  }

  const amountLabel = formatAmountYuan(order?.amountFen ?? quote?.amountFen ?? 1);

  return (
    <div className="pay-overlay" role="dialog" aria-modal="true" aria-label="导出付费">
      <div className="pay-modal">
        <header className="pay-header">
          <div>
            <h2>导出需付费</h2>
            <p>定价规则后续更新；当前为占位金额。</p>
          </div>
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="pay-amount">
          <span>应付</span>
          <strong>{amountLabel}</strong>
          {(order?.mock ?? quote?.mock) ? <em className="pay-mock-tag">Mock</em> : null}
        </div>

        {!order ? (
          <>
            <div className="pay-channels">
              {CHANNELS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={channel === item.id ? 'pay-channel active' : 'pay-channel'}
                  disabled={busy}
                  onClick={() => setChannel(item.id)}
                >
                  <strong>{item.name}</strong>
                  <span>{item.hint}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn-primary pay-cta" disabled={busy} onClick={() => { void createOrder(); }}>
              去支付
            </button>
          </>
        ) : (
          <div className="pay-order">
            <div className={`pay-qr ${order.channel}`}>
              <div className="pay-qr-grid" aria-hidden />
              <p>{order.channel === 'alipay' ? '支付宝' : '微信'}收款码（占位）</p>
            </div>
            <p className="hint pay-order-id">订单号 {order.orderId}</p>
            <code className="pay-qr-text">{order.qrContent}</code>
            <div className="pay-order-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => { void copyQr(); }}>
                复制支付串
              </button>
              {order.mock ? (
                <button type="button" className="btn-primary" disabled={busy || order.status === 'paid'} onClick={() => { void simulate(); }}>
                  模拟支付成功
                </button>
              ) : (
                <p className="hint">请使用{order.channel === 'alipay' ? '支付宝' : '微信'}扫码，支付完成后将自动继续。</p>
              )}
            </div>
            <p className="pay-status">
              状态：{order.status === 'pending' ? '待支付' : order.status === 'paid' ? '已支付' : order.status}
            </p>
          </div>
        )}

        {error ? <p className="banner">{error}</p> : null}
      </div>
    </div>
  );
}
