// 界面集成测试（happy-dom）：用真实引擎跑通「建单位 → 公式计算 → 修订 → 迁移」。
// MathLive 自定义元素与 IndexedDB 被 mock；量纲计算、版本绑定、持久化结构均为真实代码。
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act, cleanup } from "@testing-library/react";
import { emptyLibrary } from "./engine/courseUnits";

// ---- mock IndexedDB 层（内存） ----
const mem = vi.hoisted(() => ({ formulas: [] as any[], library: null as any }));
vi.mock("./storage/db", () => ({
  newId: () => `f_test_${Math.random().toString(36).slice(2, 8)}`,
  db: {
    all: vi.fn(async () => mem.formulas),
    loadLibrary: vi.fn(async () => ({ lib: mem.library ?? emptyLibrary(), warnings: [] })),
    bulkPut: vi.fn(async (rows: any[]) => { mem.formulas = rows; }),
    saveLibrary: vi.fn(async (lib: any) => { mem.library = lib; }),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  },
}));

// ---- mock MathLive：textarea 即可 ----
vi.mock("./components/MathInput", () => ({
  default: ({ value, onChange }: { value: string; onChange: (s: string) => void }) => (
    <textarea
      aria-label="math-input-mock"
      data-testid="math"
      value={value}
      onChange={(e) => onChange((e.target as HTMLTextAreaElement).value)}
    />
  ),
}));

import App from "./App";

beforeEach(() => {
  mem.formulas = [];
  mem.library = emptyLibrary();
});

afterEach(() => {
  cleanup();
});

function openLibrary() {
  return act(async () => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>(".topbar button")]
      .find((b) => b.textContent?.includes("课程单位库"))!;
    fireEvent.click(btn);
  });
}

async function createUnit(name: string, label: string, factor: string, def: string) {
  const inputs = document.querySelectorAll(".lib-form input");
  fireEvent.change(inputs[0], { target: { value: name } });
  fireEvent.change(inputs[1], { target: { value: label } });
  fireEvent.change(inputs[2], { target: { value: factor } });
  fireEvent.change(inputs[3], { target: { value: def } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "创建单位" })); });
}

describe("界面：场景 1 创建 cfs 后变量计算与 m³/s 换算一致", () => {
  it("全流程", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/还没有公式/)).toBeTruthy());

    await openLibrary();
    await createUnit("cfs", "立方英尺每秒", "1", "ft^3/s");
    expect(document.querySelector(".lib-unit-name")?.textContent).toContain("cfs");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "关闭 ✕" })); });

    // 新建公式 Q
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "＋ 新建公式" })); });
    const card = document.querySelector(".card")!;
    fireEvent.change(within(card as HTMLElement).getByTestId("math"), { target: { value: "Q" } });
    await waitFor(() => expect(within(card as HTMLElement).getByText("Q", { selector: ".var-name" })).toBeTruthy());

    const num = within(card as HTMLElement).getByPlaceholderText("如 9.81");
    const unit = within(card as HTMLElement).getByPlaceholderText("如 m/s^2、cfs");
    fireEvent.change(num, { target: { value: "2" } });
    fireEvent.change(unit, { target: { value: "cfs" } });
    fireEvent.change(within(card as HTMLElement).getByPlaceholderText("自动（保留计算单位）"), { target: { value: "m^3/s" } });

    await waitFor(() => expect(within(card as HTMLElement).getByText("已验证")).toBeTruthy());
    // 换算值 ≈ 0.0566 m^3/s
    const resultBox = card.querySelector(".result-row")!.textContent ?? "";
    expect(resultBox).toMatch(/0\.0566/);
    // 版本徽标
    expect(card.textContent).toContain("cfs·v1");
  });
});

describe("界面：场景 2 非法/循环定义被拒绝且不留残缺", () => {
  it("未知依赖被拒绝；A→B→A 修订被拒绝；合法单位仍在", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/还没有公式/)).toBeTruthy());
    await openLibrary();
    await createUnit("goodu", "g", "1", "m/s");
    // uA 依赖未知 uB
    await createUnit("uA", "a", "1", "uB");
    expect(document.querySelector(".lib-form .err-text")!.textContent).toContain("未知单位");
    expect([...document.querySelectorAll(".lib-unit-name")].some((e) => e.textContent?.includes("uA"))).toBe(false);
    // 合法建立 uA=m、uB=uA
    await createUnit("uA", "a", "1", "m");
    await createUnit("uB", "b", "1", "uA");
    // 修订 uA → uB
    const uAblock = [...document.querySelectorAll(".lib-unit")].find((e) => e.textContent?.includes("uA"))!;
    await act(async () => { fireEvent.click(within(uAblock as HTMLElement).getByRole("button", { name: "修订" })); });
    const inputs = document.querySelectorAll(".lib-form input");
    fireEvent.change(inputs[3], { target: { value: "uB" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存为新版本" })); });
    expect(document.querySelector(".lib-form .err-text")!.textContent).toContain("循环");
    // uA 仍只 v1
    expect(uAblock.querySelector(".badge-version")!.textContent).toContain("v1");
    // goodu、uA、uB 三个单位都在
    expect(document.querySelectorAll(".lib-unit").length).toBe(3);
  });
});

describe("界面：场景 3 修订生成新版本，旧公式不变，显式迁移才更新", () => {
  it("全流程", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/还没有公式/)).toBeTruthy());
    await openLibrary();
    await createUnit("mylen", "长度", "1", "ft");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "关闭 ✕" })); });

    // 公式 L=10 mylen → m
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "＋ 新建公式" })); });
    const card = document.querySelector(".card")!;
    fireEvent.change(within(card as HTMLElement).getByTestId("math"), { target: { value: "L" } });
    await waitFor(() => expect(within(card as HTMLElement).getByText("L", { selector: ".var-name" })).toBeTruthy());
    fireEvent.change(within(card as HTMLElement).getByPlaceholderText("如 9.81"), { target: { value: "10" } });
    fireEvent.change(within(card as HTMLElement).getByPlaceholderText("如 m/s^2、cfs"), { target: { value: "mylen" } });
    fireEvent.change(within(card as HTMLElement).getByPlaceholderText("自动（保留计算单位）"), { target: { value: "m" } });
    await waitFor(() => expect(within(card as HTMLElement).getByText("已验证")).toBeTruthy());
    expect(card.querySelector(".result-row")!.textContent).toMatch(/3\.048/);
    expect(card.textContent).toContain("mylen·v1");

    // 修订 mylen = 2 ft
    await openLibrary();
    const block = [...document.querySelectorAll(".lib-unit")].find((e) => e.textContent?.includes("mylen"))!;
    await act(async () => { fireEvent.click(within(block as HTMLElement).getByRole("button", { name: "修订" })); });
    const inputs = document.querySelectorAll(".lib-form input");
    fireEvent.change(inputs[2], { target: { value: "2" } });
    fireEvent.change(inputs[3], { target: { value: "ft" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存为新版本" })); });
    expect(block.querySelector(".badge-version")!.textContent).toContain("共 2 版");

    // 展开受影响公式并勾选 → 迁移
    await act(async () => { fireEvent.click(block.querySelector(".collapse-btn")!); });
    const usageDetails = within(block as HTMLElement).getByText(/受影响公式/).closest("details")!;
    await act(async () => { (usageDetails.querySelector("summary") as HTMLElement).click(); });
    const checkbox = usageDetails.querySelector("input.migrate-check") as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    await act(async () => { fireEvent.click(checkbox); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /迁移到最新 v2/ })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "关闭 ✕" })); });

    // 公式变为 v2，换算 6.096
    await waitFor(() => expect(card.textContent).toContain("mylen·v2"));
    expect(card.querySelector(".result-row")!.textContent).toMatch(/6\.096/);
    // 持久化的库含 2 个版本
    expect(mem.library.units[0].versions.length).toBe(2);
  });
});

describe("界面：场景 4 导入同名冲突单位包：隔离后旧值不变，勾选迁移后采用新定义（含刷新）", () => {
  it("全流程", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/还没有公式/)).toBeTruthy());

    // 本地 cfs = 1 ft^3/s + 公式 Q=2 cfs → m^3/s
    await openLibrary();
    await createUnit("cfs", "本地", "1", "ft^3/s");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "关闭 ✕" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "＋ 新建公式" })); });
    const card = document.querySelector(".card")!;
    fireEvent.change(within(card as HTMLElement).getByTestId("math"), { target: { value: "Q" } });
    await waitFor(() => expect(within(card as HTMLElement).getByText("Q", { selector: ".var-name" })).toBeTruthy());
    fireEvent.change(within(card as HTMLElement).getByPlaceholderText("如 9.81"), { target: { value: "2" } });
    fireEvent.change(within(card as HTMLElement).getByPlaceholderText("如 m/s^2、cfs"), { target: { value: "cfs" } });
    fireEvent.change(within(card as HTMLElement).getByPlaceholderText("自动（保留计算单位）"), { target: { value: "m^3/s" } });
    await waitFor(() => expect(card.textContent).toMatch(/0\.0566/));

    // 构造冲突单位包 cfs = 2 ft^3/s，通过隐藏 file input 选择
    const pkg = JSON.stringify({
      app: "dimension-notebook", version: 2, exportedAt: new Date().toISOString(),
      formulas: [], unitPackage: { name: "外来水利包" },
      units: [{
        name: "cfs", label: "包内", factor: 2, definition: "ft^3/s", baseUnit: "ft^3 / s",
        note: "2 倍", dimension: [0, 3, -1, 0, 0, 0, 0, 0, 0],
      }],
    });
    await openLibrary();
    const file = new File([pkg], "pkg.json", { type: "application/json" });
    const input = document.querySelectorAll<HTMLInputElement>(".topbar input[type=file]")[1];
    const dt = new DataTransfer();
    dt.items.add(file);
    Object.defineProperty(input, "files", { value: dt.files, configurable: true });
    await act(async () => { fireEvent.change(input); });
    await waitFor(() => expect(document.querySelector(".conflict-box")).toBeTruthy());
    expect(document.querySelector(".conflict-head")!.textContent).toContain("cfs");
    expect(document.querySelector(".conflict-row")!.textContent).toContain("量纲相同，比例不同");

    // 默认隔离 → 确认导入（App 导入成功后自动关闭面板）
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "按选择导入" })); });
    await waitFor(() => expect(document.querySelector(".modal")).toBeFalsy());
    // 内存库中存在两个 cfs（本地 + 隔离包）
    expect(mem.library.units.filter((u: any) => u.name === "cfs").length).toBe(2);
    expect(mem.library.units.find((u: any) => u.scope)).toBeTruthy();

    // 旧公式换算值仍 0.0566，徽标本地 v1
    expect(card.querySelector(".result-row")!.textContent).toMatch(/0\.0566/);
    expect(card.textContent).toContain("cfs·v1");

    // 模拟刷新：重新渲染（从内存 mock 读回）
    cleanup();
    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".card").length).toBe(1));
    const cardR = document.querySelector(".card")!;
    expect(cardR.querySelector(".result-row")!.textContent).toMatch(/0\.0566/);
    expect(cardR.textContent).toContain("cfs·v1");

    // 再导入一次 → 选择迁移并勾选公式
    await openLibrary();
    await act(async () => {
      fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".modal button")]
        .find((b) => b.textContent?.includes("导入单位包"))!);
    });
    const input2 = document.querySelectorAll<HTMLInputElement>(".topbar input[type=file]")[1];
    const dt2 = new DataTransfer();
    dt2.items.add(new File([pkg], "pkg.json", { type: "application/json" }));
    Object.defineProperty(input2, "files", { value: dt2.files, configurable: true });
    await act(async () => { fireEvent.change(input2); });
    await waitFor(() => expect(document.querySelector(".conflict-box")).toBeTruthy());
    // 勾选“显式迁移”
    await act(async () => {
      const radio = [...document.querySelectorAll<HTMLInputElement>(".conflict-options input[type=radio]")]
        .find((r) => r.closest("label")!.textContent!.includes("显式迁移"))!;
      fireEvent.click(radio);
    });
    await waitFor(() => expect(document.querySelector(".migrate-formulas input[type=checkbox]")).toBeTruthy());
    await act(async () => { fireEvent.click(document.querySelector(".migrate-formulas input[type=checkbox]")!); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "按选择导入" })); });
    await waitFor(() => expect(document.querySelector(".modal")).toBeFalsy());

    // 公式换算值翻倍 ≈ 0.1133，徽标带导入包标识
    await waitFor(() => expect(cardR.querySelector(".result-row")!.textContent).toMatch(/0\.1132|0\.1133/));
    expect(cardR.querySelector(".unit-ver-badge")!.textContent).toContain("📦");

    // 持久化的公式绑定 origin=import（可追溯）
    const persisted = mem.formulas[0];
    expect(persisted.variables.Q.unitRefs[0].origin).toBe("import");
    expect(persisted.variables.Q.unitRefs[0].scope).toBeTruthy();
  });
});
