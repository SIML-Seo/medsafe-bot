# 데모와 등록

## 로컬 검증

```bash
npm ci
npm test
npm run dev
```

fixture DB는 `data/master.fixture.sqlite` 또는 테스트 전용 `data/master.test.sqlite`를 사용하며 제출용 `data/master.sqlite`를 덮어쓰지 않는다.

## 3분 데모 순서

1. “아스피린”으로 모호한 후보와 token 미발급을 보여준다.
2. 정확한 아스피린프로텍트정과 유한메토트렉세이트정으로 실제 RED를 보여준다.
3. 타이레놀 500mg과 게보린의 아세트아미노펜 중복을 보여준다.
4. 타이레놀 e약은요 설명을 조회한다.
5. 호흡곤란·과량복용 문장으로 119 우선 분기를 보여준다.
6. `/readyz`의 build ID, DB SHA, generation, freshness, coverage와 원격 100회 성능 증거를 보여준다.

## PlayMCP 등록·갱신

KC Git 빌드에 공개 저장소를 연결하고 runtime 환경변수를 설정한다. endpoint가 Active가 된 뒤 PlayMCP에는 `/mcp`, Streamable HTTP로 등록한다. 배포 변경 후에는 KC 가이드에 따라 기존 KC 서버를 동일 이름으로 다시 생성하고, PlayMCP 정보 다시 불러오기와 재심사를 수행한다.

최종 증거 절차:

```bash
npm run submission:check:live
npm run verify:remote
npm run submission:check:release
```

`verify:remote`가 성공하면 현재 endpoint, build ID, verification ID, DB SHA, 고정 RED와 품목 스냅샷 없는 성분 카탈로그 전용 RED, 표기 변형·구성성분 중복, 브랜드 응급 회귀·비응급 대조군·모호한 과량복용 보류를 포함한 대표 흐름, 고정 안전 프로브 216개, 합계 100회 도구별 분포·동시 burst·cold 연결 평균·p99를 `docs/submission/remote-verification.generated.json`에 원자적으로 기록한다. token과 service key는 증거 파일에 쓰지 않는다. GitHub Actions는 미국 runner의 장거리 RTT를 `remote-verification.cross-region.generated.json`에 분리하고, 한국 strict 성능 인증·cross-region 관측·공식 Inspector의 세 JSON을 30일 artifact로 보존한다.
