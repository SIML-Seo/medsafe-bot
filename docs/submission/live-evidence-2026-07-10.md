# Live Evidence Status - Updated 2026-07-12

## Endpoint

- MCP: `https://medsafe-bot.playmcp-endpoint.kakaocloud.io/mcp`
- Transport: Streamable HTTP, stateless
- PlayMCP status: Active
- Expected tools: 3 read-only tools

## Current Status

2026-07-12 KC endpoint를 data model v3 release로 재배포하고 공식 MCP SDK, MCP Inspector, strict release gate로 다시 검증했다. endpoint의 build ID와 DB SHA는 현재 release artifact와 일치한다.

- deployed build ID: `sha256:f9a561abcf9c6500dcc765d97f6f930899b776889181243988eaad7a30586bb2`
- verification ID: `sha256:b432ca5c46dd25d44a279796560dc65982db14c43a4c473c2b3a31d5c7c152a5`
- deployed release DB SHA-256: `7807ac4207befc54730c3e600e9cb08e575942bbd9cbc47ea34e9355ebe0a782`
- deployed release DB: `PUBLIC_DATA_LIVE`, data model v3
- DUR 성분정보 dataset `15056780`: 활용신청 및 전체 수집 완료
- KC endpoint: `/healthz` 200, `/readyz` 200, build ID·DB SHA 일치, 독립 안전 프로브 `216/216`

서버와 `submission:check:live`는 아래 조건 중 하나라도 충족하지 않으면 실패한다.

- `dataModelVersion=3`
- `durIngredientCatalogComplete=true`
- DUR 성분 규칙 100건 이상
- 완전 파싱된 제품 성분 identity 커버리지 80% 이상
- 활성 제품 원료의 공식 `ORI` 관계, 제한된 염·수화물 형식 정규화 또는 수동 검증된 표기 동의어로 도달 가능한 DUR identity 매핑 100%
- DUR `ORI` 관계 필드와 `MIX` 복합제 필드 미파싱 0건
- 선별 품목 스냅샷 100%
- 완전 파싱된 품목 DUR target 성분과 제품 master 불일치 0건
- source+target RED self-test 성공
- 메타데이터와 품목 스냅샷에 의존하지 않는 고정 안전 프로브 216개(RED 7·중복 5·응급 양성 127·비응급 음성 47·잠재 과량복용 보류 18·표기 매핑 7·위험 표기 보류 5) 성공

## Local Verification Completed

- Linux Node 22.21.0에서 fixture·HTTP·MCP·의료 안전·release DB 회귀 테스트 `125/125` 통과
- Streamable HTTP protocol `2025-03-26`, `2025-06-18`, `2025-11-25` 협상과 후속 요청 검증
- 공식 MCP Inspector CLI의 로컬 `tools/list` 성공
- read-only tools 3개와 annotations 5개 확인
- HMAC token 변조·만료·status 교차사용 차단
- stateless GET·DELETE `405`, batch 크기·메시지별 rate 비용, slow POST·조기 거부 unread body 종료, 물리 ingress·논리 클라이언트 제한 검증
- 응급 현재 증상·이중부정·과량복용 정탐과 정의 질문·해소된 과거 증상 미탐 검증
- 복합성분 부분 파싱 fail-closed, EDI 선행 0, 수화물 identity, code-only DUR target, 조건부 DUR 규칙 검증
- 승인된 DUR 품목 API 전체 23,424행 감사와 e약은요 병합 후 release master 25,522품목 저장: 성분 행 보유 22,916품목 (`89.7892%`), 성분 파싱·DUR identity 보류 포함 불완전 3,807품목은 fail-closed
- 기존 DUR target 9,469행 재대조: 제품 master 누락 293행·성분 파싱 또는 identity 매핑 불완전 374행은 보류 대상으로 식별했고, 완전 파싱된 대상 제품의 성분 불일치는 0건
- DUR 성분 API 1,816행 감사: 활성 1,751행 + 삭제 65행, 활성 중 중복 규칙 1행을 제거해 고유 규칙 1,750건 저장
- 상세 금기내용 미제공 활성 규칙 35행은 누락시키지 않고 일반 사유로 명시
- 제품 API `23,424 = 23,422 정상 + 2 취소 + 0 무효 + 0 중복`, e약은요 `4,759 = 4,742 저장 + 0 무효 + 17 동일내용 중복`, 저장 필드 충돌 중복 0건
- 공식 `ORI` 별칭 1,012개와 1:N 별칭 7개를 관계 테이블로 보존, `ORI` 3,500개와 `MIX` 787개 전부 파싱
- 공식 활성 relation `512/512`, 공식 relation 기대 identity `379/379`를 결과 관계와 독립 계산해 매핑
- 제한된 염·수화물·표기 형식 매핑 79행, 수동 검증된 표기 동의어 매핑 33행, 모호 형식 0행, 위험 `FALLBACK` 1,329행은 제품 불완전으로 보류, 실제 카탈로그 부재 21,319행은 별도 provenance로 보존
- 활성 제품에서 나타나는 전체 카탈로그 identity `331/462`; 현재 제품에 없는 131개 identity도 규칙 카탈로그에 보존
- 완전 파싱·매핑된 제품의 성분 카탈로그 조회 커버리지 `21,715/25,522` (`85.0835%`)
- handoff prompt SHA-256 보존
- `npm run submission:check:live` 고정 대표 품목 `31/31`·핵심 안전 프로브 `216/216` 포함 전 항목 통과, `npm audit --omit=dev` 취약점 0건
- 공식 MCP Inspector CLI 로컬 live/v3 `tools/list` 통과: read-only tools 3개와 annotations 확인
- 로컬 MCP SDK wire 실측: `제일에페드린염산염주사액4%`(`195700013`) + `노르아드레나린주0.1%`(`199806705`) 모두 품목 스냅샷 없이 CONFIRMED, `isError:false`, `WARN`, `DUR_INGREDIENT_SNAPSHOT`, `USJNT_TABOO:RED`, 사유 `부정맥 또는 심정지`, failedTypes 없음
- 로컬 `/readyz` 200: build ID와 DB SHA 일치, `activeCatalogIdentityMapping=379/379`, `ingredientDur=21,715/25,522`, 공식 relation `512/512`, 독립 안전 프로브 `216/216`; startup 안전 검사는 캐시하며 요청마다 freshness만 재평가
- false-green 회귀 실측: 수정 전 `판토프라졸나트륨세스키히드레이트 + 릴피비린`이 `NO_KNOWN_FINDINGS`였으나, 형식 매핑 후 `isError:false`, `WARN`, `DUR_INGREDIENT_SNAPSHOT`, `USJNT_TABOO:RED`로 확인
- 추가 P0 회귀 실측: 팍스로비드+콤포나콤팩트, 카보메틱스+리팜피신, 카보메틱스+튜비스, 케토롤락+니메수리드, 케토코나졸+이소니아짓, 팍스로비드+클리피도그렐, 자일로메타졸린(공식 DUR identity: 키실로메타졸린)+라사길린이 모두 `isError:false`, `WARN`, `USJNT_TABOO:RED`, `failedTypes=[]`; 독립 프로브는 품목 스냅샷을 강제로 제거하고 성분 카탈로그만으로 재검증
- 표기 후보 전수 감사: 아미노카프로산·에데트산칼슘디나트륨·트라넥사민산·자일로메타졸린은 검증된 공식 identity로 매핑하고, 서로 다른 성분인 이소소르비드액·칼시포트리올·반코마이신/린코마이신·토수플록사신/목시플록사신·펠루비프로펜/플루르비프로펜은 `UNCERTAIN`으로 보류; 길이 제한 없는 `CATALOG_ABSENT` substring 감사의 후보 2개는 벤조산나트륨카페인·카페인과 초산 L-리신·L-리신으로 모두 명시 분류되어 미분류 후보 0개
- 중복성분 회귀: 니메수리드·이소니아짓·클리피도그렐 표기 변형 3개와 벤조산나트륨카페인·카페인 구성성분은 `DUP_INGREDIENT`, `failedTypes` 없음; 초산 L-리신·L-리신은 `DUP_INGREDIENT`를 검출하되 영양수액의 다른 미확인 성분 때문에 전체 중복검사는 `failedTypes`로 투명하게 보류
- 브랜드 응급 회귀: 자연스러운 용기·다량복용·복용 의도·문장부호·어순·자해 의도 변형 127개는 `WARN` + `EMERGENCY`; 음식·일상 복약·구매·보관·부정·인용 표현 47개는 `EMERGENCY_TRIAGE` 없이 비응급 유지; 현재 복용 여부나 자해 의도가 모호한 18개는 false-green 대신 `UNCERTAIN` + `EMERGENCY_TRIAGE`로 보류하며 `resolve_medications` 경로도 같은 결과
- 위험 fallback 대표 품목 `196000011`은 `UNCERTAIN` + `failedTypes=USJNT_TABOO`로 확인
- 정식 원격 검증기를 로컬 live endpoint에 실행: 대표·회귀 흐름과 성능 100회 통과, 평균 `6.2ms`·p99 `9.2ms`, 동시 8회 p99 `53.0ms`, cold 연결 5회 p99 `27.3ms`; 표준 SDK 장기 세션 120회도 통과하며 증거 JSON은 제출 문서와 분리해 임시 경로에만 생성
- Windows Node 22.18.0 최신 재실행은 로컬 WSL `node_modules` junction/ACL이 Windows `npm ci`를 거부해 미완료. GitHub Actions의 fresh Windows runner에서 확인 필요
- 로컬 Docker daemon이 실행 중이 아니어서 image build는 미실행. CI Docker build와 KC 재배포에서 확인 필요

## Remote Verification Completed

- SDK evidence checkedAt: `2026-07-12T12:06:58.227Z`
- Inspector evidence checkedAt: `2026-07-12T12:07:02.756Z`
- 정확한 read-only tools 3개와 annotations, 대표 중복성분·RED·설명·응급·비응급·보류 흐름 통과
- 원격 핵심 안전 프로브 `216/216`, 대표 품목 `31/31` 통과
- 대표 흐름 100회 평균 `20.5ms`, p99 `87.8ms`
- 동시 8회 p99 `88.9ms`, cold 연결 5회 p99 `73.0ms`
- 공식 MCP Inspector `tools/list` 통과
- `npm run submission:check:release`: `tools=true`, `flows=true`, `readiness=true`, `performance=true`

## Final Evidence Artifacts

v3 DB와 KC endpoint를 같은 release artifact로 맞춘 뒤 아래 명령을 통과했다.

```bash
npm run submission:check:live
npm run verify:remote
npm run submission:check:release
```

GitHub Actions `Remote Release Verification`은 다음 두 JSON을 30일 artifact로 보존한다.

- `docs/submission/remote-verification.generated.json`
- `docs/submission/inspector-tools.generated.json`

최종 문서에는 다음 실측값만 기록한다.

- `/healthz` 200, `/readyz` 200
- readiness의 build ID·DB SHA·generation ID·fetchedAt·v3 커버리지
- 정확한 tools/list 3개와 annotations
- 타이레놀+게보린 중복성분
- 아스피린프로텍트+유한메토트렉세이트 RED
- 두 품목 모두 품목 스냅샷 없이 전체 성분 카탈로그만으로 `USJNT_TABOO:RED`가 확인되는 흐름
- 제한된 염·수화물 형식 매핑으로만 연결되는 판토프라졸+릴피비린 `USJNT_TABOO:RED` 흐름
- 팍스로비드 복합제, 카보잔티닙 염, 튜비스 MIX D-code 및 니메수리드·이소니아짓·클리피도그렐·자일로메타졸린 false-green 회귀 7개 RED 흐름
- 표기 변형·구성성분 중복 5개, 브랜드명 과량복용·자해 의도 응급 127개, 음식·일상 복약·구매·보관·부정·인용 표현 비응급 47개, 잠재 과량복용·자해 표현 보류 18개 흐름
- 성분 누락·조건 해석 불가의 `UNCERTAIN` 흐름
- e약은요 설명
- 대표 흐름 합계 100회 및 도구별 분포 평균 100ms 이하·p99 3,000ms 이하, 동시 burst·cold 연결 p99 3,000ms 이하

위 원격 gate는 2026-07-12 통과했다. GitHub Actions `Remote Release Verification` 수동 실행으로 동일 검증의 fresh checkout artifact를 보존한다.
