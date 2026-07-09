# 재확인 목록

| 항목 | 상태 | 근거/사유 | 격리 위치 |
|---|---|---|---|
| DUR 8종 operation명/버전/필드 | 미해결 | 공식 페이지는 제공 기능을 확인했지만 Swagger 세부는 serviceKey/활용신청 환경에서 재확인 필요 | `src/config/schemaMap.ts` |
| DUR 성분정보 15056780 서비스 세그먼트 | 미해결 | 본 MVP 핵심 2종에는 직접 사용하지 않음 | `src/config/schemaMap.ts` |
| ATC매핑목록 제품코드=itemSeq 여부 | 미해결 | 실데이터 조인 전 확정 불가 | `MASTER_JOIN_MODE`, `scripts/build-master-db.ts` |
| 주성분코드 자릿수 배분 | 부분 확인 | 공식 페이지는 구성요소를 설명하지만 slicing 폭은 코드화하지 않음 | substring 미구현 |
| 라이선스/트래픽 | 부분 확인 | 공공데이터 페이지의 무료/이용허락 정보는 확인 가능하나 dataset별 운영한도는 활용신청 후 확인 필요 | README 운영 체크리스트 |
| e약은요 커버리지 | 부분 확인 | 공식 페이지는 일반의약품 중 공급실적 있는 제품 중심이라고 설명 | `explain_medication` 정보 없음 경로 |
| PlayMCP 일정/심사 | 확인됨 | 카카오 공식 페이지 기준 예선 2026-07-14, 심사 최대 영업일 7일 | `design/00-overview.md`, README |
| PlayMCP Widget 세부 | 미해결 | 공식 페이지는 본선 Kakao Tools/Widget 추가 스펙을 언급하지만 JSON 스펙은 별도 제공 대상 | `structuredContent` 렌더 중립 설계 |
| MCP Streamable HTTP | 확인됨 | 공식 MCP transport 스펙과 TypeScript SDK 문서 확인 | `src/server.ts` |
| 의료기기/개인정보 규제 | 미해결 | 최신 원문 검토 필요 | `design/03-safety-policy.md` |

## 공식 URL

- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP transport spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- MCP tools spec: https://modelcontextprotocol.io/specification/draft/server/tools
- DUR 품목정보 15059486: https://www.data.go.kr/data/15059486/openapi.do
- e약은요 15075057: https://www.data.go.kr/data/15075057/openapi.do
- ATC 매핑목록 15118958: https://www.data.go.kr/data/15118958/fileData.do
- 주성분코드 자료 15067461: https://www.data.go.kr/data/15067461/fileData.do
- AGENTIC PLAYER 10: https://b.kakao.com/views/PlayMCP/AGENTIC_PlAYER_10
