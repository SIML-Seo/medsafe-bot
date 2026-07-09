# Live Data Checklist

## 제출 전 반드시 바꿀 것

- `DATA_MODE=live`
- `MFDS_SERVICE_KEY`
- `LIVE_SELF_TEST_ITEM_SEQ`
- `LIVE_SELF_TEST_EXPECT_CONTRAINDICATION=true`
- `CONFIRMATION_SECRET`
- `ALLOWED_HOSTS`
- `ALLOWED_ORIGINS`
- 실 공공데이터 기반 master DB. `metadata.source`가 `DEMO_FIXTURE`이면 제출용이 아니다.
- 로컬 제출 직전 `data/source/atc_mapping.csv`, `data/source/ingredient_master.csv`, `.secrets/mfds.env`를 준비하고 `npm run build:master:live`로 `data/master.sqlite`를 재생성한다.
- live 데모 기본 timeout 예산: tool 호출 `MCP_REQUEST_TIMEOUT_MS=30000`, `DUR_TIMEOUT_MS=2500`, `DUR_MAX_RETRIES=0`; 부팅 red-case self-test `DUR_SELF_TEST_TIMEOUT_MS=12000`
- 리버스 프록시 뒤에서만 `TRUST_PROXY=true`. edge proxy가 들어오는 `X-Forwarded-For`를 정리한 뒤 사용한다.

## 성공 기준

- `npm run verify` 통과
- `npm run demo:transcript`로 transcript 생성
- `npm run submission:check:live` 통과. 이 명령은 현재 `data/master.sqlite`를 검사하며 fixture DB로 재생성하지 않는다.
- `npm run submission:check:live`에서 live DUR self-test 성공. 이때 `LIVE_SELF_TEST_ITEM_SEQ`는 실제 병용금기 finding이 반환되는 red-case 품목이어야 한다.
- 배포 URL의 `GET /healthz` 200
- 배포 URL의 `GET /readyz` 200
- PlayMCP 등록 화면에서 `tools/list` 성공
- `resolve_medications -> check_medication_safety -> explain_medication` 순서로 성공
- 과다복용/한꺼번에 N알 복용 입력이 응급 우선 `WARN`으로 표시된다.

## fixture 사용 시 명시해야 할 문장

> 현재 저장소의 fixture red case는 개발/테스트용입니다. 실제 제출 전에는 공공데이터포털 원문 데이터와 live DUR self-test로 교체합니다.

이 문장이 필요한 상태라면 수상권 제출물로는 약하다. 최소 1개 빨간색 케이스는 live 데이터 증거가 있어야 한다. `submission:check:live`는 fixture DB를 error로 처리한다.
