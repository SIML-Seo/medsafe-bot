import test from "node:test";
import assert from "node:assert/strict";
import type { MasterRepository } from "../src/repositories/masterRepository.js";
import type {
  DurIngredientContraindication,
  MasterProduct,
  ProductIngredient
} from "../src/types.js";
import { selectReleaseProbeProducts } from "../src/utils/releaseProbes.js";

test("release probes select an ingredient-only RED pair without item snapshots", () => {
  const products: MasterProduct[] = [
    product("900000001", "카탈로그원천정"),
    product("900000002", "카탈로그대상정"),
    product("900000003", "성분누락정")
  ];
  const ingredients: ProductIngredient[] = [
    ingredient("900000001", "원천성분"),
    ingredient("900000002", "대상성분")
  ];
  const rule: DurIngredientContraindication = {
    sourceIngredientCode: null,
    sourceIngredientName: "원천성분",
    sourceIngredientKey: "원천성분",
    targetIngredientCode: null,
    targetIngredientName: "대상성분",
    targetIngredientKey: "대상성분",
    sourceMixType: "단일",
    targetMixType: "단일",
    reason: "fixture ingredient-only contraindication",
    baseDate: "2026-07-01",
    dateBasis: "FIXTURE_DATE",
    source: "fixture"
  };
  const repository = {
    allProducts: () => products,
    allProductIngredients: () => ingredients,
    getKnownDurIngredientKeys: (keys: string[]) =>
      new Set(keys.filter((key) => key === "원천성분" || key === "대상성분")),
    getDurSnapshot: () => null,
    getDurIngredientContraindications: (keys: string[]) =>
      keys.includes("원천성분") ? [rule] : []
  } as unknown as MasterRepository;

  const probes = selectReleaseProbeProducts(repository);
  assert.equal(probes.catalogRedPair?.source.itemSeq, "900000001");
  assert.equal(probes.catalogRedPair?.target.itemSeq, "900000002");
  assert.equal(probes.ingredientMissing?.itemSeq, "900000003");
});

function product(itemSeq: string, name: string): MasterProduct {
  return {
    itemSeq,
    productCode: itemSeq,
    name,
    normalizedName: name,
    manufacturer: "테스트제약",
    ingredientCode: "",
    ingredientName: "",
    atcCode: "",
    atcName: "",
    source: "PUBLIC_DATA_LIVE",
    ingredientsComplete: true
  };
}

function ingredient(itemSeq: string, ingredientName: string): ProductIngredient {
  return {
    itemSeq,
    ingredientKey: ingredientName,
    durIngredientKeys: [ingredientName],
    ingredientName,
    ingredientCode: ""
  };
}
