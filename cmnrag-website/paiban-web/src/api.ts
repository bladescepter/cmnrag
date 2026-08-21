// API 客户端
// 认证已统一到主系统（cmnrag_session cookie 自动携带），无需本地 token。

// ── Types ──

export interface ScheduleRowDB {
  id: number;
  duty_date: string;
  publish_date: string;
  weekday: string;
  first_editor: string | null;
  second_editor: string | null;
  remark: string | null;
  locked: number;
}

export interface PeriodStats {
  perPerson: Record<string, { first: number; second: number; total: number }>;
  totalSlots: number;
}

export interface ScheduleResponse {
  rows: ScheduleRowDB[];
  stats: PeriodStats;
}

export interface Member {
  name: string;
  role: MemberRole;
}

export interface Exclusion {
  name: string;
  dates: string[];
}

export interface Settings {
  members: Member[];
  fridayRotation: string[];
  exclusions: Exclusion[];
}

export interface CalendarData {
  year: number;
  publishDates: string[];
  holidays: string[];
}

export interface CycleInfo {
  publishStart: string;
  publishEnd: string;
  dutyStart: string;
  dutyEnd: string;
}

export interface GenerateResult {
  ok: boolean;
  cycle: { start: string; end: string };
  rows: ScheduleRowDB[];
  stats: PeriodStats;
  skippedLocked: number;
  error?: string;
}

export interface AuthResponse {
  token: string;
  user: { username: string };
}

interface ScheduleInput {
  dutyDate: string;
  publishDate: string;
  weekday: string;
  firstEditor?: string | null;
  secondEditor?: string | null;
  remark?: string | null;
}

// ── Request helper ──

async function request<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (opts.headers) {
    new Headers(opts.headers).forEach((v, k) => headers.set(k, v));
  }
  const res = await fetch(`/api/pb${path}`, { ...opts, headers, credentials: 'same-origin' });
  if (res.status === 401) {
    throw new Error('未登录');
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `HTTP ${res.status}`);
  }
  const data: unknown = await res.json();
  return data as T; // fetch boundary — caller specifies expected shape
}

// ── API ──

export const api = {
  // 主系统登录态检测（复用 /api/auth/me）
  async me(): Promise<{ username: string }> {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.status === 401) throw new Error('未登录');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  getSchedule(start?: string, end?: string): Promise<ScheduleResponse> {
    const q = start && end ? `?start=${start}&end=${end}` : '';
    return request<ScheduleResponse>(`/schedule${q}`);
  },
  saveRow(row: ScheduleInput): Promise<{ ok: boolean; id: number }> {
    return request('/schedule', {
      method: 'POST',
      body: JSON.stringify(row),
    });
  },
  updateRow(id: number, row: ScheduleInput): Promise<{ ok: boolean }> {
    return request(`/schedule/${id}`, {
      method: 'PUT',
      body: JSON.stringify(row),
    });
  },
  deleteRow(id: number): Promise<{ ok: boolean }> {
    return request(`/schedule/${id}`, { method: 'DELETE' });
  },
  clearRange(start: string, end: string): Promise<{ ok: boolean }> {
    return request(`/schedule/range/${start}/${end}`, { method: 'DELETE' });
  },
  bulkReplace(startDate: string, endDate: string, rows: ScheduleInput[]): Promise<ScheduleResponse> {
    return request('/schedule/bulk', {
      method: 'POST',
      body: JSON.stringify({ startDate, endDate, rows }),
    });
  },
  getSettings(): Promise<Settings> {
    return request<Settings>('/settings');
  },
  updateSettings(members: Member[], fridayRotation: string[], exclusions: Exclusion[]): Promise<{ ok: boolean }> {
    return request('/settings', {
      method: 'PUT',
      body: JSON.stringify({ members, fridayRotation, exclusions }),
    });
  },
  getCalendar(year?: number): Promise<CalendarData> {
    return request<CalendarData>(`/calendar/publish-dates${year ? `?year=${year}` : ''}`);
  },
  getCalendarCycles(year?: number): Promise<{ year: number; cycles: CycleInfo[] }> {
    return request(`/calendar/cycles${year ? `?year=${year}` : ''}`);
  },
  generateCycle(start: string, end: string): Promise<GenerateResult> {
    return request<GenerateResult>('/schedule/generate', {
      method: 'POST',
      body: JSON.stringify({ start, end }),
    });
  },
  toggleLock(id: number, locked: boolean): Promise<{ ok: boolean }> {
    return request(`/schedule/${id}/lock`, {
      method: 'PUT',
      body: JSON.stringify({ locked }),
    });
  },
};
