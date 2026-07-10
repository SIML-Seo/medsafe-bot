import type { MasterRepository } from "../repositories/masterRepository.js";
import type { MasterProduct, ProductIngredient } from "../types.js";
import { ingredientRuleSideApplicability, SafetyService } from "../services/safetyService.js";
import type { MedicationResolver } from "../services/medicationResolver.js";
import { hasEmergencySignal } from "../services/safetyPolicy.js";
import { compactText } from "./text.js";

export const FIXED_RELEASE_PROBE_ITEM_SEQS = [
  "202106092",
  "197900277",
  "200108429",
  "197900145",
  "202302166",
  "201900814",
  "201707240",
  "198000054",
  "201206793",
  "199500043",
  "199100038",
  "199101243",
  "199700049",
  "198900263",
  "196200032",
  "201401455",
  "200500044",
  "200103360",
  "200500369",
  "200501505",
  "200801848",
  "199304102",
  "199806459",
  "201309347",
  "198700923",
  "200501778",
  "200704590",
  "195700015",
  "196500051",
  "200811793",
  "197400262"
] as const;

export const CRITICAL_DUR_RED_PROBES = [
  { flow: "paxlovidCompoundRedCase", itemSeqs: ["202302166", "201900814"] },
  { flow: "cabozantinibSingleRedCase", itemSeqs: ["201707240", "198000054"] },
  { flow: "cabozantinibMixCodeRedCase", itemSeqs: ["201707240", "201206793"] },
  { flow: "nimesulideSpellingRedCase", itemSeqs: ["199500043", "199100038"] },
  { flow: "isoniazidSpellingRedCase", itemSeqs: ["199101243", "199700049"] },
  { flow: "clopidogrelSpellingRedCase", itemSeqs: ["202302166", "201401455"] },
  { flow: "xylometazolineSpellingRedCase", itemSeqs: ["199806459", "201309347"] }
] as const;

export const CRITICAL_DUPLICATE_INGREDIENT_PROBES = [
  { flow: "nimesulideSpellingDuplicate", itemSeqs: ["198900263", "199100038"] },
  { flow: "isoniazidSpellingDuplicate", itemSeqs: ["196200032", "199700049"] },
  { flow: "clopidogrelSpellingDuplicate", itemSeqs: ["200500044", "201401455"] },
  {
    flow: "caffeineCompoundDuplicate",
    itemSeqs: ["195700015", "196500051"],
    ingredientNeedle: "카페인"
  },
  {
    flow: "lysineAcetateDuplicate",
    itemSeqs: ["200811793", "197400262"],
    ingredientNeedle: "리신",
    requireFailedType: true
  }
] as const;

export const CRITICAL_EMERGENCY_TEXT_PROBES = [
  "타이레놀 한 통을 다 먹었어요",
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
  "죽으려고 타이레놀을 먹었어요",
  "죽으려 타이레놀을 먹었어요",
  "죽고 싶어서 타이레놀을 먹었어요",
  "죽고 싶어 타이레놀을 먹었어요",
  "살기 싫어서 타이레놀을 먹었어요",
  "자살하려고 타이레놀을 먹었어요",
  "극단적인 선택을 하려고 타이레놀을 먹었어요",
  "자해하려고 타이레놀을 먹었어요",
  "목숨을 끊으려고 타이레놀을 먹었어요",
  "죽을려고 타이레놀을 먹었어요",
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
] as const;

export const CRITICAL_NON_EMERGENCY_TEXT_PROBES = [
  "타이레놀 한 통 먹고 있어요",
  "물 한 병을 다 먹었어요",
  "과자 한 봉지를 다 먹었어요",
  "타이레놀은 복용 중이고 물 한 병을 다 마셨어요",
  "처방받은 약을 다 먹었어요",
  "한 번에 한 알씩 먹으래요",
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
  "목숨을 내놓으면 안 돼요"
] as const;

export const CRITICAL_POTENTIAL_OVERDOSE_TEXT_PROBES = [
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
] as const;

export const CRITICAL_CURATED_SPELLING_PROBES = [
  { itemSeq: "199100038", alias: "니메수리드", catalogKey: "니메술리드" },
  { itemSeq: "199700049", alias: "이소니아짓", catalogKey: "이소니아지드" },
  { itemSeq: "201401455", alias: "클리피도그렐", catalogKey: "클로피도그렐" },
  { itemSeq: "200103360", alias: "아미노카프로산", catalogKey: "아미노카프론산" },
  {
    itemSeq: "200500369",
    alias: "에데트산칼슘디나트륨",
    catalogKey: "에데트산칼슘나트륨"
  },
  { itemSeq: "200501505", alias: "트라넥사민산", catalogKey: "트라넥삼산" },
  { itemSeq: "199806459", alias: "자일로메타졸린", catalogKey: "키실로메타졸린" }
] as const;

export const CRITICAL_UNRESOLVED_SPELLING_PROBES = [
  { itemSeq: "200801848", alias: "이소소르비드액" },
  { itemSeq: "199304102", alias: "칼시포트리올" },
  { itemSeq: "198700923", alias: "반코마이신" },
  { itemSeq: "200501778", alias: "토수플록사신" },
  { itemSeq: "200704590", alias: "펠루비프로펜" }
] as const;

export const CRITICAL_RELEASE_SAFETY_PROBE_COUNT =
  CRITICAL_DUR_RED_PROBES.length +
  CRITICAL_DUPLICATE_INGREDIENT_PROBES.length +
  CRITICAL_EMERGENCY_TEXT_PROBES.length +
  CRITICAL_NON_EMERGENCY_TEXT_PROBES.length +
  CRITICAL_POTENTIAL_OVERDOSE_TEXT_PROBES.length +
  CRITICAL_CURATED_SPELLING_PROBES.length +
  CRITICAL_UNRESOLVED_SPELLING_PROBES.length;

export interface ReleaseProbeProducts {
  catalogCovered: MasterProduct | null;
  catalogRedPair: { source: MasterProduct; target: MasterProduct } | null;
  ingredientMissing: MasterProduct | null;
}

export function selectReleaseProbeProducts(repository: MasterRepository): ReleaseProbeProducts {
  const products = repository
    .allProducts()
    .filter((product) => /^\d{9}$/.test(product.itemSeq) && product.name.length <= 512);
  const nameCounts = new Map<string, number>();
  for (const product of products) {
    const name = compactText(product.name);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const ingredientsByItemSeq = new Map<string, ProductIngredient[]>();
  for (const ingredient of repository.allProductIngredients()) {
    const values = ingredientsByItemSeq.get(ingredient.itemSeq) ?? [];
    values.push(ingredient);
    ingredientsByItemSeq.set(ingredient.itemSeq, values);
  }
  const allIngredientKeys = Array.from(
    new Set(
      Array.from(ingredientsByItemSeq.values()).flatMap((ingredients) =>
        ingredients
          .flatMap((ingredient) => ingredient.durIngredientKeys)
          .filter(Boolean)
      )
    )
  );
  const knownKeys = new Set<string>();
  for (let index = 0; index < allIngredientKeys.length; index += 1000) {
    for (const key of repository.getKnownDurIngredientKeys(
      allIngredientKeys.slice(index, index + 1000)
    )) {
      knownKeys.add(key);
    }
  }

  const uniqueExact = (product: MasterProduct) => nameCounts.get(compactText(product.name)) === 1;
  const noItemSnapshot = (product: MasterProduct) => repository.getDurSnapshot(product.itemSeq) === null;
  const catalogCovered =
    products.find((product) => {
      const ingredients = ingredientsByItemSeq.get(product.itemSeq) ?? [];
      return (
        uniqueExact(product) &&
        noItemSnapshot(product) &&
        ingredients.length > 0 &&
        ingredients.every(
          (ingredient) =>
            ingredient.durIngredientKeys.length > 0 &&
            ingredient.durIngredientKeys.every((key) => knownKeys.has(key))
        )
      );
    }) ?? null;
  const eligibleCatalogProducts = products.filter((product) => {
    const ingredients = ingredientsByItemSeq.get(product.itemSeq) ?? [];
    return (
      uniqueExact(product) &&
      noItemSnapshot(product) &&
      product.ingredientsComplete &&
      ingredients.length > 0 &&
      ingredients.every((ingredient) => ingredient.durIngredientKeys.length > 0)
    );
  });
  const productsByIngredientKey = new Map<string, MasterProduct[]>();
  for (const product of eligibleCatalogProducts) {
    for (const ingredient of ingredientsByItemSeq.get(product.itemSeq) ?? []) {
      for (const key of ingredient.durIngredientKeys) {
        const matchingProducts = productsByIngredientKey.get(key) ?? [];
        matchingProducts.push(product);
        productsByIngredientKey.set(key, matchingProducts);
      }
    }
  }
  const catalogRedPair = selectCatalogRedPair(
    repository,
    eligibleCatalogProducts,
    ingredientsByItemSeq,
    productsByIngredientKey
  );
  const ingredientMissing =
    products.find(
      (product) =>
        uniqueExact(product) &&
        noItemSnapshot(product) &&
        (ingredientsByItemSeq.get(product.itemSeq)?.length ?? 0) === 0
    ) ?? null;
  return { catalogCovered, catalogRedPair, ingredientMissing };
}

export async function criticalReleaseSafetyFailures(
  repository: MasterRepository,
  safety: Pick<SafetyService, "check">,
  resolver: Pick<MedicationResolver, "knownMedicationNamesInText">
): Promise<string[]> {
  const failures: string[] = [];
  const ingredientOnlyRepository = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "getDurSnapshot") return () => null;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const ingredientOnlySafety = new SafetyService(
    ingredientOnlyRepository,
    {
      async checkUsjntTaboo() {
        return { ok: true, type: "USJNT_TABOO" as const, contraindications: [] };
      },
      async selfTest() {
        return { ok: true, message: "ingredient-only release probe" };
      }
    },
    repository.metadata("fetchedAt")?.slice(0, 10) ?? "1970-01-01"
  );
  for (const probe of CRITICAL_CURATED_SPELLING_PROBES) {
    const product = repository.getProduct(probe.itemSeq);
    const ingredient = repository
      .getProductIngredients(probe.itemSeq)
      .find((item) => item.ingredientName.includes(probe.alias));
    if (!product || !ingredient) {
      failures.push(`curatedSpelling:${probe.itemSeq}: product or ingredient missing`);
      continue;
    }
    if (
      !ingredient.durIngredientMappings?.some(
        (mapping) =>
          mapping.key === probe.catalogKey && mapping.basis === "CURATED_SPELLING"
      )
    ) {
      failures.push(`curatedSpelling:${probe.alias}: expected ${probe.catalogKey}`);
    }
  }

  for (const probe of CRITICAL_UNRESOLVED_SPELLING_PROBES) {
    const product = repository.getProduct(probe.itemSeq);
    const ingredient = repository
      .getProductIngredients(probe.itemSeq)
      .find((item) => item.ingredientName.includes(probe.alias));
    if (!product || !ingredient) {
      failures.push(`unresolvedSpelling:${probe.itemSeq}: product or ingredient missing`);
      continue;
    }
    if (
      product.ingredientsComplete ||
      !ingredient.durIngredientMappings?.some(
        (mapping) => mapping.basis === "FALLBACK" || mapping.basis === "AMBIGUOUS_FORM"
      )
    ) {
      failures.push(`unresolvedSpelling:${probe.alias}: expected fail-closed mapping`);
    }
  }

  for (const probe of CRITICAL_DUR_RED_PROBES) {
    const products = probe.itemSeqs.map((itemSeq) => repository.getProduct(itemSeq));
    if (products.some((product) => product === null)) {
      failures.push(`${probe.flow}: product missing`);
      continue;
    }
    const result = await ingredientOnlySafety.check(
      probe.itemSeqs.map((itemSeq) => ({ itemSeq, status: "CONFIRMED" as const })),
      { ageGroup: "adult", pregnancy: "no" }
    );
    if (
      result.verdict !== "WARN" ||
      !result.findings.some(
        (finding) =>
          finding.type === "USJNT_TABOO" &&
          finding.level === "RED" &&
          finding.origin === "DUR_INGREDIENT_SNAPSHOT"
      ) ||
      result.failedTypes.includes("USJNT_TABOO")
    ) {
      failures.push(`${probe.flow}: expected ingredient-catalog RED`);
    }
  }

  for (const probe of CRITICAL_DUPLICATE_INGREDIENT_PROBES) {
    if (probe.itemSeqs.some((itemSeq) => repository.getProduct(itemSeq) === null)) {
      failures.push(`${probe.flow}: product missing`);
      continue;
    }
    const result = await safety.check(
      probe.itemSeqs.map((itemSeq) => ({ itemSeq, status: "CONFIRMED" as const })),
      { ageGroup: "adult", pregnancy: "no" }
    );
    const duplicateFailed = result.failedTypes.includes("DUP_INGREDIENT");
    const requireFailedType =
      "requireFailedType" in probe && probe.requireFailedType === true;
    if (
      result.verdict === "NO_KNOWN_FINDINGS" ||
      !result.findings.some(
        (finding) =>
          finding.type === "DUP_INGREDIENT" &&
          (!("ingredientNeedle" in probe) ||
            finding.reason.includes(probe.ingredientNeedle))
      ) ||
      (requireFailedType ? !duplicateFailed : duplicateFailed)
    ) {
      failures.push(`${probe.flow}: expected duplicate ingredient finding`);
    }
  }

  const emergencyProduct = repository.getProduct("202106092");
  if (!emergencyProduct) {
    failures.push("brandEmergency: product missing");
  } else {
    for (const notes of CRITICAL_EMERGENCY_TEXT_PROBES) {
      const medicationNames = resolver.knownMedicationNamesInText(notes);
      if (!hasEmergencySignal(notes, medicationNames)) {
        failures.push(`brandEmergency: detector missed ${notes}`);
        continue;
      }
      const result = await safety.check(
        [{ itemSeq: emergencyProduct.itemSeq, status: "CONFIRMED" }],
        { notes }
      );
      if (
        result.verdict !== "WARN" ||
        !result.findings.some((finding) => finding.type === "EMERGENCY")
      ) {
        failures.push(`brandEmergency: safety flow missed ${notes}`);
      }
    }
  }

  for (const notes of CRITICAL_NON_EMERGENCY_TEXT_PROBES) {
    const medicationNames = resolver.knownMedicationNamesInText(notes);
    if (hasEmergencySignal(notes, medicationNames)) {
      failures.push(`brandEmergency: false positive ${notes}`);
      continue;
    }
    if (!emergencyProduct) continue;
    const result = await safety.check(
      [{ itemSeq: emergencyProduct.itemSeq, status: "CONFIRMED" }],
      { notes }
    );
    if (result.findings.some((finding) => finding.type === "EMERGENCY")) {
      failures.push(`brandEmergency: safety false positive ${notes}`);
    }
    if (result.failedTypes.includes("EMERGENCY_TRIAGE")) {
      failures.push(`brandEmergency: unexpected triage hold ${notes}`);
    }
  }

  for (const notes of CRITICAL_POTENTIAL_OVERDOSE_TEXT_PROBES) {
    const medicationNames = resolver.knownMedicationNamesInText(notes);
    if (hasEmergencySignal(notes, medicationNames)) {
      failures.push(`potentialOverdose: false emergency ${notes}`);
      continue;
    }
    if (!emergencyProduct) continue;
    const result = await safety.check(
      [{ itemSeq: emergencyProduct.itemSeq, status: "CONFIRMED" }],
      { notes }
    );
    if (
      result.verdict !== "UNCERTAIN" ||
      !result.findings.some((finding) => finding.type === "CONTEXT_UNKNOWN") ||
      !result.failedTypes.includes("EMERGENCY_TRIAGE")
    ) {
      failures.push(`potentialOverdose: expected transparent hold ${notes}`);
    }
  }
  return failures;
}

function selectCatalogRedPair(
  repository: MasterRepository,
  products: MasterProduct[],
  ingredientsByItemSeq: Map<string, ProductIngredient[]>,
  productsByIngredientKey: Map<string, MasterProduct[]>
): { source: MasterProduct; target: MasterProduct } | null {
  for (const source of products) {
    const sourceIngredients = ingredientsByItemSeq.get(source.itemSeq) ?? [];
    const sourceKeys = sourceIngredients
      .flatMap((ingredient) => ingredient.durIngredientKeys)
      .filter(Boolean);
    for (const rule of repository.getDurIngredientContraindications(sourceKeys)) {
      const targetKey = rule.targetIngredientKey;
      for (const target of productsByIngredientKey.get(targetKey) ?? []) {
        if (target.itemSeq === source.itemSeq) continue;
        const targetIngredients = ingredientsByItemSeq.get(target.itemSeq) ?? [];
        const sourceApplicability = ingredientRuleSideApplicability(
          sourceIngredients,
          source.ingredientsComplete,
          rule.sourceIngredientKey,
          rule.sourceMixType,
          rule.sourceMixture
        );
        const targetApplicability = ingredientRuleSideApplicability(
          targetIngredients,
          target.ingredientsComplete,
          rule.targetIngredientKey,
          rule.targetMixType,
          rule.targetMixture
        );
        if (sourceApplicability === "MATCH" && targetApplicability === "MATCH") {
          return { source, target };
        }
      }
    }
  }
  return null;
}
