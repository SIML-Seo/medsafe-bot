# Live Data And Deployment Checklist

## 데이터 갱신

- `data/source/atc_mapping.csv`, `data/source/ingredient_master.csv` 원문 준비
- 공공데이터포털에서 DUR 품목정보 `15059486`, DUR 성분정보 `15056780`, e약은요 `15075057`을 각각 활용신청
- `.secrets/mfds.env`에 decoding 서비스키 보관, Git 추적 금지
- `npm run build:master:live`
- 결과 source `PUBLIC_DATA_LIVE`, data model v3
- 제품 10,000개 이상, 성분 10,000행 이상, e약은요 1,000개 이상
- `invalidIngredientRowCount=0`, `replicatedProductIngredientCodeCount=0`, 완전 파싱 target의 `snapshotTargetIngredientMismatchCount=0`
- `curatedDurCoverageRatio=1`, 완전한 DUR 성분 카탈로그, 제품 성분 식별 커버리지 80% 이상
- 활성 제품 원료에서 공식 `ORI` 관계 또는 제한된 염·수화물 형식 정규화로 도달 가능한 DUR identity 매핑 100%
- 활성 제품 공식 관계 기대치와 실제 매핑을 독립 계산하고 `durIngredientActiveOfficialRelationMappedCount/Count=100%`
- `durIngredientUnparsedRelationFieldCount=0`, `durIngredientUnparsedMixtureFieldCount=0`
- 제한된 염·수화물 형식, 수동 검증 `CURATED_SPELLING`, `FALLBACK`, `CATALOG_ABSENT`, 모호 매핑 건수를 DB provenance와 대조하고 검증되지 않은 근접 표기·위험 형식 제품은 fail-closed
- 메타데이터와 품목 스냅샷에 의존하지 않는 고정 안전 프로브 216개(RED 7·중복 5·응급 양성 127·비응급 음성 47·잠재 과량복용 보류 18·표기 매핑 7·위험 표기 보류 5) 통과
- 전체 카탈로그의 활성 제품 대표율은 별도 공개
- 제품 API 전체행 = 정상 + 취소 + 무효 + 중복, e약은요 전체행 = 저장 + 무효 + 동일내용 중복이며 충돌 중복 0
- DUR 성분 API 전체행 = 활성행 + 삭제행, 활성행 = 고유 규칙 + 중복 규칙
- 아스피린프로텍트 `200108429` 스냅샷에 유한메토트렉세이트 `197900145` RED 관계 포함

## KC runtime 환경

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `DATA_MODE=live`
- `MASTER_DB_PATH=data/master.sqlite`
- `LIVE_SELF_TEST_ITEM_SEQ=200108429`
- `LIVE_SELF_TEST_TARGET_ITEM_SEQ=197900145`
- `LIVE_SELF_TEST_EXPECT_CONTRAINDICATION=true`
- 32자 이상 고정 `CONFIRMATION_SECRET`
- `ALLOWED_HOSTS=medsafe-bot.playmcp-endpoint.kakaocloud.io,localhost,127.0.0.1` (Docker healthcheck 포함)
- PlayMCP 호출 origin만 `ALLOWED_ORIGINS`에 지정
- `RATE_LIMIT_MAX=600`, `RATE_LIMIT_INGRESS_MAX=6000`, `RATE_LIMIT_MAX_KEYS=10000`
- `MCP_MAX_BATCH_ITEMS=8`
- `MCP_POST_MAX_INFLIGHT=100`, `MCP_POST_MAX_PER_CLIENT=10`, `MCP_POST_MAX_PER_INGRESS=50`
- `HTTP_MAX_CONNECTIONS=500`, `HTTP_HEADERS_TIMEOUT_MS=10000`, `HTTP_MAX_REQUESTS_PER_SOCKET=1000`

공공데이터 서비스키는 build-time 갱신에만 사용하며 KC runtime에 넣지 않아도 됩니다.

## 프록시

- 프록시가 `X-Forwarded-For`를 정리할 때만 `TRUST_PROXY=true`
- edge 1홉은 `TRUST_PROXY_HOPS=1`
- 실제 edge·내부 프록시 대역만 `TRUST_PROXY_CIDRS`에 지정
- 여러 프록시라면 실제 체인을 확인해 정확한 홉 수 지정
- 외부 클라이언트가 임의의 XFF 체인을 보존한 채 전달되지 않는지 확인

## 로컬 검증

- `npm test` 통과, `data/master.sqlite` mtime·source 불변
- `npm run verify` 통과
- live 환경변수와 함께 `npm run submission:check:live` 통과
- `npm run demo:transcript`가 live snapshot을 자동 감지
- `handoff-prompt.md` SHA-256 `d2d90b1fbc3502d6a63472886e0428197e94cb3089c29484c3c181fa091078bb`

## 배포 검증

- `/healthz` 200
- `/readyz` 200
- readiness의 `dataSource=PUBLIC_DATA_LIVE`, `dataModelVersion=3`
- readiness의 `buildId`, `dataSha256`, `generationId`, `fetchedAt`, `coverage` 확인
- `npm run verify:remote` 통과
- 공식 MCP Inspector CLI로 최종 KC `/mcp`의 `tools/list` 통과
- tools/list에 read-only 3개 도구와 annotations 5개 필드
- 타이레놀정 500mg이 `202106092`로 확인
- 타이레놀+게보린 `DUP_INGREDIENT`
- 아스피린프로텍트+유한메토트렉세이트 `WARN` + RED `USJNT_TABOO`
- 타이레놀 `explain_medication` exact itemSeq `FOUND`
- 두 품목 모두 DUR 품목 스냅샷이 없는 자동 선택 쌍에서 전체 성분 카탈로그만으로 `USJNT_TABOO:RED` 확인
- 판토프라졸+릴피비린에서 제한된 염·수화물 형식 매핑 기반 `USJNT_TABOO:RED` 확인
- 팍스로비드+콤포나콤팩트, 카보메틱스+리팜피신, 카보메틱스+튜비스, 케토롤락+니메수리드, 케토코나졸+이소니아짓, 팍스로비드+클리피도그렐, 자일로메타졸린(공식 DUR identity: 키실로메타졸린)+라사길린이 `USJNT_TABOO:RED`이고 `failedTypes`에 병용금기 없음
- 니메수리드·이소니아짓·클리피도그렐 표기 변형, 벤조산나트륨카페인·카페인 및 초산 L-리신·L-리신 구성성분 중복 5개, 브랜드명 과량복용·자해 의도 응급 문장 127개, 음식·일상 복약·구매·보관·부정·인용 표현 비응급 대조군 47개, 잠재 과량복용·자해 표현 보류 18개 원격 검증
- 성분 자체가 없는 정확한 품목은 `UNCERTAIN` + `failedTypes=USJNT_TABOO`
- 평균 100ms 이하, p99 3,000ms 이하

## 증거

- PlayMCP Active 상세 화면
- tools/list 결과
- 공식 MCP Inspector CLI 결과
- GitHub Actions artifact의 한국 strict `remote-verification.generated.json`, 미국 관측 `remote-verification.cross-region.generated.json`, `inspector-tools.generated.json`
- `/readyz` JSON
- 중복성분·red-case·설명·응급 우선 캡처
- `verify:remote` 출력과 `remote-verification.generated.json`
- `npm run submission:check:release` 통과
- GitHub Actions `Remote Release Verification` 수동 실행 통과
- 캡처와 실행 시각을 `live-evidence-2026-07-10.md`에 기록

배포 변경 전 로컬 통과만으로 제출 완료라고 표시하지 않습니다. KC 재배포 후 원격 gate가 통과해야 최종 상태입니다.
