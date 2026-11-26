# WuKongIM Local Infrastructure (Pinned for Connected Clinic)

- **Image**: `registry.cn-shanghai.aliyuncs.com/wukongim/wukongim:v2@sha256:aaa2b3c0f7501083b44ee7414517dbcf7ff906aa049a1ed5c4e764ae4f05b65f`
- **Version**: `v2.2.5-20260422` (Apache-2.0)
- **Client SDK**: `easyjssdk@2.0.5` (ISC)

## Local Startup

```bash
docker compose -f infrastructure/wukongim/docker-compose.yml up -d
curl --noproxy '*' http://127.0.0.1:15001/health
```

## Full Reset (Demo / Test Namespace Wipe)

```bash
docker compose -f infrastructure/wukongim/docker-compose.yml down -v
docker compose -f infrastructure/wukongim/docker-compose.yml up -d
```

## Security & Deployment Notes

1. `5001` (HTTP Management API) is bound strictly to `127.0.0.1` and protected by `WK_MANAGERTOKEN`. Never expose `5001` to browser or miniapp clients.
2. `5200` (WebSocket) must sit behind a TLS reverse proxy (`wss://...`) on a domain configured in WeChat MiniProgram `socket合法域名` for real-device testing.
3. Because WuKongIM v2.2.5 `POST /message/send` does **not** deduplicate repeated `client_msg_no` values, all idempotency and uncertain-delivery reconciliation are owned by `ClinicWorkspaceDO`'s durable `send_command` table plus `POST /channel/messagesync` lookup (see `docs/adr/0004-connected-clinic-s0-poc-and-stack.md`).
