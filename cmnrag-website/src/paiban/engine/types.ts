// 排班引擎类型定义

/** 人员角色 */
export type Role = 'both' | 'first_only' | 'second_only' | 'inactive';

export interface Member {
  name: string;
  role: Role;
}

/** 休假排除: 特定人员在特定日期不排班 */
export interface Exclusion {
  name: string;
  dates: string[];
}

/** 排班行 */
export interface ScheduleRow {
  id?: number;
  dutyDate: string;       // 值班日期 YYYY-MM-DD
  publishDate: string;    // 见报日期 YYYY-MM-DD
  weekday: string;        // 周一..周五
  firstEditor: string | null;
  secondEditor: string | null;
  remark: string | null;
}

/** 见报日历条目 */
export interface CalendarEntry {
  date: string;           // YYYY-MM-DD
  type: 'publish' | 'holiday';
  name?: string;
}

/** 校验违规 */
export interface Violation {
  level: 'hard' | 'soft';
  rule: string;
  message: string;
  dutyDate?: string;
  person?: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

/** 周期统计 */
export interface PeriodStats {
  perPerson: Record<string, { first: number; second: number; total: number }>;
  totalSlots: number;
}
/** 引擎设置 */
export interface EngineSettings {
  members: Member[];
  fridayRotation: string[];
  exclusions: Exclusion[];
  /** 刘钊每周期上限 (默认 2) */
  liuZhaoMax?: number;
  /** 间隔最小天数建议 (默认 >3) */
  minGapDays?: number;
}
