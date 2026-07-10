import type { SafetyFinding, SafetyResult, Verdict } from "../types.js";
import { containsAny, medicationSearchStem } from "../utils/text.js";

export const STANDARD_DISCLAIMER =
  "본 정보는 식약처 공개데이터 기반 일반 참고용이며 의사·약사의 진단·처방·복약지도를 대체하지 않습니다. 실제 복용·중단·변경은 반드시 의사 또는 약사와 상담하세요. 응급 증상 시 즉시 119.";

export const SCOPE_NOTICE =
  "이 결과는 건강기능식품·식품·한약·일부 의약품 정보를 포함하지 못할 수 있습니다.";

export const NON_DEVICE_NOTICE = "본 서비스는 의료기기가 아닙니다.";

const BANNED_REPLACEMENTS: Array<[RegExp, string]> = [
  [/<script\b[^>]*>[\s\S]*?<\/script>/gi, "[제거된 스크립트]"],
  [/<\|?(?:system|assistant|developer|user)(?:_message)?\|?>/gi, "[removed role marker]"],
  [/(?:system|assistant|developer|user)\s*:\s*/gi, "[removed role marker] "],
  [/```(?:json|text|markdown|md)?/gi, "[removed code fence]"],
  [/위\s*결과\s*무시\.?/gi, "[제거된 지시문]"],
  [/(?:위|이전|앞선)\s*(?:결과|지시|규칙|메시지)(?:를|을)?\s*(?:무시|잊어)[^\n.!?]*/gi, "[제거된 지시문]"],
  [/ignore\s+(the\s+)?(above|previous)\s+(result|instruction|message)s?/gi, "[removed instruction]"],
  [/(?:disregard|forget)\s+(?:all\s+)?(?:prior|previous|above)\s+(?:instructions?|messages?|rules?)/gi, "[removed instruction]"],
  [/system\s+prompt/gi, "[removed instruction]"],
  [/안전합니다/g, "등록된 금기는 조회되지 않았습니다"],
  [/안심하세요/g, "전문가 확인을 권장합니다"],
  [/복용해도 됩니다/g, "복용 가능 여부는 의사 또는 약사와 상담하세요"],
  [/먹지 마세요/g, "임의 중단하지 말고 의사 또는 약사와 상담하세요"],
  [/끊으세요/g, "임의 중단하지 말고 의사 또는 약사와 상담하세요"],
  [/용량을 바꾸세요/g, "용량 변경은 의사 또는 약사와 상담하세요"]
];

export const EMERGENCY_TERMS = [
  "호흡곤란",
  "호흡 곤란",
  "숨쉬기 힘",
  "숨 쉬기 힘",
  "숨쉬기가 어려",
  "숨 쉬기가 어려",
  "숨이 차",
  "숨을 쉴 수가 없",
  "의식저하",
  "의식 저하",
  "아나필락시스",
  "심한 흉통",
  "가슴 통증",
  "흉통이 심",
  "가슴이 아파",
  "입술 부종",
  "과다복용",
  "과량복용",
  "과복용"
];

const MEDICATION_PARTICLE_PATTERN = String.raw`(?:까지|조차|마저|부터|라도|이나|을|를|은|는|이|가|도|만|나)?`;
const MEDICATION_SEPARATOR_PATTERN = String.raw`\s*[,.;:·-]?\s*`;
const CONTAINER_MODIFIER_TERM_PATTERN = String.raw`(?:무려|벌써|이미|어제|그제|오늘(?:\s*(?:새벽|아침|낮|밤))?(?:에)?|새벽(?:에)?|지난밤(?:에)?|방금|아까|조금\s*전(?:에)?|단숨에|단번에|한\s*번에|실수로|술김에|한꺼번에|거의|몽땅|몰래|일부러)`;
const CONTAINER_MODIFIER_PATTERN = String.raw`(?:${CONTAINER_MODIFIER_TERM_PATTERN}\s*)*`;
const NATIVE_CONTAINER_ONES_PATTERN = String.raw`(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉)`;
const NATIVE_CONTAINER_TENS_PATTERN = String.raw`(?:열|스무|스물|서른|마흔|쉰|예순|일흔|여든|아흔)`;
const CONTAINER_QUANTITY_PATTERN = String.raw`(?:\d+(?:\.\d+)?|반|몇|여러|수십|한두|두어|두세|서너|너댓|대여섯|${NATIVE_CONTAINER_TENS_PATTERN}(?:${NATIVE_CONTAINER_ONES_PATTERN})?|${NATIVE_CONTAINER_ONES_PATTERN}|하나|둘|셋|넷)`;
const CONTAINER_UNIT_PATTERN = String.raw`(?:통|병|봉지|봉|팩|박스|상자|갑|묶음|포|시트|판|움큼|주먹)(?:씩)?`;
const POST_CONTAINER_QUALIFIER_PATTERN = String.raw`(?:(?:을|를|이나|나|정도(?:를|는)?|가량|쯤|이상|넘게|가까이)\s*)*`;
const POST_CONTAINER_MODIFIER_PATTERN = CONTAINER_MODIFIER_PATTERN;
const PAST_CONTAINER_INGESTION_PATTERN = String.raw`(?:먹었|먹었다|먹어\s*버렸|먹어\s*치웠|먹고\s*말았|삼켰|삼켜\s*버렸|복용했|복용해\s*버렸|마셨|마셔\s*(?:버렸|치웠)|들이켰|들이켜\s*버렸|들이부었|넘겼|넘겨\s*버렸|원샷(?:했|했다)|털어\s*넣었|털어넣었)`;
const INTENT_NOUN_PATTERN = String.raw`(?:거|예정|계획|생각|작정|마음|참)`;
const INTENDED_CONTAINER_INGESTION_PATTERN = String.raw`(?:먹(?:으려(?:고)?|겠(?:어요|습니다)?|을래(?:요)?|을게(?:요)?|을\s*${INTENT_NOUN_PATTERN}|기로\s*(?:했|결정했)|고\s*말겠(?:어요|습니다)?)|먹어\s*버리(?:려(?:고)?|겠(?:어요|습니다)?)|먹어\s*버릴(?:래(?:요)?|게(?:요)?|\s*${INTENT_NOUN_PATTERN})|삼키(?:려(?:고)?|겠(?:어요|습니다)?|기로\s*(?:했|결정했))|삼킬(?:래(?:요)?|게(?:요)?|\s*${INTENT_NOUN_PATTERN})|삼켜\s*버리(?:려(?:고)?|겠(?:어요|습니다)?)|삼켜\s*버릴(?:래(?:요)?|게(?:요)?|\s*${INTENT_NOUN_PATTERN})|복용(?:하려(?:고)?|하겠(?:어요|습니다)?|하기로\s*(?:했|결정했))|복용할(?:래(?:요)?|게(?:요)?|\s*${INTENT_NOUN_PATTERN})|마시(?:려(?:고)?|겠(?:어요|습니다)?|기로\s*(?:했|결정했))|마실(?:래(?:요)?|게(?:요)?|\s*${INTENT_NOUN_PATTERN})|들이키(?:려(?:고)?|겠(?:어요|습니다)?|기로\s*(?:했|결정했))|들이킬(?:래(?:요)?|게(?:요)?|\s*${INTENT_NOUN_PATTERN}))`;
const CONTAINER_INGESTION_PATTERN = String.raw`(?:${PAST_CONTAINER_INGESTION_PATTERN}|${INTENDED_CONTAINER_INGESTION_PATTERN})`;
const POTENTIAL_INGESTION_ROOT_PATTERN = String.raw`(?:먹(?!고\s*있)|삼키|삼켜|삼켰|복용(?!하고\s*있)|마시(?!고\s*있)|마셨|마셔\s*치웠|들이키|들이켰|들이부|들이부었|넘기|넘겼|원샷|꿀꺽|흡입|털어\s*넣|털어넣)`;
const MEDICATION_CONTEXT_GAP_PATTERN = String.raw`(?:(?!(?:먹|삼키|삼켜|복용|마시|들이키|들이부|보관|구매|물\s|밥\s|음식\s|음료\s|주스\s|우유\s|커피\s|차\s|과자\s|(?:고|지만|는데|면서)\s))[^.!?。！？\n]){0,32}`;
const BROAD_QUANTITY_PATTERN = String.raw`(?:\d+(?:\.\d+)?|반|몇|여러|수십|한두|두어|두세|서너|너댓|대여섯|${NATIVE_CONTAINER_TENS_PATTERN}(?:${NATIVE_CONTAINER_ONES_PATTERN})?|${NATIVE_CONTAINER_ONES_PATTERN}|하나|둘|셋|넷)`;
const BROAD_NON_ROUTINE_UNIT_PATTERN = String.raw`(?!(?:알|정|캡슐|개|회|번)(?:씩)?(?:\s|을|를|이|가|은|는|도|만|$))(?!(?:하루|매일|아침|점심|저녁|밤|주|개월|달|시간|분)(?:\s|에|마다|$))(?!(?:물|밥|음식|음료|주스|우유|커피|차|과자|공기)(?:\s|을|를|이|가|은|는|도|만|$))[\p{L}]{1,6}`;
const MEDICATION_CONTEXT_PRONOUN_PATTERN = String.raw`(?:남은\s*(?:건|것|약)|그중(?:에서)?|그\s*약|그걸|그것(?:을|은|도)?|나머지(?:를|는|도)?)`;

const POTENTIAL_SELF_HARM_PATTERNS = [
  /(?:자살|자해)(?:하(?:려|겠|고\s*싶|기로|지\s*않)|할\s*(?:까|지|거|것|생각|계획|작정|예정|마음|각오))/i,
  /죽(?:고\s*싶|으려|을\s*(?:거|것|생각|계획|작정|예정|마음|각오)|기로|어야|어\s*버리|을까|을지)/i,
  /목숨(?:을)?\s*끊(?:으려|을|겠|기로|을까|을지)/i,
  /극단적(?:인)?\s*선택(?:을)?\s*(?:하|할|하려|하기|할까|할지)/i,
  /(?:삶|생)(?:을)?\s*(?:끝내|마감하)/i,
  /세상(?:을)?\s*떠나/i,
  /죽을\s*(?:셈|의향|의도)/i,
  /(?:목숨|삶|생)(?:을)?\s*(?:버리|포기하|포기할|내놓|끝내|접(?:으려|을))/i,
  /(?:깨어나지\s*않아도|눈을\s*뜨지\s*않아도)\s*(?:좋|괜찮)/i,
  /(?:영원히|그냥)\s*(?:사라지|없어지)(?:고\s*싶|고자|려)/i
];

const EMERGENCY_PATTERNS = [
  /과다\s*복용|과량\s*복용|과\s*복용/i,
  /숨(?:을|이)?\s*(?:전혀\s*)?(?:잘\s*)?(?:못|안)\s*쉬/i,
  /숨(?:을)?\s*쉴\s*수가?\s*없/i,
  /숨\s*쉬기가?\s*(?:어렵|힘들)/i,
  /숨(?:이)?\s*(?:(?:너무|매우|몹시|심하게)\s*)?(?:막히|가쁘|가빠|넘어가)/i,
  /숨(?:이|가)?\s*(?:차|찬|참|차오르)/i,
  /목(?:이|을)?\s*(?:조이|조여|막히)/i,
  /입술(?:이|가|을)?\s*(?:(?:퉁퉁|심하게|갑자기)\s*)?(?:붓|부어|부었|파래)/i,
  /(?:의식|정신)(?:이|을)?\s*(?:없|잃|흐리|흐려)/i,
  /가슴(?:\s*(?:중앙|한가운데|가운데|쪽))?(?:이|가|을)?\s*(?:(?:너무|심하게|몹시|꽉)\s*)?(?:아프|아파|조이|조여|답답)/i,
  /(?:흉통|가슴\s*통증)(?:이|가)?\s*(?:너무|아주|심해|심하|극심)/i,
  /(?:지금|현재|갑자기)[^.!?]{0,20}(?:흉통|가슴\s*통증)(?:이|가)?\s*(?:있|생겼|느껴)/i,
  /(?:흉통|가슴\s*통증)(?:이|가)?\s*(?:지금|현재)?\s*(?:있|생겼|느껴)/i,
  /실신|기절|경련|발작/i,
  /약을\s*(?:너무\s*)?(?:많이|과하게|왕창)\s*(?:먹|삼켰|복용)/i,
  /(?:약|수면제|진통제|해열제|감기약|혈압약)\s*(?:을|를)?\s*(?:여러|수십|몇십)\s*(?:알|정|캡슐|개)\s*(?:먹|삼켰|복용)/i,
  new RegExp(
    String.raw`(?:수면제|마약성\s*진통제)${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${CONTAINER_MODIFIER_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}\s*${POST_CONTAINER_QUALIFIER_PATTERN}${POST_CONTAINER_MODIFIER_PATTERN}(?:(?:다|전부|모두)\s*)?${CONTAINER_INGESTION_PATTERN}`,
    "iu"
  ),
  /(?:죽으려(?:고)?|죽을려고|죽고\s*싶(?:어|어서)?|죽을\s*생각으로|살기\s*싫(?:어|어서)?|자살(?:하)?려고|자해(?:하)?려고|목숨(?:을)?\s*끊으려고|극단적(?:인)?\s*선택(?:을)?\s*하려고)/i,
  /(?:죽(?:고\s*싶(?:어|어서|다)?|으?려(?:고)?|을래(?:요)?|겠(?:어요|습니다)?|어야지|을\s*(?:생각|계획|작정))|자살(?:하(?:고\s*싶|려(?:고)?|겠|기로)|할\s*(?:래(?:요)?|게(?:요)?|거|생각|계획|작정))|자해(?:하(?:고\s*싶|려(?:고)?|겠|기로)|할\s*(?:래(?:요)?|게(?:요)?|거|생각|계획|작정)))/i,
  /(?:죽(?:을\s*(?:거(?:야|예요)?|것(?:이다|이에요)?)|기로\s*(?:했|결정했)|어\s*버릴(?:래|게|거)|어버릴(?:래|게|거))|목숨(?:을)?\s*끊을(?:래|게|거)|극단적(?:인)?\s*선택(?:을)?\s*할(?:래|게|거))/i,
  /(?:죽을\s*(?:예정|마음|각오)|(?:삶|생)(?:을)?\s*마감할(?:래|게|거)|세상(?:을)?\s*떠날(?:래|게|거))/i,
  /(?:죽을\s*(?:셈|의향|의도)|목숨(?:을)?\s*(?:버릴|내놓을)(?:래|게|거|셈|생각|계획|작정)?|(?:삶|생)(?:을)?\s*(?:포기하(?:려|겠|기로)|포기할\s*(?:래|게|거|셈|생각|계획|작정)|끝낼\s*(?:래|게|거|셈)|접을\s*(?:래|게|거|셈)))/i,
  /일부러\s*[^,.!?]{0,30}(?:약|수면제|진통제)\s*(?:을|를)?\s*(?:먹|삼켰|복용)/i,
  /(\d+|[한두세네다섯여섯일곱여덟아홉열일이삼사오육칠팔구십백]+)\s*(알|정|캡슐)\s*(을|를)?\s*(다|전부|모두)\s*(먹|삼켰|복용)/i,
  new RegExp(
    String.raw`(?:약|수면제|진통제|해열제|감기약|혈압약)${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${CONTAINER_MODIFIER_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}\s*${POST_CONTAINER_QUALIFIER_PATTERN}${POST_CONTAINER_MODIFIER_PATTERN}(?:(?:다|전부|모두)\s*)?${CONTAINER_INGESTION_PATTERN}`,
    "iu"
  ),
  new RegExp(
    String.raw`(?:약|수면제|진통제|해열제|감기약|혈압약)${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}(?:통|병|봉지|봉|팩|박스|상자|갑|묶음|포|시트|판)째로\s*${POST_CONTAINER_MODIFIER_PATTERN}${CONTAINER_INGESTION_PATTERN}`,
    "iu"
  )
];

const NEGATED_EMERGENCY_PATTERNS = [
  /호흡\s*곤란(?:\s*증상)?(?:은|이|도)?\s*(?:전혀\s*|아예\s*|현재\s*)?(?:없(?!지)(?:어요|습니다|다)?|아니(?:에요|다)?)/gi,
  /(?:가슴\s*통증|흉통)(?:은|이|도)?\s*(?:전혀\s*|아예\s*|현재\s*)?(?:없(?!지)(?:어요|습니다|다)?|아니(?:에요|다)?)/gi,
  /(?:의식|정신)\s*저하(?:\s*증상)?(?:는|은|이|도)?\s*(?:전혀\s*|아예\s*|현재\s*)?(?:없(?!지)(?:어요|습니다|다)?|아니(?:에요|다)?)/gi,
  /과(?:다|량)?\s*복용(?:은|이|도|한)?\s*(?:적(?:은|이)?\s*)?(?:전혀\s*)?(?:없(?:어요|습니다|다)?|아니(?:에요|다)?|하지\s*않(?:았어요|았습니다|다)?)/gi,
  /약(?:을|를)?\s*(?:너무\s*)?(?:많이|과하게|왕창)\s*(?:먹|삼키|복용하)(?:지(?:는)?\s*않(?:았어요|았습니다|다|아요|습니다)?)/gi,
  /가슴(?:이|을)?\s*(?:너무\s*|심하게\s*|몹시\s*)?(?:아프|아파|조이|답답)(?:지\s*않(?:아요|습니다|다)?)/gi,
  /숨\s*(?:쉬기|을\s*쉬기)?\s*(?:힘들|어렵)(?:지)?\s*않(?:아요|습니다|다)?/gi,
  /(?:죽으려(?:고)?|죽을려고|죽고\s*싶|죽을\s*생각|살기\s*싫|자살(?:하)?려고|자해(?:하)?려고|목숨(?:을)?\s*끊으려|극단적(?:인)?\s*선택)[^.!?]{0,50}(?:아니(?:에요|다|고|고요)?|않(?:았|아|아요|습니다|다)?)/gi,
  /(?:죽(?:을래|겠|어야지|을\s*(?:생각|계획|작정))|자살할\s*(?:래|게|생각|계획|작정)|자해할\s*(?:래|게|생각|계획|작정))[^.!?]{0,50}(?:없(?:어요|습니다|다)?|아니(?:에요|다|고|고요)?|않(?:았|아|아요|습니다|다)?|안\s*했(?:어요|습니다|다)?)/gi,
  /(?:자살|자해)(?:은|는|을|를)?\s*(?:절대\s*)?(?:하지\s*않(?:을|았|아요|습니다|다)?|안\s*해(?:요|습니다|다)?|할\s*(?:생각|계획|예정|마음|의도)(?:은|이)?\s*없(?:어요|습니다|다)?)/gi,
  /(?:삶|생)(?:을)?\s*(?:끝내|마감하)지\s*않(?:을|았|아요|습니다|다)?/gi,
  /(?:목숨|삶|생)(?:을)?\s*(?:버리|포기하|내놓|끝내|접)(?:지\s*(?:말(?:자|아요|라)?|않(?:아|아요|습니다|을)?)|(?:으)?면\s*안\s*돼)/gi,
];

const NEGATED_MEDICATION_INTENT_PATTERNS = [
  new RegExp(
    String.raw`([\p{L}\p{N}._+-]{2,40}?)${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${CONTAINER_MODIFIER_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}\s*${POST_CONTAINER_QUALIFIER_PATTERN}${POST_CONTAINER_MODIFIER_PATTERN}${INTENDED_CONTAINER_INGESTION_PATTERN}[^.!?]{0,40}(?:아니(?:에요|다|고|고요)?|않(?:았|아|아요|습니다|다)?|없(?:어요|습니다|다)?)`,
    "giu"
  )
];

const DOUBLE_NEGATED_EMERGENCY_PATTERNS = [
  /(?:호흡\s*곤란|흉통|가슴\s*통증|의식\s*저하)(?:은|는|이|가)?\s*없(?:지|지는)\s*않/i,
  /숨(?:이)?\s*차(?:지|지는)\s*않은\s*게\s*아니/i
];

const RESOLVED_PAST_EMERGENCY_PATTERNS = [
  /(?:예전에|과거에|지난번에)[^.!?]{0,40}(?:의식(?:을|이)?\s*(?:잃|없)|기절|실신)[^.!?]{0,40}(?:지금|현재)(?:은|는)?\s*(?:괜찮|문제\s*없)/gi,
  /(?:예전에|과거에|지난번에)[^.!?]{0,40}(?:호흡\s*곤란|흉통|가슴\s*통증)[^.!?]{0,40}(?:지금|현재)(?:은|는)?\s*(?:괜찮|증상\s*없|문제\s*없)/gi
];

export function hasEmergencySignal(text: string, medicationNames: string[] = []): boolean {
  const raw = text.normalize("NFKC").toLowerCase();
  if (
    actionableSafetyClauses(raw).some((clause) =>
      DOUBLE_NEGATED_EMERGENCY_PATTERNS.some((pattern) => pattern.test(clause))
    )
  ) {
    return true;
  }
  const normalized = actionableSafetyClauses(
    stripNegatedEmergencyPhrases(stripResolvedPastEmergencyPhrases(raw))
  ).join(". ");
  if (!normalized) return false;
  return emergencyClauses(normalized).some(
    (clause) =>
      hasNumericOverdose(clause) ||
      hasMedicationBoundOverdose(clause, medicationNames) ||
      hasContextualContainerOverdose(clause, medicationNames) ||
      (!isInformationalEmergencyQuestion(clause) &&
        (containsAny(clause, EMERGENCY_TERMS) ||
          EMERGENCY_PATTERNS.some((pattern) => pattern.test(clause))))
  );
}

export function hasPotentialOverdoseSignal(
  text: string,
  medicationNames: string[] = []
): boolean {
  const raw = text.normalize("NFKC").toLowerCase();
  const normalizedClauses = actionableSafetyClauses(
    stripNegatedEmergencyPhrases(stripResolvedPastEmergencyPhrases(raw))
  );
  const normalized = normalizedClauses.join(". ");
  if (!normalized) return false;
  if (
    normalizedClauses.some(
      (clause) =>
        !isInformationalEmergencyQuestion(clause) &&
        POTENTIAL_SELF_HARM_PATTERNS.some((pattern) => pattern.test(clause))
    )
  ) {
    return true;
  }
  if (
    medicationNames.length > 0 &&
    normalizedClauses.some((clause) => hasPotentialContainerIngestion(clause))
  ) {
    return true;
  }
  if (
    medicationNames.length > 0 &&
    normalizedClauses.some((clause) => hasContextualBroadUnitIngestion(clause))
  ) {
    return true;
  }
  const triageText = stripRoutineMedicationDosePhrases(normalized, medicationNames);
  const suffix = String.raw`${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${CONTAINER_MODIFIER_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}[^.!?]{0,64}${POTENTIAL_INGESTION_ROOT_PATTERN}`;
  for (const alias of medicationEmergencyAliases(medicationNames)) {
    const escaped = escapeRegExp(alias);
    if (hasActionablePotentialMatch(triageText, new RegExp(`${escaped}${suffix}`, "iu"), alias)) {
      return true;
    }
    if (
      hasActionablePotentialMatch(
        triageText,
        new RegExp(
          String.raw`${CONTAINER_MODIFIER_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}\s*(?:의\s*)?${escaped}${MEDICATION_PARTICLE_PATTERN}[^.!?]{0,64}${POTENTIAL_INGESTION_ROOT_PATTERN}`,
          "iu"
        ),
        alias
      )
    ) {
      return true;
    }
    if (
      hasActionablePotentialMatch(
        triageText,
        new RegExp(
          String.raw`${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${MEDICATION_CONTEXT_GAP_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}${MEDICATION_CONTEXT_GAP_PATTERN}${POTENTIAL_INGESTION_ROOT_PATTERN}`,
          "iu"
        ),
        alias
      )
    ) {
      return true;
    }
    if (
      hasActionablePotentialMatch(
        triageText,
        new RegExp(
          String.raw`${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}${MEDICATION_CONTEXT_GAP_PATTERN}${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_CONTEXT_GAP_PATTERN}${POTENTIAL_INGESTION_ROOT_PATTERN}`,
          "iu"
        ),
        alias
      )
    ) {
      return true;
    }
    if (
      hasActionablePotentialMatch(
        triageText,
        new RegExp(
          String.raw`${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${MEDICATION_CONTEXT_GAP_PATTERN}${BROAD_QUANTITY_PATTERN}\s*${BROAD_NON_ROUTINE_UNIT_PATTERN}${MEDICATION_CONTEXT_GAP_PATTERN}${POTENTIAL_INGESTION_ROOT_PATTERN}`,
          "iu"
        ),
        alias
      )
    ) {
      return true;
    }
    if (
      hasActionablePotentialMatch(
        triageText,
        new RegExp(
          String.raw`${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${MEDICATION_CONTEXT_GAP_PATTERN}${BROAD_NON_ROUTINE_UNIT_PATTERN}\s*${BROAD_QUANTITY_PATTERN}${MEDICATION_CONTEXT_GAP_PATTERN}${POTENTIAL_INGESTION_ROOT_PATTERN}`,
          "iu"
        ),
        alias
      )
    ) {
      return true;
    }
  }
  if (new RegExp(
    String.raw`(?:약|수면제|진통제|해열제|감기약|혈압약)${suffix}`,
    "iu"
  ).test(triageText)) {
    return true;
  }
  return new RegExp(
    String.raw`(?:약|수면제|진통제|해열제|감기약|혈압약)${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${MEDICATION_CONTEXT_GAP_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}${MEDICATION_CONTEXT_GAP_PATTERN}${POTENTIAL_INGESTION_ROOT_PATTERN}`,
    "iu"
  ).test(triageText);
}

function stripRoutineMedicationDosePhrases(text: string, medicationNames: string[]): string {
  let stripped = text;
  const timing = String.raw`(?:(?:하루|매일|아침|점심|저녁|밤|식전|식후|취침\s*전|필요할\s*때)\s*)*`;
  const lowQuantity = String.raw`(?:1|2|3|한|하나|두|둘|세|셋)`;
  const routineUnit = String.raw`(?:알|정|캡슐|개|회|번)(?:씩)?`;
  for (const alias of medicationEmergencyAliases(medicationNames)) {
    const pattern = new RegExp(
      String.raw`${escapeRegExp(alias)}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${timing}${lowQuantity}\s*${routineUnit}[^.!?]{0,20}?(?:먹|복용)`,
      "giu"
    );
    stripped = stripped.replace(pattern, " [일상 복용량] ");
  }
  return stripped;
}

function hasMedicationBoundOverdose(text: string, medicationNames: string[]): boolean {
  for (const alias of medicationEmergencyAliases(medicationNames)) {
    const escaped = escapeRegExp(alias);
    const patterns = [
      new RegExp(
        String.raw`${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${CONTAINER_MODIFIER_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}\s*${POST_CONTAINER_QUALIFIER_PATTERN}${POST_CONTAINER_MODIFIER_PATTERN}(?:(?:다|전부|모두)\s*)?${CONTAINER_INGESTION_PATTERN}`,
        "iu"
      ),
      new RegExp(
        String.raw`${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${CONTAINER_MODIFIER_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}[^.!?]{0,48}(?:물|음료|주스|우유|차)(?:과|와)?\s*함께\s*${PAST_CONTAINER_INGESTION_PATTERN}`,
        "iu"
      ),
      new RegExp(
        String.raw`${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}(?:여러|수십|몇십|많은)\s*(?:알|정|캡슐|개)\s*(?:을|를)?\s*(?:먹었|먹었다|삼켰|복용했)`,
        "iu"
      ),
      new RegExp(
        String.raw`${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}(?:너무\s*많이|과하게|왕창)\s*(?:먹었|먹었다|삼켰|복용했)`,
        "iu"
      ),
      new RegExp(
        String.raw`${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}(?:통|병|봉지|봉|팩|박스|상자|갑|묶음|포|시트|판)째로\s*${POST_CONTAINER_MODIFIER_PATTERN}${CONTAINER_INGESTION_PATTERN}`,
        "iu"
      ),
      new RegExp(
        String.raw`${escaped}\s*\[부정된 복용 의도\][^.!?]{0,40}(?:하지만|그러나|그런데|다만)?\s*(?:실수로|결국)?\s*${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}\s*${POST_CONTAINER_QUALIFIER_PATTERN}${POST_CONTAINER_MODIFIER_PATTERN}${PAST_CONTAINER_INGESTION_PATTERN}`,
        "iu"
      ),
      new RegExp(
        String.raw`${CONTAINER_MODIFIER_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}\s*(?:의\s*)?${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${POST_CONTAINER_MODIFIER_PATTERN}(?:(?:다|전부|모두)\s*)?${CONTAINER_INGESTION_PATTERN}`,
        "iu"
      ),
      new RegExp(
        String.raw`${escaped}${MEDICATION_PARTICLE_PATTERN}${MEDICATION_SEPARATOR_PATTERN}${CONTAINER_MODIFIER_PATTERN}${CONTAINER_UNIT_PATTERN}\s*${CONTAINER_QUANTITY_PATTERN}\s*${POST_CONTAINER_QUALIFIER_PATTERN}${POST_CONTAINER_MODIFIER_PATTERN}(?:(?:다|전부|모두)\s*)?${CONTAINER_INGESTION_PATTERN}`,
        "iu"
      )
    ];
    if (patterns.some((pattern) => pattern.test(text))) return true;
  }
  return false;
}

function hasContextualContainerOverdose(text: string, medicationNames: string[]): boolean {
  if (medicationNames.length === 0) return false;
  return new RegExp(
    String.raw`${MEDICATION_CONTEXT_PRONOUN_PATTERN}[^.!?]{0,24}${CONTAINER_MODIFIER_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}\s*${POST_CONTAINER_QUALIFIER_PATTERN}${POST_CONTAINER_MODIFIER_PATTERN}(?:(?:다|전부|모두)\s*)?${CONTAINER_INGESTION_PATTERN}`,
    "iu"
  ).test(text);
}

function hasContextualBroadUnitIngestion(text: string): boolean {
  return new RegExp(
    String.raw`${MEDICATION_CONTEXT_PRONOUN_PATTERN}[^.!?]{0,24}${BROAD_QUANTITY_PATTERN}\s*${BROAD_NON_ROUTINE_UNIT_PATTERN}[^.!?]{0,40}${POTENTIAL_INGESTION_ROOT_PATTERN}`,
    "iu"
  ).test(text);
}

function hasPotentialContainerIngestion(text: string): boolean {
  const amounts = text.matchAll(
    new RegExp(String.raw`${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN}`, "giu")
  );
  for (const match of amounts) {
    if (match.index === undefined) continue;
    const before = text.slice(Math.max(0, match.index - 32), match.index);
    const afterStart = match.index + match[0].length;
    const after = text.slice(afterStart, afterStart + 64);
    const ingestionMatch = new RegExp(POTENTIAL_INGESTION_ROOT_PATTERN, "iu").exec(after);
    if (!ingestionMatch) continue;
    const bridge = after.slice(0, ingestionMatch.index);
    if (
      hasUnrelatedObjectAfterPossession(`${before} ${bridge}`) &&
      !isDirectCoadministrationBridge(bridge)
    ) {
      continue;
    }
    if (hasFoodOrDrinkObject(`${before} ${bridge}`) && !isDirectCoadministrationBridge(bridge)) {
      continue;
    }
    return true;
  }
  return false;
}

function hasActionablePotentialMatch(text: string, pattern: RegExp, medicationAlias: string): boolean {
  const match = pattern.exec(text)?.[0];
  return Boolean(match && !hasUnrelatedObjectAfterPossession(match, medicationAlias));
}

function hasUnrelatedObjectAfterPossession(text: string, medicationAlias = ""): boolean {
  const possession = /(?:처방|잔량|남(?:았|아\s*있|은|는)|보유|샀|사\s*왔|구매|보관|결제|주문|재고|배송|준비(?:해|했)?\s*뒀)/i.exec(
    text
  );
  if (!possession || possession.index === undefined) return false;
  const tail = text.slice(possession.index + possession[0].length);
  const ingestion = new RegExp(POTENTIAL_INGESTION_ROOT_PATTERN, "iu").exec(tail);
  const bridge = ingestion ? tail.slice(0, ingestion.index) : tail;
  return hasUnrelatedObject(bridge, medicationAlias);
}

function hasUnrelatedObject(text: string, medicationAlias = ""): boolean {
  for (const match of text.matchAll(/([가-힣]{1,16})(?:을|를)/gu)) {
    const noun = match[1] ?? "";
    if (
      /^(?:그것|나머지|약|알약|정제|캡슐)$/u.test(noun) ||
      noun.endsWith("약") ||
      (medicationAlias && noun.includes(medicationAlias))
    ) {
      continue;
    }
    return true;
  }
  const allowedTokens = /^(?:했|했고|받고|는데|인데|이며|이고|중이며|중이고|중인데|라서|후|뒤|나서|있는|걸|그런데|하지만|그러나|다만|그걸|그것|그중|나머지|다|전부|모두|결국|방금|실제로|바로|곧|함께|물과)$/u;
  for (const token of text.match(/[가-힣]{1,16}/gu) ?? []) {
    if (allowedTokens.test(token)) continue;
    if (medicationAlias && token.includes(medicationAlias)) continue;
    return true;
  }
  return false;
}

function isMedicationPossessionContext(text: string): boolean {
  return /(?:처방|잔량|남(?:았|아\s*있|은|는)|보유|샀|사\s*왔|구매|보관|결제|주문|재고|배송|준비(?:해|했)?\s*뒀)/i.test(
    text
  );
}

function hasFoodOrDrinkObject(text: string): boolean {
  return /(?:물|밥|음식|음료|주스|우유|커피|차|과자|점심|아침|저녁|식혜|막걸리|콜라|술|맥주|소주|라면|사과|죽)(?:을|를|과|와|이랑|하고)?(?:\s|$)/i.test(
    text
  );
}

function isDirectCoadministrationBridge(text: string): boolean {
  return /(?:^|\s)(?:물|음료|주스|우유|차)(?:과|와)?\s*함께\s*$/i.test(
    text
  );
}

function medicationEmergencyAliases(names: string[]): string[] {
  const aliases = new Set<string>();
  const formulationSuffix =
    /(?:서방정|장용정|연질캡슐|캡슐제|현탁액|건조시럽|주사액|주사제|캡슐|정제|시럽|크림|연고|산제|정|액|산)$/u;
  for (const name of names) {
    const primaryName = name.normalize("NFKC").split(/[([]/u, 1)[0] ?? "";
    const stem = medicationSearchStem(primaryName);
    for (const candidate of [stem, stem.replace(formulationSuffix, "")]) {
      const compact = candidate.replace(/\s+/g, "");
      if (compact.length >= 2) aliases.add(compact);
    }
  }
  return Array.from(aliases).sort((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeSafetyText(text: string): string {
  const normalized = text.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  const replaced = BANNED_REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    normalized
  );
  return escapeAngleBrackets(replaced).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function sanitizeStructuredContent<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeSafetyText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredContent(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sanitizeStructuredContent(nested)])
    ) as T;
  }
  return value;
}

export function sanitizeSafetyResult(result: SafetyResult): SafetyResult {
  return sanitizeStructuredContent(result);
}

export function verdictFrom(
  result: Omit<SafetyResult, "verdict" | "dataAsOf" | "disclaimer">
): Verdict {
  if (result.findings.some((finding) => finding.level === "RED")) return "WARN";
  if (result.unresolved.length > 0 || result.failedTypes.length > 0) return "UNCERTAIN";
  if (result.findings.some((finding) => finding.level === "YELLOW")) return "CAUTION";
  return "NO_KNOWN_FINDINGS";
}

export function formatSafetyResult(result: SafetyResult): string {
  if (result.findings.some((finding) => finding.type === "EMERGENCY")) {
    return sanitizeSafetyText(
      [
        "🚨 즉시 119 또는 응급실에 연락하세요.",
        "",
        "응급 신호가 감지되어 약물 상호작용 조회보다 긴급 도움 요청을 우선합니다.",
        "의식이 없거나 호흡이 어렵다면 지체하지 마세요.",
        "",
        "────────",
        result.disclaimer
      ].join("\n")
    );
  }

  const redCount = result.findings.filter((finding) => finding.level === "RED").length;
  const yellowCount = result.findings.filter((finding) => finding.level === "YELLOW").length;
  const signal = result.verdict === "WARN" ? "🔴" : result.verdict === "NO_KNOWN_FINDINGS" ? "🟢" : "🟡";
  const headline =
    result.verdict === "NO_KNOWN_FINDINGS"
      ? `${signal} 현재 핵심 조회 범위에서 등록된 위험을 찾지 못함`
      : result.verdict === "WARN"
        ? `${signal} 금기 ${redCount}건 / 주의 ${yellowCount}건`
        : result.findings.length === 0
          ? `${signal} 추가 확인 필요`
          : `${signal} 주의 정보 ${yellowCount}건 (🔴 금기 ${redCount}건)`;

  const lines = [headline, ""];
  for (const finding of result.findings) {
    lines.push(`• [${finding.type}] ${finding.a}${finding.b ? ` × ${finding.b}` : ""}`);
    lines.push(`  → ${finding.reason}`);
    if (needsMappingCaveat(finding)) {
      lines.push("  이 약이 아니면 이 경고는 무시하세요. 이미 처방받은 조합일 수 있으니 임의 중단 전 의사·약사에게 문의하세요.");
    }
    lines.push(
      `  출처: ${finding.source} · ${dateBasisLabel(finding.dateBasis)} ${finding.baseDate}`
    );
  }

  if (result.unresolved.length > 0) {
    lines.push("");
    lines.push(`※ 특정하지 못한 항목: ${result.unresolved.join(", ")}`);
  }

  if (result.failedTypes.length > 0) {
    lines.push("");
    lines.push(`※ 일부 조회 실패: ${Array.from(new Set(result.failedTypes)).join(", ")}. 이 경우 녹색으로 표시하지 않습니다.`);
  }

  const usjntCheckedWithoutFailure =
    result.checkedTypes.includes("USJNT_TABOO") && !result.failedTypes.includes("USJNT_TABOO");
  if (redCount === 0 && usjntCheckedWithoutFailure) {
    lines.push("");
    lines.push("※ 등록된 병용금기는 조회되지 않았습니다(안전을 보장하는 것은 아닙니다).");
  }

  lines.push(SCOPE_NOTICE);
  lines.push("이미 처방받은 조합일 수 있으니 임의 중단 전 약사·의사에게 문의하세요.");
  lines.push("");
  lines.push("────────");
  lines.push(result.disclaimer);

  return sanitizeSafetyText(lines.join("\n"));
}

function stripNegatedEmergencyPhrases(text: string): string {
  const stripped = NEGATED_EMERGENCY_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, " [부정된 응급표현] "),
    text
  );
  return NEGATED_MEDICATION_INTENT_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "$1 [부정된 복용 의도] "),
    stripped
  );
}

function stripResolvedPastEmergencyPhrases(text: string): string {
  return RESOLVED_PAST_EMERGENCY_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, " [해소된 과거 응급표현] "),
    text
  );
}

function isQuotedOrTranslationEmergencyContext(text: string): boolean {
  return [
    /(?:문장|문구|표현)(?:을|를|의)?[^.!?]{0,80}(?:번역|해석|뜻|의미)/i,
    /(?:번역|해석)(?:해|하|을|이)[^.!?]{0,40}(?:문장|문구|표현)?/i,
    /(?:번역|해석)할\s*(?:문장|문구|표현)/i,
    /(?:영화|드라마|소설|가사|대사|인용)[^.!?]{0,100}(?:라고\s*(?:했|말했)|문장|문구|표현)/i,
    /(?:이|그)\s*표현(?:의|은|이)?[^.!?]{0,40}(?:뜻|의미|번역|해석)/i
  ].some((pattern) => pattern.test(text));
}

function isNonExperientialSelfHarmContext(text: string): boolean {
  return /(?:자살|자해)\s*(?:예방|방지|교육|통계|기사|뉴스|연구|정책|상담|캠페인|단어|표현)/i.test(
    text
  );
}

function hasActualityAfterInformationalMarker(text: string): boolean {
  const informationalIndex = text.search(/(?:번역|해석|뜻|의미)/i);
  if (informationalIndex < 0) return false;
  const tail = text.slice(informationalIndex);
  const actualityIndex = tail.search(
    /(?:실제로|지금|현재|방금|오늘|내가|제가|나는|환자가|엄마가|아빠가)/i
  );
  if (actualityIndex <= 0) return false;
  return !/["'“‘「『]/u.test(tail.slice(0, actualityIndex));
}

function hasSelfHarmIntent(text: string): boolean {
  return (
    POTENTIAL_SELF_HARM_PATTERNS.some((pattern) => pattern.test(text)) ||
    EMERGENCY_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function actionableSafetyClauses(text: string): string[] {
  const clauses = emergencyClauses(text).flatMap((clause) =>
    clause
      .split(/\s+(?=(?:그런데|하지만|그러나|다만)\s)/u)
      .map((part) => part.trim())
      .filter(Boolean)
  );
  return clauses.filter((clause, index) => {
    if (
      isQuotedOrTranslationEmergencyContext(clause) &&
      !hasActualityAfterInformationalMarker(clause)
    ) {
      return false;
    }
    if (isNonExperientialSelfHarmContext(clause) && !hasSelfHarmIntent(clause)) {
      return false;
    }
    const nextClause = clauses[index + 1] ?? "";
    if (
      /(?:이|그)\s*(?:문장|문구|표현)(?:의|은|이)?[^.!?]{0,40}(?:뜻|의미|번역|해석)/i.test(
        nextClause
      ) &&
      !/(?:실제로|지금|현재|방금|내가|제가|나는|환자가|엄마가|아빠가)/i.test(clause)
    ) {
      return false;
    }
    return true;
  });
}

function isInformationalEmergencyQuestion(text: string): boolean {
  const informationalPattern =
    /(?:기준|뜻|의미|정의|어떤\s*증상|무슨\s*증상|뭐(?:예요|야)|무엇(?:인가요|이야)|설명해|알려\s*줘|어떻게\s*구분)/i;
  const informational = informationalPattern.test(text);
  if (!informational) return false;
  if (
    /(?:지금|현재|방금|실제로|제가|내가|환자가|엄마가|아빠가)[^.!?]{0,50}(?:아프|힘들|어렵|없지\s*않|숨[^.!?]{0,12}(?:차|가쁘|가빠|못\s*쉬)|흉통[^.!?]{0,12}있|가슴[^.!?]{0,12}(?:아프|조이|조여)|입술[^.!?]{0,12}(?:붓|부어|부었))/i.test(
      text
    )
  ) {
    return false;
  }
  const experientialClause = text
    .split(/[.!?\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some(
      (clause) =>
        !informationalPattern.test(clause) &&
        (containsAny(clause, EMERGENCY_TERMS) ||
          EMERGENCY_PATTERNS.some((pattern) => pattern.test(clause)))
    );
  return !experientialClause;
}

function emergencyClauses(text: string): string[] {
  return text
    .replace(
      /((?:자살|자해)\s*(?:예방|방지)?\s*(?:교육|자료|통계|기사|뉴스|연구|정책|상담|캠페인)[^.!?\n]{0,30}?(?:후|보다가|보던\s*중|들었|읽었))\s+(?=(?:실제로|지금|현재)?\s*(?:자살|자해))/giu,
      "$1\n"
    )
    .replace(
      /((?:문장|문구|표현)(?:을|를|의)?[^.!?\n]{0,80}(?:번역|해석|뜻|의미)[^.!?\n]{0,20})\s*,\s*/giu,
      "$1\n"
    )
    .replace(
      /\s*,\s*(?=(?:이|그)?\s*(?:문장|문구|표현)(?:의|은|이|을|를)?[^.!?\n]{0,40}(?:뜻|의미|번역|해석))/giu,
      "\n"
    )
    .replace(
      /\s*(?:;|그리고|그런데|하지만|그러나|다만|그래서|그러므로|그러다(?:가)?|그러면서)\s*/gu,
      "\n"
    )
    .replace(
      /((?:들었|읽었|받았|남았|샀|복용했|먹었|마셨|했)(?:지만|고))\s+(?=(?:실제로|지금|현재|방금|나는|내가|제가|타이레놀|약|한\s*통|자살|자해|목숨|삶|생|세상|밥|물|과자))/gu,
      "$1\n"
    )
    .replace(
      new RegExp(
        String.raw`([\p{L}])\.\s*(?=${CONTAINER_MODIFIER_PATTERN}${CONTAINER_QUANTITY_PATTERN}\s*${CONTAINER_UNIT_PATTERN})`,
        "gu"
      ),
      "$1 "
    )
    .split(/(?<!\d)\.(?!\d)|[!?。！？\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function hasNumericOverdose(text: string): boolean {
  const amounts = text.matchAll(/([\d가-힣]{1,8})\s*(?:알|정|캡슐|개)/g);
  for (const match of amounts) {
    const count = medicationCount(match[1]);
    if (count === null || match.index === undefined) continue;
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    const afterStart = match.index + match[0].length;
    const after = text.slice(afterStart, afterStart + 80);
    const ingestionPattern = /(?:먹|삼키|삼켜|삼켰|복용|투여|마시|마셨|들이키|들이켰|넘기|넘겼|원샷|털어\s*넣|털어넣)/i;
    const ingestionMatch = ingestionPattern.exec(after);
    if (!ingestionMatch) continue;
    const bridge = after.slice(0, ingestionMatch.index);
    if (
      hasUnrelatedObjectAfterPossession(bridge) &&
      !isDirectCoadministrationBridge(bridge)
    ) {
      continue;
    }
    if (hasFoodOrDrinkObject(bridge) && !isDirectCoadministrationBridge(bridge)) {
      continue;
    }
    if (count >= 8) return true;
    const immediateIngestion = /^\s*(?:을|를|이나|나)?\s*(?:(?:다|전부|모두|한꺼번에|방금|조금\s*전(?:에)?|오늘|어제|실수로)\s*)*(?:먹|삼키|삼켜|삼켰|복용|투여|마시|마셨|들이키|들이켰|넘기|넘겼|원샷|털어\s*넣|털어넣)/i.test(
      after
    );
    if (!immediateIngestion) continue;
    if (count >= 3 && /(?:수면제|마약성\s*진통제)/i.test(before)) return true;
    if (count >= 3 && /한\s*꺼번\s*에/i.test(`${before} ${after}`)) return true;
  }
  return false;
}

function medicationCount(token: string | undefined): number | null {
  if (!token) return null;
  if (/^\d{1,3}$/.test(token)) return Number(token);
  if (/^(?:십여|수십|수십여|백여|수백|수백여|수천|몇십|여러|많은)$/.test(token)) {
    return 100;
  }

  const nativeOnes: Record<string, number> = {
    한: 1,
    하나: 1,
    두: 2,
    둘: 2,
    세: 3,
    셋: 3,
    네: 4,
    넷: 4,
    다섯: 5,
    여섯: 6,
    일곱: 7,
    여덟: 8,
    아홉: 9
  };
  const nativeTens: Record<string, number> = {
    열: 10,
    스무: 20,
    스물: 20,
    서른: 30,
    마흔: 40,
    쉰: 50,
    예순: 60,
    일흔: 70,
    여든: 80,
    아흔: 90
  };
  if (nativeOnes[token] !== undefined) return nativeOnes[token];
  if (nativeTens[token] !== undefined) return nativeTens[token];
  for (const [prefix, tens] of Object.entries(nativeTens).sort(
    ([left], [right]) => right.length - left.length
  )) {
    if (!token.startsWith(prefix)) continue;
    const ones = nativeOnes[token.slice(prefix.length)];
    if (ones !== undefined) return tens + ones;
  }

  const sinoDigits: Record<string, number> = {
    영: 0,
    일: 1,
    이: 2,
    삼: 3,
    사: 4,
    오: 5,
    육: 6,
    칠: 7,
    팔: 8,
    구: 9
  };
  if (!/^[영일이삼사오육칠팔구십백]+$/.test(token)) return null;
  let total = 0;
  let current = 0;
  for (const character of token) {
    if (character === "백") {
      total += (current || 1) * 100;
      current = 0;
    } else if (character === "십") {
      total += (current || 1) * 10;
      current = 0;
    } else {
      current = sinoDigits[character] ?? 0;
    }
  }
  return total + current;
}

function needsMappingCaveat(finding: SafetyFinding): boolean {
  return (
    finding.level !== "GREEN" &&
    finding.type !== "CONTEXT_UNKNOWN" &&
    finding.type !== "EMERGENCY" &&
    finding.a !== "연령 정보 없음" &&
    finding.a !== "임부 여부 정보 없음"
  );
}

function escapeAngleBrackets(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function emergencyResult(baseDate: string): SafetyResult {
  const finding: SafetyFinding = {
    type: "EMERGENCY",
    origin: "LOCAL_POLICY",
    level: "RED",
    a: "응급 의심 표현",
    b: null,
    reason: "응급 신호가 언급되었습니다. 상호작용 조회보다 119 또는 응급실 상담이 우선입니다.",
    source: "서버 안전정책",
    baseDate,
    dateBasis: "LOCAL_POLICY_DATE"
  };
  return {
    verdict: "WARN",
    dataAsOf: baseDate,
    findings: [finding],
    unresolved: [],
    checkedTypes: [],
    failedTypes: [],
    disclaimer: STANDARD_DISCLAIMER
  };
}

export function potentialOverdoseResult(baseDate: string): SafetyResult {
  const finding: SafetyFinding = {
    type: "CONTEXT_UNKNOWN",
    origin: "LOCAL_POLICY",
    level: "YELLOW",
    a: "과량복용 가능성",
    b: null,
    reason:
      "용기 단위 복용 표현을 명확한 현재 응급상황으로 확정하지 못했습니다. 실제로 복용했거나 복용하려는 상황이면 즉시 119 또는 응급실에 연락하세요.",
    source: "서버 안전정책",
    baseDate,
    dateBasis: "LOCAL_POLICY_DATE"
  };
  return {
    verdict: "UNCERTAIN",
    dataAsOf: baseDate,
    findings: [finding],
    unresolved: ["과량복용 여부 확인 필요"],
    checkedTypes: [],
    failedTypes: ["EMERGENCY_TRIAGE"],
    disclaimer: STANDARD_DISCLAIMER
  };
}

function dateBasisLabel(basis: SafetyFinding["dateBasis"]): string {
  switch (basis) {
    case "SOURCE_DATE":
      return "원천 기준일";
    case "SNAPSHOT_FETCHED_AT":
      return "스냅샷 수집일";
    case "FIXTURE_DATE":
      return "fixture 기준일";
    default:
      return "정책 기준일";
  }
}
