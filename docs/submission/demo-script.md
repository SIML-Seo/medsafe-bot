# 3분 심사용 데모 스크립트

## 목표

심사자가 3분 안에 이 MCP가 단순 약 검색이 아니라 "카카오톡 대화 안에서 복약 위험을 안전하게 오케스트레이션하는 서버"라는 점을 보게 한다.

## 장면 1. 보호자 cold open

사용자:

> 엄마가 로바콜하고 더마졸 같이 먹어도 돼?

Agent:

- `resolve_medications` 호출: `["로바콜", "더마졸"]`
- 두 약 모두 실 공공데이터 기반 itemSeq로 확인된다.

보여줄 포인트:

- 호출자 LLM이 약 이름을 임의 확정하지 않는다.
- 후보에는 서버가 발급한 `confirmationToken`이 붙고, 이 token이 없으면 안전 점검으로 넘어가지 않는다.

## 장면 2. 빨간색 위험

사용자:

> 후보가 맞아.

Agent:

- `check_medication_safety` 호출
- `로바콜정(로바스타틴)(수출용)` + `더마졸정(케토코나졸)(수출용)`

예상 결과:

- `WARN`
- 실제 DUR 병용금기 `USJNT_TABOO`
- 사유: `횡문근융해증을 비롯한 근육질환 등 중증 이상반응`
- 출처, 기준일, 임의 중단 금지, 표준 disclaimer 표시

말할 문장:

> 이 서버는 위험이 확인되면 빨간색으로 올리지만, 임의 중단을 지시하지 않습니다. 이미 처방받은 조합일 수 있으므로 약사·의사 확인으로 연결합니다.

## 장면 3. 데이터 부족 fail-closed

사용자:

> 타이레놀하고 게보린은?

Agent:

- `resolve_medications` 호출: `["타이레놀", "게보린"]`
- token 포함해 `check_medication_safety` 호출

예상 결과:

- 공개 데이터에서 성분코드가 충분히 매핑되지 않으면 녹색으로 단정하지 않는다.
- `DUP_INGREDIENT` 또는 DUR 조회 보류가 `failedTypes`/미확정 항목에 명시된다.
- "등록된 병용금기는 조회되지 않았습니다" 문구가 있어도 안전 보장이 아님을 함께 표시한다.

## 장면 4. 응급 우선

사용자:

> 약 먹고 호흡곤란이 있어.

Agent:

- `resolve_medications` 또는 `check_medication_safety`에서 응급어 감지

예상 결과:

- 상호작용 조회보다 119/응급실 안내 우선

말할 문장:

> 복약 안전 MCP에서 가장 위험한 실패는 조회를 잘하는 것이 아니라, 조회하면 안 되는 상황을 놓치는 것입니다. 응급 신호는 로컬 정책으로 먼저 차단합니다.

추가 시연 입력:

> 한꺼번에 20알을 먹었대요. 과다복용 같아요.

예상 결과:

- `EMERGENCY` finding
- 상호작용 조회보다 119/응급실 안내 우선

## 장면 5. 범위 밖 입력

사용자:

> 자몽이랑 같이 먹어도 돼?

Agent:

- `resolve_medications` 결과: `OUT_OF_SCOPE`

예상 결과:

- 식품·건강기능식품·한약은 의약품 품목 조회 범위 밖이라고 안내
- 약사 확인 권장

## 제출 전 캡처 목록

- PlayMCP 등록 URL
- `tools/list` 결과
- `resolve_medications` 후보 되묻기 결과
- `check_medication_safety` 노란색 결과
- `check_medication_safety` 빨간색 결과
- `/healthz`, `/readyz`
- Widget preview 또는 카드 목업
