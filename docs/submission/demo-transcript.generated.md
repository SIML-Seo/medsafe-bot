# Demo Transcript

Generated from the local MCP server with live public-data mode.

## 1. Live red-case 입력과 확인

User: 엄마가 로바콜하고 더마졸 같이 먹어도 돼?

Tool: `resolve_medications`

```text
확인 후보: 로바콜 → 로바콜정(로바스타틴)(수출용)
확인 후보: 더마졸 → 더마졸정(케토코나졸)(수출용)

이 결과는 건강기능식품·식품·한약·일부 의약품 정보를 포함하지 못할 수 있습니다.
본 서비스는 의료기기가 아닙니다.
본 정보는 식약처 공개데이터 기반 일반 참고용이며 의사·약사의 진단·처방·복약지도를 대체하지 않습니다. 실제 복용·중단·변경은 반드시 의사 또는 약사와 상담하세요. 응급 증상 시 즉시 119.
```

Structured summary:

```json
{
  "resolved": [
    {
      "query": "로바콜",
      "status": "CONFIRMED",
      "inputKind": "PRODUCT",
      "itemSeq": "199701294",
      "ingrCode": "D000419",
      "matchedName": "로바콜정(로바스타틴)(수출용)",
      "candidates": [
        {
          "itemSeq": "199701294",
          "ingrCode": "D000419",
          "matchedName": "로바콜정(로바스타틴)(수출용)",
          "manufacturer": "명인제약(주)",
          "score": 1,
          "reason": "alias product",
          "confirmationToken": "v1.[redacted]"
        }
      ],
      "confirmationToken": "v1.[redacted]"
    },
    {
      "query": "더마졸",
      "status": "CONFIRMED",
      "inputKind": "PRODUCT",
      "itemSeq": "199101243",
      "ingrCode": "D000769",
      "matchedName": "더마졸정(케토코나졸)(수출용)",
      "candidates": [
        {
          "itemSeq": "199101243",
          "ingrCode": "D000769",
          "matchedName": "더마졸정(케토코나졸)(수출용)",
          "manufacturer": "(주)동구바이오제약",
          "score": 1,
          "reason": "alias product",
          "confirmationToken": "v1.[redacted]"
        }
      ],
      "confirmationToken": "v1.[redacted]"
    }
  ]
}
```

## 2. 실제 DUR 병용금기

Tool: `check_medication_safety`

```text
🔴 금기 1건 / 주의 0건

• [USJNT_TABOO] 로바콜정(로바스타틴)(수출용) × 더마졸정(케토코나졸)(수출용)
  → 횡문근융해증을 비롯한 근육질환 등 중증 이상반응
  이 약이 아니면 이 경고는 무시하세요. 이미 처방받은 조합일 수 있으니 임의 중단 전 의사·약사에게 문의하세요.
  출처: https://www.data.go.kr/data/15059486/openapi.do · 기준일 2026-07-01

※ 일부 조회 실패: AGE_TABOO, PREG_TABOO, CAPACITY, PERIOD, ELDERLY_CAUTION, EFCY_DUP, SR_SPLIT. 이 경우 녹색으로 표시하지 않습니다.
이 결과는 건강기능식품·식품·한약·일부 의약품 정보를 포함하지 못할 수 있습니다.
이미 처방받은 조합일 수 있으니 임의 중단 전 약사·의사에게 문의하세요.

────────
본 정보는 식약처 공개데이터 기반 일반 참고용이며 의사·약사의 진단·처방·복약지도를 대체하지 않습니다. 실제 복용·중단·변경은 반드시 의사 또는 약사와 상담하세요. 응급 증상 시 즉시 119.
```

## 3. 데이터 부족 fail-closed 데모

Tool: `resolve_medications` then `check_medication_safety`

```text
🟡 추가 확인 필요


※ 특정하지 못한 항목: 타이레놀정500밀리그람(아세트아미노펜): 성분코드 미확인으로 중복성분 판정 보류, 게보린정(수출명:돌로린정): 성분코드 미확인으로 중복성분 판정 보류

※ 일부 조회 실패: AGE_TABOO, PREG_TABOO, CAPACITY, PERIOD, ELDERLY_CAUTION, EFCY_DUP, SR_SPLIT, DUP_INGREDIENT. 이 경우 녹색으로 표시하지 않습니다.

※ 등록된 병용금기는 조회되지 않았습니다(안전을 보장하는 것은 아닙니다).
이 결과는 건강기능식품·식품·한약·일부 의약품 정보를 포함하지 못할 수 있습니다.
이미 처방받은 조합일 수 있으니 임의 중단 전 약사·의사에게 문의하세요.

────────
본 정보는 식약처 공개데이터 기반 일반 참고용이며 의사·약사의 진단·처방·복약지도를 대체하지 않습니다. 실제 복용·중단·변경은 반드시 의사 또는 약사와 상담하세요. 응급 증상 시 즉시 119.
```

## 4. 응급 우선

```text
🔴 금기 1건 / 주의 0건

• [EMERGENCY] 응급 의심 표현
  → 응급 신호가 언급되었습니다. 상호작용 조회보다 119 또는 응급실 상담이 우선입니다.
  출처: 서버 안전정책 · 기준일 2026-07-01
이 결과는 건강기능식품·식품·한약·일부 의약품 정보를 포함하지 못할 수 있습니다.
이미 처방받은 조합일 수 있으니 임의 중단 전 약사·의사에게 문의하세요.

────────
본 정보는 식약처 공개데이터 기반 일반 참고용이며 의사·약사의 진단·처방·복약지도를 대체하지 않습니다. 실제 복용·중단·변경은 반드시 의사 또는 약사와 상담하세요. 응급 증상 시 즉시 119.
```

## 5. 범위 밖 입력

```text
범위 밖 입력: 자몽 → 의약품 품목 조회 대상이 아닙니다. 식품·건강기능식품·한약 상호작용은 약사에게 확인하세요.

이 결과는 건강기능식품·식품·한약·일부 의약품 정보를 포함하지 못할 수 있습니다.
본 서비스는 의료기기가 아닙니다.
본 정보는 식약처 공개데이터 기반 일반 참고용이며 의사·약사의 진단·처방·복약지도를 대체하지 않습니다. 실제 복용·중단·변경은 반드시 의사 또는 약사와 상담하세요. 응급 증상 시 즉시 119.
```
