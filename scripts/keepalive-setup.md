# 保活配置

Render 免费额度在 15 分钟无 HTTP 请求时会冻结实例，导致内部 timer 停止。

## 推荐方案：cron-job.org（免费）

1. 注册 https://cron-job.org（免费）
2. 新建任务：
   - URL: https://<你的服务名>.onrender.com/health
   - 频率：每 10 分钟
   - 超时：至少 60 秒
3. 保存即可

## 备选方案：UptimeRobot

1. 注册 https://uptimerobot.com（免费计划支持 5 分钟间隔）
2. 添加 HTTP(S) 监控
   - URL: https://<你的服务名>.onrender.com/health
   - 间隔：5 分钟
3. 同时可配置告警，实例异常时通知

## 注意事项

- 第一次请求（冷启动）约需 30-60 秒，外部 pinger 超时应设 ≥ 60 秒
- Render 免费额度每月 750 小时，单服务 24×7 = 720 小时，刚好够用
- cron-job.org 的 ping 不计入 Render 的请求配额
