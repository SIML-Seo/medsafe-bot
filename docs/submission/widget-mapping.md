# Kakao Tools Widget Mapping

## 목적

본선에서 Widget 스펙을 요구받았을 때 `structuredContent`를 그대로 카드 UI로 옮길 수 있음을 보여준다.

## 데이터 계약

`check_medication_safety`의 `structuredContent`:

| Field | Widget role | 표시 규칙 |
|---|---|---|
| `verdict` | 상단 신호등 | `WARN` red, `CAUTION`/`UNCERTAIN` yellow, `NO_KNOWN_FINDINGS` green |
| `findings[]` | 근거 카드 목록 | type, a, b, reason, source, baseDate 표시 |
| `unresolved[]` | 되묻기/확인 필요 영역 | 미확정 약, token 누락, 범위 밖 입력 표시 |
| `checkedTypes[]` | 접힌 상세 정보 | 조회 완료 범위 |
| `failedTypes[]` | 접힌 경고 정보 | 녹색 금지 사유 |
| `disclaimer` | 카드 하단 고정 문구 | 항상 표시 |

## 카드 상태

### Ambiguous Selection

- 제목: "약을 한 번 더 확인해주세요"
- 본문: 후보 제품명 2-5개
- 액션: 후보 선택 버튼
- 서버 입력: 선택된 candidate의 `itemSeq`, `ingrCode`, `confirmationToken`

### Caution

- 제목: "주의 정보가 있습니다"
- 색상: yellow
- 본문: 중복 성분, 맥락 부족, 일부 조회 실패
- 액션: "약사에게 보여줄 요약 보기"

### Warn

- 제목: "병용금기 가능성이 있습니다"
- 색상: red
- 본문: 두 약 이름, reason, source, baseDate
- 고정 문구: "임의 중단 전 약사·의사에게 문의하세요"

### Out Of Scope

- 제목: "의약품 조회 범위 밖 입력입니다"
- 색상: neutral/yellow
- 본문: 식품·건강기능식품·한약은 별도 확인 필요

## 구현 메모

- Widget은 `content[0].text`를 재해석하지 않고 `structuredContent`만 렌더링한다.
- `confirmationToken`은 화면에 노출하지 않는다.
- `source`와 `baseDate`는 finding마다 표시한다.
- `failedTypes`가 있으면 green UI를 금지한다.
