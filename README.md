# medsafe-bot

복약안전 오케스트레이션용 remote MCP 서버 MVP입니다. 원문 핸드오프 프롬프트는 [handoff-prompt.md](./handoff-prompt.md)에 보존했습니다.

## 심사용 요약

`medsafe-bot`은 카카오톡 대화에서 보호자나 사용자가 말한 약 이름을 바로 판정하지 않고, 후보 확인 → token 기반 확정 → fail-closed 안전 점검 → 근거/출처/기준일/디스클레이머 출력까지 강제하는 read-only MCP 서버입니다.

차별점:

- 약 이름을 LLM이 임의 확정하지 않고 `resolve_medications`에서 되묻기 후보를 반환합니다.
- `check_medication_safety`는 `confirmationToken`이 없는 forged `CONFIRMED` 입력을 미확정으로 낮춥니다.
- 병용금기, 중복성분, 맥락 부족, 일부 DUR 미구현을 모두 녹색 금지 조건으로 취급합니다.
- 응급어와 과다복용 의심 표현은 상호작용 조회보다 119 안내를 우선합니다.
- Widget 전환을 위해 `structuredContent`를 신호등/근거/미확정/조회실패 카드로 분리합니다.

제출용 산출물:

- [3분 데모 스크립트](./docs/submission/demo-script.md)
- [generated demo transcript](./docs/submission/demo-transcript.generated.md)
- [Widget mapping](./docs/submission/widget-mapping.md)
- [Widget preview](./docs/submission/widget-preview.html)
- [live data checklist](./docs/submission/live-data-checklist.md)
- [live evidence 2026-07-07](./docs/submission/live-evidence-2026-07-07.md)

## 구현 범위

- TypeScript `@modelcontextprotocol/sdk` 기반 MCP 서버
- Streamable HTTP `/mcp` 엔드포인트
- `resolve_medications`, `check_medication_safety`, `explain_medication` tool
- 실 공공데이터 기반 master DB/alias 매핑과 fixture 테스트 DB 분리
- DUR/e약은요 live API 클라이언트, red-case self-test, `FIELD_MAP`/operation config 격리
- fail-closed 신호등 포맷터, 금칙어/프롬프트 오염 필터, 디스클레이머 서버 주입
- forged `CONFIRMED` 방지용 `confirmationToken`, 입력 제한, body/rate/request guard
- 병용금기/중복성분/fail-closed/안전문구/HTTP guard 테스트

## 빠른 실행

```bash
npm ci
npm run build:master
npm run dev
```

기본값은 `DATA_MODE=fixture`입니다. 공공데이터포털 serviceKey 없이도 데모와 테스트가 동작합니다.

실 API를 쓰려면 `.env` 또는 환경변수로 아래를 설정합니다.

```bash
DATA_MODE=live
MFDS_SERVICE_KEY=공공데이터포털_Decoding_서비스키
LIVE_SELF_TEST_ITEM_SEQ=실제_검증용_품목기준코드
CONFIRMATION_SECRET=운영환경_고정_랜덤문자열
```

`serviceKey`는 decoding 키를 그대로 넣습니다. 코드에서 `encodeURIComponent`를 수동으로 한 번 더 호출하지 않고 `URLSearchParams`에 맡깁니다.
공공데이터 DUR 호출은 HTTPS endpoint만 사용하며, 같은 품목 조회는 TTL cache와 429/5xx retry를 거칩니다.

공개 배포에서는 fixture mode가 기본 차단됩니다. `NODE_ENV=production` 또는 `HOST=0.0.0.0`에서 `DATA_MODE=fixture`로 띄우려면 `ALLOW_FIXTURE_IN_PUBLIC=true`를 명시해야 하며, 이 값은 데모 전용입니다.
운영에서는 `MCP_BODY_LIMIT_BYTES`, `MCP_REQUEST_TIMEOUT_MS`, `RATE_LIMIT_MAX`, `ALLOWED_HOSTS`, `ALLOWED_ORIGINS`를 배포 환경에 맞게 고정하세요.
리버스 프록시 뒤에서 `TRUST_PROXY=true`를 쓸 때는 edge proxy가 들어오는 `X-Forwarded-For`를 정리하도록 구성해야 합니다.

상태 확인:

- `GET /healthz`: 프로세스 생존 확인
- `GET /readyz`: master DB와 DUR self-test 기준 준비 상태 확인

## 검증

```bash
npm run verify
```

## 제출 패키지

```bash
npm run demo:transcript
npm run submission:check
```

- 심사용 스크립트: [docs/submission/demo-script.md](./docs/submission/demo-script.md)
- generated transcript: [docs/submission/demo-transcript.generated.md](./docs/submission/demo-transcript.generated.md)
- Widget mapping: [docs/submission/widget-mapping.md](./docs/submission/widget-mapping.md)
- Widget preview: [docs/submission/widget-preview.html](./docs/submission/widget-preview.html)
- live data checklist: [docs/submission/live-data-checklist.md](./docs/submission/live-data-checklist.md)

실제 제출 직전에는 `data/source/atc_mapping.csv`, `data/source/ingredient_master.csv`, `.secrets/mfds.env`를 준비한 뒤 실 공공데이터로 `data/master.sqlite`를 재생성합니다.

```bash
npm run build:master:live
```

그 다음 live 환경변수를 넣고 아래 명령까지 통과시킵니다.

```bash
npm run submission:check:live
```

`submission:check:live`는 `npm run build:master`를 실행하지 않으므로 현재 `data/master.sqlite`를 fixture DB로 덮어쓰지 않습니다. 이 명령은 `DATA_MODE=live`, `MFDS_SERVICE_KEY`, `LIVE_SELF_TEST_ITEM_SEQ`, `LIVE_SELF_TEST_EXPECT_CONTRAINDICATION=true`, `CONFIRMATION_SECRET`, non-fixture master DB, live DUR red-case self-test를 확인합니다.

## PlayMCP 등록 메모

- 공모전 최종 등록 URL: PlayMCP in KC에서 발급된 Endpoint URL의 `/mcp`
- 현재 OCI 검증 URL: `https://medsafe-140-245-67-103.sslip.io/mcp`
- transport: Streamable HTTP
- 서버는 read-only tool만 노출합니다.
- 배포 예시 환경변수: `HOST=0.0.0.0`, `DATA_MODE=live`, `MFDS_SERVICE_KEY`, `LIVE_SELF_TEST_ITEM_SEQ`, `CONFIRMATION_SECRET`, `DUR_TIMEOUT_MS=2500`, `DUR_SELF_TEST_TIMEOUT_MS=12000`, `DUR_MAX_RETRIES=0`, `ALLOWED_HOSTS=<배포호스트>`, `ALLOWED_ORIGINS=<PlayMCP 호출 Origin>`
- PlayMCP in KC Git 소스 배포 시 루트 `Dockerfile`을 사용합니다. secret은 이미지에 굽지 말고 런타임 환경변수로 주입합니다. Docker 기본값은 endpoint 발급 전 등록을 위해 `ALLOWED_HOSTS=*`를 허용하므로, endpoint가 확정되면 해당 host로 좁히는 것을 권장합니다.
- 카카오 공식 페이지 기준 예선 접수는 2026-07-14(화) 마감이고, 심사는 영업일 기준 최대 7일로 안내되어 있습니다. 따라서 실제 제출 전에는 PlayMCP 개발자 콘솔에서 임시 등록 테스트 후 심사 요청까지 먼저 끝내야 합니다.

현재 live red-case:

- `로바콜정(로바스타틴)(수출용)` itemSeq `199701294`
- `더마졸정(케토코나졸)(수출용)` itemSeq `199101243`
- live DUR 결과: `USJNT_TABOO`, `WARN`, 사유 `횡문근융해증을 비롯한 근육질환 등 중증 이상반응`

## 3분 데모 시나리오

1. 보호자 입력: "엄마가 로바콜하고 더마졸 같이 먹어도 돼?"
2. `resolve_medications`에 `["로바콜", "더마졸"]` 호출. 두 품목은 실 공공데이터 기반 itemSeq로 확정되고 각 후보에는 `confirmationToken`이 붙습니다.
3. 사용자가 후보를 확인하면 `check_medication_safety`에 `itemSeq`, `ingrCode`, `status`, `displayName`, `confirmationToken`을 함께 전달합니다.
4. 결과: 실제 DUR 병용금기 `WARN`, 출처, 기준일, 임의 중단 금지, 표준 디스클레이머가 서버 생성 문구로 표시됩니다.
5. 타이레놀·게보린처럼 성분코드가 공개 데이터에서 충분히 매핑되지 않는 약은 녹색으로 단정하지 않고 `DUP_INGREDIENT` 또는 DUR 조회 보류를 명시해 fail-closed 처리합니다.

`check_medication_safety`는 `resolve_medications`가 발급한 `confirmationToken`이 없는 `CONFIRMED` 입력을 미확정으로 낮춥니다. 호출자 LLM이 `itemSeq`를 임의로 넣어도 서버가 바로 판정하지 않도록 하기 위한 방어입니다.

응답에는 항상 출처, 기준일, 스코프 한계, 표준 디스클레이머가 붙습니다.
