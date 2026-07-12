# Kakao Tools Widget Mapping

`widget-preview.html`은 정적 그림이 아니라 `window.renderMedsafeWidget(structuredContent)`에 실제 MCP 응답 계약을 넣어 렌더링합니다. text 응답을 다시 파싱하지 않습니다.

## Resolve 계약

| Field | UI |
|---|---|
| `resolved[].status` | `AMBIGUOUS`, `CONFIRMED`, `NOT_FOUND`, `OUT_OF_SCOPE` 상태 |
| `resolved[].query` | 사용자가 말한 표현 |
| `resolved[].candidates[]` | 실제 품목명·제조사 선택 목록 |
| `candidate.itemSeq` | 화면에 노출하지 않는 선택 식별자 |
| `candidate.confirmationToken` | 모호한 후보에서는 항상 `null` |
| `dataAsOf` | 응답에 사용한 로컬 공개데이터 스냅샷 기준일 |

후보 선택 후 Agent는 선택한 정확한 제품명으로 `resolve_medications`를 다시 호출합니다. 모든 항목이 `CONFIRMED`이면 text handoff에는 확정 제품명 `queries`만 들어가며, check 도구가 이를 master에서 다시 확인합니다. Widget이 임의로 status를 올리거나 token을 만들지 않습니다.

후보 버튼은 선택 상태를 표시하고 Widget root에서 `medsafe:candidate-selected` CustomEvent를 발생시킵니다. 이벤트 detail은 `query`, `itemSeq`, `ingrCode`, `matchedName`, `candidateIndex`만 포함하며 token은 포함하지 않습니다. 여러 `resolved[]` 항목은 각각 별도 행으로 렌더링합니다.

## Safety 계약

| Field | UI |
|---|---|
| `verdict` | `WARN` red, `CAUTION`/`UNCERTAIN` yellow, 실패·미확인 항목이 전혀 없는 `NO_KNOWN_FINDINGS`만 green |
| `findings[]` | type, a, b, reason, source, baseDate, dateBasis 근거 행 |
| `unresolved[]` | 특정하지 못했거나 성분·DUR 규칙 조건·스냅샷 근거가 불완전한 항목 |
| `checkedTypes[]` | 실제 완료된 핵심 검사 |
| `failedTypes[]` | 실제 실패한 핵심 검사. 존재하면 green 금지 |
| `disclaimer` | 하단 고정 문구 |

## Explain 계약

| Field | UI |
|---|---|
| `found`, `status` | `FOUND`, `NOT_FOUND`, `UPSTREAM_ERROR` 상태 분기 |
| `info.itemName`, `info.entpName` | 품목명과 업체명 |
| `info.efcyQesitm` | 효능·효과 |
| `info.useMethodQesitm` | 사용 방법 |
| `info.atpnWarnQesitm`, `info.atpnQesitm` | 주의사항 |
| `dataAsOf` | 로컬 e약은요 스냅샷 기준일 |

## 렌더링 원칙

- resolve의 `{ emergency: true, resolved: [] }`와 check의 `EMERGENCY` finding 모두 일반 결과보다 먼저 119/응급실 제목을 표시합니다.
- PlayMCP text handoff에는 `confirmationToken`을 넣지 않습니다. SDK 호환 경로의 token도 화면·로그·캡처에 표시하지 않습니다.
- source, baseDate, dateBasis는 finding마다 함께 표시합니다. dateBasis로 원천 기준일·스냅샷 수집일·정책일을 구분합니다.
- `failedTypes` 또는 `unresolved`가 하나라도 있으면 payload의 verdict가 `NO_KNOWN_FINDINGS`여도 `UNCERTAIN`으로 강등합니다.
- 미구현 검사 유형을 마치 실행 실패한 것처럼 `failedTypes`에 넣지 않습니다.
- 서버 응답 문자열은 HTML로 삽입하기 전에 escape합니다.
