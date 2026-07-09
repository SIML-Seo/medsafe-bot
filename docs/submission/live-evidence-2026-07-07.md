# Live Evidence - 2026-07-07

검증 시각: 2026-07-07 19:57 KST

## Pre-KC Live Endpoint Evidence

이 문서는 PlayMCP in KC 발급 전 OCI 검증 endpoint 기준의 live evidence입니다. 공모전 최종 제출 전에는 PlayMCP in KC에서 발급된 endpoint로 같은 항목을 재검증해 증거를 추가합니다.

- MCP URL: `https://medsafe-140-245-67-103.sslip.io/mcp`
- Transport: Streamable HTTP
- Data mode: `live`

## Health Checks

`GET /healthz`

```json
{"ok":true}
```

`GET /readyz`

```json
{"ok":true,"dataMode":"live","generatedAt":"2026-07-07T10:56:22.834Z","dur":"DUR self-test succeeded"}
```

## MCP Tools

`tools/list` returned three read-only tools:

```json
[
  {"name":"resolve_medications","readOnly":true},
  {"name":"check_medication_safety","readOnly":true},
  {"name":"explain_medication","readOnly":true}
]
```

## Live Red-Case Flow

`resolve_medications` input:

```json
{"queries":["로바콜","더마졸"]}
```

Resolved medications:

```json
[
  {
    "query":"로바콜",
    "status":"CONFIRMED",
    "itemSeq":"199701294",
    "ingrCode":"D000419",
    "matchedName":"로바콜정(로바스타틴)(수출용)",
    "hasToken":true
  },
  {
    "query":"더마졸",
    "status":"CONFIRMED",
    "itemSeq":"199101243",
    "ingrCode":"D000769",
    "matchedName":"더마졸정(케토코나졸)(수출용)",
    "hasToken":true
  }
]
```

`check_medication_safety` result:

```json
{
  "isError":false,
  "verdict":"WARN",
  "findingCount":1,
  "failedTypes":[
    "AGE_TABOO",
    "PREG_TABOO",
    "CAPACITY",
    "PERIOD",
    "ELDERLY_CAUTION",
    "EFCY_DUP",
    "SR_SPLIT"
  ]
}
```

Red finding:

```json
{
  "type":"USJNT_TABOO",
  "origin":"DUR_API",
  "level":"RED",
  "a":"로바콜정(로바스타틴)(수출용)",
  "b":"더마졸정(케토코나졸)(수출용)",
  "reason":"횡문근융해증을 비롯한 근육질환 등 중증 이상반응",
  "source":"https://www.data.go.kr/data/15059486/openapi.do",
  "baseDate":"2026-07-01"
}
```

## Explain Flow

`explain_medication` input:

```json
{"itemSeq":"202106092"}
```

Result summary:

```json
{"isError":false,"found":true}
```

## Fail-Closed Probe

`resolve_medications` input:

```json
{"queries":["타이레놀","게보린"]}
```

`check_medication_safety` result summary:

```json
{
  "isError":false,
  "verdict":"UNCERTAIN",
  "unresolved":[
    "타이레놀정500밀리그람(아세트아미노펜): 성분코드 미확인으로 중복성분 판정 보류",
    "게보린정(수출명:돌로린정): 성분코드 미확인으로 중복성분 판정 보류"
  ],
  "failedTypes":[
    "AGE_TABOO",
    "PREG_TABOO",
    "CAPACITY",
    "PERIOD",
    "ELDERLY_CAUTION",
    "EFCY_DUP",
    "SR_SPLIT",
    "DUP_INGREDIENT"
  ]
}
```

`resolve_medications` input:

```json
{"queries":["와파린","아스피린"]}
```

`check_medication_safety` result summary:

```json
{
  "isError":false,
  "verdict":"UNCERTAIN",
  "unresolved":[
    "아스피린프로텍트정100밀리그람: 성분코드 미확인으로 중복성분 판정 보류",
    "쿠파린정2밀리그램(와파린나트륨)_(2mg/1정): DUR 품목기준코드 미확인으로 병용금기 조회 보류"
  ],
  "failedTypes":[
    "AGE_TABOO",
    "PREG_TABOO",
    "CAPACITY",
    "PERIOD",
    "ELDERLY_CAUTION",
    "EFCY_DUP",
    "SR_SPLIT",
    "DUP_INGREDIENT",
    "USJNT_TABOO"
  ]
}
```

## Notes

- Public data master DB source: `PUBLIC_DATA_LIVE`
- Live self-test itemSeq: `199701294`
- Live self-test expectation: `LIVE_SELF_TEST_EXPECT_CONTRAINDICATION=true`
- The live red-case uses real public DUR data. The selected pair contains export-use products because it gives a low-page-count, reliable DUR self-test path.
- Remaining unimplemented DUR categories are intentionally reported in `failedTypes` and keep the result conservative.
