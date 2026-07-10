# medsafe-bot

카카오톡 대화에서 약 이름 확인, 병용금기·중복성분 점검, 복약 설명을 연결하는 read-only Streamable HTTP MCP 서버입니다. 최초 요구사항은 [handoff-prompt.md](./handoff-prompt.md)에 원문 그대로 보존되어 있습니다.

## 심사용 요약

`medsafe-bot`은 사용자가 말한 약을 곧바로 안전하다고 판정하지 않습니다.

1. `resolve_medications`가 25,000개 이상의 실제 품목 master에서 이름·용량·제형을 확인합니다.
2. 모호한 브랜드·성분명은 2~5개 후보로 되묻고 token을 발급하지 않습니다.
3. 정확히 확인된 품목만 10분 만료 HMAC `confirmationToken`을 받습니다.
4. `check_medication_safety`가 완전 수집한 DUR 성분 병용금기 카탈로그, 선별 품목 스냅샷, 전체 복합성분 행으로 병용금기·중복성분을 점검합니다.
5. 성분 파싱·조건 해석·카탈로그 완전성·품목 스냅샷 중 필요한 근거가 불완전하면 `UNCERTAIN`으로 닫고 녹색을 금지합니다.
6. 호흡곤란·의식소실·과량복용 표현은 약물 조회보다 119/응급실 안내를 우선합니다.

`confirmationToken`은 서버가 확인한 canonical `itemSeq`·성분·status가 이후 호출에서 바뀌지 않았음을 보장합니다. 사용자가 실제로 후보를 선택했다는 사실 자체는 대화 Agent/UI가 확인해야 하며, 서버는 이를 과장해 주장하지 않습니다.

## 공개 Endpoint

- MCP: `https://medsafe-bot.playmcp-endpoint.kakaocloud.io/mcp`
- Health: `https://medsafe-bot.playmcp-endpoint.kakaocloud.io/healthz`
- Readiness: `https://medsafe-bot.playmcp-endpoint.kakaocloud.io/readyz`
- Transport: Streamable HTTP, stateless
- Tools: `resolve_medications`, `check_medication_safety`, `explain_medication`
- 세 도구 모두 `readOnlyHint=true`, `destructiveHint=false`, `openWorldHint=false`, `idempotentHint=true`

현재 로컬 변경은 KC에 다시 배포한 뒤 `npm run verify:remote`가 통과해야 공개 endpoint 최신 상태로 인정합니다.

## 데이터 구조

live DB는 `data/master.sqlite` 하나에 다음 검증된 스냅샷을 보관합니다.

- MFDS DUR 품목 API의 실제 9자리 `ITEM_SEQ` 제품과 e약은요 보충 품목을 합친 검색 master
- MFDS `MATERIAL_NAME`의 현재 `성분명,,용량` 및 순번 포함 형식과 이전 `성분명,,,` 형식을 함께 검증해 분리한 복합성분
- 선행 0을 정규화한 HIRA EDI 코드 조인으로 얻은 ATC·주성분 코드 보조 매핑
- 공개 데이터에 존재하는 품목의 e약은요 설명 스냅샷
- DUR 성분정보 전체 병용금기 카탈로그, 제품별 identity의 D-code·매핑 근거, 대표 브랜드·심사 증거 품목의 품목 단위 스냅샷
- 실제 국내 red-case: 아스피린프로텍트정 `200108429` × 유한메토트렉세이트정 `197900145`

공공 API는 데이터 갱신 빌드에서만 호출합니다. 배포된 MCP의 `resolve`, `check`, `explain`은 SQLite만 읽으므로 공공 API 지연·장애가 사용자 요청의 p99에 영향을 주지 않습니다. data model v3는 전체 DUR 성분 병용금기 규칙과 단일/복합·복합제·관계성분 조건을 로컬에 저장합니다. 제품 성분이 완전하게 식별되면 규칙 목록 전체를 조회하며, 특정 성분이 규칙에 등장하지 않는 것은 “등록된 금기 쌍 없음”이지 데이터 누락이 아닙니다. 공식 관계, 제한된 형식 정규화, 카탈로그 부재, 위험 fallback의 provenance를 구분하고, 위험 fallback·모호한 형식·조건 불일치는 `UNCERTAIN`으로 처리합니다.

## 로컬 실행

개발·테스트는 별도 fixture DB를 사용합니다.

```bash
npm ci
npm test
npm run dev
```

`npm test`는 `data/master.test.sqlite`만 재생성하며 제출용 `data/master.sqlite`를 변경하지 않습니다.

실데이터를 갱신하려면 아래 파일과 decoding 서비스키가 필요합니다.

- `data/source/atc_mapping.csv`
- `data/source/ingredient_master.csv`
- `.secrets/mfds.env`
- 공공데이터포털 활용신청: DUR 품목정보 `15059486`, DUR 성분정보 `15056780`, e약은요 `15075057`

세 API에서 같은 일반인증키 문자열을 사용하더라도 데이터셋별 활용신청은 각각 필요합니다. 성분정보 API 권한이 없으면 전체 성분 병용금기 카탈로그를 만들 수 없으므로 live 빌드는 기존 산출물을 보존한 채 실패합니다.

```bash
npm run build:master:live
```

생성기는 CP949/UTF-8 원문을 무손실 round-trip으로 검증하고, API `totalCount`, 페이지·행 중복, 페이지 누락, 요청 `itemSeq`와 다른 DUR 행, 불가능한 고시일자, 부분 복합성분 파싱, 단위처럼 잘못 파싱된 성분, 복합제 코드 복제, 완전 파싱된 품목 DUR target 성분과 제품 master 불일치를 모두 제출 차단 오류로 처리합니다. 원료 원문이 없는 target은 exact itemSeq 스냅샷 매칭만 사용하고 별도 개수로 공개합니다.

## 운영 환경변수

```bash
NODE_ENV=production
HOST=0.0.0.0
DATA_MODE=live
MASTER_DB_PATH=data/master.sqlite
LIVE_SELF_TEST_ITEM_SEQ=200108429
LIVE_SELF_TEST_TARGET_ITEM_SEQ=197900145
LIVE_SELF_TEST_EXPECT_CONTRAINDICATION=true
CONFIRMATION_SECRET=32자_이상의_고정_랜덤값
ALLOWED_HOSTS=medsafe-bot.playmcp-endpoint.kakaocloud.io,localhost,127.0.0.1
ALLOWED_ORIGINS=https://playmcp.kakao.com,https://playmcp.kakaocloud.io
RATE_LIMIT_MAX=600
RATE_LIMIT_INGRESS_MAX=6000
RATE_LIMIT_MAX_KEYS=10000
MCP_MAX_BATCH_ITEMS=8
MCP_POST_MAX_INFLIGHT=100
MCP_POST_MAX_PER_CLIENT=10
MCP_POST_MAX_PER_INGRESS=50
HTTP_MAX_CONNECTIONS=500
HTTP_HEADERS_TIMEOUT_MS=10000
HTTP_MAX_REQUESTS_PER_SOCKET=1000
TRUST_PROXY=false
TRUST_PROXY_HOPS=0
TRUST_PROXY_CIDRS=
```

`MFDS_SERVICE_KEY`는 DB 갱신 작업에만 필요하며 runtime image에 넣지 않아도 됩니다. 공개 production에서는 live DB, 32자 이상 `CONFIRMATION_SECRET`, source+target RED self-test, 비로컬 host/origin allowlist가 없으면 서버가 기동을 거부합니다.

기본값은 `TRUST_PROXY=false`입니다. 리버스 프록시가 들어오는 `X-Forwarded-For`를 덮어쓰거나 정리하고 실제 peer CIDR을 확인한 경우에만 `true`로 바꿉니다. edge 1홉이면 `TRUST_PROXY_HOPS=1`, 신뢰 프록시가 2홉이면 `2`로 설정하고 `TRUST_PROXY_CIDRS`에는 확인된 edge·내부 프록시 대역만 넣습니다. 그 밖의 직접 연결은 XFF를 무시합니다.

PlayMCP가 호출하는 공개 read-only endpoint이므로 사용자 인증은 요구하지 않습니다. 브라우저가 아닌 MCP 클라이언트의 Origin 없는 요청은 허용하되 Host는 allowlist로 검증합니다. 공개 데이터 조회 외 상태 변경 기능은 없으며 body·batch·시간·연결·POST·요청률 상한을 각각 적용합니다. stateless 서버는 독립적인 server-to-client 알림을 제공하지 않으므로 `/mcp` GET·DELETE에는 규격상 허용된 `405`를 반환하고 POST만 처리합니다.

## 상태 확인

- `/healthz`: 프로세스 생존 여부
- `/readyz`: 기동 시 compiled JS·package manifest/lockfile·Dockerfile build ID와 DB SHA-256, generation ID, source/model/count, 커버리지, red-case DUR 스냅샷, 독립 안전 프로브를 검증·고정하고 요청마다 수집 시각의 최대 age만 재평가

live readiness는 `PUBLIC_DATA_LIVE`, data model v3, 최소 제품·성분·e약은요·DUR 성분규칙 건수, 30일 이내 수집 시각, 완전한 성분 카탈로그, 제품 성분 식별 커버리지 80% 이상, 활성 제품 원료에서 공식 `ORI` 관계와 제한된 염·수화물 정규화로 도달 가능한 DUR identity 매핑 100%, `ORI`·`MIX` 필드 미파싱 0건, 선별 품목 스냅샷 100%를 모두 요구합니다. 전체 카탈로그 identity 중 현재 활성 제품 master에 나타나지 않는 identity 수와 비율은 삭제하지 않고 별도 공개합니다.

## 검증 명령

```bash
npm run verify
```

fixture 빌드·TypeScript·전체 회귀 테스트·제출 파일 검사를 실행합니다. GitHub CI는 Linux와 Windows에서 fresh `npm ci`·테스트를 실행하고 Linux에서 의존성 감사와 Docker build도 확인합니다.

```bash
NODE_ENV=production \
DATA_MODE=live \
MASTER_DB_PATH=data/master.sqlite \
LIVE_SELF_TEST_ITEM_SEQ=200108429 \
LIVE_SELF_TEST_TARGET_ITEM_SEQ=197900145 \
LIVE_SELF_TEST_EXPECT_CONTRAINDICATION=true \
CONFIRMATION_SECRET=32자_이상의_검증용_값 \
ALLOWED_HOSTS=medsafe-bot.playmcp-endpoint.kakaocloud.io \
ALLOWED_ORIGINS=https://playmcp.kakao.com \
npm run submission:check:live
```

현재 live DB를 덮어쓰지 않고 source, model, 데이터 건수, 원문 프롬프트 SHA-256, 로컬 red-case를 검사합니다.

```bash
npm run verify:remote
```

KC endpoint에 공식 MCP SDK로 연결해 `/healthz`, `/readyz`, tools/list, 타이레놀+게보린, 벤조산나트륨카페인+카페인, 초산 L-리신+L-리신 중복성분, 아스피린프로텍트+유한메토트렉세이트 RED, 타이레놀 설명, 두 품목 모두 품목 스냅샷이 없는 성분 카탈로그 전용 RED, 제한된 염·수화물 형식 매핑 기반 판토프라졸+릴피비린 RED, 팍스로비드 복합제·카보잔티닙 염·MIX D-code 및 검증된 한글 표기 변형 회귀 RED, 브랜드명 과량복용·자해 의도 응급, 음식·일상 복약·구매·보관·부정 표현 비응급 대조군, 모호한 과량복용 표현의 투명한 보류, 성분 자체가 없는 품목의 `UNCERTAIN`을 검사합니다. `/readyz`는 메타데이터·품목 스냅샷과 독립된 고정 안전 프로브 216개도 통과해야 합니다. 성능은 대표 4개 흐름 합계 100회와 도구별 분포에서 평균 100ms·p99 3초, 동시 burst p99 3초, cold 연결 p99 3초를 별도로 검증하며 성공 시 token을 제외한 증거 JSON을 생성합니다.

최종 KC 배포 뒤에는 PlayMCP 가이드가 요구하는 공식 Inspector CLI도 제출 endpoint에 직접 실행합니다. 릴리스 워크플로는 Node 22에서 lockfile에 고정된 Inspector `0.22.0`을 실행하고 결과 JSON을 artifact로 보존합니다.

```bash
npm ci
npx --no-install @modelcontextprotocol/inspector --cli \
  https://medsafe-bot.playmcp-endpoint.kakaocloud.io/mcp \
  --transport http --method tools/list > /tmp/inspector-tools.raw.json
npm run verify:inspector-output -- \
  /tmp/inspector-tools.raw.json \
  docs/submission/inspector-tools.generated.json \
  --endpoint https://medsafe-bot.playmcp-endpoint.kakaocloud.io/mcp
```

```bash
npm run submission:check:release
```

생성된 원격 증거가 24시간 이내이며 현재 build ID·DB SHA-256과 일치하는지 다시 확인합니다.
KC 재배포 후에는 GitHub Actions의 `Remote Release Verification`을 수동 실행해 같은 두 명령을 fresh checkout에서도 통과시킵니다.

## 데모 흐름

1. “아스피린”에서 여러 후보와 token 미발급을 보여줍니다.
2. 정확한 아스피린프로텍트정·유한메토트렉세이트정을 resolve하고 반환 필드를 그대로 check에 전달합니다.
3. `WARN`, `USJNT_TABOO`, “혈액학적 독성” 근거를 표시합니다.
4. “타이레놀정 500mg하고 게보린정은?”에서 아세트아미노펜 중복을 표시합니다.
5. 타이레놀 `202106092`의 e약은요 설명을 조회합니다.
6. 과량복용·호흡곤란 입력에서는 즉시 119/응급실 안내를 우선합니다.

응답은 임의 복용·중단·용량 변경을 지시하지 않습니다. 세 도구 모두 `dataAsOf`를 반환하고, 안전 finding은 `dateBasis`로 원천 기준일·스냅샷 수집일·정책일을 구분합니다.

## 제출 자료

- [3분 데모 스크립트](./docs/submission/demo-script.md)
- [generated demo transcript](./docs/submission/demo-transcript.generated.md)
- [Widget mapping](./docs/submission/widget-mapping.md)
- [Widget preview](./docs/submission/widget-preview.html)
- [live data checklist](./docs/submission/live-data-checklist.md)
- [live evidence](./docs/submission/live-evidence-2026-07-10.md)
- `docs/submission/remote-verification.generated.json` (원격 검증 성공 시 생성)
