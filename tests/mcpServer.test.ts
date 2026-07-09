import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config/env.js";
import { createAppServices } from "../src/app.js";
import { buildMcpServer } from "../src/mcpServer.js";

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
    const expectedOpenWorld = new Map([
      ["resolve_medications", false],
      ["check_medication_safety", true],
      ["explain_medication", true]
    ]);
    for (const tool of tools.tools) {
      assert.match(tool.description ?? "", /Medsafe Bot\(복약안전 봇\)/);
      assert.ok((tool.description ?? "").length <= 1024);
      assert.equal(tool.annotations?.title, tool.title);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, expectedOpenWorld.get(tool.name));
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

    const emergency = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: ["호흡곤란이 있어요"] }
    });
    const emergencyContent = emergency.content as Array<{ type: string; text?: string }>;
    assert.match(emergencyContent[0]?.text ?? "", /119/);

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
    const gevOrin = cautionStructured.resolved[1];
    const caution = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [
          {
            itemSeq: tylenol500?.itemSeq,
            ingrCode: tylenol500?.ingrCode,
            status: "CONFIRMED",
            displayName: tylenol500?.matchedName,
            confirmationToken: tylenol500?.confirmationToken
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
