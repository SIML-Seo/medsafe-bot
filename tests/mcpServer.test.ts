import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config/env.js";
import { createAppServices } from "../src/app.js";
import { buildMcpServer } from "../src/mcpServer.js";
import { ConfirmationTokenService } from "../src/services/confirmationToken.js";

test("MCP tools/list and tools/call expose read-only medication tools", async () => {
  const services = await createAppServices(loadConfig({ ...process.env, DATA_MODE: "fixture" }));
  const server = buildMcpServer(services);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["check_medication_safety", "explain_medication", "resolve_medications"]);
    assert.equal(names.length >= 3 && names.length <= 10, true);
    assert.ok(names.every((name) => /^[A-Za-z0-9_-]{1,128}$/.test(name)));
    assert.ok(names.every((name) => !name.toLowerCase().includes("kakao")));
    for (const tool of tools.tools) {
      assert.match(tool.description ?? "", /Medsafe Bot\(복약안전 봇\)/);
      assert.ok((tool.description ?? "").length <= 1024);
      assert.equal(tool.annotations?.title, tool.title);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
    }
    assert.ok(tools.tools.every((tool) => tool.outputSchema));

    const response = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: ["게보린"] }
    });
    assert.notEqual(response.isError, true);
    const content = response.content as Array<{ type: string; text?: string }>;
    assert.match(content[0]?.type === "text" ? content[0].text ?? "" : "", /게보린/);

    const explain = await client.callTool({
      name: "explain_medication",
      arguments: { itemSeq: "DEMO-TYLENOL-500" }
    });
    const explainContent = explain.content as Array<{ type: string; text?: string }>;
    assert.match(explainContent[0]?.text ?? "", /의사·약사의 진단·처방·복약지도를 대체하지 않습니다/);
    assert.equal((explain.structuredContent as { status: string }).status, "FOUND");
    assert.match((explain.structuredContent as { dataAsOf: string }).dataAsOf, /^\d{4}-\d{2}-\d{2}$/);

    const invalidExplain = await client.callTool({
      name: "explain_medication",
      arguments: { itemSeq: "1" }
    });
    assert.equal(invalidExplain.isError, true);

    const emergency = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: ["호흡곤란이 있어요"] }
    });
    const emergencyContent = emergency.content as Array<{ type: string; text?: string }>;
    assert.match(emergencyContent[0]?.text ?? "", /119/);
    assert.equal((emergency.structuredContent as { emergency: boolean }).emergency, true);

    const naturalEmergency = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: ["가슴이 너무 아파요"] }
    });
    assert.equal(
      (naturalEmergency.structuredContent as { emergency: boolean }).emergency,
      true
    );

    for (const query of [
      "타이레놀 한 통 먹었어요",
      "타이레놀 반 통 먹었어요",
      "타이레놀 다섯 통 먹었어요",
      "타이레놀 통째로 먹었어요",
      "타이레놀 여러 알 먹었어요",
      "타이레놀 몇 통 먹었어요",
      "타이레놀 두세 통 먹었어요",
      "타이레놀 한 팩을 다 먹었어요",
      "타이레놀 한 박스를 다 먹었어요",
      "타이레놀 한 통 먹으려고 해요",
      "타이레놀 한 통 먹을 거예요",
      "타이레놀 한 병 복용하려고 해요",
      "타이레놀 서너 통 삼키려고 해요",
      "타이레놀 여러 상자 먹을 예정이에요",
      "타이레놀 한 포 마시려고 해요",
      "타이레놀은 반 통 먹었어요",
      "타이레놀은 한 박스 다 먹었어요",
      "타이레놀 한 통 먹을래요",
      "타이레놀 한 통 먹을게요",
      "타이레놀 한 통 먹어버릴 거예요",
      "타이레놀 한 통 먹으려고 한 건 아니지만 실수로 반 통 먹었어요",
      "타이레놀도 반 통 먹었어요",
      "타이레놀만 한 박스 다 먹었어요",
      "타이레놀까지 두세 통 먹었어요",
      "타이레놀 한 통씩 먹었어요",
      "타이레놀을 무려 한 통 먹었어요",
      "타이레놀 한 통 먹겠어요",
      "타이레놀 한 통 먹을 생각이에요",
      "타이레놀 한 통 먹을 계획이에요",
      "타이레놀 한 통 먹어버릴래요",
      "타이레놀 한 통 삼켜버릴 거예요",
      "타이레놀 한 통을 방금 먹었어요",
      "타이레놀 한 통을 실수로 먹었어요",
      "타이레놀 한 통을 이미 먹었어요",
      "타이레놀 한 통을 한꺼번에 먹었어요",
      "타이레놀 한 통이나 먹었어요",
      "타이레놀 반 통 정도를 먹었어요",
      "타이레놀 한 통 넘게 먹었어요",
      "타이레놀 한 통을 거의 다 먹었어요",
      "타이레놀 한 통 복용해 버렸어요",
      "타이레놀 한 통 먹고 말았어요",
      "타이레놀 한 통 먹기로 했어요",
      "타이레놀 한 통 복용하기로 했어요",
      "타이레놀 한 통 먹을 작정이에요",
      "타이레놀, 한 통 먹었어요",
      "타이레놀: 한 통 먹었어요",
      "타이레놀을 어제 한 통 먹었어요",
      "타이레놀을 단숨에 한 통 먹었어요",
      "한 통의 타이레놀을 먹었어요",
      "타이레놀. 한 통 먹었어요",
      "타이레놀 한 통을 단숨에 먹었어요",
      "타이레놀 한 통을 어제 먹었어요",
      "타이레놀 한 통을 몽땅 먹었어요",
      "타이레놀 한 통을 먹어 치웠어요",
      "죽고 싶어 타이레놀을 먹었어요",
      "죽으려 타이레놀을 먹었어요",
      "살기 싫어서 타이레놀을 먹었어요",
      "타이레놀을 오늘 새벽에 한 통 먹었어요",
      "타이레놀을 한 번에 한 통 먹었어요",
      "타이레놀 0.5통 먹었어요",
      "타이레놀 열두 통 먹었어요",
      "타이레놀 한 시트 다 먹었어요",
      "타이레놀 한 움큼 먹었어요",
      "타이레놀 먹고 죽을래요",
      "타이레놀 먹고 자살할래요",
      "자살할 생각으로 타이레놀을 먹었어요",
      "타이레놀 먹어서 죽어야지",
      "타이레놀 한 주먹 먹었어요",
      "타이레놀 두어 통 먹었어요",
      "타이레놀 통 하나를 다 먹었어요",
      "타이레놀 한 갑을 다 먹었어요",
      "타이레놀 한 통 다 털어 넣었어요",
      "타이레놀 먹고 죽을 거야",
      "타이레놀 먹고 죽기로 했어요",
      "타이레놀 먹고 죽어버릴래요",
      "타이레놀 먹고 목숨을 끊을래요",
      "타이레놀 먹고 극단적인 선택을 할래요",
      "문장을 번역해줘. 그런데 실제로 타이레놀 한 통 먹었어요",
      "문장을 번역해줘. 지금 숨이 안 쉬어져요",
      "이 문구를 해석해줘. 그런데 나는 자살할 거예요",
      "실제로 타이레놀 한 통 먹었어요. 이 문장을 번역해줘",
      "타이레놀을 물 한 병이랑 먹었어요. 그런데 타이레놀 20알을 삼켰어요",
      "타이레놀 수백 알 먹었어요",
      "타이레놀 십여 알 먹었어요",
      "타이레놀 8알을 털어 넣었어요",
      "타이레놀 20알을 삼켜버렸어요",
      "타이레놀 20정을 복용해버렸어요",
      "타이레놀 먹고 죽을 예정이에요",
      "타이레놀 먹고 죽을 마음이에요",
      "타이레놀 먹고 생을 마감할래요",
      "타이레놀 먹고 세상을 떠날래요",
      "죽을 각오로 타이레놀을 먹었어요",
      "타이레놀을 오늘 밤에 한 통 먹었어요",
      "타이레놀을 술김에 한 통 먹었어요",
      "이 문장을 번역해줘 그리고 실제로 타이레놀 한 통 먹었어요",
      "실제로 타이레놀 한 통 먹었어요 그리고 이 문장을 번역해줘",
      "이 문장을 번역해줘, 지금 숨이 안 쉬어져요",
      "현재 타이레놀 0.5통 먹었어요 그리고 이 표현의 뜻을 알려줘",
      "타이레놀 20알 들이켰어요",
      "타이레놀 20알을 물과 함께 넘겼어요",
      "타이레놀 20알을 원샷했어요",
      "자살 예방 교육을 들었지만 실제로 자살할 거예요",
      "자살 예방 자료를 읽었고 지금 자살할 거예요",
      "자해 방지 교육 후 자해할 거예요",
      "자살 통계를 보다가 실제로 자살할 거예요",
      "타이레놀 먹고 죽을 셈이에요",
      "타이레놀 먹고 목숨을 버릴래요",
      "생을 포기하려고 타이레놀을 먹었어요",
      "이 문장을 번역해줘 그래서 지금 숨을 쉴 수가 없어요",
      "자살 예방 교육이 중요하다는 건 알지만 오늘 목숨을 버릴래요",
      "타이레놀은 밥 한 공기 먹고 복용 중이며 남은 건 한 통 마셨어요",
      "오늘로 생을 포기할 셈이에요",
      "타이레놀 한 통을 마셔 치웠어요",
      "타이레놀 한 통을 원샷했어요",
      "커피를 마셨어요 그리고 감기약 세 병을 원샷했어요",
      "타이레놀 한 통을 넘겼어요",
      "타이레놀 한 통을 들이부었어요",
      "타이레놀 20알 처방받고 물과 함께 넘겼어요",
      "타이레놀 한 병 보유 중이며 물과 함께 마셨어요"
    ]) {
      const brandEmergency = await client.callTool({
        name: "resolve_medications",
        arguments: { queries: [query] }
      });
      assert.equal(
        (brandEmergency.structuredContent as { emergency?: boolean }).emergency,
        true,
        query
      );
    }

    for (const query of [
      "타이레놀 한 통 먹고 있어요",
      "물 한 병을 다 먹었어요",
      "과자 한 봉지를 다 먹었어요",
      "타이레놀은 복용 중이고 물 한 병을 다 마셨어요",
      "죽고 싶어서 먹은 건 아니에요",
      "자해하려고 한 건 아니고 타이레놀을 먹었어요",
      "자살할 생각은 없어요",
      "타이레놀 먹고 죽을래요라고 말한 적 없어요",
      "타이레놀 먹고 죽을래요라는 문장을 번역해줘",
      "영화 대사에서 타이레놀 먹고 죽을래요라고 했어요",
      "타이레놀 먹고 죽을래요? 이 표현의 뜻을 알려줘",
      "타이레놀 한 알씩 먹어요",
      "타이레놀 하루 한 번씩 먹어요",
      "타이레놀을 물 한 병이랑 먹었어요",
      "타이레놀은 밥 한 공기 먹은 뒤 복용했어요",
      "자살하지 않을 거예요",
      "자해는 절대 안 해요",
      "삶을 끝내지 않을 거예요",
      "자살 예방 교육을 들었어요",
      "타이레놀 한 통 사려고 해요",
      "타이레놀 한 박스 보관하고 있어요",
      "타이레놀 한 통 먹으려고 한 건 아니에요",
      "타이레놀 한 통 먹을 예정은 없어요",
      "타이레놀 한 통 먹을 거라고 말한 적 없어요",
      "타이레놀 한 통 먹을 계획은 없어요",
      "타이레놀 한 통 먹겠다는 생각은 없어요",
      "타이레놀만 한 박스 사 왔어요",
      "타이레놀 8알을 처방받았고 밥을 먹었어요",
      "타이레놀 10알 남았는데 과자를 먹었어요",
      "타이레놀 8알 샀고 점심을 먹었어요",
      "타이레놀 12정은 잔량이며 식혜를 마셨어요",
      "타이레놀 한 상자 남았는데 라면을 먹었어요",
      "타이레놀 두 병 주문했고 사과를 먹었어요",
      "타이레놀 한 팩 구매 후 죽을 먹었어요",
      "타이레놀 세 통은 재고이고 콜라를 마셨어요",
      "타이레놀 두 상자 배송 중이고 주스를 마셨어요",
      "타이레놀 한 팩 주문했고 피자 먹었어요",
      "타이레놀 세 통 재고인데 햄버거 먹었어요",
      "번역해줘: “지금 숨을 못 쉬겠어요”",
      "해석할 문구는 ‘현재 가슴이 너무 아파요’입니다",
      "번역해줘: ‘오늘 자살할 거예요’",
      "자살 예방 교육에서 삶을 포기하지 말자고 배웠어요",
      "타이레놀 두 병 보유 중이고 결국 국수 먹었어요",
      "타이레놀 한 상자 구매했고 바다포도를 먹었어요",
      "목숨을 내놓으면 안 돼요",
      "타이레놀 한 통 먹으면 좋겠다는 광고를 봤어요",
      "타이레놀 한 통 먹어치울까 고민 중이에요",
      "타이레놀 반 통 복용할지 고민 중이에요",
      "타이레놀을 오늘 한 통 먹을지 고민 중이에요",
      "타이레놀 한 튜브를 다 먹었어요",
      "타이레놀 한 블리스터를 먹었어요",
      "타이레놀 한 알씩 먹어요. 그런데 실제로 한 통을 다 먹었어요",
      "타이레놀은 밥 한 공기 먹은 뒤 복용했고 방금 한 통을 먹었어요",
      "타이레놀을 물 한 병이랑 먹었고 그리고 한 통을 다 먹었어요",
      "타이레놀 두 바이알을 마셨어요",
      "타이레놀은 준비해 뒀어요. 그중 두 바이알을 마셨어요",
      "타이레놀 두 캐니스터를 꿀꺽했어요",
      "타이레놀 스무 포대를 흡입했어요",
      "이제는 깨어나지 않아도 좋겠어요",
      "그냥 영원히 사라지고 싶어요",
      "타이레놀 한 팩 주문했고 다 먹었어요",
      "타이레놀 세 통 재고인데 그걸 먹었어요",
      "타이레놀 두 병 남았는데 전부 마셨어요"
    ]) {
      const nonEmergency = await client.callTool({
        name: "resolve_medications",
        arguments: { queries: [query] }
      });
      assert.notEqual(
        (nonEmergency.structuredContent as { emergency?: boolean }).emergency,
        true,
        query
      );
    }

    for (const query of [
      "타이레놀 한 통 먹으면 좋겠다는 광고를 봤어요",
      "타이레놀 한 통 먹어치울까 고민 중이에요",
      "타이레놀 반 통 복용할지 고민 중이에요",
      "타이레놀을 오늘 한 통 먹을지 고민 중이에요",
      "타이레놀 한 튜브를 다 먹었어요",
      "타이레놀 한 블리스터를 먹었어요",
      "타이레놀 한 알씩 먹어요. 그런데 실제로 한 통을 다 먹었어요",
      "타이레놀은 밥 한 공기 먹은 뒤 복용했고 방금 한 통을 먹었어요",
      "타이레놀을 물 한 병이랑 먹었고 그리고 한 통을 다 먹었어요",
      "타이레놀 두 바이알을 마셨어요",
      "타이레놀은 준비해 뒀어요. 그중 두 바이알을 마셨어요",
      "타이레놀 두 캐니스터를 꿀꺽했어요",
      "타이레놀 스무 포대를 흡입했어요",
      "타이레놀 한 팩 주문했고 다 먹었어요",
      "타이레놀 세 통 재고인데 그걸 먹었어요"
    ]) {
      const potential = await client.callTool({
        name: "resolve_medications",
        arguments: { queries: [query] }
      });
      const structured = potential.structuredContent as {
        emergency?: boolean;
        triageStatus?: string;
        resolved?: Array<{
          status?: string;
          itemSeq?: string | null;
          confirmationToken?: string | null;
          candidates?: Array<{ itemSeq?: string | null; confirmationToken?: string | null }>;
        }>;
      };
      assert.notEqual(structured.emergency, true, query);
      assert.equal(structured.triageStatus, "UNCERTAIN", query);
      assert.equal(structured.resolved?.length, 1, query);
      assert.equal(structured.resolved?.[0]?.status, "AMBIGUOUS", query);
      assert.equal(structured.resolved?.[0]?.confirmationToken ?? null, null, query);
      assert.ok((structured.resolved?.[0]?.candidates?.length ?? 0) > 1, query);
      assert.equal(
        structured.resolved?.[0]?.candidates?.some((candidate) => candidate.confirmationToken),
        false,
        query
      );
    }

    for (const query of ["이제는 깨어나지 않아도 좋겠어요", "그냥 영원히 사라지고 싶어요"]) {
      const potential = await client.callTool({
        name: "resolve_medications",
        arguments: { queries: [query] }
      });
      const structured = potential.structuredContent as {
        emergency?: boolean;
        triageStatus?: string;
        resolved?: unknown[];
      };
      assert.notEqual(structured.emergency, true, query);
      assert.equal(structured.triageStatus, "UNCERTAIN", query);
      assert.deepEqual(structured.resolved, [], query);
    }

    const independentQueryEmergency = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: ["이 문장을 번역해줘", "지금 숨이 안 쉬어져요"] }
    });
    assert.equal(
      (independentQueryEmergency.structuredContent as { emergency?: boolean }).emergency,
      true
    );

    const negatedEmergency = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: ["호흡곤란이 전혀 없습니다", "게보린"] }
    });
    const negatedContent = negatedEmergency.structuredContent as {
      emergency?: boolean;
      resolved: Array<{ query: string; status: string }>;
    };
    assert.notEqual(negatedContent.emergency, true);
    assert.equal(
      negatedContent.resolved.find((item) => item.query === "게보린")?.status,
      "CONFIRMED"
    );

    const longNameResolve = await client.callTool({
      name: "resolve_medications",
      arguments: {
        queries: [
          "로수맥콤비젤연질캡슐10/1000밀리그램(로수바스타틴,오메가3산에틸에스테르90)"
        ]
      }
    });
    const longName = (
      longNameResolve.structuredContent as {
        resolved: Array<{
          status: string;
          itemSeq: string | null;
          ingrCode: string | null;
          matchedName: string | null;
          confirmationToken: string | null;
        }>;
      }
    ).resolved[0]!;
    assert.equal(longName.status, "CONFIRMED");
    const longNameCheck = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [
          {
            itemSeq: longName.itemSeq,
            ingrCode: longName.ingrCode,
            status: longName.status,
            displayName: longName.matchedName,
            confirmationToken: longName.confirmationToken
          }
        ],
        context: { ageGroup: "adult", pregnancy: "no" }
      }
    });
    assert.notEqual(longNameCheck.isError, true);

    const veryLongProductName =
      "매우긴정식품목명검증정100밀리그램(첫번째성분명,두번째성분명,세번째성분명,네번째성분명,다섯번째성분명,여섯번째성분명,일곱번째성분명,여덟번째성분명,아홉번째성분명,열번째성분명)";
    assert.ok(veryLongProductName.length > 80);
    const veryLongResolve = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: [veryLongProductName] }
    });
    const veryLongResolved = (
      veryLongResolve.structuredContent as {
        resolved: Array<{
          status: string;
          itemSeq: string | null;
          ingrCode: string | null;
          matchedName: string | null;
          confirmationToken: string | null;
        }>;
      }
    ).resolved[0]!;
    assert.equal(veryLongResolved.status, "CONFIRMED");
    const veryLongCheck = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [
          {
            itemSeq: veryLongResolved.itemSeq,
            ingrCode: veryLongResolved.ingrCode,
            status: veryLongResolved.status,
            displayName: veryLongResolved.matchedName,
            confirmationToken: veryLongResolved.confirmationToken
          }
        ],
        context: { ageGroup: "adult", pregnancy: "no" }
      }
    });
    assert.notEqual(veryLongCheck.isError, true);

    const forged = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [
          {
            itemSeq: "DEMO-WARFARIN",
            ingrCode: "INGR-WARFARIN",
            status: "CONFIRMED",
            displayName: "데모와파린정"
          },
          {
            itemSeq: "DEMO-ASPIRIN",
            ingrCode: "INGR-ASPIRIN",
            status: "CONFIRMED",
            displayName: "데모아스피린장용정"
          }
        ],
        context: { ageGroup: "adult", pregnancy: "no" }
      }
    });
    const forgedStructured = forged.structuredContent as {
      verdict: string;
      findings: Array<{ type: string }>;
      unresolved: string[];
    };
    assert.equal(forgedStructured.verdict, "UNCERTAIN");
    assert.notEqual(forged.isError, true);
    assert.equal(forgedStructured.findings.some((finding) => finding.type === "USJNT_TABOO"), false);
    assert.ok(forgedStructured.unresolved.every((item) => item.includes("확인 토큰")));

    const cautionResolve = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: ["타이레놀", "게보린"] }
    });
    const cautionStructured = cautionResolve.structuredContent as {
      resolved: Array<{
        status: string;
        itemSeq: string | null;
        ingrCode: string | null;
        matchedName: string | null;
        confirmationToken: string | null;
        candidates: Array<{
          itemSeq: string | null;
          ingrCode: string | null;
          matchedName: string;
          confirmationToken: string | null;
        }>;
      }>;
    };
    const tylenol500 = cautionStructured.resolved[0]?.candidates.find(
      (candidate) => candidate.itemSeq === "DEMO-TYLENOL-500"
    );
    assert.equal(tylenol500?.confirmationToken, null);
    const confirmedTylenolResponse = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: [tylenol500?.matchedName ?? "타이레놀정500밀리그람"] }
    });
    const confirmedTylenol = (
      confirmedTylenolResponse.structuredContent as typeof cautionStructured
    ).resolved[0];
    assert.equal(confirmedTylenol?.status, "CONFIRMED");
    const gevOrin = cautionStructured.resolved[1];
    const caution = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [
          {
            itemSeq: confirmedTylenol?.itemSeq,
            ingrCode: confirmedTylenol?.ingrCode,
            status: "CONFIRMED",
            displayName: confirmedTylenol?.matchedName,
            confirmationToken: confirmedTylenol?.confirmationToken
          },
          {
            itemSeq: gevOrin?.itemSeq,
            ingrCode: gevOrin?.ingrCode,
            status: gevOrin?.status,
            displayName: gevOrin?.matchedName,
            confirmationToken: gevOrin?.confirmationToken
          }
        ],
        context: { ageGroup: "adult", pregnancy: "no" }
      }
    });
    assert.notEqual(caution.isError, true);
    const cautionResult = caution.structuredContent as {
      findings: Array<{ type: string }>;
    };
    assert.ok(cautionResult.findings.some((finding) => finding.type === "DUP_INGREDIENT"));

    const resolvedRisk = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: ["와파린", "아스피린"] }
    });
    const resolvedStructured = resolvedRisk.structuredContent as {
      resolved: Array<{
        status: string;
        itemSeq: string | null;
        ingrCode: string | null;
        matchedName: string | null;
        confirmationToken: string | null;
      }>;
    };
    assert.ok(resolvedStructured.resolved.every((item) => item.confirmationToken));
    const checked = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: resolvedStructured.resolved.map((item) => ({
          itemSeq: item.itemSeq,
          ingrCode: item.ingrCode,
          status: item.status,
          displayName: item.matchedName,
          confirmationToken: item.confirmationToken
        })),
        context: { ageGroup: "adult", pregnancy: "no" }
      }
    });
    const checkedStructured = checked.structuredContent as { verdict: string };
    assert.equal(checkedStructured.verdict, "WARN");
    assert.notEqual(checked.isError, true);

    const emptyIngredientToken = services.confirmationTokens.sign({
      itemSeq: "DEMO-NO-INGREDIENT",
      ingrCode: null,
      status: "CONFIRMED"
    });
    const emptyIngredientCheck = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [
          {
            itemSeq: "DEMO-NO-INGREDIENT",
            ingrCode: "",
            status: "CONFIRMED",
            displayName: "성분코드없는데모정",
            confirmationToken: emptyIngredientToken
          },
          {
            itemSeq: "DEMO-BRUFEN",
            ingrCode: "INGR-IBUPROFEN",
            status: "CONFIRMED",
            displayName: "부루펜정200밀리그람",
            confirmationToken: services.confirmationTokens.sign({
              itemSeq: "DEMO-BRUFEN",
              ingrCode: "INGR-IBUPROFEN",
              status: "CONFIRMED"
            })
          }
        ],
        context: { ageGroup: "adult", pregnancy: "no" }
      }
    });
    const emptyIngredientStructured = emptyIngredientCheck.structuredContent as {
      verdict: string;
      failedTypes: string[];
    };
    assert.notEqual(emptyIngredientCheck.isError, true);
    assert.equal(emptyIngredientStructured.verdict, "UNCERTAIN");
    assert.ok(emptyIngredientStructured.failedTypes.includes("DUP_INGREDIENT"));
  } finally {
    await client.close();
    await server.close();
    services.repository.close();
  }
});

test("confirmation tokens are nonce-bound and expire", () => {
  let now = 1_000_000;
  const tokens = new ConfirmationTokenService("test-secret", 1_000, () => now);
  const payload = { itemSeq: "DEMO-TYLENOL-500", ingrCode: "INGR-APAP", status: "CONFIRMED" };
  const first = tokens.sign(payload);
  const second = tokens.sign(payload);

  assert.notEqual(first, second);
  assert.equal(tokens.verify(first, payload), true);
  now += 1_001;
  assert.equal(tokens.verify(first, payload), false);
});
