# 데이터 흐름과 매핑 파이프라인

## 데이터 소스

| 용도 | 소스 | 현재 상태 | 코드 격리 위치 |
|---|---|---|---|
| 병용금기/주의 판정 | 식약처 DUR 품목정보 15059486 | 공식 페이지 확인, Swagger 세부 미확정 | `src/config/schemaMap.ts` |
| 사용자 설명 | e약은요 15075057 | 공식 페이지 확인, 필드 일부 미확정 | `src/config/schemaMap.ts` |
| 제품명/성분/ATC 매핑 | 심평원 ATC 매핑목록 15118958 | 공식 페이지 확인, 실데이터 조인키 미확정 | `scripts/build-master-db.ts`, `src/repositories/masterRepository.ts` |

## 조인키 검증 상태

`제품코드(9자리) = 품목기준코드(itemSeq)` 여부는 아직 실데이터로 확정하지 못했다. 구현은 다음 플래그로 분리한다.

- `MASTER_JOIN_MODE=productCodeEqualsItemSeq`: 제품코드를 itemSeq로 취급
- `MASTER_JOIN_MODE=explicitItemSeq`: CSV 또는 변환 테이블에 별도 itemSeq 컬럼이 있을 때 사용

데모 seed는 `itemSeq`를 명시하므로 `explicitItemSeq` 경로로 동작한다.

## 매핑 단계

1. 입력 정규화: 공백, 괄호, 규격, 제형어를 분리하고 검색용 core token을 만든다.
2. alias 우선 매칭: 구어/축약을 별도 테이블에서 조회한다.
3. 성분명 매칭: 성분 alias와 제품 ingredient name을 비교한다.
4. 제품명 fuzzy 검색: 토큰셋 비율, 초성 보너스, 한글 자모 편집거리.
5. 신뢰도 판정:
   - 정규화 완전일치 또는 alias 단일 target: `CONFIRMED`
   - 점수 0.90 이상 단일 후보: `CONFIRMED`
   - 점수 0.75 이상 또는 후보 복수: `AMBIGUOUS`
   - 그 외: `NOT_FOUND`

## 병용금기 알고리즘

API에 약쌍을 직접 던진다고 가정하지 않는다.

1. 확인된 각 `itemSeq`별 DUR 병용금기 operation 호출
2. 전 페이지 수집
3. 응답의 상대 itemSeq/성분코드를 `FIELD_MAP`으로 정규화
4. 사용자 복약목록과 교집합
5. 조회 실패, 페이지 실패, 필드 미해결은 fail-closed

## 중복성분/효능군

- 주성분코드는 전체값 동일성으로만 비교한다.
- 주성분코드 substring 슬라이싱은 구현하지 않는다.
- ATC 효능군 중복은 MVP에서 best-effort로만 둔다. 데모는 같은 ATC prefix가 있으면 노란색 finding을 만들 수 있게 구조만 준비한다.

## 데모 데이터 주의

`data/master.seed.json`은 개발/테스트용 fixture이다. 실제 제출 전에는 15118958 파일과 조인키 검증 결과로 `data/master.sqlite`를 재생성해야 한다.
