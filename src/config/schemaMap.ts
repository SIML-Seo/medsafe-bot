export const OFFICIAL_SOURCE_URLS = {
  durProductInfo: "https://www.data.go.kr/data/15059486/openapi.do",
  durIngredientInfo: "https://www.data.go.kr/data/15056780/openapi.do",
  easyDrugInfo: "https://www.data.go.kr/data/15075057/openapi.do",
  atcMapping: "https://www.data.go.kr/data/15118958/fileData.do",
  ingredientMaster: "https://www.data.go.kr/data/15067461/fileData.do",
  mcpTransports: "https://modelcontextprotocol.io/specification/2025-03-26/basic/transports",
  mcpTools: "https://modelcontextprotocol.io/specification/draft/server/tools",
  kakaoAgenticPlayer: "https://b.kakao.com/views/PlayMCP/AGENTIC_PlAYER_10"
} as const;

export const DUR_OPERATION_MAP = {
  USJNT_TABOO: {
    operationName: "getUsjntTabooInfoList03",
    verified: true,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  },
  AGE_TABOO: {
    operationName: "getSpcifyAgrdeTabooInfoList03",
    verified: false,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  },
  PREG_TABOO: {
    operationName: "getPwnmTabooInfoList03",
    verified: false,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  },
  CAPACITY: {
    operationName: "getCpctyAtentInfoList03",
    verified: false,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  },
  PERIOD: {
    operationName: "getMdctnPdAtentInfoList03",
    verified: false,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  },
  ELDERLY_CAUTION: {
    operationName: "getOdsnAtentInfoList03",
    verified: false,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  },
  EFCY_DUP: {
    operationName: "getEfcyDplctInfoList03",
    verified: false,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  },
  SR_SPLIT: {
    operationName: "getSeobangjeongPartitnAtentInfoList03",
    verified: false,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  },
  PRODUCT_LIST: {
    operationName: "getDurPrdlstInfoList03",
    verified: false,
    sourceUrl: OFFICIAL_SOURCE_URLS.durProductInfo
  }
} as const;

export const DUR_BASE_URLS = [
  "https://apis.data.go.kr/1471000/DURPrdlstInfoService03"
] as const;

export const EASY_DRUG_ENDPOINT =
  "https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList";

export const FIELD_MAP = {
  durUsjntTaboo: {
    sourceItemSeq: ["ITEM_SEQ", "itemSeq", "ITEMSEQ"],
    targetItemSeq: ["MIXTURE_ITEM_SEQ", "mixtureItemSeq", "MIXTURE_ITEMSEQ"],
    targetIngredientCode: ["MIXTURE_INGR_CODE", "mixtureIngrCode", "MIXTURE_INGR_CODE"],
    reason: ["PROHBT_CONTENT", "prohbtContent", "REMARK", "remark", "TABOO_CONTENT"],
    baseDate: ["BASE_DATE", "baseDate", "UPDATE_DATE", "updateDate"]
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
