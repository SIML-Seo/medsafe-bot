import type {
  InputKind,
  MasterProduct,
  MedicationCandidate,
  ResolvedMedication
} from "../types.js";
import { MasterRepository } from "../repositories/masterRepository.js";
import { initialConsonants, normalizedHangulDistanceScore } from "../utils/hangul.js";
import { compactText, normalizeMedicationText, tokenSetRatio } from "../utils/text.js";

const CONFIRM_THRESHOLD = 0.9;
const AMBIGUOUS_THRESHOLD = 0.75;
const REPEATED_TOKEN_LIMIT = 6;
const OUT_OF_SCOPE_TERMS = ["홍삼", "오메가3", "오메가 3", "자몽", "건강기능식품", "한약"];

interface IndexedProduct {
  product: MasterProduct;
  compactName: string;
  compactIngredientName: string;
  compactIngredientCode: string;
  initialsName: string;
}

export class MedicationResolver {
  private indexedProductsCache: IndexedProduct[] | null = null;

  constructor(private readonly repository: MasterRepository) {}

  private products(): IndexedProduct[] {
    if (!this.indexedProductsCache) {
      this.indexedProductsCache = this.repository.allProducts().map((product) => ({
        product,
        compactName: compactText(product.name),
        compactIngredientName: compactText(product.ingredientName),
        compactIngredientCode: compactText(product.ingredientCode),
        initialsName: initialConsonants(compactText(product.name))
      }));
    }
    return this.indexedProductsCache;
  }

  resolveMany(queries: string[]): ResolvedMedication[] {
    return queries.map((query) => this.resolveOne(query));
  }

  resolveOne(query: string): ResolvedMedication {
    const normalized = normalizeMedicationText(query);
    if (!normalized) {
      return this.notFound(query, "UNKNOWN");
    }
    if (OUT_OF_SCOPE_TERMS.some((term) => compactText(term) === compactText(query))) {
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
    if (hasExcessiveRepeatedTokens(query)) {
      return this.notFound(query, "UNKNOWN");
    }

    const aliasMatches = this.repository.findAliases(normalized);
    if (aliasMatches.length > 0) {
      const kind = aliasMatches[0]?.kind ?? "UNKNOWN";
      const candidates = aliasMatches.flatMap((alias): MedicationCandidate[] => {
        if (alias.kind === "INGREDIENT") {
          return this.repository
            .getProductsByIngredient(alias.targetIngredientCode ?? "")
            .slice(0, 5)
            .map((product) => this.candidateFromProduct(product, 0.95, "alias ingredient product"));
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
    const indexedProducts = this.products();
    const exactMatches = indexedProducts
      .filter((entry) => entry.compactName === compactQuery)
      .map((entry) => entry.product);
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

    const ingredientMatches = indexedProducts
      .filter(
        (entry) =>
          (entry.compactIngredientName && entry.compactIngredientName === compactQuery) ||
          (entry.compactIngredientCode && entry.compactIngredientCode === compactQuery)
      )
      .map((entry) => entry.product);
    const ingredientCodes = Array.from(
      new Set(ingredientMatches.map((product) => product.ingredientCode).filter(Boolean))
    );
    if (ingredientCodes.length === 1) {
      return {
        query,
        status: "AMBIGUOUS",
        inputKind: "INGREDIENT",
        itemSeq: null,
        ingrCode: ingredientCodes[0]!,
        matchedName: ingredientMatches[0]?.ingredientName ?? ingredientCodes[0]!,
        candidates: ingredientMatches.slice(0, 5).map((product) =>
          this.candidateFromProduct(product, 0.95, "ingredient exact")
        )
      };
    }

    const partialMatches = indexedProducts
      .filter((entry) => compactQuery.length >= 2 && entry.compactName.includes(compactQuery))
      .sort((a, b) => a.compactName.length - b.compactName.length)
      .slice(0, 5)
      .map((entry) => this.candidateFromProduct(entry.product, 0.88, "partial normalized product"));
    if (partialMatches.length > 0) {
      return {
        query,
        status: partialMatches.length === 1 ? "CONFIRMED" : "AMBIGUOUS",
        inputKind: "PRODUCT",
        itemSeq: partialMatches.length === 1 ? partialMatches[0]!.itemSeq : null,
        ingrCode: partialMatches.length === 1 ? partialMatches[0]!.ingrCode : null,
        matchedName: partialMatches.length === 1 ? partialMatches[0]!.matchedName : null,
        candidates: partialMatches
      };
    }

    const initialsQuery = initialConsonants(compactQuery);
    const scoringPool = indexedProducts.filter((entry) => {
      if (compactQuery.length < 2) return false;
      if (entry.compactName.includes(compactQuery.slice(0, 2))) return true;
      return Boolean(initialsQuery && entry.initialsName.includes(initialsQuery));
    });
    const scored = (scoringPool.length > 0 ? scoringPool : indexedProducts)
      .map((entry) => this.scoreProduct(query, entry.product))
      .filter((candidate) => candidate.score >= AMBIGUOUS_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (scored.length === 1 && scored[0]!.score >= CONFIRM_THRESHOLD) {
      const candidate = scored[0]!;
      return {
        query,
        status: "CONFIRMED",
        inputKind: "PRODUCT",
        itemSeq: candidate.itemSeq,
        ingrCode: candidate.ingrCode,
        matchedName: candidate.matchedName,
        candidates: scored
      };
    }

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
    const distanceScore = normalizedHangulDistanceScore(compactText(query), compactText(product.name));
    const initialsQuery = initialConsonants(compactText(query));
    const initialsName = initialConsonants(compactText(product.name));
    const initialBonus = initialsQuery && initialsName.includes(initialsQuery) ? 0.05 : 0;
    const score = Math.min(1, Math.max(tokenScore, distanceScore * 0.95 + initialBonus));
    return this.candidateFromProduct(product, Number(score.toFixed(3)), "hangul fuzzy");
  }

  private candidateFromProduct(
    product: MasterProduct,
    score: number,
    reason: string
  ): MedicationCandidate {
    return {
      itemSeq: product.itemSeq,
      ingrCode: nonEmptyOrNull(product.ingredientCode),
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

function nonEmptyOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasExcessiveRepeatedTokens(query: string): boolean {
  const tokens = normalizeMedicationText(query).split(" ").filter(Boolean);
  if (tokens.length < REPEATED_TOKEN_LIMIT) return false;
  return new Set(tokens).size <= Math.max(1, Math.floor(tokens.length / 4));
}
