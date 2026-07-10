# Tool 계약

## 공통

세 도구는 모두 `readOnlyHint=true`, `destructiveHint=false`, `openWorldHint=false`, `idempotentHint=true`다. 출력 텍스트는 서버가 생성·정제하며, `structuredContent`에는 `dataAsOf`를 포함한다.

## resolve_medications

- 입력: `queries` 1~8개, 각 1~512자. 실제 정식 품목명을 그대로 재확인할 수 있는 경계다.
- 출력 상태: `CONFIRMED`, `AMBIGUOUS`, `NOT_FOUND`, `OUT_OF_SCOPE`.
- 정확한 단일 품목만 `CONFIRMED`와 10분 만료 `confirmationToken`을 받는다.
- `AMBIGUOUS` 후보에는 token을 발급하지 않는다. Agent/UI는 사용자가 고른 정확한 품목명으로 다시 resolve한다.
- 제품명에 식품·건기식 단어가 들어 있어도 실제 품목 완전일치가 먼저다.
- 응급 표현이면 `{ "resolved": [], "emergency": true, "dataAsOf": "..." }`를 반환한다.

## check_medication_safety

입력 `medications`는 resolve 결과의 `itemSeq`, `ingrCode`, `status`, `confirmationToken`을 그대로 복사하고, `matchedName`은 check 입력의 `displayName`으로 매핑한다. `displayName`은 최대 512자다. token이 없거나 canonical 필드와 다르면 해당 항목은 미확정으로 강등한다.

선택 컨텍스트:

- `ageGroup`: `adult`, `elderly`, `child`, `unknown`
- `pregnancy`: `yes`, `no`, `unknown`
- `notes`: 최대 500자

출력은 `verdict`, `dataAsOf`, `findings`, `unresolved`, `checkedTypes`, `failedTypes`, `disclaimer`다. 각 finding은 `source`, `baseDate`, `dateBasis`를 가진다. 핵심 조회 실패나 스냅샷 부재는 `UNCERTAIN`이며 tool error가 아니다.

## explain_medication

입력은 resolve가 확인한 9자리 `itemSeq`다. 출력 status는 `FOUND`, `NOT_FOUND`, `UPSTREAM_ERROR`다. runtime은 로컬 e약은요 스냅샷을 읽고, 텍스트는 주요 항목을 줄여 보여주며 `structuredContent.info`에는 저장된 전체 필드를 유지한다.
