import type { translations } from "./i18n";

// 供应商清单的单一事实源：账号管理卡片（PROVIDER_METAS）与凭证导入卡（index.html 的
// .wizard-card[data-brand]）必须覆盖同一批供应商。新增/删除 Provider 时两处同批改，
// shell/test/provider-registry.test.ts 校验卡片集合与 CRED_BRAND_PROVIDER 键集合完全相等。
//
// 注意 autoclaw 与 autoclaw-cn 是同一产品的两个 id：config 用 autoclaw（CN），
// 导入卡的 brand 用 autoclaw-cn；autoclaw 卡牌映射到国际版 autoclaw-intl。
export interface ProviderMeta {
  name: string;
  iconBg: string;
  brandChar: string;
  hintKey: keyof typeof translations.zh;
}

export const PROVIDER_METAS: Record<string, ProviderMeta> = {
  trae: {
    name: "Trae",
    iconBg: "linear-gradient(135deg, #0052d9 0%, #00f2fe 100%)",
    brandChar: "T",
    hintKey: "traeHint",
  },
  qoder: {
    name: "Qoder",
    iconBg: "linear-gradient(135deg, #7928ca 0%, #ff0080 100%)",
    brandChar: "Q",
    hintKey: "qoderHint",
  },
  "qoder-intl": {
    name: "Qoder 国际版",
    iconBg: "linear-gradient(135deg, #7928ca 0%, #ff0080 100%)",
    brandChar: "Q",
    hintKey: "qoderIntlHint",
  },
  codearts: {
    name: "CodeArts",
    iconBg: "linear-gradient(135deg, #c7000b 0%, #ff6b6b 100%)",
    brandChar: "C",
    hintKey: "codeartsHint",
  },
  workbuddy: {
    name: "WorkBuddy",
    iconBg: "linear-gradient(135deg, #2b7fff 0%, #10b981 100%)",
    brandChar: "W",
    hintKey: "workbuddyHint",
  },
  "autoclaw-intl": {
    name: "AutoClaw",
    iconBg: "linear-gradient(135deg, #0f172a 0%, #06b6d4 100%)",
    brandChar: "A",
    hintKey: "autoclawHint",
  },
  autoclaw: {
    name: "AutoClaw CN",
    iconBg: "linear-gradient(135deg, #0f172a 0%, #f59e0b 100%)",
    brandChar: "A",
    hintKey: "autoclawCnHint",
  },
  "autoclaw-cn": {
    name: "AutoClaw CN",
    iconBg: "linear-gradient(135deg, #0f172a 0%, #f59e0b 100%)",
    brandChar: "A",
    hintKey: "autoclawCnHint",
  },
  raccoon: {
    name: "小浣熊",
    iconBg: "linear-gradient(135deg, #f97316 0%, #facc15 100%)",
    brandChar: "浣",
    hintKey: "raccoonHint",
  },
};

// 凭证导入卡 brand → 账号 provider id（决定卡片状态与导入后自动登记的账号）
export const CRED_BRAND_PROVIDER: Record<string, string> = {
  qoder: "qoder",
  "qoder-intl": "qoder-intl",
  trae: "trae",
  codearts: "codearts",
  autoclaw: "autoclaw-intl",
  workbuddy: "workbuddy",
  "autoclaw-cn": "autoclaw",
  raccoon: "raccoon",
};
