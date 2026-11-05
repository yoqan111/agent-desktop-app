# 导出付费（支付宝 / 微信）设计

> 状态：已批准（方案 2：Mock 优先 + 可切换远程支付 API）  
> 日期：2026-09-24

## 目标

导出到本地前需完成支付。定价规则后续再定；客户端先接入支付宝 / 微信支付渠道选择、下单、展示收款信息、轮询与 Mock 模拟支付。

## 架构

- 渲染进程：导出按钮 → 支付面板 → 成功后携带 `orderId` 调用导出。
- 主进程 `payment` 模块：`createOrder` / `queryOrder` / `simulatePay`；无 `PAYMENT_API_BASE` 时走内存 Mock。
- 商户密钥不进客户端；真实下单由后续后端完成。

## 协议

```
POST {PAYMENT_API_BASE}/pay/orders
Body: { channel, product: 'export', amountFen?, meta? }
→ { orderId, channel, amountFen, currency, qrContent, expiresAt, mock? }

GET {PAYMENT_API_BASE}/pay/orders/:id
→ { orderId, status: pending|paid|expired|closed, paidAt? }

POST {PAYMENT_API_BASE}/pay/orders/:id/simulate  （仅 Mock）
→ { orderId, status: 'paid', paidAt }
```

## 导出门禁

`media:export` 必须带已支付的 `orderId`；主进程校验订单 `paid` 且未核销后，才弹出保存框；导出成功后核销该订单。

## 配置

- `PAYMENT_API_BASE`：有值走远程，否则 Mock
- `PAYMENT_AMOUNT_FEN`：占位金额（分），默认 `1`
