// WebUI 状态接口 / WebUI status interface
export interface WebUIStatus {
  running: boolean;
  port: number;
  allowRemote: boolean;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  adminUsername: string;
  initialPassword?: string;
}

// WebUI 重置密码结果 / WebUI reset password result
export interface WebUIResetPasswordResult {
  success: boolean;
  newPassword?: string;
  msg?: string;
}

// WebUI 获取状态结果 / WebUI get status result
export interface WebUIGetStatusResult {
  success: boolean;
  data?: WebUIStatus;
  msg?: string;
}

// WebUI 修改密码结果 / WebUI change password result
export interface WebUIChangePasswordResult {
  success: boolean;
  msg?: string;
}

export interface WebUIChangeUsernameResult {
  success: boolean;
  data?: { username: string };
  msg?: string;
}

// WebUI 生成二维码 token 结果 / WebUI generate QR token result
export interface WebUIGenerateQRTokenResult {
  success: boolean;
  data?: {
    token: string;
    expiresAt: number;
    qrUrl: string;
  };
  msg?: string;
}

export interface ElectronBridgeAPI {
  emit: (name: string, data: unknown) => Promise<unknown> | void;
  on: (callback: (event: { value: string }) => void) => void;
  // 获取拖拽文件/目录的绝对路径 / Get absolute path for dragged file/directory
  getPathForFile?: (file: File) => string;
  // 直接 IPC 调用（绕过 bridge 库）/ Direct IPC calls (bypass bridge library)
  webuiResetPassword?: () => Promise<WebUIResetPasswordResult>;
  webuiGetStatus?: () => Promise<WebUIGetStatusResult>;
  // 修改密码（需要当前密码 + 主进程确认）/ Change password (requires current password + main-process confirmation)
  webuiChangePassword?: (newPassword: string, currentPassword: string) => Promise<WebUIChangePasswordResult>;
  webuiChangeUsername?: (newUsername: string) => Promise<WebUIChangeUsernameResult>;
  // 生成二维��� token / Generate QR token
  webuiGenerateQRToken?: () => Promise<WebUIGenerateQRTokenResult>;
  // WeChat QR-code login / 微信二维码登录
  weixinLoginStart?: () => Promise<{ accountId: string; botToken: string }>;
  weixinLoginOnQR?: (callback: (data: { qrcodeUrl: string }) => void) => () => void;
  weixinLoginOnScanned?: (callback: () => void) => () => void;
  weixinLoginOnDone?: (callback: (data: { accountId: string }) => void) => () => void;
  // Feedback log collection / 收集反馈日志
  collectFeedbackLogs?: () => Promise<{ filename: string; data: number[] } | null>;
  // Wayland Constitution: agent behavioral spec at ~/.wayland/CONSTITUTION.md
  readConstitution?: () => Promise<string>;
  writeConstitution?: (content: string) => Promise<boolean>;
  resetConstitution?: () => Promise<string>;
  readConstitutionWithOverlay?: (assistantId?: string) => Promise<{ constitution: string; overlay: string | null }>;
  // Per-specialist Constitution overlays at ~/.wayland/specialists/<id>.md
  listConstitutionSpecialists?: () => Promise<{ id: string; bytes: number }[]>;
  readConstitutionSpecialist?: (id: string) => Promise<string>;
  writeConstitutionSpecialist?: (id: string, content: string) => Promise<boolean>;
  deleteConstitutionSpecialist?: (id: string) => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI?: ElectronBridgeAPI;
  }
}
