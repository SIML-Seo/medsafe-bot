# 3분 심사용 데모 스크립트

## 0:00-0:20 모호한 이름 확인

사용자:

> 아스피린 먹고 있어요.

여러 품목 후보를 보여주되 `confirmationToken`은 발급하지 않습니다. 사용자가 정확한 제품을 확인한 뒤 제품명으로 다시 resolve합니다.

## 0:20-0:40 병용금기 질문

사용자:

> 성인 남성인 아버지가 아스피린프로텍트정 100mg하고 유한메토트렉세이트정 같이 먹어도 돼?

Agent는 정확한 용량·제품명을 `resolve_medications`에 전달합니다.

- 아스피린프로텍트정100밀리그람: itemSeq `200108429`
- 유한메토트렉세이트정: itemSeq `197900145`
- 두 결과 모두 `CONFIRMED`
- `[CHECK_MEDICATION_SAFETY_INPUT]`에 확정된 두 제품명 `queries`만 제공

설명할 점: 모호한 표현에는 handoff를 만들지 않습니다. 제품이 모두 확정되면 Agent는 읽을 수 있는 제품명만 다음 도구에 넘기고, check 도구가 master에서 독립적으로 다시 확인합니다.

## 0:40-1:05 실제 RED

Agent는 handoff의 `queries`만 그대로 전달합니다. `itemSeq`, 성분코드, status, token은 PlayMCP 모델이 복사하거나 구성하지 않습니다.

예상 결과:

- `verdict: WARN`
- `USJNT_TABOO`, `level: RED`
- 사유: `혈액학적 독성`
- 실제 MFDS DUR 출처와 기준일
- `failedTypes`에 `USJNT_TABOO` 없음

말할 문장:

> 위험 근거를 빨간색으로 표시하지만 임의 중단은 지시하지 않습니다. 이미 처방받은 조합일 수 있으므로 약사·의사 확인으로 연결합니다.

## 1:05-1:30 복합제 중복성분

사용자:

> 성인 남성인 제가 타이레놀정 500mg하고 게보린정은 같이 먹어도 돼?

정확한 용량·제형으로 resolve한 뒤 check합니다.

두 장면의 `ageGroup=adult`, `pregnancy=no`는 위 사용자 발화에 근거합니다. 연령·임신 정보가 없는 실제 요청에서는 해당 범위를 보류하는 CAUTION finding을 유지합니다.

예상 결과:

- 타이레놀 `202106092`, 게보린 `197900277`
- `DUP_INGREDIENT`
- 공통 성분 `아세트아미노펜`
- 게보린의 아세트아미노펜·카페인무수물·이소프로필안티피린 복합성분이 실제 master에 보존됨
- 핵심 조회 실패가 없으면 `CAUTION`

말할 문장:

> 제품당 성분 하나를 억지로 대표시키지 않고 복합제 전체 성분의 교집합을 비교합니다.

## 1:30-1:50 e약은요 설명

`explain_medication`에 타이레놀 itemSeq `202106092`를 전달합니다.

예상 결과:

- `status: FOUND`
- 텍스트에는 핵심 효능·사용법·주의를 짧게 표시하고 structuredContent에는 원문 전체 필드 유지
- 네트워크 오류와 정보 없음은 서로 다른 status

## 1:50-2:15 응급 우선

사용자:

> 타이레놀 20정을 먹었고 숨이 안 쉬어져요.

예상 결과:

- `EMERGENCY`, `WARN`
- 첫 줄에 즉시 119 또는 응급실 안내
- 약물 상호작용 조회보다 긴급 도움 요청 우선

부정 대조 입력 “호흡곤란은 없어요”는 응급으로 오탐하지 않습니다.

## 2:15-2:30 범위 밖 입력

사용자:

> 홍삼정이랑 자몽은?

예상 결과: `OUT_OF_SCOPE`. 식품·건강기능식품·한약은 별도 전문가 확인을 안내합니다.

## 2:30-3:00 운영 증거

- PlayMCP endpoint `/healthz` 200
- `/readyz` 200, `dataSource=PUBLIC_DATA_LIVE`, `dataModelVersion=3`, 데이터 SHA·성분 DUR 커버리지 공개
- tools/list에 read-only 3개 도구
- `npm run verify:remote` 평균 100ms 이하, p99 3초 이하

## 캡처 목록

- PlayMCP Active 상세 화면과 endpoint
- tools/list annotations
- 아스피린프로텍트×유한메토트렉세이트 RED 결과
- 타이레놀×게보린 중복성분 결과
- 타이레놀 e약은요 결과
- 응급 우선 결과
- `/readyz` JSON
- 실제 structuredContent를 렌더링한 Widget preview
