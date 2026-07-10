import test from "node:test";
import assert from "node:assert/strict";
import {
  durIngredientAliasMappingsForSide,
  durIngredientContraindicationFromRow,
  hasPotentialDurIdentityVariant,
  parseDurIngredientReferences,
  resolveDurIngredientMaterialKeys,
  normalizedDurDate
} from "../src/utils/durIngredient.js";
import { canonicalIngredientIdentity, canonicalProductCode } from "../src/utils/text.js";

test("official DUR references prefer the Korean ingredient name", () => {
  assert.deepEqual(
    parseDurIngredientReferences(
      "[D000561]Elvitegravir(엘비테그라비르)/[D000665]Emtricitabine(엠트리시타빈)"
    ),
    [
      { code: "D000561", name: "엘비테그라비르", key: "엘비테그라비르" },
      { code: "D000665", name: "엠트리시타빈", key: "엠트리시타빈" }
    ]
  );
});

test("single-ingredient ORI materials map to the official catalog key", () => {
  const mappings = new Map(
    durIngredientAliasMappingsForSide(
      "로수바스타틴",
      "",
      "[M095744]로수바스타틴칼슘/[M258559]로수바스타틴칼슘염/[M270546]로수바스타틴칼슘(미분화)"
    ).map((mapping) => [mapping.aliasKey, mapping.catalogKey])
  );
  assert.equal(mappings.get("로수바스타틴칼슘"), "로수바스타틴");
  assert.equal(mappings.get("로수바스타틴칼슘염"), "로수바스타틴");
});

test("compound ORI materials map to their matching primary or MIX ingredient", () => {
  const mappings = new Map(
    durIngredientAliasMappingsForSide(
      "코비시스타트",
      "[D000561]Elvitegravir(엘비테그라비르)/[D000665]Emtricitabine(엠트리시타빈)/[D000281]Tenofovir(테노포비르)",
      "[M256270]코비시스타트이산화규소/[A005561]엘비테그라비르/[M250026]엠트리시타빈/[A001163]테노포비르"
    ).map((mapping) => [mapping.aliasKey, mapping.catalogKey])
  );
  assert.equal(mappings.get("코비시스타트이산화규소"), "코비시스타트");
  assert.equal(mappings.get("엘비테그라비르"), "엘비테그라비르");
  assert.equal(mappings.get("엠트리시타빈"), "엠트리시타빈");
  assert.equal(mappings.get("테노포비르"), "테노포비르");
});

test("conservative salt and hydrate forms resolve only to an exact DUR identity", () => {
  const aliases = new Map<string, Set<string>>([
    ["판토프라졸", new Set(["판토프라졸"])],
    ["클린다마이신", new Set(["클린다마이신"])],
    ["덱사메타손", new Set(["덱사메타손"])],
    ["살메테롤", new Set(["살메테롤"])],
    ["투카티닙", new Set(["투카티닙"])],
    ["카보잔티닙", new Set(["카보잔티닙"])],
    ["코비시스타트이산화규소", new Set(["코비시스타트"])],
    ["플루티카손프로피오네이트", new Set(["플루티카손"])]
  ]);
  const catalog = new Set([
    "판토프라졸",
    "클린다마이신",
    "덱사메타손",
    "살메테롤",
    "투카티닙",
    "카보잔티닙",
    "코비시스타트",
    "플루티카손"
  ]);
  assert.deepEqual(
    resolveDurIngredientMaterialKeys(
      "판토프라졸나트륨세스키히드레이트",
      aliases,
      catalog
    ),
    { keys: ["판토프라졸"], basis: "CONSERVATIVE_FORM" }
  );
  assert.deepEqual(
    resolveDurIngredientMaterialKeys("클린다마이신포스페이트", aliases, catalog),
    { keys: ["클린다마이신"], basis: "CONSERVATIVE_FORM" }
  );
  assert.deepEqual(
    resolveDurIngredientMaterialKeys("덱사메타손포스페이트나트륨", aliases, catalog),
    { keys: ["덱사메타손"], basis: "CONSERVATIVE_FORM" }
  );
  for (const [material, expected] of [
    ["살메테롤지나포산염", "살메테롤"],
    ["투카티닙헤미에탄올레이트", "투카티닙"],
    ["카보잔티닙(S)-말산염", "카보잔티닙"],
    ["이산화규소흡착코비시스타트", "코비시스타트"],
    ["플루티카손프로피오네이드", "플루티카손"]
  ] as const) {
    assert.deepEqual(resolveDurIngredientMaterialKeys(material, aliases, catalog), {
      keys: [expected],
      basis: "CONSERVATIVE_FORM"
    });
  }
});

test("official compound ORI matching tolerates a unique Korean spelling variant", () => {
  const mappings = new Map(
    durIngredientAliasMappingsForSide(
      "리팜피신",
      "[D001151]ethambutol(에탐뷰톨)",
      "[M020042]리팜피신/[M223143]에탐부톨염산염"
    ).map((mapping) => [mapping.aliasKey, mapping.catalogKey])
  );
  assert.equal(mappings.get("에탐부톨"), "에탐뷰톨");
});

test("conservative DUR form mapping rejects unsafe substring similarities", () => {
  const aliases = new Map<string, Set<string>>([
    ["페니라민", new Set(["페니라민"])],
    ["수산화마그네슘", new Set(["수산화마그네슘"])],
    ["시트르산", new Set(["시트르산"])],
    ["부데소니드", new Set(["부데소니드"])]
  ]);
  const catalog = new Set(["페니라민", "수산화마그네슘", "시트르산", "부데소니드"]);
  for (const ingredient of [
    "클로르페니라민말레산염",
    "산화마그네슘",
    "시트르산칼슘",
    "다파글리플로진시트르산",
    "데소니드"
  ]) {
    const result = resolveDurIngredientMaterialKeys(ingredient, aliases, catalog);
    assert.equal(result.basis, "FALLBACK", ingredient);
  }
});

test("curated Korean spelling variants map to one official DUR identity", () => {
  const pairs = [
    ["니메수리드", "니메술리드"],
    ["이소니아짓", "이소니아지드"],
    ["클리피도그렐", "클로피도그렐"],
    ["아미노카프로산", "아미노카프론산"],
    ["에데트산칼슘디나트륨", "에데트산칼슘나트륨"],
    ["트라넥사민산", "트라넥삼산"],
    ["자일로메타졸린", "키실로메타졸린"]
  ] as const;
  const aliases = new Map<string, Set<string>>(
    pairs.map(([, catalogKey]) => [catalogKey, new Set([catalogKey])])
  );
  const catalog = new Set(pairs.map(([, catalogKey]) => catalogKey));

  for (const [alias, catalogKey] of pairs) {
    assert.deepEqual(resolveDurIngredientMaterialKeys(alias, aliases, catalog), {
      keys: [catalogKey],
      basis: "CURATED_SPELLING"
    });
  }
});

test("unmapped near-spelling DUR identities are treated as potentially risky", () => {
  const known = new Set(["니메술리드", "이소니아지드", "부데소니드"]);
  assert.equal(hasPotentialDurIdentityVariant("니메소리드", known), true);
  assert.equal(hasPotentialDurIdentityVariant("이소니아지트", known), true);
  assert.equal(
    hasPotentialDurIdentityVariant("자일로메타졸린", new Set(["키실로메타졸린"])),
    true
  );
  assert.equal(hasPotentialDurIdentityVariant("아세트아미노펜", known), false);
});

test("DUR ingredient row maps official fields and canonical formulation names", () => {
  const result = durIngredientContraindicationFromRow(
    {
      TYPE_NAME: "병용금기",
      DEL_YN: "N",
      INGR_CODE: "D000001",
      INGR_KOR_NAME: "아세트아미노펜 제피세립",
      MIXTURE_INGR_CODE: "D000002",
      MIXTURE_INGR_KOR_NAME: "아스피린장용펠렛",
      MIX_TYPE: "복합",
      MIX: "카페인무수물",
      ORI: "아세트아미노펜",
      MIXTURE_MIX_TYPE: "단일",
      MIXTURE_MIX: "",
      MIXTURE_ORI: "아스피린",
      NOTIFICATION_DATE: "20260710",
      PROHBT_CONTENT: "fixture contraindication reason"
    },
    "2026-07-11T00:00:00.000Z",
    "https://example.test/dur-ingredient"
  );

  assert.equal(result?.sourceIngredientKey, "아세트아미노펜");
  assert.equal(result?.targetIngredientKey, "아스피린");
  assert.equal(result?.baseDate, "2026-07-10");
  assert.equal(result?.dateBasis, "SOURCE_DATE");
  assert.equal(result?.sourceMixType, "복합");
  assert.equal(result?.sourceMixture, "카페인무수물");
  assert.equal(result?.sourceRelation, "아세트아미노펜");
  assert.equal(result?.targetMixType, "단일");
  assert.equal(result?.targetRelation, "아스피린");
});

test("DUR ingredient row rejects unresolved required fields", () => {
  assert.equal(
    durIngredientContraindicationFromRow(
      { INGR_CODE: "D000001", INGR_KOR_NAME: "아세트아미노펜" },
      "2026-07-11T00:00:00.000Z",
      "https://example.test/dur-ingredient"
    ),
    null
  );
});

test("DUR ingredient row ignores deleted rules and rejects invalid declared dates", () => {
  const base = {
    TYPE_NAME: "병용금기",
    INGR_CODE: "D000001",
    INGR_KOR_NAME: "아세트아미노펜",
    MIXTURE_INGR_CODE: "D000002",
    MIXTURE_INGR_KOR_NAME: "아스피린",
    PROHBT_CONTENT: "fixture contraindication reason"
  };
  assert.equal(
    durIngredientContraindicationFromRow(
      { ...base, DEL_YN: "Y", NOTIFICATION_DATE: "20260710" },
      "2026-07-11T00:00:00.000Z",
      "https://example.test/dur-ingredient"
    ),
    null
  );
  assert.equal(
    durIngredientContraindicationFromRow(
      { ...base, DEL_YN: "UNKNOWN", NOTIFICATION_DATE: "20260710" },
      "2026-07-11T00:00:00.000Z",
      "https://example.test/dur-ingredient"
    ),
    null
  );
  assert.equal(
    durIngredientContraindicationFromRow(
      { ...base, TYPE_NAME: "새로운유형", DEL_YN: "N", NOTIFICATION_DATE: "20260710" },
      "2026-07-11T00:00:00.000Z",
      "https://example.test/dur-ingredient"
    ),
    null
  );
  assert.equal(
    durIngredientContraindicationFromRow(
      { ...base, DEL_YN: "삭제", NOTIFICATION_DATE: "20260710" },
      "2026-07-11T00:00:00.000Z",
      "https://example.test/dur-ingredient"
    ),
    null
  );
  assert.equal(
    durIngredientContraindicationFromRow(
      { ...base, DEL_YN: "N", NOTIFICATION_DATE: "20260229" },
      "2026-07-11T00:00:00.000Z",
      "https://example.test/dur-ingredient"
    ),
    null
  );
});

test("active contraindications without detail retain a transparent generic reason", () => {
  const result = durIngredientContraindicationFromRow(
    {
      TYPE_NAME: "병용금기",
      INGR_CODE: "D000001",
      INGR_KOR_NAME: "아세트아미노펜",
      MIXTURE_INGR_CODE: "D000002",
      MIXTURE_INGR_KOR_NAME: "아스피린",
      NOTIFICATION_DATE: "20260710",
      PROHBT_CONTENT: null,
      REMARK: null,
      DEL_YN: "정상"
    },
    "2026-07-11T00:00:00.000Z",
    "https://example.test/dur-ingredient"
  );

  assert.match(result?.reason ?? "", /상세 금기내용 미제공/);
  assert.equal(result?.dateBasis, "SOURCE_DATE");
});

test("DUR dates reject impossible calendar values", () => {
  assert.equal(normalizedDurDate("20260228"), "2026-02-28");
  assert.equal(normalizedDurDate("2026-02-29"), null);
  assert.equal(normalizedDurDate("20261340"), null);
  assert.equal(normalizedDurDate("2026-13-40"), null);
});

test("ingredient and EDI identities normalize safe representational variants", () => {
  assert.equal(
    canonicalIngredientIdentity("아토르바스타틴칼슘삼수화물"),
    canonicalIngredientIdentity("아토르바스타틴칼슘수화물")
  );
  assert.equal(canonicalIngredientIdentity("에제티미브(미분화)"), "에제티미브");
  assert.equal(
    canonicalIngredientIdentity("클로르페니라민말레산염"),
    canonicalIngredientIdentity("클로르페니라민")
  );
  assert.equal(
    canonicalIngredientIdentity("와르파린나트륨"),
    canonicalIngredientIdentity("와파린나트륨")
  );
  assert.notEqual(
    canonicalIngredientIdentity("인산칼슘"),
    canonicalIngredientIdentity("인산나트륨")
  );
  assert.equal(canonicalProductCode("073400340"), canonicalProductCode("73400340"));
});
