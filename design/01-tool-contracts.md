# Tool 계약

## 공통 원칙

- 모든 tool은 read-only이다.
- 호출자 LLM을 신뢰하지 않는다. `check_medication_safety`는 `resolve_medications`가 발급한 `confirmationToken`이 없거나 불일치하는 `CONFIRMED` 항목을 미확정 처리한다.
- 실행 실패는 가능한 한 tool result의 `isError=true`와 서버 생성 텍스트로 반환한다.
- 판정/설명 텍스트는 서버가 생성한다. 호출자 LLM이 의료 표현을 자유 작성하지 않도록 한다.

## resolve_medications

입력:

```json
{
  "queries": ["타이레놀", "게보린"]
}
```

출력:

```json
{
  "resolved": [
    {
      "query": "타이레놀",
      "status": "AMBIGUOUS",
      "inputKind": "PRODUCT",
      "itemSeq": null,
      "ingrCode": null,
      "matchedName": null,
      "confirmationToken": null,
      "candidates": []
    }
  ]
}
```

상태:

- `CONFIRMED`: 단일 고신뢰 후보. 그래도 판정 전 사용자에게 되보이는 것을 기본 UX로 한다.
- `AMBIGUOUS`: 복수 후보 또는 중간 신뢰도. 후보 최대 5개.
- `NOT_FOUND`: 후보 없음. 판정에서는 unresolved로 밀린다.
- `OUT_OF_SCOPE`: 식품·건강기능식품·한약 등 의약품 품목 조회 범위 밖 입력.

입력 제한:

- `queries`: 1-8개
- 각 query: 1-80자
- 후보와 확정 결과에는 `confirmationToken`이 붙을 수 있다. 이 값은 판정 전용이며 사용자에게 설명할 필요는 없다.
- 후보의 `confirmationToken`은 사용자가 해당 후보를 선택해 `status=CONFIRMED`로 넘길 때만 유효하다.

## check_medication_safety

입력:

```json
{
  "medications": [
    {
      "itemSeq": "DEMO-TYLENOL-500",
      "ingrCode": "INGR-APAP",
      "status": "CONFIRMED",
      "displayName": "타이레놀정500밀리그람",
      "confirmationToken": "v1..."
    }
  ],
  "context": {
    "subjectIsUser": false,
    "ageGroup": "elderly",
    "pregnancy": "unknown"
  }
}
```

출력 핵심:

- `verdict`: `NO_KNOWN_FINDINGS`, `CAUTION`, `WARN`, `UNCERTAIN`
- `findings`: 금기/주의/보류 finding 배열
- `unresolved`: 미확정/무효/비의약품 의심 항목
- `checkedTypes`, `failedTypes`
- `disclaimer`

입력 제한:

- `medications`: 1-12개
- `itemSeq`, `ingrCode`: 최대 80자
- `displayName`: 최대 100자
- `context.notes`: 최대 500자

부분 실패:

- 핵심 2종 중 병용금기 조회 실패 또는 필드 미해결이면 `UNCERTAIN`.
- 중복성분은 로컬 DB 기준으로 수행한다.
- 8종 전체 중 일부 best-effort 실패는 `failedTypes`에 남기고 녹색을 금지한다.

## explain_medication

입력:

```json
{ "itemSeq": "DEMO-TYLENOL-500" }
```

출력:

- 제품명, 업체명, 효능, 사용법, 주의, 상호작용, 부작용, 보관법
- e약은요 커버리지 밖이면 `isError=false`로 "정보 없음"을 반환한다.

## 본선 후보 tool

`identify_pill_by_text`는 MVP 코드에는 넣지 않는다. 본선에서 색/모양/각인 입력을 받아 후보만 반환하며 단독 확정하지 않는다.
