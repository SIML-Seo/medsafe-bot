import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMfDSMaterialIngredients,
  parseMfDSMaterialIngredients
} from "../src/utils/materialName.js";

test("MFDS material parser ignores slashes inside unit remarks", () => {
  const ingredients = parseMfDSMaterialIngredients(
    "메타규산알루민산마그네슘,,,밀리그램,KP,/리파제,,,밀리그램,KP,지방소화력 표시량 6000단위/g",
    []
  );

  assert.deepEqual(
    ingredients.map((ingredient) => ingredient.ingredientName),
    ["메타규산알루민산마그네슘", "리파제"]
  );
  assert.equal(ingredients.some((ingredient) => ingredient.ingredientKey === "g"), false);
});

test("MFDS material parser keeps dose-volume ratios inside one ingredient record", () => {
  const analysis = analyzeMfDSMaterialIngredients(
    "토실리주맙(숙주:CHO DXB11, 벡터:phPM1HL2, 종세포주:CHO V4), - 80mg/4ml,80,밀리그램,별규,/토실리주맙(숙주:CHO DXB11, 벡터:phPM1HL2, 종세포주:CHO V4), - 200mg/10ml,200,밀리그램,별규,/토실리주맙(숙주:CHO DXB11, 벡터:phPM1HL2, 종세포주:CHO V4), - 400mg/20ml,400,밀리그램,별규,",
    []
  );

  assert.deepEqual(
    analysis.ingredients.map((ingredient) => ingredient.ingredientName),
    ["토실리주맙(숙주:CHO DXB11,벡터:phPM1HL2,종세포주:CHO V4)"]
  );
  assert.equal(analysis.complete, true);
  assert.equal(analysis.invalidRecordCount, 0);
});

test("MFDS material parser splits a slash only when another ingredient record follows", () => {
  const ingredients = parseMfDSMaterialIngredients(
    "에제티미브,,,밀리그램,별첨규격(전과동),미분화/로수바스타틴칼슘,,,밀리그램,별첨규격(전과동),미분화",
    []
  );

  assert.deepEqual(
    ingredients.map((ingredient) => ingredient.ingredientName),
    ["에제티미브", "로수바스타틴칼슘"]
  );
});

test("MFDS material parser preserves commas inside an ingredient name", () => {
  const ingredients = parseMfDSMaterialIngredients(
    "첫번째성분,,,밀리그램,KP/1,2-시험성분,,,밀리그램,KP",
    []
  );

  assert.deepEqual(
    ingredients.map((ingredient) => ingredient.ingredientName),
    ["첫번째성분", "1,2-시험성분"]
  );
});

test("HIRA code is not copied to every ingredient in a compound product", () => {
  const ingredients = parseMfDSMaterialIngredients(
    "카제인,,,그램,KP,/비타민A,,,밀리그램,KP,/염화나트륨,,,밀리그램,KP,",
    [{ ingredientName: "카제인", ingredientCode: "529300ALQ" }]
  );

  assert.equal(ingredients.find((item) => item.ingredientKey === "카제인")?.ingredientCode, "529300ALQ");
  assert.equal(ingredients.find((item) => item.ingredientKey === "비타민a")?.ingredientCode, "");
  assert.equal(ingredients.find((item) => item.ingredientKey === "염화나트륨")?.ingredientCode, "");
});

test("a duplicate domestic/export material record can use one matching HIRA code", () => {
  const result = analyzeMfDSMaterialIngredients(
    "와르파린나트륨,,5,밀리그램/와르파린나트륨,,5,밀리그램",
    [{ ingredientCode: "249102ATB", ingredientName: "와르파린나트륨" }]
  );
  assert.equal(result.complete, true);
  assert.equal(result.ingredients.length, 1);
  assert.equal(result.ingredients[0]?.ingredientCode, "249102ATB");
});

test("domestic/export labels are never stored as partial ingredient identities", () => {
  const result = analyzeMfDSMaterialIngredients(
    "유효성분,,1,밀리그램/수출용,,1,밀리그램",
    []
  );
  assert.equal(result.complete, false);
  assert.deepEqual(result.ingredients.map((ingredient) => ingredient.ingredientName), ["유효성분"]);
});

test("MFDS material parser handles the current double-comma record format", () => {
  const analysis = analyzeMfDSMaterialIngredients(
    "암피실린나트륨,1,500,밀리그램,별규,(역가)/설박탐나트륨,1,250,밀리그램,JP,(역가)",
    []
  );

  assert.deepEqual(
    analysis.ingredients.map((ingredient) => ingredient.ingredientName),
    ["암피실린나트륨", "설박탐나트륨"]
  );
  assert.equal(analysis.complete, true);
  assert.equal(analysis.recordCount, 2);
});

test("MFDS material parser marks an unstructured partial record as incomplete", () => {
  const analysis = analyzeMfDSMaterialIngredients(
    "암피실린나트륨,,500,밀리그램,KP/g,,1,그램,KP",
    []
  );
  assert.equal(analysis.ingredients.length, 1);
  assert.equal(analysis.complete, false);
  assert.equal(analysis.invalidRecordCount, 1);
});

test("MFDS material parser handles manufacturing-method and domestic/export metadata", () => {
  const analysis = analyzeMfDSMaterialIngredients(
    "푸르설티아민,1548.225,50,밀리그램,KP/리보플라빈부티레이트,1548.225,2.5,밀리그램,KP/우르소데옥시콜산, - [제1법]내수용1,[제2법]내수용2,50,밀리그램,JP/리팜피신, - 국내용,150,밀리그램,KP,역가",
    []
  );
  assert.deepEqual(
    analysis.ingredients.map((ingredient) => ingredient.ingredientName),
    ["푸르설티아민", "리보플라빈부티레이트", "우르소데옥시콜산", "리팜피신"]
  );
  assert.equal(analysis.complete, true);
});
