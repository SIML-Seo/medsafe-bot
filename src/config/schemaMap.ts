export const OFFICIAL_SOURCE_URLS = {
  durProductInfo: "https://www.data.go.kr/data/15059486/openapi.do",
  durIngredientInfo: "https://www.data.go.kr/data/15056780/openapi.do",
  easyDrugInfo: "https://www.data.go.kr/data/15075057/openapi.do",
  atcMapping: "https://www.data.go.kr/data/15118958/fileData.do",
  ingredientMaster: "https://www.data.go.kr/data/15067461/fileData.do",
  mcpTransports: "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports",
  mcpTools: "https://modelcontextprotocol.io/specification/draft/server/tools",
  kakaoAgenticPlayer: "https://b.kakao.com/views/PlayMCP/AGENTIC_PlAYER_10"
} as const;

export const DUR_OPERATION_MAP = {
  USJNT_TABOO: {
    operationName: "getUsjntTabooInfoList03",
    verified: true,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  },
  PRODUCT_LIST: {
    operationName: "getDurPrdlstInfoList03",
    verified: false,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  },
  INGREDIENT_USJNT_TABOO: {
    operationName: "getUsjntTabooInfoList02",
    verified: false,
    sourceUrl: OFFICIAL_SOURCE_URLS.durIngredientInfo
  }
} as const;

export const DUR_PRODUCT_BASE_URL =
  "https://apis.data.go.kr/1471000/DURPrdlstInfoService03";

export const DUR_INGREDIENT_BASE_URL =
  "https://apis.data.go.kr/1471000/DURIrdntInfoService03";

export const DUR_BASE_URLS = [DUR_PRODUCT_BASE_URL, DUR_INGREDIENT_BASE_URL] as const;

export const EASY_DRUG_ENDPOINT =
  "https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList";

export const SUBMISSION_MCP_ENDPOINT =
  "https://medsafe-bot.playmcp-endpoint.kakaocloud.io/mcp";

export const FIELD_MAP = {
  durUsjntTaboo: {
    sourceItemSeq: ["ITEM_SEQ", "itemSeq", "ITEMSEQ"],
    targetItemSeq: ["MIXTURE_ITEM_SEQ", "mixtureItemSeq", "MIXTURE_ITEMSEQ"],
    targetIngredientCode: ["MIXTURE_INGR_CODE", "mixtureIngrCode", "MIXTURE_INGR_CODE"],
    targetIngredientName: ["MIXTURE_INGR_KOR_NAME", "mixtureIngrKorName"],
    reason: ["PROHBT_CONTENT", "prohbtContent", "REMARK", "remark", "TABOO_CONTENT"],
    baseDate: [
      "NOTIFICATION_DATE",
      "notificationDate",
      "BASE_DATE",
      "baseDate",
      "UPDATE_DATE",
      "updateDate"
    ]
  },
  easyDrug: {
    itemSeq: ["itemSeq", "ITEM_SEQ"],
    itemName: ["itemName", "ITEM_NAME"],
    entpName: ["entpName", "ENTP_NAME"],
    efcyQesitm: ["efcyQesitm", "EFCY_QESITM"],
    useMethodQesitm: ["useMethodQesitm", "USE_METHOD_QESITM"],
    atpnWarnQesitm: ["atpnWarnQesitm", "ATPN_WARN_QESITM"],
    atpnQesitm: ["atpnQesitm", "ATPN_QESITM"],
    intrcQesitm: ["intrcQesitm", "INTRC_QESITM"],
    seQesitm: ["seQesitm", "SE_QESITM"],
    depositMethodQesitm: ["depositMethodQesitm", "DEPOSIT_METHOD_QESITM"]
  }
} as const;

export function readMappedField(
  row: Record<string, unknown>,
  possibleKeys: readonly string[]
): string | null {
  for (const key of possibleKeys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/_/g, ""), value])
  );
  for (const key of possibleKeys) {
    const value = normalized.get(key.toLowerCase().replace(/_/g, ""));
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return null;
}
