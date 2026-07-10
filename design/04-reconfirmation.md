# 재확인 목록

| 항목 | 현재 상태 | 자동 검증 |
|---|---|---|
| Streamable HTTP stateless 호환 | 확인 | MCP SDK, Inspector, conformance |
| tools annotations 5개 필드 | 확인 | tools/list 원격 검증 |
| MFDS itemSeq와 HIRA EDI 분리 | 확인 | live 생성기·회귀 테스트 |
| 복합성분 파싱 완전성과 EDI 코드 조인 | 확인 | 전용 material parser·선행 0 테스트 |
| DUR 페이지 완전성 | 확인 | totalCount·중복 page/row·itemSeq 검증 |
| 실제 국내 RED 쌍 | 확인 | source+target local self-test |
| e약은요 exact itemSeq | 확인 | local repository·remote flow |
| 전체 DUR 성분 규칙 카탈로그 | 로컬 v3 확인·KC 재배포 필요 | `/readyz.coverage`, strict-live, remote flow |
| 연령·임부 DUR | 미구현 | CAUTION 범위 보류 |
| PlayMCP Widget host 연동 | 콘솔 확인 필요 | 실제 structuredContent renderer와 mapping 문서 |
| KC 최신 배포 | 재배포 후 확인 | build ID·DB SHA 일치 원격 증거 |

`confirmationToken`은 stateless read-only 서버에서 만료 전 재사용 가능하다. canonical 매핑 변조 방지용이며 일회성 사용자 동의 증명으로 표현하지 않는다.

공식 URL은 `src/config/schemaMap.ts`가 단일 기준이다. 시간에 따라 변하는 공모전 일정은 구현 계약에 넣지 않는다.
