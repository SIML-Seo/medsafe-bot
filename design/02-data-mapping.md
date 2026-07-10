# 데이터 흐름과 매핑

## 원천과 역할

| 원천 | 역할 | 런타임 사용 |
|---|---|---|
| 식약처 DUR 품목 API | 9자리 itemSeq, 제품명, 업체, 원료성분, 병용금기 | 빌드 시 스냅샷 |
| e약은요 API | 효능, 사용법, 주의, 상호작용, 부작용, 보관법 | 빌드 시 스냅샷 |
| HIRA ATC 매핑·주성분 CSV | EDI 코드에 ATC·HIRA 성분코드 보조 조인 | 빌드 시 조인 |
| 식약처 DUR 성분정보 API | 병용금기 대표 성분, `ORI` 실제 원료 관계, `MIX` 복합제 구성 조건 | 빌드 시 전체 카탈로그 스냅샷 |

HIRA 제품코드를 itemSeq로 사용하지 않는다. MFDS의 9자리 `ITEM_SEQ`가 canonical 품목 식별자이며, HIRA 제품코드는 MFDS `EDI_CODE`와 조인할 때만 사용한다. MFDS DUR 성분코드와 HIRA 주성분코드는 서로 다른 namespace이므로 직접 비교하지 않는다.

## 생성 무결성

- UTF-8은 fatal decode, CP949는 encode round-trip으로 무손실을 확인한다.
- API `totalCount`, 페이지 수, 페이지·행 중복, 중간 totalCount 변경을 검증한다.
- DUR 단건 응답의 source itemSeq가 요청 itemSeq와 다르면 빌드를 실패시킨다.
- MFDS `MATERIAL_NAME`은 `/` 뒤에 현재 `성분명,,용량`, 순번 포함 `성분명,순번,용량`, 또는 이전 `성분명,,,` 레코드가 올 때만 경계로 취급해 `단위/g` 같은 내부 slash를 보존한다. 일부 레코드만 파싱되면 제품을 `ingredientsComplete=false`로 저장한다.
- HIRA EDI 숫자 코드는 선행 0을 제거한 비교키로 조인하되 원문 코드는 보존한다.
- HIRA 성분코드는 정규화 성분명이 실제로 일치하거나 단일성분 품목일 때만 붙인다.
- DUR 품목·성분 규칙의 `NOTIFICATION_DATE`를 유효한 원천 고시일자로 보존하고, 불가능한 날짜는 빌드를 중단한다. `DEL_YN=Y` 행은 활성 규칙에서 제외하며 동일 활성 규칙은 최신 고시일자를 선택한다.
- DUR `ORI`의 `[M...]`·`[A...]` 원료명은 제품 `MATERIAL_NAME`과 대표 D성분 identity를 잇는 공식 관계로 사용한다. `MIX`의 `[D...]English(한글)` 항목만 복합제 구성 조건으로 해석한다. 한 실제 원료가 여러 대표 identity에 연결되면 `product_ingredient_dur_keys` 관계 테이블에 모두 저장하며 하나를 임의 선택하지 않는다.
- `ORI` exact 관계가 없더라도 수화물·히드레이트와 제한된 염 형태를 제거한 긴 유기성분명이 공식 identity와 정확히 일치하면 `CONSERVATIVE_FORM`으로 연결한다. 임의 substring, 입체이성질체, 에스터·유도체 유사성은 사용하지 않는다. 여러 identity로 갈리는 형식은 매핑하지 않고 해당 제품을 불완전으로 표시해 `UNCERTAIN`으로 닫는다.
- 공공데이터의 명백한 한글 표기 변형은 제품·ATC·영문 성분을 수동 대조한 고정 목록에 한해서만 `CURATED_SPELLING`으로 연결한다. 편집거리만으로 성분을 자동 동일시하지 않는다.
- 제품 성분과 DUR identity 관계에는 D-code와 `OFFICIAL_RELATION`·`CONSERVATIVE_FORM`·`CURATED_SPELLING`·`CATALOG_ABSENT`·`FALLBACK`·`AMBIGUOUS_FORM` provenance를 저장한다. 알려진 identity와 근접하지만 검증된 연결이 없는 `FALLBACK`은 제품을 불완전으로 표시한다.
- 현재 근접 표기 전수 감사 8개 중 니메수리드·이소니아짓·클리피도그렐·아미노카프로산·에데트산칼슘디나트륨·트라넥사민산은 검증된 공식 identity로 연결한다. 서로 다른 성분인 이소소르비드액·칼시포트리올은 매핑하지 않고 fail-closed한다.
- `MIX` 조건은 한글 identity와 공식 D-code를 함께 비교한다. 한 물리 성분 행이 공식 ORI에서 여러 DUR identity로 연결된 경우에도 필요한 identity/D-code를 모두 만족하면 복합 조건으로 인정한다.
- API 전체행은 활성·삭제·중복 규칙으로 합계가 일치해야 한다. 상세 금기내용이 없는 활성 병용금기는 누락시키지 않고 “상세 금기내용 미제공”임을 명시한다.
- 품목 DUR target itemSeq가 master에 있고 그 제품 성분이 완전 파싱됐다면 target 성분명 또는 코드가 실제 저장 성분과 일치해야 한다. 원료 원문이 없는 target은 exact itemSeq 스냅샷 매칭만 허용하고 별도 개수로 공개한다.
- seed와 alias는 같은 `generationId`여야 하며 SQLite는 고유 임시 파일에서 원자적으로 교체한다.

## 커버리지 경계

전체 제품 master는 이름 확인에 사용한다. e약은요는 공개 데이터가 있는 일부 품목만 설명을 제공한다. data model v3는 DUR 성분정보 API의 전체 병용금기 규칙을 저장하고, 대표 브랜드·심사 증거 품목은 품목 단위 DUR 스냅샷도 함께 보존한다. `/readyz`는 세 경계를 분리한다. `ingredientDur`는 전체 제품 중 성분 식별과 DUR 형식 매핑이 완전한 비율이며 80% 이상이어야 한다. `activeCatalogIdentityMapping`은 활성 제품 원료와 공식 `ORI` 관계에서 독립적으로 만든 기대 identity 분모가 실제 관계 테이블에 모두 저장됐는지 나타내며 100%여야 한다. 제한된 형식 정규화는 별도 건수와 고정 RED 회귀로 검증한다. `catalogIdentityMapping`은 전체 카탈로그 identity 중 현재 활성 제품 master에 나타나는 비율을 정보성으로 공개하며, 제품이 없는 과거 identity도 규칙 카탈로그에서 삭제하지 않는다. 특정 제품 성분이 금기 규칙에 등장하지 않는 것은 정상적인 “등록 규칙 없음”이며 커버리지 실패가 아니다. 성분 파싱이나 `MIX` 조건·형식 매핑이 불완전한 품목만 녹색이 아닌 `UNCERTAIN`으로 닫는다.
