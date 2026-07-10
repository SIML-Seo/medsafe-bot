import type {
  InputKind,
  MasterProduct,
  MedicationCandidate,
  ProductIngredient,
  ResolvedMedication
} from "../types.js";
import { MasterRepository } from "../repositories/masterRepository.js";
import { initialConsonants, normalizedHangulDistanceScore } from "../utils/hangul.js";
import {
  compactText,
  extractDosageTokens,
  extractFormTokens,
  medicationSearchStem,
  normalizeMedicationText,
  tokenSetRatio
} from "../utils/text.js";

const AMBIGUOUS_THRESHOLD = 0.75;
const REPEATED_TOKEN_LIMIT = 6;
const OUT_OF_SCOPE_TERMS = ["홍삼", "오메가3", "오메가 3", "자몽", "건강기능식품", "한약"];

interface IndexedProduct {
  product: MasterProduct;
  compactName: string;
  searchStem: string;
  dosageTokens: string[];
  formTokens: string[];
  compactIngredientNames: string[];
  compactIngredientCodes: string[];
  ingredients: ProductIngredient[];
  initialsName: string;
}

export class MedicationResolver {
  private indexedProductsCache: IndexedProduct[] | null = null;
  private readonly exactNameIndex = new Map<string, IndexedProduct[]>();
  private readonly ingredientIndex = new Map<
    string,
    Array<{ entry: IndexedProduct; ingredient: ProductIngredient }>
  >();
  private readonly searchGramIndex = new Map<string, Set<IndexedProduct>>();
  private readonly initialsGramIndex = new Map<string, Set<IndexedProduct>>();

  constructor(private readonly repository: MasterRepository) {
    this.products();
  }

  private products(): IndexedProduct[] {
    if (!this.indexedProductsCache) {
      const ingredientsByItemSeq = new Map<string, ReturnType<MasterRepository["allProductIngredients"]>>();
      for (const ingredient of this.repository.allProductIngredients()) {
        const ingredients = ingredientsByItemSeq.get(ingredient.itemSeq) ?? [];
        ingredients.push(ingredient);
        ingredientsByItemSeq.set(ingredient.itemSeq, ingredients);
      }
      this.indexedProductsCache = this.repository.allProducts().map((product) => {
        const ingredients = ingredientsByItemSeq.get(product.itemSeq) ?? [];
        return {
          product,
          compactName: compactText(product.name),
          searchStem: medicationSearchStem(product.name),
          dosageTokens: extractDosageTokens(product.name),
          formTokens: extractFormTokens(product.name),
          compactIngredientNames: Array.from(
            new Set(
              ingredients
                .map((ingredient) => compactText(ingredient.ingredientName))
                .filter(Boolean)
            )
          ),
          compactIngredientCodes: Array.from(
            new Set(
              [product.ingredientCode, ...ingredients.map((ingredient) => ingredient.ingredientCode)]
                .map(compactText)
                .filter(Boolean)
            )
          ),
          ingredients,
          initialsName: initialConsonants(compactText(product.name))
        };
      });
      for (const entry of this.indexedProductsCache) this.indexEntry(entry);
    }
    return this.indexedProductsCache;
  }

  resolveMany(queries: string[]): ResolvedMedication[] {
    return queries.map((query) => this.resolveOne(query));
  }

  medicationReferencesInText(text: string): string[] {
    const references = new Set(
      emergencyMedicationReferences(text).filter(
        (reference) => !isQuantityUnitReference(text, reference)
      )
    );
    for (const reference of exactMedicationTokenReferences(text)) {
      if (isQuantityUnitReference(text, reference)) continue;
      const normalized = normalizeMedicationText(reference);
      const compact = compactText(reference);
      if (
        this.repository.findAliases(normalized).length > 0 ||
        this.exactNameIndex.has(compact) ||
        this.ingredientIndex.has(compact)
      ) {
        references.add(reference);
      }
    }
    return Array.from(references).filter((reference) => {
      const resolved = this.resolveOne(reference);
      return (
        resolved.status !== "NOT_FOUND" &&
        resolved.status !== "OUT_OF_SCOPE" &&
        (resolved.itemSeq !== null || resolved.ingrCode !== null || resolved.candidates.length > 0)
      );
    });
  }

  knownMedicationNamesInText(text: string): string[] {
    const names = new Set<string>();
    for (const reference of this.medicationReferencesInText(text)) {
      const resolved = this.resolveOne(reference);
      if (resolved.matchedName) names.add(resolved.matchedName);
      for (const candidate of resolved.candidates) names.add(candidate.matchedName);
    }
    return Array.from(names);
  }

  resolveOne(query: string): ResolvedMedication {
    const normalized = normalizeMedicationText(query);
    if (!normalized) {
      return this.notFound(query, "UNKNOWN");
    }
    if (hasExcessiveRepeatedTokens(query)) {
      return this.notFound(query, "UNKNOWN");
    }

    const aliasMatches = this.repository.findAliases(normalized);
    if (aliasMatches.length > 0) {
      const kind = aliasMatches[0]?.kind ?? "UNKNOWN";
      const candidates = aliasMatches.flatMap((alias): MedicationCandidate[] => {
        if (alias.kind === "INGREDIENT") {
          const products = alias.targetIngredientKey
            ? this.repository.getProductsByIngredientKey(alias.targetIngredientKey)
            : this.repository.getProductsByIngredient(alias.targetIngredientCode ?? "");
          return products
            .slice(0, 5)
            .map((product) =>
              this.candidateFromProduct(
                product,
                0.95,
                "alias ingredient product",
                this.repository
                  .getProductIngredients(product.itemSeq)
                  .find(
                    (ingredient) =>
                      ingredient.ingredientKey === alias.targetIngredientKey ||
                      ingredient.ingredientCode === alias.targetIngredientCode
                  )
              )
            );
        }

        if (!alias.targetItemSeq) return [];
        const product = this.repository.getProduct(alias.targetItemSeq);
        if (!product) return [];
        return [this.candidateFromProduct(product, 1, "alias product")];
      });

      if (kind === "INGREDIENT") {
        return {
          query,
          status: "AMBIGUOUS",
          inputKind: kind,
          itemSeq: null,
          ingrCode: aliasMatches[0]?.targetIngredientCode ?? null,
          matchedName: aliasMatches[0]?.label ?? aliasMatches[0]?.alias ?? null,
          candidates: candidates.slice(0, 5)
        };
      }

      if (candidates.length === 1) {
        const candidate = candidates[0]!;
        return {
          query,
          status: "CONFIRMED",
          inputKind: kind,
          itemSeq: candidate.itemSeq,
          ingrCode: candidate.ingrCode,
          matchedName: candidate.matchedName,
          candidates
        };
      }

      return {
        query,
        status: "AMBIGUOUS",
        inputKind: kind,
        itemSeq: null,
        ingrCode: null,
        matchedName: null,
        candidates: candidates.slice(0, 5)
      };
    }

    const compactQuery = compactText(query);
    const querySearchStem = medicationSearchStem(query);
    const queryDosages = extractDosageTokens(query);
    const queryForms = extractFormTokens(query);
    this.products();
    const exactMatches = (this.exactNameIndex.get(compactQuery) ?? []).map(
      (entry) => entry.product
    );
    if (exactMatches.length === 1) {
      const product = exactMatches[0]!;
      const candidate = this.candidateFromProduct(product, 1, "exact normalized product");
      return {
        query,
        status: "CONFIRMED",
        inputKind: "PRODUCT",
        itemSeq: candidate.itemSeq,
        ingrCode: candidate.ingrCode,
        matchedName: product.name,
        candidates: [candidate]
      };
    }
    if (exactMatches.length > 1) {
      return {
        query,
        status: "AMBIGUOUS",
        inputKind: "PRODUCT",
        itemSeq: null,
        ingrCode: null,
        matchedName: null,
        candidates: exactMatches.slice(0, 5).map((product) =>
          this.candidateFromProduct(product, 1, "exact normalized product")
        )
      };
    }

    const ingredientMatches = (this.ingredientIndex.get(compactQuery) ?? []).map(
      ({ entry, ingredient }) => ({ product: entry.product, ingredient })
    );
    const ingredientCodes = Array.from(
      new Set(ingredientMatches.map(({ ingredient }) => ingredient.ingredientCode).filter(Boolean))
    );
    if (ingredientMatches.length > 0) {
      const ingredientNames = Array.from(
        new Set(ingredientMatches.map(({ ingredient }) => ingredient.ingredientName))
      );
      return {
        query,
        status: "AMBIGUOUS",
        inputKind: "INGREDIENT",
        itemSeq: null,
        ingrCode: ingredientCodes.length === 1 ? ingredientCodes[0]! : null,
        matchedName: ingredientNames.length === 1 ? ingredientNames[0]! : query,
        candidates: ingredientMatches.slice(0, 5).map(({ product, ingredient }) =>
          this.candidateFromProduct(product, 0.95, "ingredient exact", ingredient)
        )
      };
    }

    if (OUT_OF_SCOPE_TERMS.some((term) => compactText(query).includes(compactText(term)))) {
      return {
        query,
        status: "OUT_OF_SCOPE",
        inputKind: "FOOD_OR_SUPPLEMENT",
        itemSeq: null,
        ingrCode: null,
        matchedName: query,
        candidates: []
      };
    }

    const initialsQuery = initialConsonants(querySearchStem);
    const searchPool = this.searchPool(querySearchStem, initialsQuery);
    const partialMatches = searchPool
      .filter(
        (entry) =>
          querySearchStem.length >= 2 &&
          identityCompatible(queryDosages, queryForms, entry) &&
          (entry.searchStem.includes(querySearchStem) || querySearchStem.includes(entry.searchStem))
      )
      .sort((a, b) => a.searchStem.length - b.searchStem.length)
      .slice(0, 5)
      .map((entry) => this.candidateFromProduct(entry.product, 0.88, "partial normalized product"));
    if (partialMatches.length > 0) {
      const qualifiedUnique =
        partialMatches.length === 1 && (queryDosages.length > 0 || queryForms.length > 0);
      return {
        query,
        status: qualifiedUnique ? "CONFIRMED" : "AMBIGUOUS",
        inputKind: "PRODUCT",
        itemSeq: qualifiedUnique ? partialMatches[0]!.itemSeq : null,
        ingrCode: qualifiedUnique ? partialMatches[0]!.ingrCode : null,
        matchedName: qualifiedUnique ? partialMatches[0]!.matchedName : null,
        candidates: partialMatches
      };
    }

    const scoringPool = searchPool.filter((entry) => {
      if (querySearchStem.length < 2 || !identityCompatible(queryDosages, queryForms, entry)) {
        return false;
      }
      if (entry.searchStem.includes(querySearchStem.slice(0, 2))) return true;
      return Boolean(initialsQuery.length >= 2 && entry.initialsName.includes(initialsQuery));
    });
    const scored = scoringPool
      .sort((a, b) => Math.abs(a.searchStem.length - querySearchStem.length) - Math.abs(b.searchStem.length - querySearchStem.length))
      .slice(0, 500)
      .map((entry) => this.scoreProduct(query, entry.product))
      .filter((candidate) => candidate.score >= AMBIGUOUS_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (scored.length > 0) {
      return {
        query,
        status: "AMBIGUOUS",
        inputKind: "PRODUCT",
        itemSeq: null,
        ingrCode: null,
        matchedName: null,
        candidates: scored
      };
    }

    return this.notFound(query, "UNKNOWN");
  }

  private scoreProduct(query: string, product: MasterProduct): MedicationCandidate {
    const tokenScore = tokenSetRatio(query, product.name);
    const queryStem = medicationSearchStem(query);
    const productStem = medicationSearchStem(product.name);
    const distanceScore = normalizedHangulDistanceScore(queryStem, productStem);
    const prefixScore = normalizedHangulDistanceScore(
      queryStem,
      productStem.slice(0, Math.max(queryStem.length, 1))
    );
    const initialsQuery = initialConsonants(queryStem);
    const initialsName = initialConsonants(productStem);
    const initialBonus = initialsQuery && initialsName.includes(initialsQuery) ? 0.05 : 0;
    const score = Math.min(
      1,
      Math.max(tokenScore, distanceScore * 0.95 + initialBonus, prefixScore * 0.95 + initialBonus)
    );
    return this.candidateFromProduct(product, Number(score.toFixed(3)), "hangul fuzzy");
  }

  private indexEntry(entry: IndexedProduct): void {
    addToListIndex(this.exactNameIndex, entry.compactName, entry);
    for (const ingredient of entry.ingredients) {
      addToListIndex(this.ingredientIndex, compactText(ingredient.ingredientName), {
        entry,
        ingredient
      });
      if (ingredient.ingredientCode) {
        addToListIndex(this.ingredientIndex, compactText(ingredient.ingredientCode), {
          entry,
          ingredient
        });
      }
    }
    for (const gram of textGrams(entry.searchStem)) {
      addToSetIndex(this.searchGramIndex, gram, entry);
    }
    for (const gram of textGrams(entry.initialsName)) {
      addToSetIndex(this.initialsGramIndex, gram, entry);
    }
  }

  private searchPool(queryStem: string, initialsQuery: string): IndexedProduct[] {
    const candidates = new Set<IndexedProduct>();
    for (const gram of textGrams(queryStem)) {
      for (const entry of this.searchGramIndex.get(gram) ?? []) candidates.add(entry);
    }
    for (const gram of textGrams(initialsQuery)) {
      for (const entry of this.initialsGramIndex.get(gram) ?? []) candidates.add(entry);
    }
    return Array.from(candidates);
  }

  private candidateFromProduct(
    product: MasterProduct,
    score: number,
    reason: string,
    matchedIngredient?: ProductIngredient
  ): MedicationCandidate {
    return {
      itemSeq: product.itemSeq,
      ingrCode: nonEmptyOrNull(matchedIngredient?.ingredientCode ?? product.ingredientCode),
      matchedName: product.name,
      manufacturer: product.manufacturer || null,
      score,
      reason
    };
  }

  private notFound(query: string, inputKind: InputKind): ResolvedMedication {
    return {
      query,
      status: "NOT_FOUND",
      inputKind,
      itemSeq: null,
      ingrCode: null,
      matchedName: null,
      candidates: []
    };
  }
}

function textGrams(value: string): string[] {
  if (value.length < 2) return value ? [value] : [];
  const grams = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.add(value.slice(index, index + 2));
  }
  return Array.from(grams);
}

function addToListIndex<T>(index: Map<string, T[]>, key: string, value: T): void {
  if (!key) return;
  const values = index.get(key) ?? [];
  values.push(value);
  index.set(key, values);
}

function addToSetIndex<T>(index: Map<string, Set<T>>, key: string, value: T): void {
  if (!key) return;
  const values = index.get(key) ?? new Set<T>();
  values.add(value);
  index.set(key, values);
}

function identityCompatible(
  queryDosages: string[],
  queryForms: string[],
  product: Pick<IndexedProduct, "dosageTokens" | "formTokens">
): boolean {
  if (queryDosages.some((dosage) => !product.dosageTokens.includes(dosage))) return false;
  if (queryForms.some((form) => !product.formTokens.includes(form))) return false;
  return true;
}

function nonEmptyOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasExcessiveRepeatedTokens(query: string): boolean {
  const tokens = normalizeMedicationText(query).split(" ").filter(Boolean);
  if (tokens.length < REPEATED_TOKEN_LIMIT) return false;
  return new Set(tokens).size <= Math.max(1, Math.floor(tokens.length / 4));
}

function exactMedicationTokenReferences(text: string): string[] {
  const references = new Set<string>();
  const particles = ["까지", "조차", "마저", "부터", "라도", "이나", "을", "를", "은", "는", "이", "가", "도", "만", "나"];
  for (const token of text.normalize("NFKC").match(/[\p{L}\p{N}.%_+-]{2,80}/gu) ?? []) {
    references.add(token);
    for (const particle of particles) {
      if (!token.endsWith(particle)) continue;
      const withoutParticle = token.slice(0, -particle.length);
      if (compactText(withoutParticle).length >= 2) references.add(withoutParticle);
    }
  }
  return Array.from(references);
}

const EMERGENCY_REFERENCE_QUANTITY_PATTERN = String.raw`(?:\d+(?:\.\d+)?|반|몇|여러|수십|한두|두어|두세|서너|너댓|대여섯|(?:(?:열|스무|스물|서른|마흔|쉰|예순|일흔|여든|아흔)(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉)?)|(?:한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉))`;
const EMERGENCY_REFERENCE_UNIT_PATTERN = String.raw`(?:통|병|봉지|봉|팩|박스|상자|갑|묶음|포|시트|판|움큼|주먹|알|정|캡슐|개)(?:씩)?`;
const EMERGENCY_REFERENCE_MODIFIER_PATTERN = String.raw`(?:(?:무려|벌써|이미|어제|그제|오늘(?:\s*새벽)?(?:에)?|새벽(?:에)?|지난밤(?:에)?|방금|아까|조금\s*전(?:에)?|단숨에|단번에|한\s*번에|실수로|한꺼번에|거의|몽땅|몰래|일부러)\s*)*`;
const EMERGENCY_REFERENCE_CONTEXT_GAP_PATTERN = String.raw`[^.!?。！？\n]{0,32}`;
const EMERGENCY_REFERENCE_INGESTION_PATTERN = String.raw`(?:먹|삼키|삼켜|삼켰|복용|마시|마셨|들이키|들이켰|들이부|넘기|넘겼|원샷|꿀꺽|흡입|털어\s*넣|털어넣)`;
const NON_MEDICATION_REFERENCE_TERMS = new Set([
  "그리고",
  "그런데",
  "하지만",
  "그러나",
  "그래서",
  "그러므로",
  "다만",
  "실제로",
  "지금",
  "현재",
  "방금",
  "그중",
  "나머지"
]);

function isQuantityUnitReference(text: string, reference: string): boolean {
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    String.raw`(?:^|\s)${EMERGENCY_REFERENCE_QUANTITY_PATTERN}\s*${escaped}(?:을|를|은|는|이|가|도|만)?[^.!?。！？\n]{0,16}${EMERGENCY_REFERENCE_INGESTION_PATTERN}`,
    "iu"
  ).test(text.normalize("NFKC"));
}

function emergencyMedicationReferences(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const references = new Set<string>();
  const patterns = [
    new RegExp(
      String.raw`(?:^|[\s,.;!?])([\p{L}\p{N}][\p{L}\p{N}._+-]{1,40}?)(?:까지|조차|마저|부터|라도|이나|을|를|은|는|이|가|도|만|나)?\s*[,.;:·-]?\s*${EMERGENCY_REFERENCE_MODIFIER_PATTERN}(?:${EMERGENCY_REFERENCE_QUANTITY_PATTERN}\s*${EMERGENCY_REFERENCE_UNIT_PATTERN}|(?:여러|수십|몇십|많은)\s*(?:알|정|캡슐|개)|(?:통|병|봉지|팩|박스|상자|포|시트|판)째로)`,
      "giu"
    ),
    new RegExp(
      String.raw`(?:^|[\s,.;!?])${EMERGENCY_REFERENCE_QUANTITY_PATTERN}\s*${EMERGENCY_REFERENCE_UNIT_PATTERN}\s*(?:의\s*)?([\p{L}\p{N}][\p{L}\p{N}._+-]{1,40}?)(?:까지|조차|마저|부터|라도|이나|을|를|은|는|이|가|도|만|나)?(?=\s*(?:먹|삼키|삼켜|복용|마시|들이키|들이부))`,
      "giu"
    ),
    new RegExp(
      String.raw`(?:^|[\s,.;!?])([\p{L}\p{N}][\p{L}\p{N}._+-]{1,40})(?:까지|조차|마저|부터|라도|이나|을|를|은|는|이|가|도|만|나)?\s*[,.;:·-]?\s*${EMERGENCY_REFERENCE_CONTEXT_GAP_PATTERN}(?:${EMERGENCY_REFERENCE_QUANTITY_PATTERN}\s*${EMERGENCY_REFERENCE_UNIT_PATTERN}|${EMERGENCY_REFERENCE_UNIT_PATTERN}\s*${EMERGENCY_REFERENCE_QUANTITY_PATTERN})${EMERGENCY_REFERENCE_CONTEXT_GAP_PATTERN}${EMERGENCY_REFERENCE_INGESTION_PATTERN}`,
      "giu"
    )
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const reference = (match[1] ?? "")
        .replace(/(?:까지|조차|마저|부터|라도|이나|을|를|은|는|이|가|도|만|나)$/u, "")
        .trim();
      if (
        compactText(reference).length >= 2 &&
        !NON_MEDICATION_REFERENCE_TERMS.has(reference)
      ) {
        references.add(reference);
      }
      if (references.size >= 8) return Array.from(references);
    }
  }
  return Array.from(references);
}
