// 端到端：课程单位库
// 验收：
//  1) 创建 cfs → 变量计算与 m^3 换算一致；
//  2) A↔B 循环定义被完整拒绝，已有单位继续可用；
//  3) 旧比例公式在修订后保持原值，显式迁移后才采用新版本；
//  4) 导入同名冲突单位包，未迁移公式仍解析原版本，迁移后可追溯，导出文件含库与绑定。
import { chromium } from "playwright";

const URL = "http://localhost:5199/";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector(".app");

const fill = async (sel, text) => { await page.locator(sel).fill(text); };

// 清空上次运行残留（同库名的 IndexedDB）
await page.evaluate(async () => {
  await new Promise((res) => {
    const r = indexedDB.deleteDatabase("dimension-notebook");
    r.onsuccess = r.onerror = r.onblocked = () => res(undefined);
  });
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".app");
await page.getByRole("button", { name: /课程单位库/ }).click();
await page.waitForSelector(".unit-form");

const unitForm = page.locator(".unit-form");
const nameInput = unitForm.locator("input").nth(0);
const factorInput = unitForm.locator("input").nth(1);
const dimInput = unitForm.locator("input").nth(2);
const saveBtn = unitForm.getByRole("button", { name: /保存新单位/ });

// ---------- 1) 创建 cfs ----------
await nameInput.fill("cfs");
await factorInput.fill("0.028316846592");
await dimInput.fill("m^3/s");
await saveBtn.click();
await page.waitForTimeout(300);
check("库列表出现 cfs 条目", await page.locator(".unit-item", { hasText: "cfs" }).count() >= 1);

// 用内置“新建公式”手搓一条 Q*t
await page.getByRole("button", { name: "＋ 新建公式" }).click();
await page.waitForTimeout(200);
let card = page.locator(".card").last();
await card.locator("math-field").evaluate((el, val) => {
  el.setValue(val);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, "Q\\cdot t");
await page.waitForTimeout(300);
// 变量行：Q=10 单位选择 cfs v1；t=2 s
let rows = card.locator(".var-row:not(.var-head)");
await rows.nth(0).locator(".num-input").fill("10");
await rows.nth(0).locator(".unit-input").fill("cfs");
await rows.nth(0).locator(".unit-version-select").selectOption({ label: "cfs v1（最新）" });
await rows.nth(1).locator(".num-input").fill("2");
await rows.nth(1).locator(".unit-input").fill("s");
await page.waitForTimeout(300);
// 结果目标单位 m^3
await card.locator(".unit-result-input").fill("m^3");
await page.waitForTimeout(300);
let resultText = await card.locator(".result-row .tex-box").innerText();
const expected = 10 * 2 * 0.028316846592; // 0.56633693184
check("cfs 变量计算状态为已验证", (await card.locator(".badge").innerText()).includes("已验证"), await card.locator(".badge").innerText());
check(`cfs 换算 m^3 = ${expected}`, resultText.includes("0.5663"), resultText.replace(/\n/g, " "));
check("代入式含 cfs", (await card.locator(".display-area").innerText()).includes("cfs"));

// ---------- 2) A↔B 循环 ----------
const startCreate = async () => {
  await page.getByRole("button", { name: "取消修订（新建）" }).click().catch(() => {});
  await nameInput.waitFor();
};
const defineUnit = async (name, factor, dim) => {
  await startCreate();
  await nameInput.fill(name);
  await factorInput.fill(String(factor));
  await dimInput.fill(dim);
  await saveBtn.click();
  await page.waitForTimeout(200);
};

await defineUnit("rateB", 2, "m/s");
await defineUnit("rateA", 3, "rateB");
// 打开 rateB 的修订表单
await page.locator(".unit-item", { has: page.locator("strong", { hasText: "rateB" }) })
  .getByRole("button", { name: "修订出新版本" }).first().click();
await page.waitForTimeout(100);
// 表单现在是修订模式：改量纲为 A
const reviseForm = page.locator(".unit-form");
await reviseForm.locator("input").nth(2).fill("rateA");
await page.waitForTimeout(200);
// 实时校验识别循环：保存按钮被禁用，且给出循环原因（保存根本无法发生，不留残缺单位）
const reviseBtn = reviseForm.getByRole("button", { name: /生成新版本/ });
const disabled = await reviseBtn.isDisabled();
const liveHint = await reviseForm.locator(".hint-warn").innerText().catch(() => "");
check("rateA↔rateB 循环被实时拒绝（按钮禁用并提示循环）", disabled && liveHint.includes("循环"), `disabled=${disabled} hint=${liveHint.slice(0, 40)}`);
// 已有单位仍可用：cfs 卡片仍然已验证
check("循环被拒后已有 cfs 公式继续已验证", (await card.locator(".badge").innerText()).includes("已验证"));
// 失败保存未产生残缺/新版本（rateB 仍只有 v1）
const rateBItem = page.locator(".unit-item", { has: page.locator("strong", { hasText: "rateB" }) });
check("失败保存未产生残缺/新版本（rateB 仍只有 v1）",
  !(await rateBItem.innerText()).includes("v2"));

// ---------- 3) 修订 cfs 比例：旧公式保持原值，迁移后采用新版本 ----------
await page.locator(".unit-item", { hasText: "cfs" }).getByRole("button", { name: "修订出新版本" }).first().click();
await page.waitForTimeout(100);
const cfsForm = page.locator(".unit-form");
await cfsForm.locator("input").nth(1).fill("0.03");
await cfsForm.getByRole("button", { name: /生成新版本/ }).click();
await page.waitForTimeout(400);

// 旧公式卡片出现旧版本提示条
card = page.locator(".card").last();
let banner = await card.locator(".outdated-banner").innerText().catch(() => "");
check("旧公式出现“绑定旧版本”提示", banner.includes("旧版本"), banner.slice(0, 60));
// 旧结果仍是 0.5663
resultText = await card.locator(".result-row .tex-box").innerText();
check("旧公式修订后结果仍为旧比例 0.5663", resultText.includes("0.5663"), resultText.replace(/\n/g, " "));
check("旧公式未被悄悄改成新比例 0.6", !resultText.replace(/\s/g, "").includes("0.6") || resultText.includes("0.5663"));

// 显式迁移该公式
await card.locator(".outdated-banner .mini-btn").click();
await page.waitForTimeout(400);
resultText = await card.locator(".result-row .tex-box").innerText();
check("显式迁移后结果采用新比例 0.6", resultText.includes("0.6") && !resultText.includes("0.5663"), resultText.replace(/\n/g, " "));
check("迁移后旧版本提示消失", (await card.locator(".outdated-banner").count()) === 0);

// ---------- 4) 导入同名冲突单位包 ----------
// 先把当前库与公式导出成 JSON（作为“另一个课程组”的包基础），
// 但为了制造冲突，我们直接构造一个包：cfs = 1 kg（同名不同量纲），带一条公式。
const conflictPackage = {
  app: "dimension-notebook",
  version: 2,
  exportedAt: new Date().toISOString(),
  unitLibrary: {
    schemaVersion: 1,
    units: [{
      uid: "u_foreign_cfs",
      versions: [{
        version: 1, name: "cfs", factor: 1, dimension: "kg",
        hint: "外来的同名 cfs（质量量纲）", createdAt: Date.now(), deps: [],
      }],
    }],
  },
  formulas: [{
    id: "foreign_f1",
    latex: "M",
    note: "外来公式（同名 cfs 实为 kg）",
    variables: { M: { value: "7", unit: "cfs", unitRef: { uid: "u_foreign_cfs", version: 1, name: "cfs" } } },
    targetUnit: "kg",
    createdAt: Date.now(),
  }],
};
const fileJson = JSON.stringify(conflictPackage);

// 用文件选择器注入
const fileInput = page.locator('input[type="file"]').last();
await fileInput.setInputFiles({
  name: "foreign-units.json",
  mimeType: "application/json",
  buffer: Buffer.from(fileJson),
});
await page.waitForTimeout(400);
// 冲突对话框
await page.waitForSelector(".modal");
const modal = page.locator(".modal");
check("检测到同名冲突并弹窗", (await modal.innerText()).includes("同名冲突"));
check("标明量纲不同", (await modal.innerText()).includes("量纲不同"));
// 受影响公式默认折叠，展开后应列出包内公式与其变量绑定
await modal.getByRole("button", { name: /受影响/ }).click();
await page.waitForTimeout(100);
check("展示包内受影响公式及绑定版本",
  (await modal.locator(".usage-list").innerText()).includes("外来公式") &&
  (await modal.locator(".usage-list").innerText()).includes("cfs v1"),
  (await modal.locator(".usage-list").innerText().catch(() => "")).slice(0, 80));

// 选“隔离”并确认
await modal.getByText(/隔离：两个定义并存/).click();
await page.waitForTimeout(100);
await modal.getByRole("button", { name: /按所选方式导入/ }).click();
await page.waitForTimeout(500);
check("冲突对话框关闭", await page.locator(".modal").count() === 0);

// 外来公式导入后仍按 kg 解析：定位含 kg 结果的卡片
const foreignCard = page.locator(".card", { hasText: "kg" });
await foreignCard.first().waitFor();
const foreignBadge = await foreignCard.first().locator(".badge").innerText();
const foreignResult = await foreignCard.first().locator(".result-row .tex-box").innerText();
check("隔离后外来公式仍按包内定义解析（7 kg、已验证）",
  foreignBadge.includes("已验证") && foreignResult.includes("7"), `${foreignBadge} | ${foreignResult.replace(/\n/g, " ")}`);

// 刷新：IndexedDB 持久化后，两个 cfs 都在，外来公式仍解析 kg，本地公式仍解析迁移后的 v2
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);
const foreignCard2 = page.locator(".card", { hasText: "kg" });
await foreignCard2.first().waitFor();
const fr2 = await foreignCard2.first().locator(".result-row .tex-box").innerText();
check("刷新后外来公式仍解析原定义（7 kg）", fr2.includes("7"), fr2.replace(/\n/g, " "));

// 本地迁移后的公式结果仍是 0.6
const localCard = page.locator(".card", { hasText: "Q" }).first();
// 通过找结果 0.6 的卡片更稳妥
const allCards = page.locator(".card");
const nCards = await allCards.count();
let found06 = false;
for (let i = 0; i < nCards; i++) {
  const t = await allCards.nth(i).locator(".result-row .tex-box").innerText().catch(() => "");
  if (t.includes("0.6")) { found06 = true; break; }
}
check("刷新后本地迁移公式保持新比例结果 0.6", found06);

// 导出 JSON：包含两个版本的库与所有绑定（可追溯）
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "导出 JSON" }).click(),
]);
const path = await download.path();
const content = JSON.parse((await import("fs")).readFileSync(path, "utf8"));
const cfsUnit = content.unitLibrary.units.find((u) => u.versions.some((v) => v.name === "cfs" && v.dimension === "m^3/s"));
check("导出文件含课程单位库", !!content.unitLibrary && Array.isArray(content.unitLibrary.units));
check("导出库保留 cfs 两个版本（v1/v2）", cfsUnit && cfsUnit.versions.length >= 2, cfsUnit ? `${cfsUnit.versions.length} 版本` : "无 cfs");
const foreignFormula = content.formulas.find((f) => f.id === "foreign_f1");
check("导出文件中公式绑定保留（外来公式仍绑 u_foreign_cfs v1）",
  foreignFormula && foreignFormula.variables.M.unitRef.uid === "u_foreign_cfs" && foreignFormula.variables.M.unitRef.version === 1);
const migratedFormula = content.formulas.find((f) => f.variables && f.variables.Q && f.variables.Q.unitRef && f.variables.Q.unitRef.migratedFrom);
check("导出文件中迁移公式带 migratedFrom 留痕",
  !!migratedFormula && migratedFormula.variables.Q.unitRef.version === 2 && migratedFormula.variables.Q.unitRef.migratedFrom.version === 1);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (consoleErrors.length) console.log("浏览器控制台错误：", JSON.stringify(consoleErrors.slice(0, 5), null, 1));
await browser.close();
if (failed.length) process.exit(1);
