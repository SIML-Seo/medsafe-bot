# 데모와 등록 가이드

## 로컬 데모

```bash
npm install
npm run build:master
DATA_MODE=fixture npm run dev
```

MCP endpoint:

```text
http://127.0.0.1:3000/mcp
```

## 데모 대화

사용자:

```text
엄마가 타이레놀하고 게보린 같이 먹어도 되는지 봐줘
```

오케스트레이션:

1. `resolve_medications({ "queries": ["타이레놀", "게보린"] })`
2. 후보가 단일이면 사용자에게 제품명을 되보여 확인
3. `check_medication_safety({ medications, context: { subjectIsUser: false, ageGroup: "unknown", pregnancy: "unknown" } })`

예상 결과:

- 중복성분 노란색 finding
- 등록된 병용금기는 fixture 기준 미조회 문구
- 스코프 한계와 디스클레이머
- "안전합니다" 미출현

## PlayMCP 등록 순서

1. 카카오클라우드 또는 허용된 배포 환경에 HTTPS로 배포
2. `MFDS_SERVICE_KEY`와 `DATA_MODE=live` 설정
3. `npm run build:master`를 실제 ATC 매핑 파일로 실행
4. PlayMCP 개발자 콘솔에서 MCP 서버 endpoint 등록
5. 임시 등록으로 tool list/call 테스트
6. 최종 제출용은 등록 및 심사 요청
7. 심사 통과 후 공개 상태를 전체 공개로 변경
8. AGENTIC PLAYER 예선 참여 버튼으로 제출

## 제출 전 필수 확인

- 2026-07-07까지 심사 요청하는 것이 가장 안전하다. 공식 페이지는 2026-07-07(화)까지 요청 건은 2026-07-10(금)까지 심사 완료 예정, 이후 요청은 응모기한 내 심사 완료가 어려울 수 있다고 안내한다.
- serviceKey self-test 정상
- 실 DUR 병용금기 회귀쌍 최소 1건
- 실제 ATC 매핑 파일로 조인키 검증 노트 갱신
- 개인정보처리방침/데이터 미저장 설명 준비
